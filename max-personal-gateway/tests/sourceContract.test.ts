import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(gatewayRoot, '..')
const source = (path: string): string => readFileSync(resolve(gatewayRoot, path), 'utf8')
const repositorySource = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8')

test('journal interface exposes no raw update/delete mutation path', () => {
  const contract = source('src/journal/RawEventJournal.ts')
  assert.match(contract, /append\(observation:/)
  assert.match(contract, /readAfter\(/)
  assert.match(contract, /claimProcessing\(/)
  assert.match(contract, /advanceCursor\(/)
  assert.doesNotMatch(contract, /updateRaw|deleteRaw|removeRaw/)
})

test('journal foundation has no Redis, browser, sender, or live-listener dependency', () => {
  const files = [
    'src/journal/RawEventJournal.ts',
    'src/journal/PrismaRawEventJournal.ts',
    'src/journal/sanitizer.ts',
    'src/journal/featureFlag.ts',
  ].map(source).join('\n')
  assert.doesNotMatch(files, /ioredis|bullmq|redis|playwright|puppeteer|TransportInterceptor|SessionController|sendFrame|send-message/)
})

test('migration uses correlation indexes without unsafe raw dedup constraints', () => {
  const migration = repositorySource('gravity-mvp/prisma/migrations/20260726162043_add_max_raw_transport_journal/migration.sql')
  assert.match(migration, /BIGSERIAL/)
  assert.match(migration, /append_only_guard/)
  assert.match(migration, /accountId_providerEventId_idx/)
  assert.match(migration, /payloadSha256_idx/)
  assert.doesNotMatch(migration, /UNIQUE INDEX[^\n]*(payloadSha256|providerEventId|frameId|transportSequence|observedAt)/i)
  assert.match(migration, /observationId_parserVersion_key/)
})

test('migration unconditionally guards raw mutation and validates processing states', () => {
  const migration = repositorySource('gravity-mvp/prisma/migrations/20260726162043_add_max_raw_transport_journal/migration.sql')
  const schema = repositorySource('gravity-mvp/prisma/schema.prisma')
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "MaxRawTransportEvent"/)
  assert.match(migration, /RAISE EXCEPTION 'MaxRawTransportEvent is append-only'/)
  assert.doesNotMatch(migration, /current_setting|allow_raw_retention|SET LOCAL/i)
  assert.match(migration, /MaxRawTransportProcessing_state_check/)
  for (const state of ['pending', 'processing', 'completed', 'retryable', 'quarantined', 'dead_letter']) {
    assert.match(migration, new RegExp(`'${state}'`))
  }
  assert.doesNotMatch(migration, /TRIGGER[^;]+MaxRawTransportProcessing/is)
  for (const field of ['payloadSizeBytes', 'replayAvailability', 'quarantineReason']) {
    assert.match(schema, new RegExp(`\\b${field}\\b`))
    assert.match(migration, new RegExp(`"${field}"`))
  }
})

test('Stage 1 does not wire journal into existing MAX runtime', () => {
  const runtime = repositorySource('max-web-scraper/index.js')
  assert.doesNotMatch(runtime, /RawEventJournal|MAX_RAW_JOURNAL_ENABLED|MaxRawTransportEvent/)
})
