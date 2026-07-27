import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { MaxInboundNormalizer } from '../../src/inbound/MaxInboundNormalizer.ts'
import type { NormalizationOutcome, NormalizeRawObservationInput } from '../../src/inbound/types.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import { MAX_SHADOW_COMPARISON_VERSION } from '../../src/comparison/constants.ts'
import { ShadowComparisonError } from '../../src/comparison/errors.ts'
import { DefaultSemanticComparisonEngine } from '../../src/comparison/SemanticComparisonEngine.ts'
import { PrismaShadowSemanticComparisonHarness } from '../../src/comparison/PrismaShadowSemanticComparisonHarness.ts'
import { appendComparisonFixture, createComparisonRun } from '../support/comparisonHarness.ts'
import { fixtureById } from '../support/comparisonFixtures.ts'
import {
  createRealPrismaClient,
  readRealPostgresConfig,
  runId,
  type RealPrismaClient,
} from '../support/realPostgres.ts'

const config = readRealPostgresConfig()

class ProviderIdentityFaultNormalizer extends MaxInboundNormalizer {
  override normalizeRawObservation(input: NormalizeRawObservationInput): NormalizationOutcome {
    const outcome = super.normalizeRawObservation(input)
    return {
      ...outcome,
      events: outcome.events.map((event, index) => index === 0
        ? { ...event, providerMessageId: `wrong-${event.providerMessageId ?? 'missing'}` }
        : event),
    }
  }
}

async function inChunks<T>(values: readonly T[], size: number, operation: (value: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < values.length; offset += size) {
    await Promise.all(values.slice(offset, offset + size).map(operation))
  }
}

