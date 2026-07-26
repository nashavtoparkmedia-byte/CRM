import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../../src/inbound/constants.ts'
import { MaxInboundNormalizer } from '../../src/inbound/MaxInboundNormalizer.ts'
import { PrismaShadowInboundNormalizationProcessor } from '../../src/inbound/PrismaShadowInboundNormalizationProcessor.ts'
import type { InboundNormalizer, NormalizationOutcome } from '../../src/inbound/types.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import type { JsonValue, SanitizedObservationInput } from '../../src/journal/types.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()
const now = new Date('2026-07-26T21:30:00.000Z')

function observation(
  accountId: string,
  payload: JsonValue,
  historyLive: 'history' | 'live' | 'unknown' = 'live',
  parserVersion = MAX_INBOUND_NORMALIZER_VERSION,
): SanitizedObservationInput {
  return {
    accountId,
    observedAt: now,
    sourceTransport: 'max_synthetic_fixture',
    sourceOrigin: 'stage3-real-postgres',
    historyLive,
    payloadEncoding: 'json',
    sanitizedPayload: payload,
    payloadSha256: 'c'.repeat(64),
    payloadSizeBytes: 1,
    replayAvailability: 'available',
    sanitizerVersion: 'stage3-sanitizer-v1',
    captureAdapterVersion: 'stage3-capture-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'stage3-sanitizer-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion,
  }
}

