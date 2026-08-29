#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  assertAuthorityPredecessorInventory,
  assertPredecessorRuntimeInventory,
  assertRepositoryRawPredecessorEvidence,
  assertSanitizedPredecessorInventory,
  RAW_PREDECESSOR_EVIDENCE_PATH,
  runtimeMigrationRows,
} from './verify-production-migration-runtime.mjs'

const authority = JSON.parse(await readFile('architecture/migrations/v1/production-migration-authority.json', 'utf8'))
const predecessorInventory = JSON.parse(await readFile('architecture/migrations/v1/predecessor-runtime-migration-inventory.json', 'utf8'))
const rawPredecessorEvidence = await readFile(RAW_PREDECESSOR_EVIDENCE_PATH)
assert.equal(assertRepositoryRawPredecessorEvidence(rawPredecessorEvidence, predecessorInventory).length, 62)
const corruptRawPredecessorEvidence = Buffer.from(rawPredecessorEvidence)
corruptRawPredecessorEvidence[0] ^= 1
assert.throws(() => assertRepositoryRawPredecessorEvidence(corruptRawPredecessorEvidence, predecessorInventory), /capture checksum\/size mismatch/)
const records = authority.migrations
  .filter((row) => row.name !== authority.current_target.name)
  .map(({ name, sha256, size }) => ({ path: `/app/prisma/migrations/${name}/migration.sql`, sha256, size }))
records.push({
  path: '/app/prisma/migrations/20260223211509_add_is_linear_to_survey/migration.sql',
  sha256: '1e6f4be04902cc74473bb37b512acb3d1c3ce1010ad696dea48e8969f762fc8e',
  size: 2688,
})
const runtime = { evidence: { records } }
assert.equal(runtimeMigrationRows(runtime).length, 62)
assert.deepEqual(assertPredecessorRuntimeInventory(runtime, authority, predecessorInventory), { rows: 62, exact_inventory_match: true })
runtime.evidence.records[0].sha256 = '0'.repeat(64)
assert.throws(() => assertPredecessorRuntimeInventory(runtime, authority, predecessorInventory), /checksum\/name\/size mismatch/)

for (const mutate of [
  (candidate) => candidate.rows.pop(),
  (candidate) => candidate.rows.push({ name: '20269999999999_extra', sha256: '0'.repeat(64), size: 1 }),
  (candidate) => { candidate.rows[0].sha256 = '0'.repeat(64) },
  (candidate) => { candidate.rows[0].size += 1 },
  (candidate) => candidate.rows.reverse(),
  (candidate) => candidate.rows.push({ ...candidate.rows[0] }),
]) {
  const candidate = structuredClone(predecessorInventory)
  mutate(candidate)
  assert.throws(() => assertSanitizedPredecessorInventory(candidate))
}
const authorityCoTamper = structuredClone(authority)
authorityCoTamper.migrations[0].sha256 = '0'.repeat(64)
authorityCoTamper.migrations[0].size = 1
assert.throws(() => assertAuthorityPredecessorInventory(authorityCoTamper, predecessorInventory), /authority predecessor inventory checksum\/name\/size mismatch/)
process.stdout.write('production migration runtime inventory: PASS\n')
