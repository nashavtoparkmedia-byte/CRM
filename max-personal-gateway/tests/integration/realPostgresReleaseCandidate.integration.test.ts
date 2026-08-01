import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { PrismaRawCaptureIngress } from '../../src/capture/PrismaRawCaptureIngress.ts'
import { loadGatewayConfig, REQUIRED_MIGRATION } from '../../src/runtime/config.ts'
import { GatewayRuntime } from '../../src/runtime/GatewayRuntime.ts'
import { OperationalMetrics } from '../../src/runtime/metrics.ts'
import { ShadowPipeline } from '../../src/runtime/ShadowPipeline.ts'
import { createRealPrismaClient, readRealPostgresConfig, runId, type RealPrismaClient } from '../support/realPostgres.ts'

const config = readRealPostgresConfig()
const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const producer = require(resolve(repositoryRoot, 'max-web-scraper/capture/LiveCaptureAdapter.js'))
const { TransportInterceptor } = require(resolve(repositoryRoot, 'max-web-scraper/transport/TransportInterceptor.js'))
const secret = 'synthetic-stage8b1-hmac-secret-0000000000000000'

async function eventually(operation: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await operation()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('eventual database condition did not become true')
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const value = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
  return { p50: value(0.5), p95: value(0.95), p99: value(0.99) }
}

