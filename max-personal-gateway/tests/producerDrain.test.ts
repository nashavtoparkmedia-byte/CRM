import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { loadGatewayConfig } from '../src/runtime/config.ts'
import { GatewayRuntime } from '../src/runtime/GatewayRuntime.ts'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const producer = require(resolve(repositoryRoot, 'max-web-scraper/capture/LiveCaptureAdapter.js'))
const secret = 'synthetic-stage8b1-hmac-secret-0000000000000000'
const temporary: string[] = []

function directory(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `max-stage8b1-${name}-`))
  temporary.push(value)
  return value
}

test.after(() => { for (const root of temporary) rmSync(root, { recursive: true, force: true }) })

function activeConfig() {
  return { ...loadGatewayConfig({
    MAX_RAW_JOURNAL_ENABLED: 'account-a', MAX_INBOUND_NORMALIZER_ENABLED: 'account-a',
    MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED: 'account-a',
    MAX_SHADOW_COMPARISON_ENABLED: 'account-a', MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a',
    MAX_PERSONAL_GATEWAY_DATABASE_URL: 'postgresql://synthetic.invalid/db',
    MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
  }), port: 0 }
}

function capture(adapter: any, index: number): void {
  const result = adapter.capturePhysicalFrame({
    raw: JSON.stringify({ opcode: 128, payload: { kind: 'message', text: `synthetic-${index}` } }),
    metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1', transportSequence: String(index) },
  })
  assert.equal(result.captured, true)
}

test('actual producer HMAC drain ACKs durable records and mount survives producer recreation', async () => {
  const observations = new Map<string, string>()
  const runtime = new GatewayRuntime(activeConfig(), {
    ingress: {
      async ingestEnvelope(value) {
        const existing = observations.get(value.captureEnvelopeId)
        if (existing) return { observationId: existing, created: false }
        const id = `observation-${observations.size + 1}`
        observations.set(value.captureEnvelopeId, id)
        return { observationId: id, created: true }
      },
      getCaptureHealth: () => ({ ingressIdempotentRetryCount: 0, rejectedCount: 0, captureEnvelopeIdCollisionCount: 0 }),
    },
    pipeline: { start() {}, notify() {}, async stop() { return true }, normalizerLagMs: 0, comparisonLagMs: 0, queueCritical: false },
    checkDatabase: async () => true, checkMigration: async () => true,
  })
  await runtime.start()
  const spoolPath = directory('persistent-spool')
  let adapter = new producer.LiveCaptureAdapter({
    accountId: 'account-a', spoolPath,
    ingress: { endpoint: `http://127.0.0.1:${runtime.address.port}/v1/capture`, keyId: 'current', secret, intervalMs: 1000, requestTimeoutMs: 1000, batchSize: 100 },
  })
  try {
    for (let index = 0; index < 25; index += 1) capture(adapter, index)
    const drained = await adapter.drain.drainOnce()
    assert.deepEqual(drained, { attempted: 25, acknowledged: 25, retained: 0 })
    assert.equal(observations.size, 25)
    assert.equal(adapter.getCaptureHealth().spoolPendingCount, 0)
    adapter.close()
    adapter = new producer.LiveCaptureAdapter({ accountId: 'account-a', spoolPath })
    assert.equal(adapter.getCaptureHealth().spoolPendingCount, 0)
    capture(adapter, 26)
    assert.equal(adapter.getCaptureHealth().spoolPendingCount, 1)
    const recoveredSequence = adapter.spool.readPending(10)
    assert.equal(recoveredSequence.length, 1)
    assert.equal(recoveredSequence[0].sequence, 26)
  } finally {
    adapter.close()
    await runtime.stop()
  }
})

test('gateway outage, invalid auth and network interruption retain records without content dedup', async () => {
  const spoolPath = directory('outage')
  const adapter = new producer.LiveCaptureAdapter({
    accountId: 'account-a', spoolPath,
    ingress: { endpoint: 'http://127.0.0.1:9/v1/capture', keyId: 'current', secret, intervalMs: 1000, requestTimeoutMs: 200, batchSize: 100 },
  })
  try {
    for (let index = 0; index < 2; index += 1) {
      const result = adapter.capturePhysicalFrame({
        raw: JSON.stringify({ opcode: 128, payload: { kind: 'message', text: 'identical' } }),
        metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1' },
      })
      assert.equal(result.captured, true)
    }
    const pending = adapter.spool.readPending(10)
    assert.equal(pending.length, 2)
    assert.notEqual(pending[0].envelope.captureEnvelopeId, pending[1].envelope.captureEnvelopeId)
    assert.equal(pending[0].envelope.payloadSha256, pending[1].envelope.payloadSha256)
    const drained = await adapter.drain.drainOnce()
    assert.equal(drained.acknowledged, 0)
    assert.equal(adapter.getCaptureHealth().spoolPendingCount, 2)
    assert.equal(adapter.getCaptureHealth().adapterState, 'degraded')
  } finally { adapter.close() }
})

test('enabled producer with incomplete ingress config stays durable and reports critical', () => {
  const spoolPath = directory('incomplete')
  const adapter = producer.createLiveCaptureAdapterFromEnvironment({
    MAX_PERSONAL_ACCOUNT_ID: 'account-a', MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a',
    MAX_PERSONAL_CAPTURE_SPOOL_PATH: spoolPath,
  })
  assert.equal(adapter.enabled, true)
  capture(adapter, 1)
  assert.equal(adapter.getCaptureHealth().adapterState, 'critical')
  assert.equal(adapter.getCaptureHealth().lastDrainErrorCode, 'INGRESS_CONFIG_INVALID')
  assert.equal(adapter.getCaptureHealth().spoolPendingCount, 1)
  adapter.close()
})

test('producer flags reject global, wildcard, whitespace and malformed allowlists without spool effects', () => {
  for (const value of ['all', 'true', '1', '*', 'account-a, account-b', 'account-a,']) {
    const root = directory('invalid-allowlist')
    const spoolPath = join(root, 'spool')
    const adapter = producer.createLiveCaptureAdapterFromEnvironment({
      MAX_PERSONAL_ACCOUNT_ID: 'account-a',
      MAX_PERSONAL_LIVE_CAPTURE_ENABLED: value,
      MAX_PERSONAL_CAPTURE_SPOOL_PATH: spoolPath,
    })
    assert.equal(adapter.enabled, false)
    assert.equal(existsSync(spoolPath), false)
    adapter.close()
  }
})
