import assert from 'node:assert/strict'
import test from 'node:test'
import { JournalError } from '../src/journal/errors.ts'
import { PrismaRawEventJournal } from '../src/journal/PrismaRawEventJournal.ts'
import { sanitizeRawObservationPayload } from '../src/journal/sanitizer.ts'
import type { SanitizedObservationInput } from '../src/journal/types.ts'
import { FakePrismaClient } from './support/FakePrisma.ts'

function ids(prefix = 'id'): () => string {
  let value = 0
  return () => `${prefix}-${++value}`
}

function observation(accountId: string, payload: unknown = { text: 'same' }, overrides: Partial<SanitizedObservationInput> = {}): SanitizedObservationInput {
  const sanitized = sanitizeRawObservationPayload(payload)
  return {
    accountId,
    observedAt: new Date('2026-07-26T10:00:00.000Z'),
    sourceTransport: 'max-websocket',
    sourceOrigin: 'physical-frame',
    historyLive: 'live',
    socketGeneration: 'socket-1',
    frameId: 'frame-same',
    providerEventId: 'provider-event-same',
    transportSequence: '42',
    opcode: 128,
    eventType: 'message-observed',
    payloadEncoding: 'msgpack_sanitized_json',
    sanitizedPayload: sanitized.sanitizedPayload,
    payloadSha256: sanitized.payloadSha256,
    payloadSizeBytes: sanitized.payloadSizeBytes,
    replayAvailability: sanitized.replayAvailability,
    quarantineReason: sanitized.quarantineReason,
    sanitizerVersion: sanitized.sanitizerVersion,
    captureAdapterVersion: 'capture-v1',
    schemaVersion: 1,
    redactionMetadata: sanitized.redactionMetadata,
    quarantineEligible: true,
    parserVersion: 'parser-a',
    ...overrides,
  }
}

test('identical physical observations retain distinct IDs and journal positions', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const input = observation('account-a')

  const firstId = await journal.append(input)
  const secondId = await journal.append(input)
  const page = await journal.readAfter('account-a', 0n, 10)

  assert.notEqual(firstId, secondId)
  assert.deepEqual(page.observations.map(item => item.observationId), [firstId, secondId])
  assert.deepEqual(page.observations.map(item => item.journalSequence), [1n, 2n])
  assert.equal(page.observations[0]?.providerEventId, page.observations[1]?.providerEventId)
  assert.equal(page.observations[0]?.payloadSha256, page.observations[1]?.payloadSha256)
})

test('history and live copies remain distinct physical observations', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  await journal.append(observation('account-a', { text: 'overlap' }, { historyLive: 'history' }))
  await journal.append(observation('account-a', { text: 'overlap' }, { historyLive: 'live' }))

  const page = await journal.readAfter('account-a', 0n, 10)
  assert.deepEqual(page.observations.map(item => item.historyLive), ['history', 'live'])
  assert.equal(page.observations.length, 2)
})

test('reads, processing, and correlation evidence are account isolated', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const accountAId = await journal.append(observation('account-a'))
  await journal.append(observation('account-b'))

  assert.equal((await journal.readAfter('account-a', 0n, 10)).observations.length, 1)
  assert.equal((await journal.readAfter('account-b', 0n, 10)).observations.length, 1)
  assert.equal(await journal.getProcessingState('account-b', accountAId, 'parser-a'), null)
  await assert.rejects(
    journal.claimProcessing({
      accountId: 'account-b', observationId: accountAId, parserVersion: 'parser-a', workerId: 'worker-b',
      now: new Date('2026-07-26T10:01:00Z'), leaseUntil: new Date('2026-07-26T10:02:00Z'),
    }),
    (error: unknown) => error instanceof JournalError && error.code === 'ACCOUNT_MISMATCH',
  )

  const claimed = await journal.claimProcessing({
    accountId: 'account-a', observationId: accountAId, parserVersion: 'parser-a', workerId: 'worker-a',
    now: new Date('2026-07-26T10:01:00Z'), leaseUntil: new Date('2026-07-26T10:02:00Z'),
  })
  await assert.rejects(
    journal.markProcessingState({
      accountId: 'account-b', observationId: accountAId, parserVersion: 'parser-a', workerId: 'worker-a',
      expectedLeaseVersion: claimed.leaseVersion, state: 'completed',
    }),
    (error: unknown) => error instanceof JournalError && error.code === 'STALE_WORKER',
  )
  assert.equal((await journal.getProcessingState('account-a', accountAId, 'parser-a'))?.state, 'processing')
})

