#!/usr/bin/env node
import assert from 'node:assert/strict'
import { classifyTrackedSurface, inventoryTrackedSurfaces, parseGitTrackedEntries } from './tracked-surface-inventory.mjs'

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
assert.deepEqual(
  classifyTrackedSurface('packaging/postinst', null, { gitMode: '100755' }),
  {
    path: 'packaging/postinst',
    extension: '.git-executable',
    lifecycle: 'OPERATIONAL_SCRIPT',
    disposition: 'UNREVIEWED',
    functional_owner: null,
    owner_context: null,
    production_capability: 'UNKNOWN',
    rationale: null,
    migration_target: null,
    maintenance_lifecycle: undefined,
    migration_authority: undefined,
    registered_source_sha256: null,
    registry_classified: false,
    executable_source: 'GIT_MODE_100755',
  },
)
assert.equal(classifyTrackedSurface('templates/runtime.in'), null, 'non-executable .in remains outside the executable inventory')
assert.deepEqual(
  classifyTrackedSurface('templates/crm-activation-profile.py.in'),
  {
    path: 'templates/crm-activation-profile.py.in',
    extension: '.py',
    lifecycle: 'OPERATIONAL_SCRIPT',
    disposition: 'UNREVIEWED',
    functional_owner: null,
    owner_context: null,
    production_capability: 'UNKNOWN',
    rationale: null,
    migration_target: null,
    maintenance_lifecycle: undefined,
    migration_authority: undefined,
    registered_source_sha256: null,
    registry_classified: false,
    executable_source: 'COMPOUND_EXECUTABLE_TEMPLATE_SUFFIX',
  },
)
assert.equal(classifyTrackedSurface('module/public-v1-index.ts.template')?.extension, '.ts', 'tracked code template is executable source input')
assert.equal(classifyTrackedSurface('templates/profile.json.in'), null, 'data template does not become executable merely from a compound suffix')
assert.equal(classifyTrackedSurface('templates/runtime.in', null, { hasShebang: true })?.extension, '.shebang-source', 'a shebang identifies otherwise extensionless executable source')
assert.equal(classifyTrackedSurface('README.md', null, { hasShebang: false }), null, 'ordinary documentation is not a shebang source')
assert.equal(classifyTrackedSurface('README.md', null, { gitMode: '100644' }), null, 'ordinary non-executable documentation remains excluded')
assert.equal(classifyTrackedSurface('README.md', null, { gitMode: '100755' })?.extension, '.git-executable', 'Git executable mode wins over an unsupported filename extension')

assert.deepEqual(parseGitTrackedEntries(Buffer.from(
  `100755 ${'a'.repeat(40)} 0\tpackaging/postinst\0` +
  `100644 ${'b'.repeat(40)} 0\tREADME.md\0`,
)), [
  { mode: '100755', path: 'packaging/postinst' },
  { mode: '100644', path: 'README.md' },
])
assert.throws(() => parseGitTrackedEntries(`100755 ${'a'.repeat(40)} 2\tconflicted\0`), /unmerged git tracked-index record/)
assert.throws(() => parseGitTrackedEntries('not-an-index-record\0'), /invalid git tracked-index record/)

const registry = {
  surfaces: [
    {
      path: 'gravity-mvp/scripts/legacy.ts',
      lifecycle: 'DEAD_HISTORICAL',
      disposition: 'DEAD_HISTORICAL',
      owner_context: 'messaging',
      functional_owner: 'messaging_architecture_reviewer',
      production_capability: 'NONE',
      rationale: 'retained incident artifact',
      classification_artifact: 'architecture/reviews/dead-historical.json',
      source_sha256: 'a'.repeat(64),
      migration_target: null,
    },
    {
      path: 'gravity-mvp/scripts/active.ts',
      lifecycle: 'OPERATIONAL_SCRIPT',
      disposition: 'ACTIVE',
      functional_owner: 'messaging',
      production_capability: 'POSSIBLE',
      rationale: 'operator runbook',
      migration_target: 'messaging.public.v1',
    },
  ],
}

