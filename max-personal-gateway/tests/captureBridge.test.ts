import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CaptureDrainWorker } from '../src/capture/CaptureDrainWorker.ts'
import { CaptureEnvelopeFactory } from '../src/capture/CaptureEnvelopeFactory.ts'
import { CaptureError } from '../src/capture/errors.ts'
import { isLiveCaptureEnabled } from '../src/capture/featureFlag.ts'
import { PrismaRawCaptureIngress } from '../src/capture/PrismaRawCaptureIngress.ts'
import { SegmentedFileCaptureSpool } from '../src/capture/SegmentedFileCaptureSpool.ts'
import type { CaptureEnvelope, RawCaptureIngress } from '../src/capture/types.ts'
import { FakePrismaClient } from './support/FakePrisma.ts'

function temp(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `max-stage8a-${name}-`))
  temporaryRoots.push(value)
  return value
}

const temporaryRoots: string[] = []
test.after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }) })

function factory() {
  let id = 0
  let tick = 0
  return new CaptureEnvelopeFactory({
    idGenerator: () => `capture-${++id}`,
    clock: () => new Date(1_785_171_600_000 + tick++),
  })
}

function envelope(create = factory(), overrides: Partial<Parameters<CaptureEnvelopeFactory['createEnvelope']>[0]> = {}): CaptureEnvelope {
  return create.createEnvelope({
    accountId: 'account-a',
    sourceOrigin: 'live',
    socketGeneration: 'socket-1',
    sessionGeneration: 'session-1',
    frameId: 'frame-1',
    providerEventId: 'provider-shared',
    transportSequence: '1',
    opcode: 128,
    eventType: 'message',
    payloadEncoding: 'json',
    payload: { kind: 'message', direction: 'inbound', text: 'synthetic' },
    ...overrides,
  })
}

test('Stage 8A feature flag is exact-account allowlist only and defaults false', () => {
  assert.equal(isLiveCaptureEnabled(undefined, 'account-a'), false)
  assert.equal(isLiveCaptureEnabled('', 'account-a'), false)
  assert.equal(isLiveCaptureEnabled('true', 'account-a'), false)
  assert.equal(isLiveCaptureEnabled('*', 'account-a'), false)
  assert.equal(isLiveCaptureEnabled('account-a,!', 'account-a'), false)
  assert.equal(isLiveCaptureEnabled('account-a,account-b', 'account-a'), true)
  assert.equal(isLiveCaptureEnabled('account-a', 'account-b'), false)
})

test('physical identity is generated once, retry-stable, and never content-derived', async () => {
  const create = factory()
  const first = envelope(create)
  const second = envelope(create)
  const history = envelope(create, { sourceOrigin: 'history' })
  assert.notEqual(first.captureEnvelopeId, second.captureEnvelopeId)
  assert.equal(first.payloadSha256, second.payloadSha256)
  assert.notEqual(first.captureEnvelopeId, first.payloadSha256)
  assert.equal(first.providerEventId, second.providerEventId)
  assert.notEqual(history.captureEnvelopeId, first.captureEnvelopeId)
  assert.equal(history.sourceOrigin, 'history')
  assert.ok(Object.isFrozen(first))

  const client = new FakePrismaClient()
  const ingress = new PrismaRawCaptureIngress(client)
  const one = await ingress.ingestEnvelope(first)
  const retry = await ingress.ingestEnvelope(first)
  assert.equal(retry.observationId, one.observationId)
  assert.equal(retry.created, false)
  assert.equal(client.rawRows().length, 1)
  assert.equal(client.processingRows().length, 1)
  assert.equal(ingress.getCaptureHealth().ingressIdempotentRetryCount, 1)
})

test('account scope permits same retry identity across accounts and physical duplicates remain separate', async () => {
  const create = factory()
  const original = envelope(create)
  const accountB = { ...original, accountId: 'account-b' }
  const physicalDuplicate = envelope(create)
  const client = new FakePrismaClient()
  const ingress = new PrismaRawCaptureIngress(client)
  await ingress.ingestEnvelope(original)
  await ingress.ingestEnvelope(accountB)
  await ingress.ingestEnvelope(physicalDuplicate)
  assert.equal(client.rawRows().length, 3)
  assert.equal(client.rawRows().filter(row => row.accountId === 'account-a').length, 2)
  assert.equal(client.rawRows().filter(row => row.accountId === 'account-b').length, 1)
})