test('readAfter is deterministic, bounded, and never skips the next position', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  for (let index = 0; index < 5; index += 1) await journal.append(observation('account-a', { index }))

  const first = await journal.readAfter('account-a', 0n, 2)
  const second = await journal.readAfter('account-a', first.nextCursor, 2)
  const third = await journal.readAfter('account-a', second.nextCursor, 2)
  assert.deepEqual(first.observations.map(item => item.journalSequence), [1n, 2n])
  assert.deepEqual(second.observations.map(item => item.journalSequence), [3n, 4n])
  assert.deepEqual(third.observations.map(item => item.journalSequence), [5n])
  assert.equal((await journal.readAfter('account-a', third.nextCursor, 2)).observations.length, 0)
})

test('durable cursor resumes after restart and isolates consumer/account/parser', async () => {
  const client = new FakePrismaClient()
  const firstProcess = new PrismaRawEventJournal(client, { idGenerator: ids('first') })
  const cursor = await firstProcess.advanceCursor({
    consumerId: 'normalizer', accountId: 'account-a', parserVersion: 'parser-a',
    lastJournalSequence: 7n, expectedVersion: 0,
  })
  const secondProcess = new PrismaRawEventJournal(client, { idGenerator: ids('second') })

  assert.equal((await secondProcess.getCursor('normalizer', 'account-a', 'parser-a'))?.lastJournalSequence, 7n)
  assert.equal(await secondProcess.getCursor('other', 'account-a', 'parser-a'), null)
  assert.equal(await secondProcess.getCursor('normalizer', 'account-b', 'parser-a'), null)
  assert.equal(await secondProcess.getCursor('normalizer', 'account-a', 'parser-b'), null)
  await assert.rejects(
    secondProcess.advanceCursor({
      consumerId: 'normalizer', accountId: 'account-a', parserVersion: 'parser-a',
      lastJournalSequence: 8n, expectedVersion: cursor.version - 1,
    }),
    (error: unknown) => error instanceof JournalError && error.code === 'CURSOR_CONFLICT',
  )

  const accountB = await secondProcess.advanceCursor({
    consumerId: 'normalizer', accountId: 'account-b', parserVersion: 'parser-a',
    lastJournalSequence: 3n, expectedVersion: 0,
  })
  assert.equal(accountB.lastJournalSequence, 3n)
  assert.equal((await secondProcess.getCursor('normalizer', 'account-a', 'parser-a'))?.lastJournalSequence, 7n)
  await assert.rejects(
    secondProcess.advanceCursor({
      consumerId: 'normalizer', accountId: 'account-a', parserVersion: 'parser-a',
      lastJournalSequence: 6n, expectedVersion: cursor.version,
    }),
    (error: unknown) => error instanceof JournalError && error.code === 'CURSOR_CONFLICT',
  )
})

test('processing insert failure rolls back raw observation atomically', async () => {
  const client = new FakePrismaClient()
  client.failNextProcessingCreate()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })

  await assert.rejects(journal.append(observation('account-a')), JournalError)
  assert.equal(client.rawRows().length, 0)
  assert.equal(client.processingRows().length, 0)
})

test('raw insert failure creates no processing orphan', async () => {
  const client = new FakePrismaClient()
  client.failNextRawCreate()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })

  await assert.rejects(journal.append(observation('account-a')), JournalError)
  assert.equal(client.rawRows().length, 0)
  assert.equal(client.processingRows().length, 0)
})