const inventory = await inventoryTrackedSurfaces('/fixture', {
  registry,
  sourceHashes: { 'gravity-mvp/scripts/legacy.ts': 'a'.repeat(64) },
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
assert.equal(inventory.surfaces.find((surface) => surface.path.endsWith('active.ts')).functional_owner, 'messaging')
assert.equal(inventory.surfaces.find((surface) => surface.path.endsWith('active.ts')).owner_context, null)

const gitModeInventory = await inventoryTrackedSurfaces('/fixture', {
  trackedFiles: [
    { mode: '100755', path: 'packaging/postinst' },
    { mode: '100755', path: 'templates/runtime.in' },
    { mode: '100644', path: 'README.md' },
    { mode: '100644', path: 'src/application.ts' },
  ],
})
assert.deepEqual(gitModeInventory.surfaces.map((surface) => [
  surface.path,
  surface.extension,
  surface.lifecycle,
]), [
  ['packaging/postinst', '.git-executable', 'OPERATIONAL_SCRIPT'],
  ['src/application.ts', '.ts', 'APPLICATION_RUNTIME'],
  ['templates/runtime.in', '.git-executable', 'OPERATIONAL_SCRIPT'],
])
await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', { trackedFiles: [{ mode: 'executable', path: 'packaging/postinst' }] }),
  /invalid tracked-file injection mode/,
)
await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', { trackedFiles: [{ mode: '100644', path: 'templates/runtime.in', hasShebang: 'yes' }] }),
  /invalid tracked-file shebang declaration/,
)

await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', {
    registry,
    sourceHashes: { 'gravity-mvp/scripts/legacy.ts': 'b'.repeat(64) },
    trackedFiles: ['gravity-mvp/scripts/legacy.ts'],
  }),
  /registered lifecycle source hash drift/,
)

await assert.rejects(
  () => inventoryTrackedSurfaces('/fixture', {
    registry: {
      surfaces: [{
        path: 'deploy/exact.yml',
        lifecycle: 'MIGRATION',
        disposition: 'MIGRATION_ONLY',
        production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT',
        functional_owner: 'fleet_operations',
        source_sha256: 'a'.repeat(64),
      }],
    },
    sourceHashes: { 'deploy/exact.yml': 'b'.repeat(64) },
    trackedFiles: ['deploy/exact.yml'],
  }),
  /registered lifecycle source hash drift/,
)

for (const mutation of [
  { source_sha256: undefined },
  { production_capability: 'POSSIBLE' },
  { functional_owner: '' },
  { classification_artifact: '' },
  { classification_artifact: 'gravity-mvp/scripts/legacy.ts' },
  { rationale: '' },
]) {
  assert.throws(() => classifyTrackedSurface('gravity-mvp/scripts/legacy.ts', {
    surfaces: [{ ...registry.surfaces[0], ...mutation }],
  }), /dead historical surface/)
}

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
  /must declare functional_owner/,
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

const exactMigration = classifyTrackedSurface('deploy/exact.yml', {
  surfaces: [{
    path: 'deploy/exact.yml', lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY',
    production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT',
    migration_authority: {
      data_owner: 'fleet_operations', target_kind: 'SCHEMA',
      exact_name: 'yandex-fleet-scraper/prisma/schema.prisma',
      operation: 'mixed-script-command:prisma db push',
    },
  }],
})
assert.deepEqual(exactMigration.migration_authority, {
  data_owner: 'fleet_operations', target_kind: 'SCHEMA',
  exact_name: 'yandex-fleet-scraper/prisma/schema.prisma',
  operation: 'mixed-script-command:prisma db push',
})
for (const mutation of [
  { data_owner: '', target_kind: 'SCHEMA', exact_name: 'schema.prisma', operation: 'mixed-script-command:prisma db push' },
  { data_owner: 'fleet_operations', target_kind: 'PATH', exact_name: 'schema.prisma', operation: 'mixed-script-command:prisma db push' },
  { data_owner: 'fleet_operations', target_kind: 'SCHEMA', exact_name: '', operation: 'mixed-script-command:prisma db push' },
  { data_owner: 'fleet_operations', target_kind: 'SCHEMA', exact_name: 'schema.prisma', operation: 'prisma db push' },
]) {
  assert.throws(() => classifyTrackedSurface('deploy/exact.yml', {
    surfaces: [{
      path: 'deploy/exact.yml', lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY',
      production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT', migration_authority: mutation,
    }],
  }), /invalid exact migration authority/)
}
assert.throws(() => classifyTrackedSurface('deploy/exact.yml', {
  surfaces: [{
    path: 'deploy/exact.yml', lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY',
    production_capability: 'NOT_A_REAL_REACHABILITY_STATE',
    migration_authority: exactMigration.migration_authority,
  }],
}), /lacks enumerated production reachability/)

process.stdout.write('tracked surface inventory tests: PASS\n')
