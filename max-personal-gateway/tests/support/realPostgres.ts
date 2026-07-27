import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface RealPostgresConfig {
  readonly url: string
  readonly databaseName: string
}

interface PrismaClientConstructor {
  new(options: { datasources: { db: { url: string } } }): RealPrismaClient
}

export interface RealPrismaClient {
  readonly maxRawTransportEvent: Record<string, (...args: any[]) => Promise<any>>
  readonly maxRawTransportProcessing: Record<string, (...args: any[]) => Promise<any>>
  readonly maxRawTransportCursor: Record<string, (...args: any[]) => Promise<any>>
  readonly maxRouteConversation: Record<string, (...args: any[]) => Promise<any>>
  readonly maxRouteIdentityBinding: Record<string, (...args: any[]) => Promise<any>>
  readonly maxRouteObservation: Record<string, (...args: any[]) => Promise<any>>
  readonly maxRouteConflict: Record<string, (...args: any[]) => Promise<any>>
  readonly maxInboundNormalizationResult: Record<string, (...args: any[]) => Promise<any>>
  readonly maxInboundNormalizedEvent: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundCommand: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundConversationActor: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundCommandReservation: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundDispatch: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundDispatchLane: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundDispatchAttempt: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundDispatchTransition: Record<string, (...args: any[]) => Promise<any>>
  readonly maxOutboundReconciliationTask: Record<string, (...args: any[]) => Promise<any>>
  readonly maxProviderConfirmationEvidence: Record<string, (...args: any[]) => Promise<any>>
  readonly maxProviderConfirmationResolution: Record<string, (...args: any[]) => Promise<any>>
  readonly maxProviderConfirmationDecision: Record<string, (...args: any[]) => Promise<any>>
  readonly maxProviderConfirmationCursor: Record<string, (...args: any[]) => Promise<any>>
  $connect(): Promise<void>
  $disconnect(): Promise<void>
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>
  $transaction<T>(operation: (transaction: RealPrismaClient) => Promise<T>): Promise<T>
}

export function readRealPostgresConfig(): RealPostgresConfig | null {
  const raw = process.env.PERSONAL_MAX_REAL_POSTGRES_URL
  if (raw === undefined) return null
  const parsed = new URL(raw)
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, 'real gate requires a PostgreSQL URL')
  assert.ok(
    parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]',
    'real gate refuses non-local PostgreSQL hosts',
  )
  assert.ok(parsed.port !== '' && parsed.port !== '5432', 'real gate requires an explicit non-default disposable port')
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  assert.match(databaseName, /^personal_max_[a-z0-9_]*gate[a-z0-9_]*$/, 'database name must carry the disposable gate marker')
  assert.equal(parsed.password, '', 'real gate URL must not contain a password')
  return { url: parsed.toString(), databaseName }
}

export async function createRealPrismaClient(config: RealPostgresConfig): Promise<RealPrismaClient> {
  const override = process.env.PERSONAL_MAX_REAL_PRISMA_CLIENT
  let modulePath: string
  if (override !== undefined) {
    assert.ok(isAbsolute(override), 'PERSONAL_MAX_REAL_PRISMA_CLIENT must be an absolute generated-client path')
    modulePath = override
  } else {
    const requireFromGravity = createRequire(new URL('../../../gravity-mvp/package.json', import.meta.url))
    modulePath = requireFromGravity.resolve('@prisma/client')
  }
  const loaded = await import(pathToFileURL(modulePath).href)
  const PrismaClient = (loaded.PrismaClient ?? loaded.default?.PrismaClient) as PrismaClientConstructor | undefined
  assert.ok(PrismaClient, 'generated PrismaClient export is required')
  const client = new PrismaClient({ datasources: { db: { url: config.url } } })
  await client.$connect()
  const rows = await client.$queryRawUnsafe<Array<{
    database_name: string
    server_address: string
    server_port: number
  }>>(`SELECT current_database() AS database_name,
      inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port`)
  assert.equal(rows[0]?.database_name, config.databaseName)
  assert.match(rows[0]?.server_address ?? '', /^(?:127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/)
  assert.notEqual(rows[0]?.server_port, 5432)
  return client
}

export function runId(prefix: string): string {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object'
    ? Reflect.get(error, 'code') as string | undefined
    : undefined
}

export async function rejectedCode(operation: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(operation, error => errorCode(error) === expected)
}
