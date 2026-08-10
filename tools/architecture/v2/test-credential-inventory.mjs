#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { inventoryCredentialAccess, mixedCredentialSqlFragments } from './credential-inventory.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'yoko-credential-inventory-'))
await mkdir(path.join(root, 'architecture/evidence/v1'), { recursive: true })
await mkdir(path.join(root, 'architecture/contexts/v1/manifests'), { recursive: true })
await mkdir(path.join(root, 'gravity-mvp/src/modules/fleet-operations'), { recursive: true })
await mkdir(path.join(root, 'gravity-mvp/src/app'), { recursive: true })
await mkdir(path.join(root, 'scripts'), { recursive: true })
await writeFile(path.join(root, 'architecture/evidence/v1/module-rules.json'), JSON.stringify({
  modules: [{ id: 'shell', context: 'old', match: '^gravity-mvp/src/app/' }],
}))
await writeFile(path.join(root, 'architecture/contexts/v1/context-index.json'), JSON.stringify({
  contexts: [
    { path: 'architecture/contexts/v1/manifests/fleet.json' },
    { path: 'architecture/contexts/v1/manifests/shell.json' },
  ],
}))
await writeFile(path.join(root, 'architecture/contexts/v1/manifests/fleet.json'), JSON.stringify({ context: { id: 'fleet_operations' }, technical_modules: ['fleet'] }))
await writeFile(path.join(root, 'architecture/contexts/v1/manifests/shell.json'), JSON.stringify({ context: { id: 'platform_shell' }, technical_modules: ['shell'] }))
await writeFile(path.join(root, 'gravity-mvp/src/modules/fleet-operations/owner.ts'), 'prisma.apiConnection.findFirst()\n')
await writeFile(path.join(root, 'gravity-mvp/src/app/foreign.ts'), 'prisma.apiConnection.findFirst({ select: { apiKey: true } })\n')
await writeFile(
  path.join(root, 'scripts/restore-pg.sh'),
  await readFile(new URL('../../../scripts/restore-pg.sh', import.meta.url), 'utf8'),
)
await writeFile(
  path.join(root, 'scripts/migrate-data-to-vps.sh'),
  await readFile(new URL('../../../scripts/migrate-data-to-vps.sh', import.meta.url), 'utf8'),
)
await writeFile(path.join(root, 'scripts/export-db.py'), [
  'cursor.query("COPY ApiConnection(apiKey) TO STDOUT")',
  'cursor.query("TABLE ApiConnection")',
  'cursor.query(runtime_sql)',
  'await connection.fetch("SELECT token FROM bots")',
  'await connection.fetch(runtime_sql)',
  'search.query(runtime_sql)',
  'animation.execute(runtime_sql)',
].join('\n'))
const secretMarker = 'YOKO_SECRET_MARKER_5b613e'
await writeFile(path.join(root, 'scripts/nested-db.sh'), [
  'docker exec crm-db sh -c \'pg_restore --dbname "$DATABASE_URL" "$BACKUP"\'',
  'bash -c "psql \\"$DATABASE_URL\\" -f \\"$SQL_FILE\\""',
  `ssh deploy@db 'pg_dump "postgres://user:${secretMarker}@db/crm" > backup.dump'`,
  'docker exec crm-db bash -o pipefail -c \'pg_restore --dbname "$DATABASE_URL" "$BACKUP"\'',
  'bash -lc \'# pg_dump "$DATABASE_URL" > ignored.dump\'',
].join('\n'))

const trackedFiles = [
  'gravity-mvp/src/modules/fleet-operations/owner.ts',
  'gravity-mvp/src/app/foreign.ts',
  'scripts/export-db.py',
  'scripts/restore-pg.sh',
  'scripts/migrate-data-to-vps.sh',
  'scripts/nested-db.sh',
]
const registry = {
  surfaces: trackedFiles.map((entry) => ({
    path: entry,
    lifecycle: 'APPLICATION_RUNTIME',
    owner_context: null,
  })),
}

// The inventory API normally asks Git for tracked files. Initialize a minimal
// repository so this integration test exercises that exact production path.
const { execFileSync } = await import('node:child_process')
execFileSync('git', ['init', '-q'], { cwd: root })
execFileSync('git', ['add', ...trackedFiles], { cwd: root })

