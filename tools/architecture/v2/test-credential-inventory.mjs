#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { inventoryCredentialAccess, mixedCredentialSqlFragments } from './credential-inventory.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'yoko-credential-inventory-'))
await mkdir(path.join(root, 'architecture/evidence/v1'), { recursive: true })
await mkdir(path.join(root, 'architecture/contexts/v1/manifests'), { recursive: true })
await mkdir(path.join(root, 'gravity-mvp/src/modules/fleet-operations'), { recursive: true })
await mkdir(path.join(root, 'gravity-mvp/src/app'), { recursive: true })
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

const trackedFiles = [
  'gravity-mvp/src/modules/fleet-operations/owner.ts',
  'gravity-mvp/src/app/foreign.ts',
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
assert.equal(result.summary.credential_database_accesses, 2)
assert.equal(result.summary.owner_direct_accesses, 1)
assert.equal(result.summary.foreign_direct_accesses, 1)
assert.equal(result.summary.secret_reads, 2)
assert.deepEqual(result.accesses.map((entry) => entry.context_classification).sort(), [
  'FOREIGN_DIRECT_DB_ACCESS',
  'OWNER_DIRECT_DB_ACCESS',
])
assert(!JSON.stringify(result).includes('prisma.apiConnection'))

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
