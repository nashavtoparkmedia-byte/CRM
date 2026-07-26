import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../../src/inbound/constants.ts'
import { normalizationErrorCode } from '../../src/inbound/errors.ts'
import { MaxInboundNormalizer } from '../../src/inbound/MaxInboundNormalizer.ts'
import { PrismaShadowInboundNormalizationProcessor } from '../../src/inbound/PrismaShadowInboundNormalizationProcessor.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import type { JsonValue } from '../../src/journal/types.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

function observation(accountId: string, payload: JsonValue, parserVersion = MAX_INBOUND_NORMALIZER_VERSION) {
  return {
    accountId,
    observedAt: new Date('2026-07-26T21:45:00.000Z'),
    sourceTransport: 'max_synthetic_fixture', sourceOrigin: 'stage3-concurrency', historyLive: 'live' as const,
    payloadEncoding: 'json' as const, sanitizedPayload: payload, payloadSha256: 'f'.repeat(64), payloadSizeBytes: 1,
    replayAvailability: 'available' as const, sanitizerVersion: 'stage3-v1', captureAdapterVersion: 'stage3-v1',
    schemaVersion: 1, redactionMetadata: { sanitizerVersion: 'stage3-v1', categories: [], paths: [] },
    quarantineEligible: true, parserVersion,
  }
}
function summary(results: readonly PromiseSettledResult<any>[]) {
  const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value)
  const codes = results.filter(result => result.status === 'rejected').map(result => normalizationErrorCode(result.reason) ?? 'UNCLASSIFIED')
  return {
    attempts: results.length,
    successes: fulfilled.length,
    idempotent: fulfilled.filter(value => value?.idempotent === true).length,
    classifiedConflicts: codes.filter(code => code === 'CLAIM_CONFLICT' || code === 'CURSOR_CONFLICT').length,
    unexpectedErrors: codes.filter(code => code !== 'CLAIM_CONFLICT' && code !== 'CURSOR_CONFLICT').length,
    codes,
  }
}

