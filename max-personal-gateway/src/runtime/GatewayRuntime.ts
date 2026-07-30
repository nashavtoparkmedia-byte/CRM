import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { CaptureEnvelope, CaptureIngressResult, RawCaptureIngress } from '../capture/types.ts'
import { authenticateCaptureRequest } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { OperationalMetrics } from './metrics.ts'
import { buildReadiness, type ProducerHealthEvidence, type RuntimeSafetyState } from './readiness.ts'

export interface GatewayRuntimeDependencies {
  readonly ingress: RawCaptureIngress | null
  readonly checkDatabase: () => Promise<boolean>
  readonly checkMigration: (migration: string) => Promise<boolean>
  readonly pipeline: {
    start(): void
    notify(accountId?: string): void
    stop(timeoutMs?: number): Promise<boolean>
    readonly normalizerLagMs: number
    readonly comparisonLagMs: number
    readonly queueCritical: boolean
  } | null
  readonly textSender?: {
    authenticateCommand(body: Buffer, authentication: { timestamp: string | undefined; nonce: string | undefined; signature: string | undefined }): boolean
    submit(value: unknown): Promise<Readonly<Record<string, unknown>>>
    authorize(value: unknown): Promise<Readonly<Record<string, unknown>>>
  } | null
  readonly metrics?: OperationalMetrics
  readonly log?: (event: Readonly<Record<string, unknown>>) => void
}

interface CaptureRequestBody {
  readonly envelope: CaptureEnvelope
  readonly producerHealth: ProducerHealthEvidence
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function producerHealth(value: unknown): ProducerHealthEvidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!['healthy', 'degraded', 'critical'].includes(String(record.adapterState))
    || !isNonNegative(record.spoolPendingCount) || !isNonNegative(record.spoolPendingBytes)
    || !(record.oldestPendingAgeMs === null || isNonNegative(record.oldestPendingAgeMs))
    || !isNonNegative(record.lostBeforeSpoolCount) || !isNonNegative(record.captureEnvelopeIdCollisionCount)) return null
  return {
    adapterState: record.adapterState as ProducerHealthEvidence['adapterState'],
    spoolPendingCount: record.spoolPendingCount,
    spoolPendingBytes: record.spoolPendingBytes,
    oldestPendingAgeMs: record.oldestPendingAgeMs,
    lostBeforeSpoolCount: record.lostBeforeSpoolCount,
    captureEnvelopeIdCollisionCount: record.captureEnvelopeIdCollisionCount,
    observedAt: Date.now(),
  }
}

function captureBody(value: unknown): CaptureRequestBody | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const envelope = record.envelope
  const health = producerHealth(record.producerHealth)
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) || health === null) return null
  const candidate = envelope as Record<string, unknown>
  if (candidate.captureEnvelopeVersion !== 1 || typeof candidate.captureEnvelopeId !== 'string'
    || candidate.captureEnvelopeId.length < 1 || candidate.captureEnvelopeId.length > 256
    || typeof candidate.accountId !== 'string') return null
  return { envelope: envelope as CaptureEnvelope, producerHealth: health }
}

async function readBody(request: IncomingMessage, maximumBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let finished = false
    const complete = (operation: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      operation()
    }
    const timer = setTimeout(() => {
      complete(() => reject(Object.assign(new Error('body timeout'), { code: 'BODY_TIMEOUT' })))
      request.destroy()
    }, timeoutMs)
    request.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maximumBytes) {
        complete(() => reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' })))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => complete(() => resolve(Buffer.concat(chunks))))
    request.on('error', error => complete(() => reject(error)))
  })
}

function json(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const encoded = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': encoded.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(encoded)
}