test('same capture identity with different physical evidence is rejected and counted as a collision', async () => {
  const create = factory()
  const original = envelope(create)
  const conflicting = { ...envelope(create, { transportSequence: 'different' }), captureEnvelopeId: original.captureEnvelopeId }
  const client = new FakePrismaClient()
  const ingress = new PrismaRawCaptureIngress(client)
  await ingress.ingestEnvelope(original)
  await assert.rejects(
    ingress.ingestEnvelope(conflicting),
    (error: unknown) => error instanceof CaptureError && error.code === 'CAPTURE_ENVELOPE_ID_COLLISION',
  )
  assert.equal(client.rawRows().length, 1)
  assert.deepEqual(ingress.getCaptureHealth(), {
    ingressIdempotentRetryCount: 0,
    rejectedCount: 1,
    captureEnvelopeIdCollisionCount: 1,
  })
})

test('sanitization precedes spool, does not mutate input, and quarantines binary evidence', () => {
  const create = factory()
  const input = {
    kind: 'message',
    Authorization: 'Bearer synthetic-not-a-secret',
    Cookie: 'session=synthetic',
    signedUrl: 'https://example.invalid/file?signature=synthetic-signature&safe=1',
    nested: { text: 'keep' },
  }
  const before = structuredClone(input)
  const sanitized = envelope(create, { payload: input })
  assert.deepEqual(input, before)
  const stored = JSON.stringify(sanitized)
  assert.doesNotMatch(stored, /synthetic-not-a-secret|session=synthetic|synthetic-signature/)
  assert.match(stored, /REDACTED/)
  const binary = envelope(create, { payload: Buffer.from('credential-like-bytes'), payloadEncoding: 'msgpack_sanitized_json' })
  assert.equal(binary.replayAvailability, 'quarantined')
  assert.equal(binary.quarantineReason, 'binary_payload_not_persisted')
  assert.doesNotMatch(JSON.stringify(binary), /credential-like-bytes/)
})

test('durable segmented spool survives restart, preserves order, ACKs contiguously, and compacts only ACKed data', () => {
  const directory = temp('restart')
  const create = factory()
  let spool = new SegmentedFileCaptureSpool({ directory, maxSegmentBytes: 1800 })
  for (let index = 0; index < 20; index += 1) spool.appendToSpool(envelope(create, { transportSequence: String(index) }))
  assert.deepEqual(spool.readPending(100).map(record => record.sequence), Array.from({ length: 20 }, (_, index) => index + 1))
  spool.close()
  spool = new SegmentedFileCaptureSpool({ directory, maxSegmentBytes: 1800 })
  assert.equal(spool.readPending(100).length, 20)
  for (let sequence = 1; sequence <= 10; sequence += 1) spool.markAcknowledged(sequence)
  assert.deepEqual(spool.readPending(100).map(record => record.sequence), Array.from({ length: 10 }, (_, index) => index + 11))
  assert.ok(spool.compactAcknowledged() >= 1)
  const restarted = new SegmentedFileCaptureSpool({ directory, maxSegmentBytes: 1800 })
  assert.deepEqual(restarted.readPending(100).map(record => record.sequence), Array.from({ length: 10 }, (_, index) => index + 11))
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  for (const name of readdirSync(directory).filter(name => name.endsWith('.jsonl') || name === 'ack.watermark')) {
    assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600)
  }
})

test('corrupt tail is detected, segment quarantined, and valid prefix remains recoverable', () => {
  const directory = temp('corrupt')
  const spool = new SegmentedFileCaptureSpool({ directory })
  spool.appendToSpool(envelope())
  const segment = readdirSync(directory).find(name => name.endsWith('.jsonl'))
  assert.ok(segment)
  appendFileSync(join(directory, segment), '{partial', 'utf8')
  const recovered = new SegmentedFileCaptureSpool({ directory })
  assert.equal(recovered.readPending(10).length, 1)
  assert.equal(recovered.getCaptureHealth().adapterState, 'critical')
  assert.equal(readdirSync(join(directory, 'quarantine')).length, 1)
})

test('bounded spool reports honest critical loss while caller can continue', () => {
  const directory = temp('full')
  const spool = new SegmentedFileCaptureSpool({ directory, maxTotalBytes: 2500, maxRecordBytes: 10_000 })
  let continued = false
  assert.throws(() => {
    for (let index = 0; index < 10; index += 1) spool.appendToSpool(envelope(factory(), { payload: { body: 'x'.repeat(700) } }))
  }, (error: unknown) => error instanceof CaptureError && error.code === 'SPOOL_FULL')
  continued = true
  assert.equal(continued, true)
  assert.equal(spool.getCaptureHealth().adapterState, 'critical')
  assert.equal(spool.getCaptureHealth().lostBeforeSpoolCount, 1)
})

