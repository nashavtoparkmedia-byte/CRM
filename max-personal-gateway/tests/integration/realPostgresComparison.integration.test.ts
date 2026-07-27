import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../../src/inbound/constants.ts'
import { MaxInboundNormalizer } from '../../src/inbound/MaxInboundNormalizer.ts'
import type { NormalizationOutcome, NormalizeRawObservationInput } from '../../src/inbound/types.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import { MAX_SHADOW_COMPARISON_VERSION } from '../../src/comparison/constants.ts'
import { DefaultSemanticComparisonEngine } from '../../src/comparison/SemanticComparisonEngine.ts'
import { PrismaShadowSemanticComparisonHarness } from '../../src/comparison/PrismaShadowSemanticComparisonHarness.ts'
import { ShadowComparisonError } from '../../src/comparison/errors.ts'
import { appendComparisonFixture, createComparisonRun } from '../support/comparisonHarness.ts'
import { SAFE_COMPARISON_FIXTURES, fixtureById } from '../support/comparisonFixtures.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

class TransformingNormalizer extends MaxInboundNormalizer {
  readonly #transform: (outcome: NormalizationOutcome) => NormalizationOutcome
  constructor(transform: (outcome: NormalizationOutcome) => NormalizationOutcome) {
    super()
    this.#transform = transform
  }
  override normalizeRawObservation(input: NormalizeRawObservationInput): NormalizationOutcome {
    return this.#transform(super.normalizeRawObservation(input))
  }
}

