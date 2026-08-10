#!/usr/bin/env node
import assert from 'node:assert/strict'
import { classifyTrackedSurface, inventoryTrackedSurfaces } from './tracked-surface-inventory.mjs'

const cases = [
  ['gravity-mvp/src/app/api/route.ts', 'APPLICATION_RUNTIME'],
  ['gravity-mvp/src/app/api/route.test.ts', 'TEST'],
  ['gravity-mvp/src/__tests__/route.ts', 'TEST'],
  ['telephony/tests/test_inbound.py', 'TEST'],
  ['max-web-scraper/test3.js', 'TEST'],
  ['max-web-scraper/test/max_source_test.py', 'TEST'],
  ['gravity-mvp/src/fixtures/provider.ts', 'FIXTURE'],
  ['tools/audio-bridge-day1/gen-test-wav.js', 'FIXTURE'],
  ['gravity-mvp/src/generated/client.ts', 'GENERATED'],
  ['gravity-mvp/prisma/migrations/20260101_init/migration.sql', 'MIGRATION'],
  ['gravity-mvp/scripts/reconcile-chats.ts', 'OPERATIONAL_SCRIPT'],
  ['scripts/backup.sh', 'OPERATIONAL_SCRIPT'],
  ['tools/architecture/enforce.mjs', 'OPERATIONAL_SCRIPT'],
  ['gravity-mvp/run_45d_sync.js', 'OPERATIONAL_SCRIPT'],
  ['gravity-mvp/append_action.js', 'OPERATIONAL_SCRIPT'],
  ['gravity-mvp/verify-final-counts.ts', 'OPERATIONAL_SCRIPT'],
  ['tg-bot/apply-beauty.js', 'OPERATIONAL_SCRIPT'],
  ['tg-bot/start.js', 'APPLICATION_RUNTIME'],
  ['tg-bot/start-api-only.js', 'OPERATIONAL_SCRIPT'],
  ['yandex-fleet-scraper/fix-accounts.ts', 'OPERATIONAL_SCRIPT'],
  ['yandex-fleet-scraper/update_locator.cjs', 'OPERATIONAL_SCRIPT'],
  ['tg-bot/check-db.js', 'OPERATIONAL_SCRIPT'],
  ['scripts/migrate-docker-wsl.ps1', 'OPERATIONAL_SCRIPT'],
  ['max-web-scraper/parse.js', 'OPERATIONAL_SCRIPT'],
  ['max-web-scraper/restart-graceful.js', 'OPERATIONAL_SCRIPT'],
  ['max-web-scraper/index.js', 'APPLICATION_RUNTIME'],
  ['eslint.config.mjs', 'OPERATIONAL_SCRIPT'],
  ['avito-worker/src/jobs/handlers/check-session.handler.ts', 'APPLICATION_RUNTIME'],
  ['deploy/docker-compose.production.yml', 'OPERATIONAL_SCRIPT'],
  ['gravity-mvp/Dockerfile', 'OPERATIONAL_SCRIPT'],
  ['yandex-fleet-scraper/prisma/schema.prisma', 'MIGRATION'],
  ['gravity-mvp/package.json', 'OPERATIONAL_SCRIPT'],
]

for (const [file, expected] of cases) {
  assert.equal(classifyTrackedSurface(file)?.lifecycle, expected, file)
}
assert.equal(classifyTrackedSurface('README.md'), null)

const registry = {
  surfaces: [
    {
      path: 'gravity-mvp/scripts/legacy.ts',
      lifecycle: 'DEAD_HISTORICAL',
      disposition: 'DEAD_HISTORICAL',
      owner_context: 'messaging',
      production_capability: 'NONE',
      rationale: 'retained incident artifact',
      migration_target: null,
    },
    {
      path: 'gravity-mvp/scripts/active.ts',
      lifecycle: 'OPERATIONAL_SCRIPT',
      disposition: 'ACTIVE',
      owner_context: 'messaging',
      production_capability: 'POSSIBLE',
      rationale: 'operator runbook',
      migration_target: 'messaging.public.v1',
    },
  ],
}

const inventory = await inventoryTrackedSurfaces('/fixture', {
  registry,
  trackedFiles: [
    'gravity-mvp/src/app.ts',
    'gravity-mvp/scripts/active.ts',
    'gravity-mvp/scripts/legacy.ts',
    'gravity-mvp/scripts/unreviewed.js',
    'gravity-mvp/prisma/migrations/1/migration.sql',
    'deploy/docker-compose.yml',
    'gravity-mvp/Dockerfile',
    'gravity-mvp/prisma/schema.prisma',
    'gravity-mvp/package.json',
    'docs/ignore.md',
  ],
})

assert.equal(inventory.repository_root, '.')
assert.equal(inventory.summary.tracked_executable_surfaces, 9)
assert.equal(inventory.summary.by_lifecycle.APPLICATION_RUNTIME, 1)
assert.equal(inventory.summary.by_lifecycle.OPERATIONAL_SCRIPT, 5)
assert.equal(inventory.summary.by_lifecycle.DEAD_HISTORICAL, 1)
assert.equal(inventory.summary.by_lifecycle.MIGRATION, 2)
assert.equal(inventory.summary.unreviewed_operational_surfaces, 4)
assert.deepEqual(inventory.controls.stale_registry_entries, [])
assert.equal(inventory.surfaces.find((surface) => surface.path.endsWith('active.ts')).disposition, 'ACTIVE')

await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', {
    registry: { surfaces: [{ path: 'x.ts', lifecycle: 'UNKNOWN' }] },
    trackedFiles: ['x.ts'],
  }),
  /invalid lifecycle/,
)

await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', {
    registry: {
      surfaces: [
        { path: 'x.ts', lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE' },
      ],
    },
    trackedFiles: ['x.ts'],
  }),
  /must declare owner_context/,
)

await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', {
    registry: {
      surfaces: [
        { path: 'x.ts', lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'UNREVIEWED' },
        { path: 'x.ts', lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'UNREVIEWED' },
      ],
    },
    trackedFiles: ['x.ts'],
  }),
  /duplicate registry surface path/,
)

process.stdout.write('tracked surface inventory tests: PASS\n')
