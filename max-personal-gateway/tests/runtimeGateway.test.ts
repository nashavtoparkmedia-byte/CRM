import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import test from 'node:test'
import type { CaptureEnvelope } from '../src/capture/types.ts'
import { signCaptureRequest } from '../src/runtime/auth.ts'
import { loadGatewayConfig } from '../src/runtime/config.ts'
import { GatewayRuntime } from '../src/runtime/GatewayRuntime.ts'

const secret = 'synthetic-stage8b1-hmac-secret-0000000000000000'

function envelope(id: string, accountId = 'account-a'): CaptureEnvelope {
  return {
    captureEnvelopeId: id, captureEnvelopeVersion: 1, accountId,
    observedAt: new Date().toISOString(), sourceTransport: 'max_websocket', sourceOrigin: 'live',
    socketGeneration: 'socket-1', sessionGeneration: 'session-1', frameId: null,
    providerEventId: null, transportSequence: null, opcode: 128, eventType: 'message',
    payloadEncoding: 'json', sanitizedPayload: { kind: 'message', text: 'synthetic' },
    payloadSha256: 'a'.repeat(64), payloadSizeBytes: 37, replayAvailability: 'available',
    quarantineReason: null, redactionMetadata: { sanitizerVersion: 'max-raw-sanitizer-v1', categories: [], paths: [] },
    sanitizerVersion: 'max-raw-sanitizer-v1', captureAdapterVersion: 'max-live-capture-adapter-v1',
    capturedAt: new Date().toISOString(), retryCount: 0, safeMetadata: { synthetic: true },
  }
}

const healthyProducer = {
  adapterState: 'healthy', spoolPendingCount: 1, spoolPendingBytes: 100,
  oldestPendingAgeMs: 1, lostBeforeSpoolCount: 0, captureEnvelopeIdCollisionCount: 0,
}

async function call(port: number, method: string, path: string, body?: Buffer, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const operation = request({ host: '127.0.0.1', port, method, path, headers: {
      ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}), ...headers,
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: raw.startsWith('{') ? JSON.parse(raw) : raw })
      })
    })
    operation.on('error', reject)
    operation.end(body)
  })
}

function activeConfig() {
  return { ...loadGatewayConfig({
    MAX_RAW_JOURNAL_ENABLED: 'account-a', MAX_INBOUND_NORMALIZER_ENABLED: 'account-a',
    MAX_SHADOW_COMPARISON_ENABLED: 'account-a', MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a',
    MAX_PERSONAL_GATEWAY_DATABASE_URL: 'postgresql://synthetic.invalid/db',
    MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
  }), port: 0 }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function startDormantProcess(port: number) {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/runtime/main.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
      MAX_PERSONAL_GATEWAY_HOST: '127.0.0.1',
      MAX_PERSONAL_GATEWAY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`gateway start timeout: ${output}`)), 5000)
    const inspect = () => {
      if (output.includes('gateway_signal_handlers_ready')) {
        clearTimeout(deadline)
        resolve()
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', (code, signal) => {
      clearTimeout(deadline)
      reject(new Error(`gateway exited before start: code=${code} signal=${signal} output=${output}`))
    })
  })
  return { child, output: () => output }
}

test('dormant gateway is ready without DB/auth and capture endpoint remains inert', async () => {
  let sideEffects = 0
  const runtime = new GatewayRuntime({ ...loadGatewayConfig({}), port: 0 }, {
    ingress: null, pipeline: null,
    checkDatabase: async () => { sideEffects += 1; return false },
    checkMigration: async () => { sideEffects += 1; return false },
  })
  await runtime.start()
  try {
    assert.equal((await call(runtime.address.port, 'GET', '/ready')).status, 200)
    assert.equal((await call(runtime.address.port, 'POST', '/v1/capture', Buffer.from('{}'))).status, 503)
    assert.equal(sideEffects, 0)
  } finally { await runtime.stop() }
})