if (config === null) {
  test('real PostgreSQL Stage 7 concurrency gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  describe('Stage 7 real PostgreSQL concurrency and load', { concurrency: false }, () => {
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

    test('S7-CONC-01 25 same-observation compares elect one result and 24 idempotent outcomes', async () => {
      const account = runId('s7_conc_same')
      const run = runId('s7_run_same')
      await createComparisonRun(harness, account, run)
      const observationId = await appendComparisonFixture(journal, account, fixtureById('inbound-text'), 'same')
      const outcomes = await Promise.all(Array.from({ length: 25 }, () => harness.compareObservation({
        runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId,
      })))
      assert.equal(outcomes.filter(outcome => !outcome.idempotent).length, 1)
      assert.equal(outcomes.filter(outcome => outcome.idempotent).length, 24)
      assert.equal(new Set(outcomes.map(outcome => outcome.result.resultId)).size, 1)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 1)
      assert.equal((await harness.getRun(account, run))?.processedCount, 1)
    })

    test('S7-CONC-02 25 physical duplicates produce 25 results and exact counters', async () => {
      const account = runId('s7_conc_physical')
      const run = runId('s7_run_physical')
      await createComparisonRun(harness, account, run)
      const ids: string[] = []
      for (let index = 0; index < 25; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('duplicate-provider-frame'), `duplicate-${index}`))
      }
      const outcomes = await Promise.all(ids.map(observationId => harness.compareObservation({
        runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId,
      })))
      assert.equal(outcomes.length, 25)
      assert.equal(outcomes.every(outcome => !outcome.idempotent && outcome.result.classification === 'matched'), true)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 25)
      const storedRun = await harness.getRun(account, run)
      assert.deepEqual({ processed: storedRun?.processedCount, matched: storedRun?.matchedCount }, { processed: 25, matched: 25 })
    })

    test('S7-CONC-03 interleaved 100 A and 100 B preserve account and cursor isolation', async () => {
      const accountA = runId('s7_conc_a')
      const accountB = runId('s7_conc_b')
      const runA = runId('s7_run_a')
      const runB = runId('s7_run_b')
      await createComparisonRun(harness, accountA, runA)
      await createComparisonRun(harness, accountB, runB)
      const work: Array<{ accountId: string; runId: string; observationId: string }> = []
      for (let index = 0; index < 100; index += 1) {
        work.push({ accountId: accountA, runId: runA, observationId: await appendComparisonFixture(journal, accountA, fixtureById('inbound-text'), `a-${index}`) })
        work.push({ accountId: accountB, runId: runB, observationId: await appendComparisonFixture(journal, accountB, fixtureById('inbound-text'), `b-${index}`) })
      }
      await inChunks(work, 40, async item => {
        const result = await harness.compareObservation({ ...item, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION })
        assert.equal(result.result.accountId, item.accountId)
      })
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: runA, accountId: accountA } }), 100)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: runB, accountId: accountB } }), 100)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { OR: [
        { runId: runA, accountId: accountB }, { runId: runB, accountId: accountA },
      ] } }), 0)
      assert.equal((await harness.getCursor(accountA, runA, MAX_SHADOW_COMPARISON_VERSION))?.optimisticVersion, 0)
      assert.equal((await harness.getCursor(accountB, runB, MAX_SHADOW_COMPARISON_VERSION))?.optimisticVersion, 0)
    })

    test('S7-CONC-04 cursor contention classifies optimistic conflicts and bounded resume skips no result', async () => {
      const account = runId('s7_conc_cursor')
      const run = runId('s7_run_cursor')
      await createComparisonRun(harness, account, run)
      const attempts = await Promise.allSettled(Array.from({ length: 25 }, (_value, index) => harness.advanceCursor(
        account, run, MAX_SHADOW_COMPARISON_VERSION, BigInt(index + 1), 0,
      )))
      assert.equal(attempts.filter(outcome => outcome.status === 'fulfilled').length, 1)
      const rejected = attempts.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      assert.equal(rejected.length, 24)
      assert.equal(rejected.every(outcome => outcome.reason instanceof ShadowComparisonError
        && outcome.reason.code === 'CURSOR_CONFLICT'), true)

      const resumeAccount = runId('s7_resume_cursor')
      const resumeRun = runId('s7_run_resume')
      await createComparisonRun(harness, resumeAccount, resumeRun)
      for (let index = 0; index < 25; index += 1) {
        await appendComparisonFixture(journal, resumeAccount, fixtureById('inbound-text'), `resume-${index}`)
      }
      let processed = 0
      for (;;) {
        const batch = await harness.resumeRun({
          runId: resumeRun, accountId: resumeAccount, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, limit: 7,
        })
        processed += batch.processed
        if (batch.processed === 0) break
      }
      assert.equal(processed, 25)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: resumeRun } }), 25)
      assert.equal((await harness.getCursor(resumeAccount, resumeRun, MAX_SHADOW_COMPARISON_VERSION))?.optimisticVersion, 25)
    })

    test('S7-LOAD-01 1000 matched comparisons have zero loss and exact counters', async () => {
      const account = runId('s7_load_matched')
      const run = runId('s7_run_load_matched')
      await createComparisonRun(harness, account, run)
      const ids: string[] = []
      for (let index = 0; index < 1_000; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('inbound-text'), `matched-${index}`))
      }
      await inChunks(ids, 50, async observationId => {
        await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      })
      const storedRun = await harness.getRun(account, run)
      assert.deepEqual({ processed: storedRun?.processedCount, matched: storedRun?.matchedCount, regressions: storedRun?.regressionCount },
        { processed: 1_000, matched: 1_000, regressions: 0 })
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 1_000)
    })

    test('S7-LOAD-02 1000 interleaved A/B comparisons have zero wrong-account rows', async () => {
      const accountA = runId('s7_load_ab_a')
      const accountB = runId('s7_load_ab_b')
      const runA = runId('s7_run_ab_a')
      const runB = runId('s7_run_ab_b')
      await createComparisonRun(harness, accountA, runA)
      await createComparisonRun(harness, accountB, runB)
      const work: Array<{ accountId: string; runId: string; observationId: string }> = []
      for (let index = 0; index < 500; index += 1) {
        work.push({ accountId: accountA, runId: runA, observationId: await appendComparisonFixture(journal, accountA, fixtureById('inbound-text'), `load-a-${index}`) })
        work.push({ accountId: accountB, runId: runB, observationId: await appendComparisonFixture(journal, accountB, fixtureById('inbound-text'), `load-b-${index}`) })
      }
      await inChunks(work, 50, async item => {
        await harness.compareObservation({ ...item, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION })
      })
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: runA, accountId: accountA } }), 500)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: runB, accountId: accountB } }), 500)
      assert.equal(await client.maxShadowComparisonResult.count({ where: { OR: [
        { runId: runA, accountId: accountB }, { runId: runB, accountId: accountA },
      ] } }), 0)
    })

    test('S7-LOAD-03 identical observations and 100 history/live pairs are physically preserved', async () => {
      const account = runId('s7_load_physical')
      const run = runId('s7_run_load_physical')
      await createComparisonRun(harness, account, run)
      const ids: string[] = []
      for (let index = 0; index < 100; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('duplicate-provider-frame'), `identical-${index}`))
      }
      for (let index = 0; index < 100; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('history-copy'), `history-${index}`))
        ids.push(await appendComparisonFixture(journal, account, fixtureById('live-copy'), `live-${index}`))
      }
      await inChunks(ids, 50, async observationId => {
        await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      })
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 300)
      assert.equal((await harness.getRun(account, run))?.matchedCount, 300)
    })

    test('S7-LOAD-04 100 expected differences are exact and do not mask unexpected differences', async () => {
      const account = runId('s7_load_expected')
      const run = runId('s7_run_load_expected')
      await createComparisonRun(harness, account, run)
      const ids: string[] = []
      for (let index = 0; index < 100; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('unknown-ack'), `expected-${index}`))
      }
      await inChunks(ids, 25, async observationId => {
        await harness.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
      })
      const storedRun = await harness.getRun(account, run)
      assert.deepEqual({ processed: storedRun?.processedCount, expected: storedRun?.expectedDifferenceCount, regressions: storedRun?.regressionCount },
        { processed: 100, expected: 100, regressions: 0 })
      assert.equal(await client.maxShadowSemanticDiff.count({ where: { result: { runId: run } } }), 300)
    })

    test('S7-LOAD-05 100 injected critical identity regressions are classified deterministically', async () => {
      const account = runId('s7_load_critical')
      const run = runId('s7_run_load_critical')
      const faulty = new PrismaShadowSemanticComparisonHarness(
        client as any,
        new DefaultSemanticComparisonEngine(undefined, new ProviderIdentityFaultNormalizer()),
      )
      await createComparisonRun(faulty, account, run)
      const ids: string[] = []
      for (let index = 0; index < 100; index += 1) {
        ids.push(await appendComparisonFixture(journal, account, fixtureById('inbound-text'), `critical-${index}`))
      }
      await inChunks(ids, 25, async observationId => {
        const result = await faulty.compareObservation({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, observationId })
        assert.equal(result.result.classification, 'regression')
        assert.equal(result.result.highestSeverity, 'critical')
      })
      const storedRun = await faulty.getRun(account, run)
      assert.deepEqual({ processed: storedRun?.processedCount, regressions: storedRun?.regressionCount }, { processed: 100, regressions: 100 })
      assert.equal(await client.maxShadowComparisonResult.count({ where: { runId: run } }), 100)
      assert.equal(await client.maxShadowSemanticDiff.count({ where: { result: { runId: run }, severity: 'critical' } }), 100)
    })

    test('S7-LOAD-06 restart/new client and bounded batch resume recover all durable work', async () => {
      const account = runId('s7_load_restart')
      const run = runId('s7_run_load_restart')
      await createComparisonRun(harness, account, run)
      for (let index = 0; index < 113; index += 1) {
        await appendComparisonFixture(journal, account, fixtureById('inbound-text'), `restart-${index}`)
      }
      assert.equal((await harness.compareBatch({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, limit: 13 })).processed, 13)
      const restartedClient = await createRealPrismaClient(config)
      try {
        const restarted = new PrismaShadowSemanticComparisonHarness(restartedClient as any, new DefaultSemanticComparisonEngine())
        let processed = 13
        for (;;) {
          const batch = await restarted.resumeRun({ runId: run, accountId: account, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION, limit: 17 })
          processed += batch.processed
          if (batch.processed === 0) break
        }
        assert.equal(processed, 113)
        assert.equal(await restartedClient.maxShadowComparisonResult.count({ where: { runId: run } }), 113)
        assert.equal((await restarted.getRun(account, run))?.processedCount, 113)
      } finally {
        await restartedClient.$disconnect()
      }
    })
  })
}