export class GatewayRuntime {
  readonly config: GatewayConfig
  readonly metrics: OperationalMetrics
  readonly #dependencies: GatewayRuntimeDependencies
  readonly #server: Server
  readonly #state: RuntimeSafetyState = {
    configValid: true,
    databaseReachable: false,
    migrationPresent: false,
    lastJournalAckAt: null,
    normalizerLagMs: 0,
    comparisonLagMs: 0,
    producerHealth: null,
    workerQueueCritical: false,
  }
  #started = false

  constructor(config: GatewayConfig, dependencies: GatewayRuntimeDependencies) {
    this.config = config
    this.#dependencies = dependencies
    this.metrics = dependencies.metrics ?? new OperationalMetrics()
    this.#server = createServer((request, response) => { void this.#handle(request, response) })
    this.#server.headersTimeout = config.headerTimeoutMs
    this.#server.requestTimeout = config.bodyTimeoutMs + config.headerTimeoutMs
    this.#server.keepAliveTimeout = 5000
    this.#server.maxHeadersCount = 32
  }

  get address(): { host: string; port: number } {
    const address = this.#server.address()
    if (address === null || typeof address === 'string') return { host: this.config.bindHost, port: this.config.port }
    return { host: this.config.bindHost, port: address.port }
  }

  async start(): Promise<void> {
    if (this.#started) return
    if (this.config.mode === 'active') {
      await this.refreshSafety()
      this.#dependencies.pipeline?.start()
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.config.port, this.config.bindHost, () => {
        this.#server.off('error', reject)
        resolve()
      })
    })
    this.#started = true
    this.#log({ event: 'gateway_started', mode: this.config.mode, port: this.address.port })
  }

  async stop(timeoutMs = 5000): Promise<boolean> {
    const workers = await this.#dependencies.pipeline?.stop(timeoutMs) ?? true
    if (this.#started) {
      await new Promise<void>(resolve => this.#server.close(() => resolve()))
      this.#started = false
    }
    this.#log({ event: 'gateway_stopped', workersFlushed: workers })
    return workers
  }

  async refreshSafety(): Promise<void> {
    if (this.config.mode === 'dormant') return
    try { this.#state.databaseReachable = await this.#dependencies.checkDatabase() } catch { this.#state.databaseReachable = false }
    try { this.#state.migrationPresent = await this.#dependencies.checkMigration(this.config.expectedMigration) } catch { this.#state.migrationPresent = false }
    const pipeline = this.#dependencies.pipeline
    if (pipeline !== null) {
      this.#state.normalizerLagMs = pipeline.normalizerLagMs
      this.#state.comparisonLagMs = pipeline.comparisonLagMs
      this.#state.workerQueueCritical = pipeline.queueCritical
    }
  }

  healthSnapshot(): Readonly<Record<string, unknown>> {
    return {
      service: 'max-personal-gateway',
      mode: this.config.mode,
      enabledAccountCount: this.config.enabledAccounts.size,
      metrics: this.metrics.snapshot(),
      readiness: buildReadiness(this.config, this.#state, this.metrics),
    }
  }

  readinessSnapshot() { return buildReadiness(this.config, this.#state, this.metrics) }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://gateway.invalid')
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, this.healthSnapshot())
        return
      }
      if (request.method === 'GET' && url.pathname === '/ready') {
        await this.refreshSafety()
        const readiness = this.readinessSnapshot()
        json(response, readiness.ready ? 200 : 503, readiness as unknown as Record<string, unknown>)
        return
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        const body = this.metrics.prometheus()
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
        response.end(body)
        return
      }
      if (request.method === 'POST' && url.search === ''
        && (url.pathname === '/v1/personal-max/commands/text' || url.pathname === '/v1/personal-max/sender/authorize')) {
        if (this.#dependencies.textSender == null) {
          json(response, 503, { code: 'TEXT_SENDER_DISABLED' })
          return
        }
        if (header(request, 'content-type')?.split(';')[0].trim() !== 'application/json') {
          json(response, 415, { code: 'CONTENT_TYPE_REJECTED' })
          return
        }
        const body = await readBody(request, 100_000, this.config.bodyTimeoutMs)
        if (url.pathname === '/v1/personal-max/commands/text' && !this.#dependencies.textSender.authenticateCommand(body, {
          timestamp: header(request, 'x-max-command-timestamp'),
          nonce: header(request, 'x-max-command-nonce'),
          signature: header(request, 'x-max-command-signature'),
        })) {
          json(response, 401, { code: 'COMMAND_AUTH_REJECTED' })
          return
        }
        let decoded: unknown
        try { decoded = JSON.parse(body.toString('utf8')) } catch { decoded = null }
        try {
          const result = url.pathname === '/v1/personal-max/commands/text'
            ? await this.#dependencies.textSender.submit(decoded)
            : await this.#dependencies.textSender.authorize(decoded)
          const uncertain = result.deliveryStatus === 'needs_review'
          json(response, uncertain ? 202 : 200, result)
        } catch (error) {
          const code = error !== null && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
            ? String(Reflect.get(error, 'code')) : 'TEXT_SENDER_FAILED'
          json(response, 409, { code, safeCode: code })
        }
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/capture' || url.search !== '') {
        json(response, 404, { code: 'NOT_FOUND' })
        return
      }
      if (this.config.mode === 'dormant' || this.#dependencies.ingress === null) {
        json(response, 503, { code: 'INGRESS_DORMANT' })
        return
      }
      if (header(request, 'content-type')?.split(';')[0].trim() !== 'application/json') {
        this.metrics.increment('captureRejected')
        json(response, 415, { code: 'CONTENT_TYPE_REJECTED' })
        return
      }
      const body = await readBody(request, this.config.requestMaxBytes, this.config.bodyTimeoutMs)
      const authentication = authenticateCaptureRequest({
        keys: this.config.hmacKeys,
        method: request.method,
        path: url.pathname,
        body,
        keyId: header(request, 'x-max-capture-key-id'),
        timestamp: header(request, 'x-max-capture-timestamp'),
        signature: header(request, 'x-max-capture-signature'),
        maximumClockSkewMs: this.config.authClockSkewMs,
      })
      if (!authentication.authenticated) {
        this.metrics.increment('ingressAuthFailures')
        this.metrics.increment('captureRejected')
        this.#log({ event: 'capture_auth_rejected', code: authentication.code })
        json(response, 401, { code: 'AUTH_REJECTED' })
        return
      }
      let decoded: unknown
      try { decoded = JSON.parse(body.toString('utf8')) } catch { decoded = null }
      const parsed = captureBody(decoded)
      if (parsed === null || !this.config.features.rawJournal.has(parsed.envelope.accountId)
        || !this.config.features.liveCapture.has(parsed.envelope.accountId)) {
        this.metrics.increment('captureRejected')
        json(response, 403, { code: 'ACCOUNT_OR_ENVELOPE_REJECTED' })
        return
      }
      this.#state.producerHealth = parsed.producerHealth
      this.metrics.spoolPending = parsed.producerHealth.spoolPendingCount
      this.metrics.spoolBytes = parsed.producerHealth.spoolPendingBytes
      this.metrics.oldestPendingAgeMs = parsed.producerHealth.oldestPendingAgeMs
      this.metrics.set('lostBeforeSpool', parsed.producerHealth.lostBeforeSpoolCount)
      const started = performance.now()
      let result: CaptureIngressResult
      try {
        result = await this.#dependencies.ingress.ingestEnvelope(parsed.envelope)
      } catch {
        this.metrics.increment('captureRejected')
        this.metrics.increment('drainFailures')
        this.#log({ event: 'capture_ingress_failed', code: 'JOURNAL_INGEST_FAILED' })
        json(response, 503, { code: 'JOURNAL_INGEST_FAILED' })
        return
      }
      const elapsed = performance.now() - started
      this.metrics.observe('journalMs', elapsed)
      this.metrics.observe('ingressAckMs', elapsed)
      this.metrics.increment('captureAccepted')
      this.metrics.increment('journalAckCount')
      if (!result.created) this.metrics.increment('idempotentRetryCount')
      this.#state.lastJournalAckAt = Date.now()
      this.#dependencies.pipeline?.notify(parsed.envelope.accountId)
      json(response, result.created ? 201 : 200, {
        captureEnvelopeId: parsed.envelope.captureEnvelopeId,
        observationId: result.observationId,
        created: result.created,
      })
    } catch (error) {
      const code = error !== null && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
        ? String(Reflect.get(error, 'code')) : 'REQUEST_REJECTED'
      this.metrics.increment('captureRejected')
      json(response, code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 : 400, { code })
    }
  }

  #log(event: Readonly<Record<string, unknown>>): void {
    if (this.#dependencies.log !== undefined) this.#dependencies.log(event)
  }
}
