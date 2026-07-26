import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../src/inbound/constants.ts'
import { InboundNormalizationError } from '../src/inbound/errors.ts'
import { MaxInboundNormalizer } from '../src/inbound/MaxInboundNormalizer.ts'
import { PrismaShadowInboundNormalizationProcessor } from '../src/inbound/PrismaShadowInboundNormalizationProcessor.ts'
import { PrismaRawEventJournal } from '../src/journal/PrismaRawEventJournal.ts'
import type { JsonValue, SanitizedObservationInput } from '../src/journal/types.ts'
import { FakePrismaClient } from './support/FakePrisma.ts'

const now = new Date('2026-07-26T12:00:00.000Z')

function ids(prefix: string): () => string {
  let value = 0
  return () => `${prefix}-${++value}`
}

function observation(
  accountId: string,
  payload: JsonValue,
  historyLive: 'history' | 'live' | 'unknown' = 'live',
): SanitizedObservationInput {
  return {
    accountId,
    observedAt: now,
    sourceTransport: 'max_synthetic_fixture',
    sourceOrigin: 'protocol',
    historyLive,
    payloadEncoding: 'json',
    sanitizedPayload: payload,
    payloadSha256: 'b'.repeat(64),
    payloadSizeBytes: 1,
    replayAvailability: 'available',
    sanitizerVersion: 'test-sanitizer-v1',
    captureAdapterVersion: 'test-capture-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'test-sanitizer-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
  }
}

function harness() {
  const client = new FakePrismaClient()
  const journal = new PrismaRawEventJournal(client, { idGenerator: ids('journal') })
  const processor = new PrismaShadowInboundNormalizationProcessor(
    client,
    journal,
    new MaxInboundNormalizer(),
    { idGenerator: ids('inbound'), clock: () => now },
  )
  return { client, journal, processor }
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof InboundNormalizationError && error.code === code)
}