if (config === null) {
  test('real PostgreSQL inbound gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 3 real PostgreSQL inbound normalization semantics', { concurrency: false }, () => {
    let client: RealPrismaClient
    let journal: PrismaRawEventJournal
    let processor: PrismaShadowInboundNormalizationProcessor

    before(async () => {
      client = await createRealPrismaClient(config)
      journal = new PrismaRawEventJournal(client as any)
      processor = new PrismaShadowInboundNormalizationProcessor(client as any, journal, new MaxInboundNormalizer())
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S3-DB-01..08 commits result/events, idempotency, parser replay, physical duplicates, and history/live overlap', async () => {
      const account = runId('s3_durable')
      const payload = { kind: 'message', direction: 'inbound', providerMessageId: 'same-provider-message', text: 'identical' } as const
      const firstId = await journal.append(observation(account, payload, 'history'))
      const secondId = await journal.append(observation(account, payload, 'live'))
      const first = await processor.normalizeObservation({ accountId: account, observationId: firstId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-1' })
      const repeated = await processor.normalizeObservation({ accountId: account, observationId: firstId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-2' })
      const parserB = await processor.normalizeObservation({ accountId: account, observationId: firstId, parserVersion: 'max-inbound-normalizer-v2', workerId: 'worker-2' })
      const second = await processor.normalizeObservation({ accountId: account, observationId: secondId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'worker-2' })
      assert.equal(first.idempotent, false)
      assert.equal(repeated.idempotent, true)
      assert.equal(repeated.result.normalizationResultId, first.result.normalizationResultId)
      assert.notEqual(parserB.result.normalizationResultId, first.result.normalizationResultId)
      assert.notEqual(second.result.normalizationResultId, first.result.normalizationResultId)
      assert.equal(first.events[0]?.origin, 'history')
      assert.equal(second.events[0]?.origin, 'live')
      assert.equal(await client.maxInboundNormalizationResult.count({ where: { accountId: account } }), 3)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, providerMessageId: 'same-provider-message' } }), 3)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, semanticSha256: first.events[0]?.semanticSha256 } }), 2)
    })

    test('S3-DB-09..13 persists deterministic multi-event order, account scope, and nonunique provider/hash correlation', async () => {
      const accountA = runId('s3_order_a')
      const accountB = runId('s3_order_b')
      const payload: JsonValue = {
        kind: 'message', providerMessageId: 'shared-external-id', text: 'ordered',
        routeEvidence: [
          { identityKind: 'provider_user_id', identityValue: 'user-shared' },
          { identityKind: 'protocol_chat_id', identityValue: 'chat-shared' },
        ],
      }
      const idA1 = await journal.append(observation(accountA, payload))
      const idA2 = await journal.append(observation(accountA, payload))
      const idB = await journal.append(observation(accountB, payload))
      await processor.normalizeObservation({ accountId: accountA, observationId: idA1, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'a1' })
      await processor.normalizeObservation({ accountId: accountA, observationId: idA2, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'a2' })
      await processor.normalizeObservation({ accountId: accountB, observationId: idB, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'b' })
      const page = await processor.readNormalizedAfter(accountA, MAX_INBOUND_NORMALIZER_VERSION, { sourceJournalSequence: 0n, eventOrdinal: -1 }, 20)
      assert.equal(page.events.length, 6)
      assert.deepEqual(page.events.map(event => event.eventOrdinal), [0, 1, 2, 0, 1, 2])
      assert.equal(page.events.every((event, index, events) => index === 0
        || event.sourceJournalSequence > events[index - 1]!.sourceJournalSequence
        || (event.sourceJournalSequence === events[index - 1]!.sourceJournalSequence && event.eventOrdinal > events[index - 1]!.eventOrdinal)), true)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: accountA, providerMessageId: 'shared-external-id' } }), 2)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: accountB, providerMessageId: 'shared-external-id' } }), 1)
      await assert.rejects(client.maxInboundNormalizedEvent.create({
        data: {
          normalizedEventId: runId('cross_event'), normalizationResultId: page.events[0]!.normalizationResultId,
          accountId: accountB, sourceObservationId: idB, sourceJournalSequence: page.events[0]!.sourceJournalSequence,
          parserVersion: MAX_INBOUND_NORMALIZER_VERSION, envelopeVersion: 'max-normalized-envelope-v1', eventOrdinal: 99,
          eventKind: 'message', direction: 'inbound', origin: 'live', normalizedPayload: {}, semanticSha256: 'd'.repeat(64),
        },
      }))
    })

    test('S3-DB-14..18 append-only result/events reject UPDATE, DELETE, and custom GUC bypass while processing remains mutable', async () => {
      const account = runId('s3_immutable')
      const id = await journal.append(observation(account, { kind: 'message', text: 'immutable' }))
      const stored = await processor.normalizeObservation({ accountId: account, observationId: id, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'immutable' })
      const resultId = stored.result.normalizationResultId
      const eventId = stored.events[0]!.normalizedEventId
      await assert.rejects(client.$executeRawUnsafe(`UPDATE "MaxInboundNormalizationResult" SET "eventCount" = 99 WHERE "normalizationResultId" = $1`, resultId))
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM "MaxInboundNormalizationResult" WHERE "normalizationResultId" = $1`, resultId))
      await assert.rejects(client.$executeRawUnsafe(`UPDATE "MaxInboundNormalizedEvent" SET "eventOrdinal" = 9 WHERE "normalizedEventId" = $1`, eventId))
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM "MaxInboundNormalizedEvent" WHERE "normalizedEventId" = $1`, eventId))
      await assert.rejects(client.$transaction(async transaction => {
        await transaction.$executeRawUnsafe(`SET LOCAL max_personal.allow_normalization_retention = 'on'`)
        await transaction.$executeRawUnsafe(`DELETE FROM "MaxInboundNormalizedEvent" WHERE "normalizedEventId" = $1`, eventId)
      }))
      const processing = await client.maxRawTransportProcessing.findUniqueOrThrow({
        where: { observationId_parserVersion: { observationId: id, parserVersion: MAX_INBOUND_NORMALIZER_VERSION } },
      })
      await client.maxRawTransportProcessing.update({ where: { id: processing.id }, data: { lastErrorSummary: 'mutable processing audit' } })
      assert.equal((await client.maxRawTransportProcessing.findUniqueOrThrow({ where: { id: processing.id } })).lastErrorSummary, 'mutable processing audit')
    })

    test('S3-DB-19..22 processor transaction rolls back invalid event and stale processing terminal update without partial rows', async () => {
      const account = runId('s3_rollback')
      const invalidId = await journal.append(observation(account, { kind: 'message', text: 'invalid event' }))
      const normalOutcome = new MaxInboundNormalizer().normalizeRawObservation({
        accountId: account, observationId: invalidId, journalSequence: 1n, observedAt: now,
        sourceTransport: 'max_synthetic_fixture', sourceOrigin: 'test', historyLive: 'live', payloadEncoding: 'json',
        sanitizedPayload: { kind: 'message', text: 'invalid event' }, payloadSha256: 'e'.repeat(64),
        captureAdapterVersion: 'v1', parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
      })
      const invalidNormalizer: InboundNormalizer = {
        normalizeRawObservation(): NormalizationOutcome {
          return { ...normalOutcome, events: normalOutcome.events.map(event => ({ ...event, semanticSha256: 'invalid' })) }
        },
      }
      const invalidProcessor = new PrismaShadowInboundNormalizationProcessor(client as any, journal, invalidNormalizer)
      await assert.rejects(invalidProcessor.normalizeObservation({ accountId: account, observationId: invalidId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'invalid' }))
      assert.equal(await client.maxInboundNormalizationResult.count({ where: { accountId: account, sourceObservationId: invalidId } }), 0)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, sourceObservationId: invalidId } }), 0)

      const staleId = await journal.append(observation(account, { kind: 'message', text: 'stale processing' }))
      const staleJournal = Object.create(journal) as PrismaRawEventJournal
      staleJournal.claimProcessing = async claim => {
        const result = await journal.claimProcessing(claim)
        return { ...result, leaseVersion: result.leaseVersion + 100 }
      }
      const staleProcessor = new PrismaShadowInboundNormalizationProcessor(client as any, staleJournal, new MaxInboundNormalizer())
      await assert.rejects(staleProcessor.normalizeObservation({ accountId: account, observationId: staleId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'stale' }))
      assert.equal(await client.maxInboundNormalizationResult.count({ where: { accountId: account, sourceObservationId: staleId } }), 0)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, sourceObservationId: staleId } }), 0)
    })

    test('S3-DB-23..30 terminal unknown/quarantine advance cursor, restart persists, signed URL is absent, and partial attachment keeps text', async () => {
      const account = runId('s3_batch')
      await journal.append(observation(account, { kind: 'future_opcode', bearer: 'must-not-persist-normalized' }))
      await journal.append(observation(account, { kind: 'message', attachments: { malformed: true } }))
      await journal.append(observation(account, {
        kind: 'message', text: 'text survives', attachments: [
          { providerAttachmentId: 'good', mimeHint: 'image/jpeg' },
          { providerAttachmentId: ' bad ', mimeHint: 'audio/ogg', signedUrl: `https://provider.invalid/x?token=${['signed', 'synthetic'].join('-')}` },
        ],
      }))
      const batch = await processor.normalizeBatch({
        accountId: account, consumerId: 'stage3-shadow', parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'batch', limit: 3,
      })
      assert.deepEqual({ processed: batch.processed, normalized: batch.normalized, unsupported: batch.unsupported, quarantined: batch.quarantined },
        { processed: 3, normalized: 1, unsupported: 1, quarantined: 1 })
      const cursor = await journal.getCursor('stage3-shadow', account, MAX_INBOUND_NORMALIZER_VERSION)
      assert.equal(cursor?.lastJournalSequence, batch.lastJournalSequence)
      const persisted = await client.maxInboundNormalizedEvent.findMany({ where: { accountId: account } })
      assert.doesNotMatch(JSON.stringify(persisted, (_key, value) => typeof value === 'bigint' ? value.toString() : value), /signed-synthetic|must-not-persist-normalized/)
      const message = persisted.find((row: any) => row.eventKind === 'message')
      assert.equal(message.normalizedPayload.text, 'text survives')
      assert.equal(message.normalizedPayload.attachments.length, 2)
      const restartedClient = await createRealPrismaClient(config)
      try {
        const restartedJournal = new PrismaRawEventJournal(restartedClient as any)
        const restartedProcessor = new PrismaShadowInboundNormalizationProcessor(restartedClient as any, restartedJournal, new MaxInboundNormalizer())
        const empty = await restartedProcessor.normalizeBatch({
          accountId: account, consumerId: 'stage3-shadow', parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'restart', limit: 3,
        })
        assert.equal(empty.processed, 0)
      } finally {
        await restartedClient.$disconnect()
      }
    })

    test('S3-DB-31..38 reply, reactions, receipts, route evidence, and feature flag have honest durable semantics', async () => {
      const account = runId('s3_semantics')
      const payloads: JsonValue[] = [
        { kind: 'message', text: 'reply exact', reply: { targetProviderMessageId: 'target-exact' } },
        { kind: 'message', text: 'reply unresolved', reply: { targetText: 'never match' } },
        { kind: 'reaction', operation: 'add', targetProviderMessageId: 'target-exact', actorProviderUserId: 'actor', reactionValue: 'like' },
        { kind: 'reaction', operation: 'remove', targetProviderMessageId: 'target-exact', actorProviderUserId: 'actor', reactionValue: 'like' },
        { kind: 'receipt', receiptType: 'ack', proof: 'provider_acceptance', targetProviderMessageId: 'target-exact' },
        { kind: 'receipt', receiptType: 'ack', targetProviderMessageId: 'target-exact' },
        { kind: 'route_evidence', evidence: [{ identityKind: 'protocol_chat_id', identityValue: 'chat-exact' }] },
      ]
      for (const [index, payload] of payloads.entries()) {
        const id = await journal.append(observation(account, payload))
        await processor.normalizeObservation({ accountId: account, observationId: id, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: `semantic-${index}` })
      }
      const events = await client.maxInboundNormalizedEvent.findMany({ where: { accountId: account }, orderBy: [{ sourceJournalSequence: 'asc' }, { eventOrdinal: 'asc' }] })
      assert.equal(events[0].targetProviderMessageId, 'target-exact')
      assert.equal(events[1].targetProviderMessageId, null)
      assert.deepEqual(events.filter((row: any) => row.eventKind === 'reaction').map((row: any) => row.normalizedPayload.operation), ['add', 'remove'])
      assert.deepEqual(events.filter((row: any) => row.eventKind === 'receipt').map((row: any) => row.normalizedPayload.receiptType), ['provider_acceptance', 'unknown_receipt'])
      assert.equal(events.at(-1).eventKind, 'route_evidence')
      assert.equal(events.at(-1).normalizedPayload.mutationPerformed, false)
    })

    test('S3-DB-39 catalog exposes expected tables, indexes, FKs, checks, and append-only triggers', async () => {
      const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('MaxInboundNormalizationResult', 'MaxInboundNormalizedEvent')
        ORDER BY table_name`)
      assert.equal(tables.length, 2)
      const indexes = await client.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('MaxInboundNormalizationResult', 'MaxInboundNormalizedEvent')`)
      assert.equal(indexes.some(row => row.indexname === 'MaxInboundNormalizedEvent_account_provider_message_idx' && !row.indexdef.includes('UNIQUE')), true)
      const constraints = await client.$queryRawUnsafe<Array<{ type: string; count: bigint }>>(`
        SELECT contype::text AS type, count(*)::bigint AS count FROM pg_constraint
        WHERE conrelid IN ('"MaxInboundNormalizationResult"'::regclass, '"MaxInboundNormalizedEvent"'::regclass)
        GROUP BY contype`)
      assert.equal(Number(constraints.find(row => row.type === 'f')?.count ?? 0n) >= 2, true)
      assert.equal(Number(constraints.find(row => row.type === 'c')?.count ?? 0n) >= 10, true)
      const triggers = await client.$queryRawUnsafe<Array<{ trigger_name: string }>>(`
        SELECT tgname AS trigger_name FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid IN ('"MaxInboundNormalizationResult"'::regclass, '"MaxInboundNormalizedEvent"'::regclass)`)
      assert.deepEqual(new Set(triggers.map(row => row.trigger_name)), new Set([
        'MaxInboundNormalizationResult_append_only', 'MaxInboundNormalizedEvent_append_only',
      ]))
    })
  })
}
