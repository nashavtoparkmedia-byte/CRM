import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const inboundRoot = new URL('../src/inbound/', import.meta.url)
const inboundSource = readdirSync(inboundRoot)
  .filter(name => name.endsWith('.ts'))
  .map(name => readFileSync(new URL(name, inboundRoot), 'utf8'))
  .join('\n')
const repositoryRoot = new URL('../../', import.meta.url)
const migration = readFileSync(new URL('gravity-mvp/prisma/migrations/20260726205437_add_max_inbound_normalization/migration.sql', repositoryRoot), 'utf8')
const schema = readFileSync(new URL('gravity-mvp/prisma/schema.prisma', repositoryRoot), 'utf8')

test('Stage 3 module has no Redis, Chromium, sender, Gravity projector, provider, or runtime wiring imports', () => {
  assert.doesNotMatch(inboundSource, /from\s+['"][^'"]*(?:redis|ioredis|chromium|puppeteer|sender|MessageService|InboundProjector|gravity)/i)
  assert.doesNotMatch(inboundSource, /fetch\s*\(|axios|WebSocket|RouteRegistry/)
  const protectedRuntime = [
    'max-web-scraper/transport/TransportInterceptor.js',
    'max-web-scraper/sync/MessageSync.js',
    'max-web-scraper/sync/InitialHistorySync.js',
  ].map(path => readFileSync(new URL(path, repositoryRoot), 'utf8')).join('\n')
  assert.doesNotMatch(protectedRuntime, /MAX_INBOUND_NORMALIZER_ENABLED|MaxInboundNormalizer|ShadowInboundNormalization/)
})

test('migration enforces required uniqueness, nonunique provider indexes, account FKs, checks, and unconditional append-only guards', () => {
  assert.match(migration, /CREATE TABLE "MaxInboundNormalizationResult"/)
  assert.match(migration, /CREATE TABLE "MaxInboundNormalizedEvent"/)
  assert.match(migration, /UNIQUE INDEX "MaxInboundNormalizationResult_account_source_parser_key"/)
  assert.match(migration, /UNIQUE INDEX "MaxInboundNormalizedEvent_result_ordinal_key"/)
  assert.match(migration, /CREATE INDEX "MaxInboundNormalizedEvent_account_provider_message_idx"/)
  assert.doesNotMatch(migration, /UNIQUE INDEX[^;]+provider_message/is)
  assert.match(migration, /FOREIGN KEY \("accountId", "sourceObservationId"\)/)
  assert.match(migration, /FOREIGN KEY \("accountId", "normalizationResultId", "sourceObservationId", "parserVersion"\)/)
  assert.match(migration, /CHECK \("status" IN \('normalized', 'unsupported', 'quarantined'\)\)/)
  assert.match(migration, /CHECK \("eventKind" IN \('message', 'reaction', 'receipt', 'route_evidence', 'unsupported'\)\)/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxInboundNormalizationResult"/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxInboundNormalizedEvent"/)
  assert.doesNotMatch(migration, /current_setting|set_config|retention_bypass/i)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE[^;]+DROP/i)
})

test('Prisma schema preserves provider identifiers and semantic hash as nonunique correlation fields', () => {
  assert.match(schema, /model MaxInboundNormalizationResult/)
  assert.match(schema, /model MaxInboundNormalizedEvent/)
  assert.match(schema, /@@unique\(\[accountId, sourceObservationId, parserVersion\], map:/)
  assert.match(schema, /@@unique\(\[normalizationResultId, eventOrdinal\], map:/)
  for (const field of ['providerMessageId', 'providerUserId', 'protocolChatId', 'webRouteId', 'semanticSha256']) {
    const line = schema.split('\n').find(candidate => candidate.trimStart().startsWith(field))
    assert.ok(line, `${field} must exist`)
    assert.doesNotMatch(line, /@unique/)
  }
})

test('Stage 3 contains no generated garbage or fixture secret files', () => {
  const files = readdirSync(inboundRoot)
  assert.equal(files.some(name => /\.js$|\.map$|coverage|node_modules|\.env/i.test(name)), false)
  assert.equal(join('max-personal-gateway', 'src', 'inbound').includes('/opt/crm'), false)
})
