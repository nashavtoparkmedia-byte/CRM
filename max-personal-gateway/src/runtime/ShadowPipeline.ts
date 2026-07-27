import { createHash, randomUUID } from 'node:crypto'
import { DefaultSemanticComparisonEngine } from '../comparison/SemanticComparisonEngine.ts'
import { PrismaShadowSemanticComparisonHarness } from '../comparison/PrismaShadowSemanticComparisonHarness.ts'
import { MAX_SHADOW_COMPARISON_VERSION } from '../comparison/constants.ts'
import { MaxInboundNormalizer } from '../inbound/MaxInboundNormalizer.ts'
import { PrismaShadowInboundNormalizationProcessor } from '../inbound/PrismaShadowInboundNormalizationProcessor.ts'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../inbound/constants.ts'
import { PrismaRawEventJournal } from '../journal/PrismaRawEventJournal.ts'
import type { GatewayConfig } from './config.ts'
import type { OperationalMetrics } from './metrics.ts'

type PrismaClientLike = any

function anonymousRunId(accountId: string): string {
  return `live-shadow-${createHash('sha256').update(accountId).digest('hex').slice(0, 24)}`
}

export class ShadowPipeline {
  readonly #client: PrismaClientLike
  readonly #config: GatewayConfig
  readonly #metrics: OperationalMetrics
  readonly #journal: PrismaRawEventJournal
  readonly #normalizer: PrismaShadowInboundNormalizationProcessor
  readonly #engine = new DefaultSemanticComparisonEngine()
  readonly #comparison: PrismaShadowSemanticComparisonHarness
  readonly #running = new Map<string, Promise<void>>()
  readonly #workerId = `gateway-${randomUUID()}`
  #timer: NodeJS.Timeout | null = null
  #stopped = true
  normalizerLagMs = 0
  comparisonLagMs = 0
  queueCritical = false

  constructor(client: PrismaClientLike, config: GatewayConfig, metrics: OperationalMetrics) {
    this.#client = client
    this.#config = config
    this.#metrics = metrics
    this.#journal = new PrismaRawEventJournal(client)
    this.#normalizer = new PrismaShadowInboundNormalizationProcessor(
      client,
      this.#journal,
      new MaxInboundNormalizer(),
    )
    this.#comparison = new PrismaShadowSemanticComparisonHarness(client, this.#engine)
  }

  start(): void {
    if (!this.#stopped || this.#config.mode === 'dormant') return
    this.#stopped = false
    this.notify()
    this.#timer = setInterval(() => this.notify(), this.#config.workerPollMs)
    this.#timer.unref?.()
  }

  notify(accountId?: string): void {
    const accounts = accountId === undefined ? this.#config.enabledAccounts : new Set([accountId])
    for (const account of accounts) {
      if (!this.#config.enabledAccounts.has(account) || this.#running.has(account)) continue
      const operation = this.#runAccount(account)
        .catch(() => { this.queueCritical = true })
        .finally(() => { this.#running.delete(account) })
      this.#running.set(account, operation)
    }
  }

  async stop(timeoutMs = 5000): Promise<boolean> {
    this.#stopped = true
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    const operations = Promise.allSettled([...this.#running.values()])
    const completed = await Promise.race([
      operations.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
    return completed
  }

  async #runAccount(accountId: string): Promise<void> {
    if (this.#config.features.normalizer.has(accountId)) {
      const started = Date.now()
      const result = await this.#normalizer.normalizeBatch({
        accountId,
        consumerId: 'max-personal-gateway-shadow-normalizer-v1',
        parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
        workerId: this.#workerId,
        limit: this.#config.workerBatchSize,
      })
      this.normalizerLagMs = Date.now() - started
      this.#metrics.observe('normalizationLagMs', this.normalizerLagMs)
      this.#metrics.increment('normalizerQuarantined', result.quarantined)
    }
    if (this.#config.features.comparison.has(accountId)) {
      const runId = anonymousRunId(accountId)
      let run = await this.#comparison.getRun(accountId, runId)
      if (run === null) {
        run = await this.#comparison.createRun({
          runId,
          accountId,
          comparisonVersion: MAX_SHADOW_COMPARISON_VERSION,
          legacyAdapterVersion: this.#engine.legacyAdapterVersion,
          newNormalizerVersion: this.#engine.newNormalizerVersion,
        })
      }
      if (run.state !== 'running') throw new Error('SHADOW_COMPARISON_RUN_NOT_RUNNING')
      const started = Date.now()
      const result = await this.#comparison.compareBatch({
        runId,
        accountId,
        comparisonVersion: MAX_SHADOW_COMPARISON_VERSION,
        limit: this.#config.workerBatchSize,
      })
      this.comparisonLagMs = Date.now() - started
      this.#metrics.observe('comparisonLagMs', this.comparisonLagMs)
      this.#metrics.increment('matched', result.classifications.matched)
      this.#metrics.increment('expectedDifferences', result.classifications.expected_difference)
      this.#metrics.increment('regressions', result.classifications.regression)
      const critical = await this.#comparison.listCriticalDiffs(accountId, runId, this.#config.workerBatchSize)
      this.#metrics.set('criticalRegressions', critical.length)
    }
    this.queueCritical = false
  }
}
