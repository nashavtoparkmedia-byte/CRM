#!/usr/bin/env node
import assert from 'node:assert/strict'
import { access, chmod, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateProductionMigrationAuthority } from './production-migration-authority.mjs'

const root = process.cwd()

async function makeFixtureTreeWritable(directory) {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await makeFixtureTreeWritable(target)
    else await chmod(target, 0o600)
  }
}

const fixture = await mkdtemp(path.join(os.tmpdir(), 'yoko-migration-clean-checkout-'))
try {
  for (const relative of [
    'gravity-mvp/prisma/migrations',
    'architecture/migrations/v1/archive/pre-outbox',
    'architecture/migrations/v1/provenance',
  ]) {
    await cp(path.join(root, relative), path.join(fixture, relative), { recursive: true })
  }
  await makeFixtureTreeWritable(path.join(fixture, 'architecture/migrations/v1/provenance'))
  for (const relative of [
    'gravity-mvp/prisma/schema.prisma',
    'architecture/migrations/v1/production-migration-authority.json',
    'architecture/migrations/v1/predecessor-runtime-migration-inventory.json',
  ]) {
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true })
    await cp(path.join(root, relative), path.join(fixture, relative))
  }
  await assert.rejects(access(path.join(fixture, '.git')), { code: 'ENOENT' })
  assert.deepEqual(await validateProductionMigrationAuthority(fixture), {
    active: 44,
    archive: 18,
    total: 62,
    inventoryDigest: 'dc29667f6f72842a9d9452f5aff44f49f6296cfde111da6bc5daca6c83aec669',
  })
} finally {
  await rm(fixture, { recursive: true, force: true })
}
process.stdout.write('production migration default-clean-checkout provenance: PASS\n')