test('same observation/parser is idempotent while a new parser version creates independent result/events', async () => {
  const { client, journal, processor } = harness()
  const observationId = await journal.append(observation('account-a', { kind: 'message', providerMessageId: 'provider-1', text: 'hello' }))
  const first = await processor.normalizeObservation({ accountId: 'account-a', observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  const repeated = await processor.normalizeObservation({ accountId: 'account-a', observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-b', now })
  const parserB = await processor.normalizeObservation({ accountId: 'account-a', observationId, parserVersion: 'max-inbound-normalizer-v2', workerId: 'worker-b', now })
  assert.equal(first.idempotent, false)
  assert.equal(repeated.idempotent, true)
  assert.equal(repeated.result.normalizationResultId, first.result.normalizationResultId)
  assert.notEqual(parserB.result.normalizationResultId, first.result.normalizationResultId)
  assert.equal(client.normalizationResultRows().length, 2)
  assert.equal(client.normalizedEventRows().length, 2)
})
test('byte-identical physical observations and same provider/semantic identity remain distinct', async () => {
  const { client, journal, processor } = harness()
  const payload = { kind: 'message', providerMessageId: 'provider-same', text: 'identical' } as const
  const firstId = await journal.append(observation('account-a', payload))
  const secondId = await journal.append(observation('account-a', payload))
  const first = await processor.normalizeObservation({ accountId: 'account-a', observationId: firstId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  const second = await processor.normalizeObservation({ accountId: 'account-a', observationId: secondId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  assert.notEqual(first.result.normalizationResultId, second.result.normalizationResultId)
  assert.equal(first.events[0]?.semanticSha256, second.events[0]?.semanticSha256)
  assert.equal(client.normalizationResultRows().length, 2)
  assert.equal(client.normalizedEventRows().filter(row => row.providerMessageId === 'provider-same').length, 2)
})

test('history/live overlap preserves two normalization rows and event sets', async () => {
  const { client, journal, processor } = harness()
  const payload = { kind: 'message', providerMessageId: 'overlap-1', text: 'same' } as const
  const historyId = await journal.append(observation('account-a', payload, 'history'))
  const liveId = await journal.append(observation('account-a', payload, 'live'))
  const history = await processor.normalizeObservation({ accountId: 'account-a', observationId: historyId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  const live = await processor.normalizeObservation({ accountId: 'account-a', observationId: liveId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  assert.equal(history.events[0]?.origin, 'history')
  assert.equal(live.events[0]?.origin, 'live')
  assert.equal(client.normalizationResultRows().length, 2)
  assert.equal(client.normalizedEventRows().length, 2)
})

test('multi-event ordinals and readNormalizedAfter order/limit are deterministic', async () => {
  const { journal, processor } = harness()
  const firstId = await journal.append(observation('account-a', {
    kind: 'message', text: 'one', routeEvidence: [
      { identityKind: 'provider_user_id', identityValue: 'user-1' },
      { identityKind: 'protocol_chat_id', identityValue: 'chat-1' },
    ],
  }))
  const secondId = await journal.append(observation('account-a', { kind: 'message', text: 'two' }))
  const first = await processor.normalizeObservation({ accountId: 'account-a', observationId: firstId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  await processor.normalizeObservation({ accountId: 'account-a', observationId: secondId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  assert.deepEqual(first.events.map(event => event.eventOrdinal), [0, 1, 2])
  const page1 = await processor.readNormalizedAfter('account-a', MAX_INBOUND_NORMALIZER_VERSION, { sourceJournalSequence: 0n, eventOrdinal: -1 }, 2)
  const page2 = await processor.readNormalizedAfter('account-a', MAX_INBOUND_NORMALIZER_VERSION, page1.nextCursor, 2)
  assert.equal(page1.events.length, 2)
  assert.equal(page2.events.length, 2)
  assert.deepEqual([...page1.events, ...page2.events].map(event => [event.sourceJournalSequence, event.eventOrdinal]), [
    [1n, 0], [1n, 1], [1n, 2], [2n, 0],
  ])
})

test('batch cursor advances only after terminal durable outcomes and survives processor restart', async () => {
  const { client, journal, processor } = harness()
  await journal.append(observation('account-a', { kind: 'future_opcode' }))
  await journal.append(observation('account-a', { kind: 'message', attachments: { malformed: true } }))
  await journal.append(observation('account-a', { kind: 'message', text: 'after malformed' }))
  const batch = await processor.normalizeBatch({
    accountId: 'account-a', consumerId: 'normalizer', parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', limit: 3,
  })
  assert.deepEqual(batch, { processed: 3, normalized: 1, unsupported: 1, quarantined: 1, idempotent: 0, lastJournalSequence: 3n })
  const restarted = new PrismaShadowInboundNormalizationProcessor(client, journal, new MaxInboundNormalizer(), { idGenerator: ids('restart'), clock: () => now })
  const empty = await restarted.normalizeBatch({
    accountId: 'account-a', consumerId: 'normalizer', parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-b', limit: 3,
  })
  assert.equal(empty.processed, 0)
  assert.equal((await journal.getCursor('normalizer', 'account-a', MAX_INBOUND_NORMALIZER_VERSION))?.lastJournalSequence, 3n)
})

test('event insert failure rolls back result and all events, does not advance cursor, and retry succeeds', async () => {
  const { client, journal, processor } = harness()
  const observationId = await journal.append(observation('account-a', {
    kind: 'message', text: 'multi', routeEvidence: [{ identityKind: 'provider_user_id', identityValue: 'user-a' }],
  }))
  client.failNormalizedEventCreateAt(2)
  await rejectsCode(processor.normalizeBatch({
    accountId: 'account-a', consumerId: 'normalizer', parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', limit: 1,
  }), 'DATABASE_FAILURE')
  assert.equal(client.normalizationResultRows().length, 0)
  assert.equal(client.normalizedEventRows().length, 0)
  assert.equal(await journal.getCursor('normalizer', 'account-a', MAX_INBOUND_NORMALIZER_VERSION), null)
  client.clearFailures()
  const retried = await processor.normalizeObservation({ accountId: 'account-a', observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  assert.equal(retried.events.length, 2)
  assert.equal(client.normalizationResultRows().length, 1)
  assert.equal(client.normalizedEventRows().length, 2)
})

test('result insert and processing terminal failures leave no partial normalization rows', async () => {
  const first = harness()
  const firstId = await first.journal.append(observation('account-a', { kind: 'message', text: 'first' }))
  first.client.failNextNormalizationResultCreate()
  await rejectsCode(first.processor.normalizeObservation({ accountId: 'account-a', observationId: firstId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now }), 'DATABASE_FAILURE')
  assert.equal(first.client.normalizationResultRows().length, 0)
  assert.equal(first.client.normalizedEventRows().length, 0)

  const second = harness()
  const secondId = await second.journal.append(observation('account-a', { kind: 'message', text: 'second' }))
  second.client.failNextTerminalProcessingUpdate()
  await rejectsCode(second.processor.normalizeObservation({ accountId: 'account-a', observationId: secondId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now }), 'DATABASE_FAILURE')
  assert.equal(second.client.normalizationResultRows().length, 0)
  assert.equal(second.client.normalizedEventRows().length, 0)
})

test('account isolation prevents cross-account normalize/read/cursor effects with identical provider IDs', async () => {
  const { journal, processor } = harness()
  const idA = await journal.append(observation('account-a', { kind: 'message', providerMessageId: 'shared', text: 'A' }))
  const idB = await journal.append(observation('account-b', { kind: 'message', providerMessageId: 'shared', text: 'B' }))
  await rejectsCode(processor.normalizeObservation({ accountId: 'account-a', observationId: idB, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now }), 'ACCOUNT_MISMATCH')
  await processor.normalizeObservation({ accountId: 'account-a', observationId: idA, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', now })
  await processor.normalizeObservation({ accountId: 'account-b', observationId: idB, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-b', now })
  assert.equal((await processor.readNormalizedAfter('account-a', MAX_INBOUND_NORMALIZER_VERSION, { sourceJournalSequence: 0n, eventOrdinal: -1 }, 10)).events.length, 1)
  assert.equal((await processor.readNormalizedAfter('account-b', MAX_INBOUND_NORMALIZER_VERSION, { sourceJournalSequence: 0n, eventOrdinal: -1 }, 10)).events.length, 1)
  assert.equal(await processor.getNormalizationResult('account-a', idB, MAX_INBOUND_NORMALIZER_VERSION), null)
})

test('a retryable failure in account A does not block account B', async () => {
  const { client, journal, processor } = harness()
  await journal.append(observation('account-a', { kind: 'message', text: 'A' }))
  const idB = await journal.append(observation('account-b', { kind: 'message', text: 'B' }))
  client.failNextNormalizationResultCreate()
  await rejectsCode(processor.normalizeBatch({ accountId: 'account-a', consumerId: 'normalizer', parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-a', limit: 1 }), 'DATABASE_FAILURE')
  client.clearFailures()
  const resultB = await processor.normalizeObservation({ accountId: 'account-b', observationId: idB, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-b', now })
  assert.equal(resultB.result.status, 'normalized')
})
