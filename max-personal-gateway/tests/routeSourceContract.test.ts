import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(gatewayRoot, '..')
const source = (path: string): string => readFileSync(resolve(gatewayRoot, path), 'utf8')
const repositorySource = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8')
const routeSources = (): string => readdirSync(resolve(gatewayRoot, 'src/route'))
  .filter(name => name.endsWith('.ts'))
  .map(name => source(`src/route/${name}`))
  .join('\n')

test('RouteRegistry is account-explicit, framework-independent, bounded, and exposes required operations', () => {
  const contract = source('src/route/RouteRegistry.ts')
  for (const operation of [
    'observeRouteEvidence', 'getRouteSnapshot', 'getSendableRouteSnapshot', 'resolveByIdentity',
    'listOpenConflicts', 'supersedeIdentity', 'resolveConflict', 'retireConversation',
  ]) assert.match(contract, new RegExp(`\\b${operation}\\b`))
  assert.match(contract, /getRouteSnapshot\(accountId: string/)
  assert.match(contract, /listOpenConflicts\(accountId: string, cursor: string \| undefined, limit: number/)
  assert.doesNotMatch(contract, /Prisma|Redis|Chromium|sender/i)
})

test('Route Registry has no name/phone matching, Redis, Chromium, sender, listener, provider, or UI dependency', () => {
  const files = routeSources()
  assert.doesNotMatch(files, /display.?name|phone.?number|phone.?match|name.?match|contact.?merge/i)
  assert.doesNotMatch(files, /ioredis|bullmq|redis|playwright|puppeteer|chromium/i)
  assert.doesNotMatch(files, /SerializedOutboundQueue|TransportInterceptor|MessageSync|SessionController|sendFrame|sendMessage|providerAction/i)
  assert.doesNotMatch(files, /gravity|react|next\//i)
})

test('Stage 2 remains unwired from the existing MAX runtime and feature flag has no listener import', () => {
  const runtime = repositorySource('max-web-scraper/index.js')
  assert.doesNotMatch(runtime, /RouteRegistry|MAX_ROUTE_REGISTRY_ENABLED|MaxRouteConversation/)
  assert.doesNotMatch(source('src/route/featureFlag.ts'), /max-web-scraper|listener|TransportInterceptor/)
})

test('migration is additive, account-scoped, append-only, and contains no caller-controlled bypass', () => {
  const migration = repositorySource('gravity-mvp/prisma/migrations/20260726190658_add_max_route_registry/migration.sql')
  const stageOneMigration = repositorySource('gravity-mvp/prisma/migrations/20260726162043_add_max_raw_transport_journal/migration.sql')
  assert.match(migration, /CREATE TABLE "MaxRouteConversation"/)
  assert.match(migration, /CREATE TABLE "MaxRouteIdentityBinding"/)
  assert.match(migration, /CREATE TABLE "MaxRouteObservation"/)
  assert.match(migration, /CREATE TABLE "MaxRouteConflict"/)
  assert.match(migration, /MaxRouteConversation_accountId_conversationKey_key/)
  assert.match(migration, /MaxRouteIdentityBinding_accountId_identityKind_identityValu_key/)
  assert.match(migration, /MaxRouteConflict_one_open_identity_route_pair_key/)
  assert.match(migration, /WHERE "status" = 'open'/)
  assert.match(migration, /FOREIGN KEY \("accountId", "conversationKey"\)/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxRouteObservation"/)
  assert.match(migration, /RAISE EXCEPTION 'MaxRouteObservation is append-only'/)
  assert.doesNotMatch(migration, /current_setting|SET LOCAL|allow_route_retention/i)
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN|INDEX)|ALTER\s+TABLE[^;]+RENAME|TRUNCATE/i)
  assert.doesNotMatch(migration, /UNIQUE INDEX[^\n]+\("identityKind", "identityValue"\)/)
  assert.match(stageOneMigration, /MaxRawTransportEvent/)
  assert.doesNotMatch(stageOneMigration, /MaxRouteConversation/)
})

test('schema and migration consistently enumerate route states, identity kinds, and conflicts', () => {
  const schema = repositorySource('gravity-mvp/prisma/schema.prisma')
  const migration = repositorySource('gravity-mvp/prisma/migrations/20260726190658_add_max_route_registry/migration.sql')
  for (const model of ['MaxRouteConversation', 'MaxRouteIdentityBinding', 'MaxRouteObservation', 'MaxRouteConflict']) {
    assert.match(schema, new RegExp(`model ${model} \\{`))
    assert.match(migration, new RegExp(`CREATE TABLE "${model}"`))
  }
  for (const state of ['unresolved', 'active', 'conflicted', 'retired', 'provisional', 'superseded', 'open', 'resolved', 'dismissed']) {
    assert.match(migration, new RegExp(`'${state}'`))
  }
  for (const kind of ['provider_user_id', 'protocol_chat_id', 'web_route_id']) {
    assert.match(migration, new RegExp(`'${kind}'`))
  }
  assert.match(migration, /routeVersion" >= 0/)
  assert.match(migration, /optimisticVersion" >= 0/)
})
