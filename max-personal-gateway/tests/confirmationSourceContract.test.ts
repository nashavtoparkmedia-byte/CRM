import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const confirmationRoot = new URL('../src/confirmation/', import.meta.url)

test('confirmation module has no Redis, Chromium, sender, network, or provider runtime dependency', async () => {
  const files = (await readdir(confirmationRoot)).filter(name => name.endsWith('.ts'))
  const source = (await Promise.all(files.map(name => readFile(new URL(name, confirmationRoot), 'utf8')))).join('\n')
  assert.doesNotMatch(source, /from ['"][^'"]*(?:redis|ioredis|playwright|puppeteer|chromium|existingSender|MessageService)[^'"]*['"]/i)
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|axios)\s*\(/)
  assert.doesNotMatch(source, /MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED.*(?:true|\*)/)
})
test('provider-facing runtimes do not import the confirmation matcher or feature flag', async () => {
  const providerRuntimeFiles = [
    '../../max-web-scraper/index.js',
    '../../gravity-mvp/src/lib/MessageService.ts',
  ]
  for (const relative of providerRuntimeFiles) {
    const content = await readFile(new URL(relative, import.meta.url), 'utf8')
    assert.doesNotMatch(content, /confirmation\/PrismaConfirmationMatcher|MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED/)
  }
})

test('gateway shadow worker runs confirmation matcher only behind an exact account allowlist', async () => {
  const pipeline = await readFile(new URL('../src/runtime/ShadowPipeline.ts', import.meta.url), 'utf8')
  const config = await readFile(new URL('../src/runtime/config.ts', import.meta.url), 'utf8')
  assert.match(config, /providerConfirmation: parseExactAccountAllowlist\(environment\.MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED\)/)
  assert.match(config, /subset\(features\.providerConfirmation, features\.normalizer, 'Provider confirmation matcher'\)/)
  assert.match(pipeline, /new PrismaConfirmationMatcher\(client\)/)
  assert.match(pipeline, /features\.providerConfirmation\.has\(accountId\)/)
  assert.match(pipeline, /consumerId: 'max-personal-gateway-provider-confirmation-v1'/)
  assert.doesNotMatch(config, /MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED.*(?:true|\*)/)
})

test('migration is additive and carries append-only and cursor guards', async () => {
  const migration = await readFile(new URL('../../gravity-mvp/prisma/migrations/20260727053744_add_max_provider_confirmation_matcher/migration.sql', import.meta.url), 'utf8')
  assert.doesNotMatch(migration, /\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i)
  assert.match(migration, /MaxProviderConfirmationEvidence_append_only/)
  assert.match(migration, /MaxProviderConfirmationDecision_append_only/)
  assert.match(migration, /MaxProviderConfirmationCursor_monotonic/)
  assert.doesNotMatch(migration, /current_setting|set_config|codex_allow|app\./i)
})