if (config === null) {
  test('real PostgreSQL Stage 7 gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 7 real PostgreSQL semantic comparison', { concurrency: false }, () => {
    let client: RealPrismaClient
    let journal: PrismaRawEventJournal
    let harness: PrismaShadowSemanticComparisonHarness

    before(async () => {
      client = await createRealPrismaClient(config)
      journal = new PrismaRawEventJournal(client as any)
      harness = new PrismaShadowSemanticComparisonHarness(client as any, new DefaultSemanticComparisonEngine())
    })

    after(async () => {
      await client.$disconnect()
    })

    test('S7-DB-01 run/result transaction is durable, idempotent, and counter-exact', async () => {
      const account = runId('s7_db_basic')
      const run = runId('s7_run_basic')
      await createComparisonRun(harness, account, run)
      const observationId = await appendComparisonFixture(journal, account, fixtureById('inbound-text'), 'basic')
      const first = await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      const repeated = await harness.replayObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      assert.equal(first.idempotent, false)
      assert.equal(repeated.idempotent, true)
      assert.equal(repeated.result.resultId, first.result.resultId)
      assert.equal(first.result.classification, 'matched')
      assert.equal(first.diffs.length, 0)
      const storedRun = await harness.getRun(account, run)
      assert.deepEqual({ processed: storedRun?.processedCount, matched: storedRun?.matchedCount }, { processed: 1, matched: 1 })
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 1)
    })

    test('S7-DB-02 expected difference stores paths/types/hashes only and cannot mask false acceptance', async () => {
      const account = runId('s7_db_expected')
      const run = runId('s7_run_expected')
      await createComparisonRun(harness, account, run)
      const observationId = await appendComparisonFixture(journal, account, fixtureById('unknown-ack'), 'expected')
      const compared = await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      assert.equal(compared.result.classification, 'expected_difference')
      assert.deepEqual(compared.diffs.map(diff => diff.path), [
        '$events[0].issueClassification', '$events[0].receiptSemantic', '$issueClassification',
      ])
      assert.equal(compared.diffs.every(diff => diff.legacyValueHash?.length === 64 && diff.newValueHash?.length === 64), true)
      assert.doesNotMatch(JSON.stringify(compared, (_key, value) => typeof value === 'bigint' ? value.toString() : value),
        /synthetic|recipient text|redacted-fixture-reference/i)

      const faultyEngine = new DefaultSemanticComparisonEngine(undefined, new TransformingNormalizer(outcome => ({
        ...outcome,
        events: outcome.events.map((event, index) => index === 0 ? {
          ...event,
          normalizedPayload: {
            ...(event.normalizedPayload as unknown as Record<string, unknown>),
            receiptType: 'provider_acceptance',
          } as never,
        } : event),
      })))
      const faultyRun = runId('s7_run_false_acceptance')
      const faultyHarness = new PrismaShadowSemanticComparisonHarness(client as any, faultyEngine)
      await createComparisonRun(faultyHarness, account, faultyRun)
      const regression = await faultyHarness.compareObservation({
        runId: faultyRun, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId,
      })
      assert.equal(regression.result.classification, 'regression')
      assert.equal(regression.result.highestSeverity, 'critical')
    })

    test('S7-DB-03 complete fixture snapshot persists with deterministic batch cursor and restart', async () => {
      const account = runId('s7_db_snapshot')
      const run = runId('s7_run_snapshot')
      await createComparisonRun(harness, account, run)
      for (const [index, fixture] of SAFE_COMPARISON_FIXTURES.entries()) {
        await appendComparisonFixture(journal, account, fixture, `snapshot-${index}`)
      }
      const batch = await harness.compareBatch({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, limit: SAFE_COMPARISON_FIXTURES.length })
      assert.equal(batch.processed, SAFE_COMPARISON_FIXTURES.length)
      const empty = await harness.resumeRun({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, limit: 100 })
      assert.equal(empty.processed, 0)
      const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'support', 'comparisonSnapshot.json')
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Array<{
        fixtureId: string; legacySemanticSha256: string; newSemanticSha256: string; expectedClassification: string
      }>
      const rows = await harness.listResults({ accountId: account, runId: run, limit: 100 })
      assert.equal(rows.length, snapshot.length)
      for (const [index, expected] of snapshot.entries()) {
        assert.equal(rows[index]?.legacySemanticSha256, expected.legacySemanticSha256, expected.fixtureId)
        assert.equal(rows[index]?.newSemanticSha256, expected.newSemanticSha256, expected.fixtureId)
        assert.equal(rows[index]?.classification, expected.expectedClassification, expected.fixtureId)
      }
      const restartedClient = await createRealPrismaClient(config)
      try {
        const restarted = new PrismaShadowSemanticComparisonHarness(restartedClient as any, new DefaultSemanticComparisonEngine())
        const cursor = await restarted.getCursor(account, run, MAX_SHADOW_COMPARISON_VERSION)
        assert.equal(cursor?.lastJournalSequence, batch.lastJournalSequence)
        assert.equal((await restarted.resumeRun({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, limit: 100 })).processed, 0)
      } finally {
        await restartedClient.$disconnect()
      }
    })

    test('S7-DB-04 physical duplicates, history/live, and identical payloads remain distinct results', async () => {
      const account = runId('s7_db_physical')
      const run = runId('s7_run_physical')
      await createComparisonRun(harness, account, run)
      const ids: string[] = []
      for (let index = 0; index < 25; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('duplicate-provider-frame'), `physical-${index}`))
      }
      ids.push(await appendComparisonFixture(journal, account, fixtureById('history-copy'), 'history'))
      ids.push(await appendComparisonFixture(journal, account, fixtureById('live-copy'), 'live'))
      for (const observationId of ids) {
        await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      }
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 27)
      assert.equal(new Set(ids).size, 27)
      const rows = await harness.listResults({ accountId: account, runId: run, limit: 100 })
      assert.equal(rows.every(row => row.classification === 'matched'), true)
    })

    test('S7-DB-05 result/diff/counter failures rollback atomically, isolate account B, and retry safely', async () => {
      const account = runId('s7_db_rollback')
      const run = runId('s7_run_rollback')
      let failurePoint: 'after_result' | 'during_diffs' | null = 'after_result'
      const failing = new PrismaShadowSemanticComparisonHarness(
        client as any,
        new DefaultSemanticComparisonEngine(),
        point => { if (point === failurePoint) throw new Error(`synthetic ${point} failure`) },
      )
      await createComparisonRun(failing, account, run)
      const observationId = await appendComparisonFixture(journal, account, fixtureById('unknown-ack'), 'rollback')
      await assert.rejects(failing.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId }))
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 0)
      assert.equal(await client.maxShadowSemanticDiff.count({ where: { accountId: account } }), 0)
      assert.equal((await failing.getRun(account, run))?.processedCount, 0)
      assert.equal((await failing.getCursor(account, run, MAX_SHADOW_COMPARISON_VERSION))?.lastJournalSequence, 0n)

      const accountB = runId('s7_db_rollback_b')
      const runB = runId('s7_run_rollback_b')
      await createComparisonRun(harness, accountB, runB)
      const observationB = await appendComparisonFixture(journal, accountB, fixtureById('inbound-text'), 'rollback-b')
      const comparedB = await harness.compareObservation({
        runId: runB, accountId: accountB, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId: observationB,
      })
      assert.equal(comparedB.result.classification, 'matched')
      assert.equal((await harness.getRun(accountB, runB))?.processedCount, 1)

      failurePoint = 'during_diffs'
      await assert.rejects(failing.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId }))
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 0)
      assert.equal(await client.maxShadowSemanticDiff.count({ where: { accountId: account } }), 0)
      assert.equal((await failing.getRun(account, run))?.processedCount, 0)

      failurePoint = null
      const retried = await failing.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      assert.equal(retried.idempotent, false)
      assert.equal(retried.result.classification, 'expected_difference')
      assert.equal((await failing.getRun(account, run))?.processedCount, 1)
    })

    test('S7-DB-06 account/run/version scope and composite foreign keys prevent cross-account reads and writes', async () => {
      const accountA = runId('s7_scope_a')
      const accountB = runId('s7_scope_b')
      const runA = runId('s7_run_scope_a')
      const runB = runId('s7_run_scope_b')
      await createComparisonRun(harness, accountA, runA)
      await createComparisonRun(harness, accountB, runB)
      const observationA = await appendComparisonFixture(journal, accountA, fixtureById('inbound-text'), 'scope-a')
      const observationB = await appendComparisonFixture(journal, accountB, fixtureById('inbound-text'), 'scope-b')
      await harness.compareObservation({ runId: runA, accountId: accountA, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId: observationA })
      await harness.compareObservation({ runId: runB, accountId: accountB, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId: observationB })

      const comparisonVersionV2 = 'max-shadow-comparison-v2-test'
      const runV2 = runId('s7_run_scope_v2')
      const harnessV2 = new PrismaShadowSemanticComparisonHarness(
        client as any,
        new DefaultSemanticComparisonEngine(undefined, undefined, comparisonVersionV2),
      )
      await harnessV2.createRun({
        runId: runV2,
        accountId: accountA,
        comparisonVersion: comparisonVersionV2,
        legacyAdapterVersion: 'max-legacy-semantic-adapter-v1',
        newNormalizerVersion: MAX_INBOUND_NORMALIZER_VERSION,
      })
      const v2 = await harnessV2.compareObservation({
        runId: runV2, accountId: accountA, comparisonVersion: comparisonVersionV2, observationId: observationA,
      })
      assert.equal(v2.result.comparisonVersion, comparisonVersionV2)
      assert.equal(v2.result.classification, 'matched')
      assert.equal(await client.maxShadowComparisonResult.count({
        where: { accountId: accountA, sourceObservationId: observationA },
      }), 2)
      assert.equal(await harness.getRun(accountB, runA), null)
      await assert.rejects(
        harness.compareObservation({ runId: runA, accountId: accountB, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId: observationB }),
        error => error instanceof ShadowComparisonError && error.code === 'RUN_SCOPE_MISMATCH',
      )
      await assert.rejects(client.maxShadowComparisonResult.create({ data: {
        resultId: runId('cross_result'), runId: runA, accountId: accountA,
        sourceObservationId: observationB, sourceJournalSequence: 1n,
        comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, classification: 'matched',
        legacyStatus: 'normalized', newStatus: 'normalized', legacySemanticSha256: 'a'.repeat(64),
        newSemanticSha256: 'a'.repeat(64), diffCount: 0, highestSeverity: 'none',
      } }))
      assert.equal((await harness.getCursor(accountA, runA, MAX_SHADOW_COMPARISON_VERSION))?.optimisticVersion, 0)
      assert.equal((await harness.getCursor(accountB, runB, MAX_SHADOW_COMPARISON_VERSION))?.optimisticVersion, 0)
    })

    test('S7-DB-07 immutable result/diff, no GUC bypass, controlled counters, and terminal run are enforced', async () => {
      const account = runId('s7_db_immutable')
      const run = runId('s7_run_immutable')
      await createComparisonRun(harness, account, run)
      const observationId = await appendComparisonFixture(journal, account, fixtureById('unknown-ack'), 'immutable')
      const compared = await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      const resultId = compared.result.resultId
      const diffId = compared.diffs[0]!.diffId
      await assert.rejects(client.$executeRawUnsafe(`UPDATE "MaxShadowComparisonResult" SET "diffCount" = 99 WHERE "resultId" = $1`, resultId))
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM "MaxShadowComparisonResult" WHERE "resultId" = $1`, resultId))
      await assert.rejects(client.$executeRawUnsafe(`UPDATE "MaxShadowSemanticDiff" SET "path" = '$tampered' WHERE "diffId" = $1`, diffId))
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM "MaxShadowSemanticDiff" WHERE "diffId" = $1`, diffId))
      await assert.rejects(client.$transaction(async transaction => {
        await transaction.$executeRawUnsafe(`SET LOCAL max_personal.allow_shadow_comparison_mutation = 'on'`)
        await transaction.$executeRawUnsafe(`DELETE FROM "MaxShadowSemanticDiff" WHERE "diffId" = $1`, diffId)
      }))
      await assert.rejects(client.maxShadowComparisonRun.update({ where: { runId: run }, data: { processedCount: 99 } }))
      const completed = await harness.completeRun(account, run, MAX_SHADOW_COMPARISON_VERSION)
      assert.equal(completed.state, 'completed')
      await assert.rejects(client.maxShadowComparisonRun.update({
        where: { runId: run }, data: { state: 'failed', completedAt: new Date() },
      }))
    })

    test('S7-DB-08 catalog exposes exact Stage 7 tables, indexes, foreign keys, checks, and triggers', async () => {
      const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
        AND table_name IN ('MaxShadowComparisonRun', 'MaxShadowComparisonResult',
          'MaxShadowSemanticDiff', 'MaxShadowComparisonCursor') ORDER BY table_name`)
      assert.equal(tables.length, 4)
      const indexes = await client.$queryRawUnsafe<Array<{ indexname: string }>>(`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND tablename IN ('MaxShadowComparisonRun', 'MaxShadowComparisonResult',
          'MaxShadowSemanticDiff', 'MaxShadowComparisonCursor')`)
      assert.equal(indexes.length, 18)
      const constraints = await client.$queryRawUnsafe<Array<{ contype: string; count: bigint }>>(`
        SELECT contype::text AS contype, count(*)::bigint AS count FROM pg_constraint
        WHERE conrelid IN ('"MaxShadowComparisonRun"'::regclass, '"MaxShadowComparisonResult"'::regclass,
          '"MaxShadowSemanticDiff"'::regclass, '"MaxShadowComparisonCursor"'::regclass)
        GROUP BY contype`)
      assert.equal(Number(constraints.find(row => row.contype === 'f')?.count ?? 0n), 4)
      assert.equal(Number(constraints.find(row => row.contype === 'c')?.count ?? 0n) >= 9, true)
      const triggers = await client.$queryRawUnsafe<Array<{ trigger_name: string }>>(`
        SELECT tgname AS trigger_name FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid IN ('"MaxShadowComparisonRun"'::regclass, '"MaxShadowComparisonResult"'::regclass,
          '"MaxShadowSemanticDiff"'::regclass, '"MaxShadowComparisonCursor"'::regclass)`)
      assert.deepEqual(new Set(triggers.map(row => row.trigger_name)), new Set([
        'MaxShadowComparisonResult_append_only', 'MaxShadowSemanticDiff_append_only',
        'MaxShadowComparisonRun_controlled_update', 'MaxShadowComparisonCursor_monotonic',
      ]))
    })
  })
}