if (config === null) {
  test('real PostgreSQL inbound concurrency gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 3 real PostgreSQL concurrency', { concurrency: false }, () => {
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

    test('25 concurrent attempts for one observation/parser create one semantic result/event set', async () => {
      const account = runId('s3_conc_same')
      const observationId = await journal.append(observation(account, { kind: 'message', providerMessageId: 'one', text: 'one' }))
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => processor.normalizeObservation({
        accountId: account, observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: `worker-${index}`,
      })))
      const counts = summary(results)
      assert.equal(counts.successes >= 1, true)
      assert.equal(counts.successes + counts.classifiedConflicts, 25)
      assert.equal(counts.unexpectedErrors, 0)
      assert.equal(await client.maxInboundNormalizationResult.count({ where: { accountId: account, sourceObservationId: observationId } }), 1)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, sourceObservationId: observationId } }), 1)
      console.log('STAGE3_CONCURRENCY same_observation', JSON.stringify({ ...counts, finalResults: 1, finalEvents: 1, invariantViolations: 0 }))
    })

    test('25 identical physical observations create 25 results and event sets without deduplication', async () => {
      const account = runId('s3_conc_physical')
      const payload = { kind: 'message', providerMessageId: 'same-provider', text: 'identical' } as const
      const ids = await Promise.all(Array.from({ length: 25 }, () => journal.append(observation(account, payload))))
      const results = await Promise.allSettled(ids.map((observationId, index) => processor.normalizeObservation({
        accountId: account, observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: `physical-${index}`,
      })))
      const counts = summary(results)
      assert.deepEqual({ successes: counts.successes, classifiedConflicts: counts.classifiedConflicts, unexpectedErrors: counts.unexpectedErrors },
        { successes: 25, classifiedConflicts: 0, unexpectedErrors: 0 })
      const rows = await client.maxInboundNormalizationResult.findMany({ where: { accountId: account }, orderBy: { sourceJournalSequence: 'asc' } })
      assert.equal(rows.length, 25)
      assert.equal(rows.every((row: any, index: number) => index === 0 || row.sourceJournalSequence > rows[index - 1].sourceJournalSequence), true)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, providerMessageId: 'same-provider' } }), 25)
      console.log('STAGE3_CONCURRENCY physical_duplicates', JSON.stringify({ ...counts, finalResults: 25, finalEvents: 25, invariantViolations: 0 }))
    })

    test('10 parser A plus 10 parser B attempts converge to one independent result/event set per version', async () => {
      const account = runId('s3_conc_parser')
      const observationId = await journal.append(observation(account, { kind: 'message', text: 'replay' }))
      const attempts = [
        ...Array.from({ length: 10 }, (_, index) => ({ parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: `a-${index}` })),
        ...Array.from({ length: 10 }, (_, index) => ({ parserVersion: 'max-inbound-normalizer-v2', workerId: `b-${index}` })),
      ]
      const results = await Promise.allSettled(attempts.map(attempt => processor.normalizeObservation({ accountId: account, observationId, ...attempt })))
      const counts = summary(results)
      assert.equal(counts.successes + counts.classifiedConflicts, 20)
      assert.equal(counts.unexpectedErrors, 0)
      const resultRows = await client.maxInboundNormalizationResult.findMany({ where: { accountId: account, sourceObservationId: observationId } })
      assert.deepEqual(new Set(resultRows.map((row: any) => row.parserVersion)), new Set([MAX_INBOUND_NORMALIZER_VERSION, 'max-inbound-normalizer-v2']))
      assert.equal(resultRows.length, 2)
      assert.equal(await client.maxInboundNormalizedEvent.count({ where: { accountId: account, sourceObservationId: observationId } }), 2)
      console.log('STAGE3_CONCURRENCY parser_versions', JSON.stringify({ ...counts, finalResults: 2, finalEvents: 2, invariantViolations: 0 }))
    })

    test('25 concurrent cursor advances classify optimistic conflicts with no regression or nonterminal skip', async () => {
      const account = runId('s3_conc_cursor')
      const observationId = await journal.append(observation(account, { kind: 'message', text: 'terminal' }))
      const normalized = await processor.normalizeObservation({ accountId: account, observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: 'seed' })
      const initial = await journal.advanceCursor({
        consumerId: 'stage3-concurrent', accountId: account, parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
        lastJournalSequence: normalized.result.sourceJournalSequence, expectedVersion: 0,
      })
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => journal.advanceCursor({
        consumerId: 'stage3-concurrent', accountId: account, parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
        lastJournalSequence: normalized.result.sourceJournalSequence, expectedVersion: initial.version,
      })))
      const counts = summary(results)
      assert.equal(counts.successes, 1)
      assert.equal(counts.classifiedConflicts, 24)
      assert.equal(counts.unexpectedErrors, 0)
      const final = await journal.getCursor('stage3-concurrent', account, MAX_INBOUND_NORMALIZER_VERSION)
      assert.equal(final?.lastJournalSequence, normalized.result.sourceJournalSequence)
      const pendingId = await journal.append(observation(account, { kind: 'message', text: 'pending' }))
      const pending = await journal.getProcessingState(account, pendingId, MAX_INBOUND_NORMALIZER_VERSION)
      assert.equal(pending?.state, 'pending')
      assert.equal(final!.lastJournalSequence < (await journal.readAfter(account, final!.lastJournalSequence, 1)).observations[0]!.journalSequence, true)
      console.log('STAGE3_CONCURRENCY cursor', JSON.stringify({ ...counts, finalSequence: final?.lastJournalSequence.toString(), skippedNonterminal: 0, invariantViolations: 0 }))
    })

    test('parallel account A/B normalization with identical external IDs stays isolated', async () => {
      const accountA = runId('s3_conc_account_a')
      const accountB = runId('s3_conc_account_b')
      const payload = { kind: 'message', providerMessageId: 'same-cross-account', protocolChatId: 'same-chat', text: 'same' } as const
      const idsA = await Promise.all(Array.from({ length: 10 }, () => journal.append(observation(accountA, payload))))
      const idsB = await Promise.all(Array.from({ length: 10 }, () => journal.append(observation(accountB, payload))))
      const results = await Promise.allSettled([
        ...idsA.map((observationId, index) => processor.normalizeObservation({ accountId: accountA, observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: `a-${index}` })),
        ...idsB.map((observationId, index) => processor.normalizeObservation({ accountId: accountB, observationId, parserVersion: MAX_INBOUND_NORMALIZER_VERSION, workerId: `b-${index}` })),
      ])
      const counts = summary(results)
      assert.equal(counts.successes, 20)
      assert.equal(counts.unexpectedErrors, 0)
      assert.equal(await client.maxInboundNormalizationResult.count({ where: { accountId: accountA } }), 10)
      assert.equal(await client.maxInboundNormalizationResult.count({ where: { accountId: accountB } }), 10)
      assert.equal((await processor.readNormalizedAfter(accountA, MAX_INBOUND_NORMALIZER_VERSION, { sourceJournalSequence: 0n, eventOrdinal: -1 }, 20)).events.length, 10)
      assert.equal((await processor.readNormalizedAfter(accountB, MAX_INBOUND_NORMALIZER_VERSION, { sourceJournalSequence: 0n, eventOrdinal: -1 }, 20)).events.length, 10)
      console.log('STAGE3_CONCURRENCY account_isolation', JSON.stringify({ ...counts, accountAResults: 10, accountBResults: 10, invariantViolations: 0 }))
    })
  })
}