test('processing state is parser-versioned and repeated claim is predictable', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const observationId = await journal.append(observation('account-a'))
  const now = new Date('2026-07-26T10:01:00Z')
  const leaseUntil = new Date('2026-07-26T10:02:00Z')

  const parserA = await journal.claimProcessing({ accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-a', now, leaseUntil })
  const sameWorker = await journal.claimProcessing({ accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-a', now, leaseUntil })
  const parserB = await journal.claimProcessing({ accountId: 'account-a', observationId, parserVersion: 'parser-b', workerId: 'worker-b', now, leaseUntil })

  assert.equal(sameWorker.id, parserA.id)
  assert.equal(parserB.parserVersion, 'parser-b')
  assert.equal(client.processingRows().length, 2)
  await assert.rejects(
    journal.claimProcessing({ accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'late', now, leaseUntil }),
    (error: unknown) => error instanceof JournalError && error.code === 'CLAIM_CONFLICT',
  )
})

test('expired lease can be reclaimed and stale worker cannot overwrite it', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const observationId = await journal.append(observation('account-a'))
  const first = await journal.claimProcessing({
    accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-old',
    now: new Date('2026-07-26T10:00:00Z'), leaseUntil: new Date('2026-07-26T10:01:00Z'),
  })
  const replacement = await journal.claimProcessing({
    accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-new',
    now: new Date('2026-07-26T10:02:00Z'), leaseUntil: new Date('2026-07-26T10:03:00Z'),
  })
  assert.ok(replacement.leaseVersion > first.leaseVersion)
  await assert.rejects(
    journal.markProcessingState({
      accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-old',
      expectedLeaseVersion: first.leaseVersion, state: 'completed',
    }),
    (error: unknown) => error instanceof JournalError && error.code === 'STALE_WORKER',
  )
})

test('processing updates cannot mutate append-only raw payload or hash', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const observationId = await journal.append(observation('account-a', { immutable: true }))
  const before = client.rawRows()[0]
  assert.ok(before)
  const claimed = await journal.claimProcessing({
    accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-a',
    now: new Date('2026-07-26T10:00:00Z'), leaseUntil: new Date('2026-07-26T10:01:00Z'),
  })
  await journal.markProcessingState({
    accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-a',
    expectedLeaseVersion: claimed.leaseVersion, state: 'completed', completedAt: new Date('2026-07-26T10:00:30Z'),
  })
  const after = client.rawRows()[0]
  assert.deepEqual(after?.sanitizedPayload, before.sanitizedPayload)
  assert.equal(after?.payloadSha256, before.payloadSha256)
})

test('oversized sanitized payload becomes durable quarantine evidence without blocking the next observation', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids(), maxPayloadBytes: 256 })
  const oversized = observation('account-a', {
    body: 'x'.repeat(2048),
    Authorization: 'Bearer synthetic-oversized-secret',
  })

  const oversizedId = await journal.append(oversized)
  const normalId = await journal.append(observation('account-a', { body: 'next' }))
  const page = await journal.readAfter('account-a', 0n, 10)
  const quarantined = page.observations[0]

  assert.deepEqual(page.observations.map(item => item.observationId), [oversizedId, normalId])
  assert.deepEqual(page.observations.map(item => item.journalSequence), [1n, 2n])
  assert.equal(quarantined?.replayAvailability, 'quarantined')
  assert.equal(quarantined?.quarantineReason, 'sanitized_payload_too_large')
  assert.ok((quarantined?.payloadSizeBytes ?? 0) > 256)
  assert.equal(JSON.stringify(quarantined?.sanitizedPayload).includes('synthetic-oversized-secret'), false)
  assert.equal((await journal.getProcessingState('account-a', oversizedId, 'parser-a'))?.state, 'quarantined')
  assert.equal(page.observations[1]?.replayAvailability, 'available')
})

test('oversized quarantine insert remains atomic when initial processing insert fails', async () => {
  const client = new FakePrismaClient()
  client.failNextProcessingCreate()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids(), maxPayloadBytes: 32 })

  await assert.rejects(journal.append(observation('account-a', { body: 'x'.repeat(512) })), JournalError)
  assert.equal(client.rawRows().length, 0)
  assert.equal(client.processingRows().length, 0)
})

test('binary quarantine metadata is durable and starts quarantined processing', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const binary = observation('account-a', Buffer.from('synthetic-binary-secret'))

  const observationId = await journal.append(binary)
  const stored = (await journal.readAfter('account-a', 0n, 10)).observations[0]

  assert.equal(stored?.replayAvailability, 'quarantined')
  assert.equal(stored?.quarantineReason, 'binary_payload_not_persisted')
  assert.equal(JSON.stringify(stored?.sanitizedPayload).includes('synthetic-binary-secret'), false)
  assert.equal((await journal.getProcessingState('account-a', observationId, 'parser-a'))?.state, 'quarantined')
})

test('invalid processing state is rejected before persistence', async () => {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids() })
  const observationId = await journal.append(observation('account-a'))
  const claimed = await journal.claimProcessing({
    accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-a',
    now: new Date('2026-07-26T10:00:00Z'), leaseUntil: new Date('2026-07-26T10:01:00Z'),
  })

  await assert.rejects(
    journal.markProcessingState({
      accountId: 'account-a', observationId, parserVersion: 'parser-a', workerId: 'worker-a',
      expectedLeaseVersion: claimed.leaseVersion,
      state: 'invented' as never,
    }),
    (error: unknown) => error instanceof JournalError && error.code === 'INVALID_INPUT',
  )
  assert.equal((await journal.getProcessingState('account-a', observationId, 'parser-a'))?.state, 'processing')
})
