import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const comparisonRoot = join(root, 'src', 'comparison')

describe('Stage 7 source and security contracts', () => {
  test('S7-SRC-01 comparison module has no browser, provider, Redis, sender, network, or CRM runtime import', async () => {
    const files = (await readdir(comparisonRoot)).filter(file => file.endsWith('.ts'))
    const source = (await Promise.all(files.map(file => readFile(join(comparisonRoot, file), 'utf8')))).join('\n')
    assert.doesNotMatch(source, /from ['"][^'"]*(?:chromium|puppeteer|playwright|redis|sender|MessageService|SessionController|TransportInterceptor)[^'"]*['"]/i)
    assert.doesNotMatch(source, /\b(?:fetch|axios|WebSocket)\s*\(/)
    assert.doesNotMatch(source, /process\.env\.(?:DATABASE_URL|MAX_TOKEN|AUTHORIZATION)/)
  })

  test('S7-SRC-02 legacy adapter is independent from the new normalizer implementation', async () => {
    const source = await readFile(join(comparisonRoot, 'LegacySemanticAdapter.ts'), 'utf8')
    assert.doesNotMatch(source, /MaxInboundNormalizer|parserRegistry|canonicalizeNewOutcome/)
    assert.match(source, /side-effect|PureLegacySemanticAdapter|LegacySemanticAdapter/)
  })

  test('S7-SRC-03 existing runtime modules do not import comparison or its feature flag', async () => {
    const sourceRoot = join(root, 'src')
    const directories = ['journal', 'inbound', 'route', 'outbound', 'dispatch', 'confirmation']
    for (const directory of directories) {
      const files = (await readdir(join(sourceRoot, directory))).filter(file => file.endsWith('.ts'))
      for (const file of files) {
        const source = await readFile(join(sourceRoot, directory, file), 'utf8')
        assert.doesNotMatch(source, /comparison|MAX_SHADOW_COMPARISON_ENABLED/)
      }
    }
  })

  test('S7-SRC-04 durable comparison files never define raw text/caption or secret value columns', async () => {
    const schema = await readFile(join(root, '..', 'gravity-mvp', 'prisma', 'schema.prisma'), 'utf8')
    const start = schema.indexOf('model MaxShadowComparisonRun')
    const end = schema.indexOf('model MaxRouteIdentityBinding', start)
    const stage7 = schema.slice(start, end)
    assert.doesNotMatch(stage7, /^\s*(?:text|caption|cookie|authorization|token|signedUrl|rawValue)\s+/mi)
    assert.match(stage7, /legacyValueHash/)
    assert.match(stage7, /newValueHash/)
  })

  test('S7-SRC-05 migration is additive and contains no destructive SQL or caller GUC bypass', async () => {
    const migration = await readFile(join(root, '..', 'gravity-mvp', 'prisma', 'migrations',
      '20260727141925_add_max_shadow_semantic_comparison', 'migration.sql'), 'utf8')
    assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b|ALTER\s+TABLE\s+"Max(?:Raw|Inbound|Route|Outbound|Provider)/i)
    assert.doesNotMatch(migration, /current_setting|set_config|allow_/i)
    assert.match(migration, /MaxShadowSemanticDiff_append_only/)
    assert.match(migration, /MaxShadowComparisonCursor_monotonic/)
  })
})