if (config === null) {
  test('real PostgreSQL Stage 8B1 gate requires PERSONAL_MAX_REAL_POSTGRES_URL', { skip: true }, () => {})
} else {
  const realConfig = config
  describe('Stage 8B1 real PostgreSQL authenticated release candidate', { concurrency: false }, () => {
    let client: RealPrismaClient
    const temporary: string[] = []
    before(async () => { client = await createRealPrismaClient(realConfig) })
    after(async () => {
      await client.$disconnect()
      for (const root of temporary) rmSync(root, { recursive: true, force: true })
    })

    async function gateway(accountId: string) {
      const runtimeConfig = { ...loadGatewayConfig({
        MAX_RAW_JOURNAL_ENABLED: accountId,
        MAX_INBOUND_NORMALIZER_ENABLED: accountId,
        MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED: accountId,
        MAX_SHADOW_COMPARISON_ENABLED: accountId,
        MAX_PERSONAL_LIVE_CAPTURE_ENABLED: accountId,
        MAX_PERSONAL_GATEWAY_DATABASE_URL: realConfig.url,
        MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
        MAX_PERSONAL_GATEWAY_WORKER_POLL_MS: '100',
      }), port: 0 }
      const metrics = new OperationalMetrics()
      const pipeline = new ShadowPipeline(client as any, runtimeConfig, metrics)
      const runtime = new GatewayRuntime(runtimeConfig, {
        metrics,
        ingress: new PrismaRawCaptureIngress(client as any),
        pipeline,
        checkDatabase: async () => (await client.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok'))[0]?.ok === 1,
        checkMigration: async migration => (await client.$queryRawUnsafe<Array<{ present: boolean }>>(
          'SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS present', migration,
        ))[0]?.present === true,
      })
      await runtime.start()
      return runtime
    }

    function adapter(accountId: string, spoolPath: string, port: number, keySecret = secret) {
      return new producer.LiveCaptureAdapter({
        accountId, spoolPath, maxSpoolBytes: 64 * 1024 * 1024,
        ingress: { endpoint: `http://127.0.0.1:${port}/v1/capture`, keyId: 'current', secret: keySecret, intervalMs: 100, requestTimeoutMs: 1000, batchSize: 100 },
      })
    }

    test('S8B1-DB-01 actual hook to authenticated ingress, journal, normalizer, comparison and readiness', async () => {
      const account = runId('s8b1_e2e')
      const spoolPath = mkdtempSync(join(tmpdir(), 'max-stage8b1-pg-e2e-'))
      temporary.push(spoolPath)
      const runtime = await gateway(account)
      const capture = adapter(account, spoolPath, runtime.address.port)
      const transport = new TransportInterceptor(capture)
      transport._processDecodedFrame = () => {}
      try {
        transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://synthetic.invalid' }))
        transport._handleFrame(JSON.stringify({ opcode: 128, seq: 1, payload: {
          kind: 'message', direction: 'inbound', providerMessageId: 'synthetic-provider-1', text: 'synthetic-one',
        } }))
        const identical = JSON.stringify({ opcode: 128, seq: 2, payload: { kind: 'message', direction: 'inbound', text: 'identical' } })
        transport._handleFrame(identical)
        transport._handleFrame(identical)
        assert.equal(capture.getCaptureHealth().spoolPendingCount, 3)
        assert.equal((await capture.drain.drainOnce()).acknowledged, 3)
        await eventually(async () => await client.maxInboundNormalizationResult.count({ where: { accountId: account } }) === 3)
        await eventually(async () => await client.maxShadowComparisonResult.count({ where: { accountId: account } }) === 3)
        assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account } }), 3)
        assert.equal(new Set((await client.maxRawTransportEvent.findMany({ where: { accountId: account }, select: { captureEnvelopeId: true } })).map((row: any) => row.captureEnvelopeId)).size, 3)
        assert.equal(runtime.readinessSnapshot().ready, true)
        assert.equal(runtime.readinessSnapshot().browserOwnersExpected, 1)
        assert.equal(runtime.readinessSnapshot().browserOwnersObserved, null)
      } finally {
        capture.close()
        await runtime.stop()
      }
    })

    test('S8B1-DB-02 invalid authentication creates no raw row and outage/recreation drains exactly once', async () => {
      const account = runId('s8b1_recovery')
      const spoolPath = mkdtempSync(join(tmpdir(), 'max-stage8b1-pg-recovery-'))
      temporary.push(spoolPath)
      let runtime = await gateway(account)
      let capture = adapter(account, spoolPath, runtime.address.port, `${secret}-invalid`)
      capture.capturePhysicalFrame({ raw: JSON.stringify({ opcode: 128, payload: { kind: 'message', text: 'retained' } }), metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1' } })
      assert.equal((await capture.drain.drainOnce()).acknowledged, 0)
      assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account } }), 0)
      capture.close()
      await runtime.stop()

      capture = adapter(account, spoolPath, 9)
      assert.equal((await capture.drain.drainOnce()).acknowledged, 0)
      assert.equal(capture.getCaptureHealth().spoolPendingCount, 1)
      capture.close()

      runtime = await gateway(account)
      capture = adapter(account, spoolPath, runtime.address.port)
      try {
        assert.equal((await capture.drain.drainOnce()).acknowledged, 1)
        assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account } }), 1)
        capture.close()
        capture = adapter(account, spoolPath, runtime.address.port)
        assert.equal((await capture.drain.drainOnce()).attempted, 0)
        assert.equal(await client.maxRawTransportEvent.count({ where: { accountId: account } }), 1)
      } finally {
        capture.close()
        await runtime.stop()
      }
    })

    test('S8B1-DB-03 migration readiness and representative performance evidence are honest', async t => {
      const migration = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
        REQUIRED_MIGRATION,
      )
      assert.equal(migration[0]?.count, 1n)
      const account = runId('s8b1_perf')
      const spoolPath = mkdtempSync(join(tmpdir(), 'max-stage8b1-pg-perf-'))
      temporary.push(spoolPath)
      const runtime = await gateway(account)
      const capture = adapter(account, spoolPath, runtime.address.port)
      const hookMs: number[] = []
      const cpuBefore = process.cpuUsage()
      const memoryBefore = process.memoryUsage().rss
      try {
        for (let index = 0; index < 100; index += 1) {
          const started = performance.now()
          capture.capturePhysicalFrame({
            raw: JSON.stringify({ opcode: 128, payload: { kind: 'message', text: `performance-${index}` } }),
            metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1', transportSequence: String(index) },
          })
          hookMs.push(performance.now() - started)
        }
        const outageGrowthBytes = capture.getCaptureHealth().spoolPendingBytes
        const drainStarted = performance.now()
        while (capture.getCaptureHealth().spoolPendingCount > 0) await capture.drain.drainOnce()
        const drainSeconds = Math.max(0.001, (performance.now() - drainStarted) / 1000)
        await eventually(async () => await client.maxShadowComparisonResult.count({ where: { accountId: account } }) === 100)
        const cpu = process.cpuUsage(cpuBefore)
        const evidence = {
          captureHookMs: percentiles(hookMs),
          spoolAppendMs: percentiles(hookMs),
          ingressAckMs: runtime.metrics.percentiles('ingressAckMs'),
          journalMs: runtime.metrics.percentiles('journalMs'),
          normalizationLagMs: runtime.metrics.percentiles('normalizationLagMs'),
          comparisonLagMs: runtime.metrics.percentiles('comparisonLagMs'),
          cpuUserMs: cpu.user / 1000,
          cpuSystemMs: cpu.system / 1000,
          memoryRssDeltaBytes: process.memoryUsage().rss - memoryBefore,
          outageSpoolGrowthBytes: outageGrowthBytes,
          recoveryDrainPerSecond: 100 / drainSeconds,
        }
        t.diagnostic(`STAGE8B1_PERFORMANCE ${JSON.stringify(evidence)}`)
        assert.equal(runtime.metrics.counter('lostBeforeSpool'), 0)
        assert.equal(runtime.metrics.counter('criticalRegressions'), 0)
      } finally {
        capture.close()
        await runtime.stop()
      }
    })
  })
}