test('1000 scheduled appends are deterministic and uncorrupted', async () => {
  const directory = temp('concurrent')
  const create = factory()
  const spool = new SegmentedFileCaptureSpool({ directory, maxTotalBytes: 64 * 1024 * 1024 })
  await Promise.all(Array.from({ length: 1000 }, (_, index) => Promise.resolve().then(() => {
    spool.appendToSpool(envelope(create, { transportSequence: String(index) }))
  })))
  const records = spool.readPending(1000)
  assert.equal(records.length, 1000)
  assert.equal(new Set(records.map(record => record.envelope.captureEnvelopeId)).size, 1000)
  assert.deepEqual(records.map(record => record.sequence), Array.from({ length: 1000 }, (_, index) => index + 1))
  assert.equal(new SegmentedFileCaptureSpool({ directory }).readPending(1000).length, 1000)
})

test('drain is batch/concurrency bounded, retries without ACK, recovers in order, and handles idempotent duplicate responses', async () => {
  const directory = temp('drain')
  const create = factory()
  const spool = new SegmentedFileCaptureSpool({ directory })
  for (let index = 0; index < 12; index += 1) spool.appendToSpool(envelope(create, { transportSequence: String(index) }))
  const ingested = new Map<string, string>()
  let unavailable = true
  let active = 0
  let maximumActive = 0
  const ingress: RawCaptureIngress = {
    async ingestEnvelope(value) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      try {
        await Promise.resolve()
        if (unavailable) throw new Error('synthetic outage')
        const existing = ingested.get(value.captureEnvelopeId)
        if (existing !== undefined) return { observationId: existing, created: false }
        const observationId = `observation-${ingested.size + 1}`
        ingested.set(value.captureEnvelopeId, observationId)
        return { observationId, created: true }
      } finally { active -= 1 }
    },
    getCaptureHealth: () => ({ ingressIdempotentRetryCount: 0, rejectedCount: 0, captureEnvelopeIdCollisionCount: 0 }),
  }
  const worker = new CaptureDrainWorker(spool, ingress, {
    batchSize: 5, maxConcurrency: 2, initialRetryDelayMs: 10, maximumRetryDelayMs: 80, jitterRatio: 0,
  })
  const failed = await worker.drainOnce()
  assert.deepEqual(failed, { attempted: 5, acknowledged: 0, retained: 5, nextDelayMs: 10 })
  assert.equal(spool.readPending(100).length, 12)
  assert.equal(spool.getCaptureHealth().adapterState, 'degraded')
  unavailable = false
  while (spool.readPending(1).length > 0) await worker.drainOnce()
  assert.equal(maximumActive, 2)
  assert.equal(ingested.size, 12)
  assert.equal(spool.readPending(100).length, 0)
  assert.equal(spool.getCaptureHealth().adapterState, 'healthy')
})

test('retry storm preserves 100 raw rows across 2500 transport attempts', async () => {
  const create = factory()
  const client = new FakePrismaClient()
  const ingress = new PrismaRawCaptureIngress(client)
  const values = Array.from({ length: 100 }, () => envelope(create))
  for (const value of values) for (let retry = 0; retry < 25; retry += 1) await ingress.ingestEnvelope(value)
  assert.equal(client.rawRows().length, 100)
  assert.equal(ingress.getCaptureHealth().ingressIdempotentRetryCount, 2400)
})

test('A/B interleave preserves 500 rows per account with no wrong-account row', async () => {
  const create = factory()
  const client = new FakePrismaClient()
  const ingress = new PrismaRawCaptureIngress(client)
  for (let index = 0; index < 500; index += 1) {
    await ingress.ingestEnvelope(envelope(create, { accountId: 'account-a', transportSequence: String(index) }))
    await ingress.ingestEnvelope(envelope(create, { accountId: 'account-b', transportSequence: String(index) }))
  }
  assert.equal(client.rawRows().filter(row => row.accountId === 'account-a').length, 500)
  assert.equal(client.rawRows().filter(row => row.accountId === 'account-b').length, 500)
})

test('spool files contain sanitized envelopes only', () => {
  const directory = temp('secret-scan')
  const spool = new SegmentedFileCaptureSpool({ directory })
  spool.appendToSpool(envelope(factory(), { payload: { Authorization: 'Bearer forbidden-value', text: 'safe' } }))
  const contents = readdirSync(directory).filter(name => name.endsWith('.jsonl'))
    .map(name => readFileSync(join(directory, name), 'utf8')).join('')
  assert.doesNotMatch(contents, /forbidden-value/)
  assert.match(contents, /REDACTED/)
})