test('active ingress denies auth/account failures, persists valid requests and handles replay idempotently', async () => {
  const observations = new Map<string, string>()
  const notified: string[] = []
  const runtime = new GatewayRuntime(activeConfig(), {
    ingress: {
      async ingestEnvelope(value) {
        const existing = observations.get(value.captureEnvelopeId)
        if (existing) return { observationId: existing, created: false }
        const observationId = `observation-${observations.size + 1}`
        observations.set(value.captureEnvelopeId, observationId)
        return { observationId, created: true }
      },
      getCaptureHealth: () => ({ ingressIdempotentRetryCount: 0, rejectedCount: 0, captureEnvelopeIdCollisionCount: 0 }),
    },
    pipeline: { start() {}, notify(value) { if (value) notified.push(value) }, async stop() { return true }, normalizerLagMs: 0, comparisonLagMs: 0, queueCritical: false },
    checkDatabase: async () => true, checkMigration: async () => true,
  })
  await runtime.start()
  try {
    const value = Buffer.from(JSON.stringify({ envelope: envelope('capture-1'), producerHealth: healthyProducer }))
    assert.equal((await call(runtime.address.port, 'POST', '/v1/capture', value)).status, 401)
    const invalid = signCaptureRequest(`${secret}-invalid`, 'current', 'POST', '/v1/capture', String(Date.now()), value)
    assert.equal((await call(runtime.address.port, 'POST', '/v1/capture', value, {
      'x-max-capture-key-id': invalid.keyId, 'x-max-capture-timestamp': invalid.timestamp,
      'x-max-capture-signature': invalid.signature,
    })).status, 401)
    const wrongBody = Buffer.from(JSON.stringify({ envelope: envelope('capture-wrong', 'account-b'), producerHealth: healthyProducer }))
    const wrong = signCaptureRequest(secret, 'current', 'POST', '/v1/capture', String(Date.now()), wrongBody)
    assert.equal((await call(runtime.address.port, 'POST', '/v1/capture', wrongBody, {
      'x-max-capture-key-id': wrong.keyId, 'x-max-capture-timestamp': wrong.timestamp,
      'x-max-capture-signature': wrong.signature,
    })).status, 403)
    const signed = signCaptureRequest(secret, 'current', 'POST', '/v1/capture', String(Date.now()), value)
    const headers = { 'x-max-capture-key-id': signed.keyId, 'x-max-capture-timestamp': signed.timestamp, 'x-max-capture-signature': signed.signature }
    assert.equal((await call(runtime.address.port, 'POST', '/v1/capture', value, headers)).status, 201)
    const replay = signCaptureRequest(secret, 'current', 'POST', '/v1/capture', String(Date.now()), value)
    assert.equal((await call(runtime.address.port, 'POST', '/v1/capture', value, {
      'x-max-capture-key-id': replay.keyId, 'x-max-capture-timestamp': replay.timestamp,
      'x-max-capture-signature': replay.signature,
    })).status, 200)
    assert.equal(observations.size, 1)
    assert.deepEqual(notified, ['account-a', 'account-a'])
    assert.equal((await call(runtime.address.port, 'GET', '/ready')).status, 200)
  } finally { await runtime.stop() }
})

test('readiness fails honestly for missing migration and critical/lost producer evidence', async () => {
  const runtime = new GatewayRuntime(activeConfig(), {
    ingress: { async ingestEnvelope() { return { observationId: 'observation', created: true } }, getCaptureHealth: () => ({ ingressIdempotentRetryCount: 0, rejectedCount: 0, captureEnvelopeIdCollisionCount: 0 }) },
    pipeline: { start() {}, notify() {}, async stop() { return true }, normalizerLagMs: 0, comparisonLagMs: 0, queueCritical: false },
    checkDatabase: async () => true, checkMigration: async () => false,
  })
  await runtime.start()
  try {
    const body = Buffer.from(JSON.stringify({ envelope: envelope('capture-critical'), producerHealth: {
      ...healthyProducer, adapterState: 'critical', lostBeforeSpoolCount: 1,
    } }))
    const signed = signCaptureRequest(secret, 'current', 'POST', '/v1/capture', String(Date.now()), body)
    await call(runtime.address.port, 'POST', '/v1/capture', body, {
      'x-max-capture-key-id': signed.keyId, 'x-max-capture-timestamp': signed.timestamp,
      'x-max-capture-signature': signed.signature,
    })
    const readiness = await call(runtime.address.port, 'GET', '/ready')
    assert.equal(readiness.status, 503)
    assert.equal(readiness.body.gates.migrationPresent, false)
    assert.equal(readiness.body.gates.spoolWritable, false)
    assert.equal(readiness.body.gates.lostBeforeSpoolZero, false)
  } finally { await runtime.stop() }
})

test('gateway process drains cleanly on SIGTERM and is restartable after SIGKILL', async () => {
  const graceful = await startDormantProcess(await unusedLoopbackPort())
  graceful.child.kill('SIGTERM')
  const gracefulExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    graceful.child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(gracefulExit, { code: 0, signal: null })
  assert.match(graceful.output(), /gateway_shutdown_complete/)

  const killed = await startDormantProcess(await unusedLoopbackPort())
  killed.child.kill('SIGKILL')
  const killedExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    killed.child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.equal(killedExit.code, null)
  assert.equal(killedExit.signal, 'SIGKILL')

  const restarted = await startDormantProcess(await unusedLoopbackPort())
  restarted.child.kill('SIGTERM')
  const restartExit = await new Promise<number | null>(resolve => restarted.child.once('exit', code => resolve(code)))
  assert.equal(restartExit, 0)
})
