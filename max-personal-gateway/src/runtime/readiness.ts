import type { GatewayConfig } from './config.ts'
import type { OperationalMetrics } from './metrics.ts'

export interface ProducerHealthEvidence {
  readonly adapterState: 'healthy' | 'degraded' | 'critical'
  readonly spoolPendingCount: number
  readonly spoolPendingBytes: number
  readonly oldestPendingAgeMs: number | null
  readonly lostBeforeSpoolCount: number
  readonly captureEnvelopeIdCollisionCount: number
  readonly observedAt: number
}

export interface RuntimeSafetyState {
  configValid: boolean
  databaseReachable: boolean
  migrationPresent: boolean
  lastJournalAckAt: number | null
  normalizerLagMs: number
  comparisonLagMs: number
  producerHealth: ProducerHealthEvidence | null
  workerQueueCritical: boolean
}

export interface ReadinessSnapshot {
  readonly ready: boolean
  readonly state: 'dormant-ready' | 'ready' | 'not-ready'
  readonly gates: Readonly<Record<string, boolean>>
  readonly browserOwnersExpected: 1
  readonly browserOwnersObserved: number | null
  readonly senderModulesInactive: true
  readonly providerActionsInactive: true
}

export function buildReadiness(
  config: GatewayConfig,
  runtime: RuntimeSafetyState,
  metrics: OperationalMetrics,
  now = Date.now(),
): ReadinessSnapshot {
  if (config.mode === 'dormant') {
    return {
      ready: runtime.configValid,
      state: runtime.configValid ? 'dormant-ready' : 'not-ready',
      gates: {
        configValid: runtime.configValid,
        featuresDormant: true,
        senderModulesInactive: true,
        providerActionsInactive: true,
        browserOwnerInvariant: config.browserOwnersExpected === 1,
      },
      browserOwnersExpected: config.browserOwnersExpected,
      browserOwnersObserved: config.browserOwnersObserved,
      senderModulesInactive: true,
      providerActionsInactive: true,
    }
  }
  const producer = runtime.producerHealth
  const requiresCapture = config.features.liveCapture.size > 0
  const gates: Record<string, boolean> = {
    configValid: runtime.configValid,
    databaseReachable: runtime.databaseReachable,
    migrationPresent: runtime.migrationPresent,
    ingressAuthConfigured: config.hmacKeys.size > 0,
    producerHealthObserved: !requiresCapture || producer !== null,
    spoolWritable: !requiresCapture || (producer !== null && producer.adapterState !== 'critical'),
    spoolBelowCritical: !requiresCapture || (producer !== null && producer.adapterState !== 'critical'),
    lostBeforeSpoolZero: metrics.counter('lostBeforeSpool') === 0,
    captureEnvelopeCollisionsZero: producer?.captureEnvelopeIdCollisionCount !== undefined
      ? producer.captureEnvelopeIdCollisionCount === 0 : !requiresCapture,
    journalIngestHealthy: metrics.counter('drainFailures') === 0,
    recentJournalAck: !requiresCapture || (runtime.lastJournalAckAt !== null
      && now - runtime.lastJournalAckAt <= config.recentAckWindowMs),
    normalizerLagWithinLimit: config.features.normalizer.size === 0
      || runtime.normalizerLagMs <= config.normalizerLagLimitMs,
    comparisonLagWithinLimit: config.features.comparison.size === 0
      || runtime.comparisonLagMs <= config.comparisonLagLimitMs,
    criticalRegressionsZero: metrics.counter('criticalRegressions') === 0,
    wrongAccountDifferencesZero: metrics.counter('wrongAccountDifferences') === 0,
    browserOwnerInvariant: config.browserOwnersExpected === 1,
    senderModulesInactive: config.senderModulesInactive,
    providerActionsInactive: config.providerActionsInactive,
    workerQueueHealthy: !runtime.workerQueueCritical,
  }
  const ready = Object.values(gates).every(Boolean)
  return {
    ready,
    state: ready ? 'ready' : 'not-ready',
    gates,
    browserOwnersExpected: config.browserOwnersExpected,
    browserOwnersObserved: config.browserOwnersObserved,
    senderModulesInactive: true,
    providerActionsInactive: true,
  }
}
