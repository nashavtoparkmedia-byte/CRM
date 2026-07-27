import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DefaultSemanticComparisonEngine } from '../src/comparison/SemanticComparisonEngine.ts'
import { SAFE_COMPARISON_FIXTURES, comparisonInput } from './support/comparisonFixtures.ts'

interface SnapshotRow {
  fixtureId: string
  comparisonVersion: string
  legacySemanticSha256: string
  newSemanticSha256: string
  expectedClassification: string
  expectedDiffPaths: string[]
}

test('S7-SNAPSHOT-01 immutable safe fixture snapshot matches exact hashes, classification, and paths', async () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'support', 'comparisonSnapshot.json')
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as SnapshotRow[]
  const engine = new DefaultSemanticComparisonEngine()
  assert.equal(snapshot.length, SAFE_COMPARISON_FIXTURES.length)
  const actual = SAFE_COMPARISON_FIXTURES.map(fixture => {
    const compared = engine.compare(comparisonInput(fixture))
    return {
      fixtureId: fixture.fixtureId,
      comparisonVersion: engine.comparisonVersion,
      legacySemanticSha256: compared.legacy.semanticSha256,
      newSemanticSha256: compared.current.semanticSha256,
      expectedClassification: compared.classification,
      expectedDiffPaths: compared.diffs.map(diff => diff.path),
    }
  })
  assert.deepEqual(actual, snapshot)
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic inbound|synthetic caption|redacted-fixture-reference/)
})
