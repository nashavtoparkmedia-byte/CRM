import assert from 'node:assert/strict'
import test from 'node:test'
import { loadGatewayConfig } from '../src/runtime/config.ts'
import { OperationalMetrics } from '../src/runtime/metrics.ts'
import { buildReadiness } from '../src/runtime/readiness.ts'

const secret = 'synthetic-stage8b1-hmac-secret-0000000000000000'

test('readiness enforces every safety gate and metrics stay bounded/payload-free', () => {
  const config = loadGatewayConfig({
    MAX_RAW_JOURNAL_ENABLED: 'account-a', MAX_INBOUND_NORMALIZER_ENABLED: 'account-a',
    MAX_ROUTE_REGISTRY_ENABLED: 'account-a',
    MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED: 'account-a',
    MAX_SHADOW_COMPARISON_ENABLED: 'account-a', MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a',
    MAX_PERSONAL_GATEWAY_DATABASE_URL: 'postgresql://synthetic.invalid/db',
    MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
  })
  const metrics = new OperationalMetrics()
  metrics.increment('captureAccepted')
  metrics.observe('journalMs', 2)
  const state = {
    configValid: true, databaseReachable: true, migrationPresent: true, lastJournalAckAt: Date.now(),
    normalizerLagMs: 2, comparisonLagMs: 3, workerQueueCritical: false,
    producerHealth: {
      adapterState: 'healthy' as const, spoolPendingCount: 0, spoolPendingBytes: 0,
      oldestPendingAgeMs: null, lostBeforeSpoolCount: 0, captureEnvelopeIdCollisionCount: 0, observedAt: Date.now(),
    },
  }
  assert.equal(buildReadiness(config, state, metrics).ready, true)
  metrics.increment('criticalRegressions')
  assert.equal(buildReadiness(config, state, metrics).ready, false)
  const serialized = JSON.stringify(metrics.snapshot())
  assert.doesNotMatch(serialized, /message|caption|providerMessageId|cookie|token|secret/i)
})
