#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { deriveCurrentDependencySource, deriveFinalDependencySource } from './derive-final-dependency-source.mjs'
import { materializeFinalDependencyArtifact } from './materialize-final-dependency-artifact.mjs'

const root = process.cwd()
const sourcePath = 'architecture/contexts/v1/final-dependency-source.json'
const currentPath = 'architecture/contexts/v1/final-dependency-current.json'
const historicalPath = 'architecture/contexts/v1/dependency-transition-plan.json'
const source = await readFile(path.join(root, sourcePath), 'utf8')
const current = JSON.parse(await readFile(path.join(root, currentPath), 'utf8'))

assert.ok(await readFile(path.join(root, historicalPath), 'utf8'), 'historical dependency transition plan must be preserved')
assert.equal(JSON.parse(await readFile(path.join(root, historicalPath), 'utf8')).historical_status, 'ARCHIVED_BASELINE_EVIDENCE_NOT_CURRENT_DEPENDENCY_TRUTH')
assert.deepEqual(current, materializeFinalDependencyArtifact(source))
assert.equal(current.summary.forbidden_dependencies, 0)
assert.equal(current.summary.public_surface_migrations, 0)
assert(current.summary.cross_context_imports > 0)
assert(current.summary.relationships > 0)
assert.deepEqual(JSON.parse(source), await deriveCurrentDependencySource(root))

const derivedFixture = deriveFinalDependencySource({
  policy: { id: 'fixture' },
  findings: [],
  scanned_files: 2,
  observed_cross_context_imports: [
    { kind: 'static', source_context: 'calling', source_file: 'a.ts', specifier: './b', target_context: 'contacts', target_file: 'b.ts' },
    { kind: 'static', source_context: 'calling', source_file: 'c.ts', specifier: './b', target_context: 'contacts', target_file: 'b.ts' },
  ],
})
assert.equal(derivedFixture.observed.cross_context_imports, 2)
assert.equal(derivedFixture.relationship_projection.count, 1)
assert.match(derivedFixture.relationship_projection.sha256, /^[0-9a-f]{64}$/)

assert.throws(() => materializeFinalDependencyArtifact(JSON.stringify({
  schema: 'yoko.crm.accepted-dependency-source.v1', version: 1,
  derivation: { kind: 'architecture-enforcement-observed-cross-context-imports' },
  observed: { cross_context_imports: 0, cross_context_imports_sha256: '0'.repeat(64) },
  relationship_projection: { count: 0, sha256: '0'.repeat(64) },
  public_surface_migrations: [],
})), /relationship projection missing/)
process.stdout.write('final dependency artifact: PASS\n')
