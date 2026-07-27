import { PrismaClient } from '@prisma/client'
import { PrismaRawCaptureIngress } from '../capture/PrismaRawCaptureIngress.ts'
import { loadGatewayConfig } from './config.ts'
import { GatewayRuntime } from './GatewayRuntime.ts'
import { OperationalMetrics } from './metrics.ts'
import { ShadowPipeline } from './ShadowPipeline.ts'

function structured(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`)
}

async function start(): Promise<void> {
  const config = loadGatewayConfig(process.env)
  let client: PrismaClient | null = null
  let ingress: PrismaRawCaptureIngress | null = null
  let pipeline: ShadowPipeline | null = null
  const sharedMetrics = new OperationalMetrics()
  if (config.mode === 'active') {
    client = new PrismaClient({ datasources: { db: { url: config.databaseUrl! } } })
    ingress = new PrismaRawCaptureIngress(client as any)
    pipeline = new ShadowPipeline(client, config, sharedMetrics)
  }
  const runtime = new GatewayRuntime(config, {
    ingress,
    pipeline,
    metrics: sharedMetrics,
    checkDatabase: async () => {
      if (client === null) return false
      await client.$queryRawUnsafe('SELECT 1')
      return true
    },
    checkMigration: async migration => {
      if (client === null) return false
      const rows = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
        'SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS present',
        migration,
      )
      return rows[0]?.present === true
    },
    log: structured,
  })
  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    structured({ event: 'gateway_shutdown_requested', signal })
    const flushed = await runtime.stop(5000)
    await client?.$disconnect()
    structured({ event: 'gateway_shutdown_complete', workersFlushed: flushed })
    process.exit(flushed ? 0 : 1)
  }
  process.on('SIGTERM', () => { void stop('SIGTERM') })
  process.on('SIGINT', () => { void stop('SIGINT') })
  await runtime.start()
  structured({ event: 'gateway_signal_handlers_ready' })
}

start().catch(error => {
  structured({ event: 'gateway_start_failed', code: error instanceof Error ? error.name : 'START_FAILED' })
  process.exit(1)
})