const result = await inventoryCredentialAccess(root, { registry })
assert.equal(result.source.repository_root, '.')
assert.equal(new Set(result.accesses.map((entry) => (
  `${entry.file}:${entry.site_signature}:${entry.policy_id ?? '<null>'}:${entry.access}`
))).size, result.accesses.length)
assert(result.accesses.filter((entry) => entry.policy_id === null).every((entry) => (
  Array.isArray(entry.candidate_entities) && typeof entry.intended_access === 'string'
)))
assert.equal(result.summary.credential_database_accesses, 16)
assert.equal(result.summary.owner_direct_accesses, 1)
assert.equal(result.summary.foreign_direct_accesses, 1)
assert.equal(result.summary.secret_reads, 5)
assert.equal(result.summary.unresolved_database_accesses, 11)
assert.deepEqual(result.accesses.map((entry) => entry.context_classification).sort(), [
  'FOREIGN_DIRECT_DB_ACCESS',
  'OWNER_DIRECT_DB_ACCESS',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
  'UNCLASSIFIED',
])
assert(!JSON.stringify(result).includes('prisma.apiConnection'))
assert(!JSON.stringify(result).includes(secretMarker))
const commandAccesses = result.accesses.filter((entry) => entry.database_command_intent)
assert.deepEqual(commandAccesses.map((entry) => ({
  file: entry.file,
  intent: entry.database_command_intent,
  method: entry.method,
  access: entry.access,
})), [
  {
    file: 'scripts/export-db.py',
    intent: 'UNKNOWN',
    method: 'dynamic-mixed-database-unknown:query',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/export-db.py',
    intent: 'UNKNOWN',
    method: 'dynamic-mixed-database-unknown:fetch',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/migrate-data-to-vps.sh',
    intent: 'READ',
    method: 'dynamic-mixed-database-read:pg_dump',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/nested-db.sh',
    intent: 'WRITE',
    method: 'dynamic-mixed-database-write:pg_restore',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/nested-db.sh',
    intent: 'UNKNOWN',
    method: 'dynamic-mixed-database-unknown:psql',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/nested-db.sh',
    intent: 'READ',
    method: 'dynamic-mixed-database-read:pg_dump',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/nested-db.sh',
    intent: 'WRITE',
    method: 'dynamic-mixed-database-write:pg_restore',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/restore-pg.sh',
    intent: 'READ',
    method: 'dynamic-mixed-database-read:pg_dump',
    access: 'UNKNOWN',
  },
  {
    file: 'scripts/restore-pg.sh',
    intent: 'WRITE',
    method: 'dynamic-mixed-database-write:pg_restore',
    access: 'UNKNOWN',
  },
])
assert.deepEqual(
  result.accesses.filter((entry) => entry.file === 'scripts/restore-pg.sh').map((entry) => entry.line),
  [76, 82, 83, 87],
)
assert.deepEqual(
  result.accesses.filter((entry) => entry.file === 'scripts/export-db.py').map((entry) => ({
    line: entry.line,
    access: entry.access,
    entity: entry.entity,
    exposure: entry.credential_exposure,
    intent: entry.database_command_intent ?? null,
  })),
  [
    { line: 1, access: 'READ', entity: 'ApiConnection', exposure: 'SECRET_READ', intent: null },
    { line: 2, access: 'READ', entity: 'ApiConnection', exposure: 'SECRET_READ', intent: null },
    { line: 3, access: 'UNKNOWN', entity: null, exposure: 'AMBIGUOUS', intent: 'UNKNOWN' },
    { line: 4, access: 'READ', entity: 'Bot', exposure: 'SECRET_READ', intent: null },
    { line: 5, access: 'UNKNOWN', entity: null, exposure: 'AMBIGUOUS', intent: 'UNKNOWN' },
  ],
)

const mixed = mixedCredentialSqlFragments([
  'echo "SELECT token from bots"',
  'psql "$DATABASE_URL" -c "SELECT token FROM bots"',
  'cursor.execute("SELECT apiKey FROM ApiConnection")',
].join('\n'))
assert.deepEqual(mixed.map((fragment) => fragment.sql), [
  'SELECT token FROM bots',
  'SELECT apiKey FROM ApiConnection',
])

process.stdout.write('whole-repository credential inventory tests: PASS\n')
