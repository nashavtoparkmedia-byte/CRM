import { captureErrorCode, CaptureError } from './errors.ts'
import type {
  CaptureDrainResult,
  DurableCaptureSpool,
  RawCaptureIngress,
  SpoolRecord,
} from './types.ts'

export interface CaptureDrainWorkerOptions {
  readonly batchSize?: number
  readonly maxConcurrency?: number
  readonly initialRetryDelayMs?: number
  readonly maximumRetryDelayMs?: number
  readonly jitterRatio?: number
  readonly random?: () => number
}

function boundedPositive(value: number, field: string, maximum = 1000): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CaptureError('INVALID_CAPTURE_CONFIG', `${field} is outside its safe bound`)
  }
}

export class CaptureDrainWorker {
  readonly #spool: DurableCaptureSpool
  readonly #ingress: RawCaptureIngress
  readonly #batchSize: number
  readonly #maxConcurrency: number
  readonly #initialRetryDelayMs: number
  readonly #maximumRetryDelayMs: number
  readonly #jitterRatio: number
  readonly #random: () => number
  #consecutiveFailures = 0
  #timer: NodeJS.Timeout | null = null
  #running: Promise<CaptureDrainResult> | null = null
  #stopped = true

  constructor(spool: DurableCaptureSpool, ingress: RawCaptureIngress, options: CaptureDrainWorkerOptions = {}) {
    this.#spool = spool
    this.#ingress = ingress
    this.#batchSize = options.batchSize ?? 100
    this.#maxConcurrency = options.maxConcurrency ?? 4
    this.#initialRetryDelayMs = options.initialRetryDelayMs ?? 250
    this.#maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000
    this.#jitterRatio = options.jitterRatio ?? 0.2
    this.#random = options.random ?? Math.random
    boundedPositive(this.#batchSize, 'batchSize')
    boundedPositive(this.#maxConcurrency, 'maxConcurrency', 32)
    boundedPositive(this.#initialRetryDelayMs, 'initialRetryDelayMs', 60_000)
    boundedPositive(this.#maximumRetryDelayMs, 'maximumRetryDelayMs', 300_000)
    if (this.#maximumRetryDelayMs < this.#initialRetryDelayMs || this.#jitterRatio < 0 || this.#jitterRatio > 1) {
      throw new CaptureError('INVALID_CAPTURE_CONFIG', 'Capture drain retry configuration is invalid')
    }
  }

  async drainOnce(): Promise<CaptureDrainResult> {
    if (this.#running !== null) return this.#running
    this.#running = this.#drainBatch()
    try { return await this.#running } finally { this.#running = null }
  }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#schedule(0)
  }

  async stopAndFlush(timeoutMs = 2000): Promise<CaptureDrainResult | null> {
    boundedPositive(timeoutMs, 'timeoutMs', 30_000)
    this.#stopped = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    const operation = this.#running ?? this.drainOnce()
    return Promise.race([
      operation,
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ])
  }

  async #drainBatch(): Promise<CaptureDrainResult> {
    const records = this.#spool.readPending(this.#batchSize)
    if (records.length === 0) {
      this.#consecutiveFailures = 0
      return { attempted: 0, acknowledged: 0, retained: 0, nextDelayMs: this.#initialRetryDelayMs }
    }
    const outcomes: Array<{ record: SpoolRecord; ok: boolean; errorCode?: string }> = []
    for (let offset = 0; offset < records.length; offset += this.#maxConcurrency) {
      const group = records.slice(offset, offset + this.#maxConcurrency)
      outcomes.push(...await Promise.all(group.map(async record => {
        try {
          await this.#ingress.ingestEnvelope(record.envelope)
          return { record, ok: true as const }
        } catch (error) {
          return { record, ok: false as const, errorCode: captureErrorCode(error) }
        }
      })))
    }
    let acknowledged = 0
    for (const outcome of outcomes) {
      if (!outcome.ok) break
      this.#spool.markAcknowledged(outcome.record.sequence)
      acknowledged += 1
    }
    const retained = records.length - acknowledged
    if (retained > 0) {
      this.#consecutiveFailures += 1
      const firstFailure = outcomes.find(outcome => !outcome.ok)
      const retryAware = this.#spool as DurableCaptureSpool & { noteRetry?: (errorCode: string) => void }
      retryAware.noteRetry?.(firstFailure?.errorCode ?? 'INGRESS_UNAVAILABLE')
    } else {
      this.#consecutiveFailures = 0
    }
    return {
      attempted: records.length,
      acknowledged,
      retained,
      nextDelayMs: this.#retryDelay(),
    }
  }

  #retryDelay(): number {
    const exponent = Math.max(0, this.#consecutiveFailures - 1)
    const base = Math.min(this.#maximumRetryDelayMs, this.#initialRetryDelayMs * (2 ** exponent))
    const jitter = base * this.#jitterRatio * ((this.#random() * 2) - 1)
    return Math.max(this.#initialRetryDelayMs, Math.min(this.#maximumRetryDelayMs, Math.round(base + jitter)))
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return
    this.#timer = setTimeout(async () => {
      this.#timer = null
      const result = await this.drainOnce()
      this.#schedule(result.retained > 0 ? result.nextDelayMs : this.#initialRetryDelayMs)
    }, delayMs)
    this.#timer.unref?.()
  }
}
