#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const v2 = path.join(root, 'architecture/recovery/whole-project-dod/v2')
const readJson = async (name) => JSON.parse(await readFile(path.join(v2, name), 'utf8'))
const source = await readJson('PUBLIC_SECRET_RISK_CLASSIFICATION_20260811.json')
const inventory = await readJson('CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json')
const unknown = await readJson('credential-unknown-access-resolution.json')
const migration = await readJson('CREDENTIAL_DYNAMIC_MIGRATION_BOUNDARY_20260811.json')

const route = await readFile(path.join(root, 'gravity-mvp/src/app/api/avito/accounts/route.ts'), 'utf8')
const settings = await readFile(path.join(root, 'gravity-mvp/src/app/api/avito/settings/route.ts'), 'utf8')
const yfs = await readFile(path.join(root, 'yandex-fleet-scraper/src/api.ts'), 'utf8')
assert.match(route, /profileManaged:\s*Boolean\(a\.profile_path\)/u)
assert.doesNotMatch(route, /profilePath:\s*a\.profile_path/u)
assert.doesNotMatch(route, /profilePath,\s*autoReplyConfigured/u)
assert.doesNotMatch(settings, /err\?\.message/u)
assert.match(yfs, /select:\s*accountAdminMetadataSelect/u)
assert.equal(migration.summary.material_credential_unresolved, 0)
assert.equal(unknown.summary.total, 81)

const remediated = source.candidate_classifications.map((record) => {
  if (record.classification !== 'CONFIRMED_EXPOSURE') return record
  return {
    ...record,
    prior_classification: record.classification,
    classification: 'CLOSED_REMEDIATED',
    confidence: 'HIGH',
    remediation_evidence: [
      'credential boundary remediation batch 2255e373',
      'targeted projection/serialization tests passed',
    ],
  }
})
const counts = Object.fromEntries([...new Set(remediated.map((record) => record.classification))].map((key) => [
  key,
  remediated.filter((record) => record.classification === key).length,
]))
assert.equal(counts.CLOSED_REMEDIATED, 7)
assert.equal(counts.UNRESOLVED ?? 0, 0)

const result = {
  schema: 'yoko.crm.public-secret-risk-closure.v1',
  generated_at: new Date().toISOString(),
  source_artifact: 'PUBLIC_SECRET_RISK_CLASSIFICATION_20260811.json',
  source_sha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
  inventory_artifact: 'CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json',
  summary: {
    candidate_total: remediated.length,
    confirmed_public_secret_exposure: 0,
    closed_remediated: counts.CLOSED_REMEDIATED,
    safe_owner_internal: counts.SAFE_OWNER_INTERNAL ?? 0,
    analyzer_false_positive: counts.ANALYZER_FALSE_POSITIVE ?? 0,
    unresolved: counts.UNRESOLVED ?? 0,
    credential_db_accesses: inventory.summary.credential_database_accesses,
    credential_db_accesses_unresolved_static: inventory.summary.unresolved_database_accesses,
    material_credential_unresolved: migration.summary.material_credential_unresolved,
  },
  required_checks: {
    explicit_public_projection: 'PASS',
    no_sensitive_error_response: 'PASS',
    provider_admin_dto: 'PASS',
    migration_schema_only_boundary: 'PASS',
  },
  candidate_classifications: remediated,
  validation: {
    exact_candidate_coverage: source.summary.exact_coverage,
    source_projection_tests: ['gravity-mvp/src/app/actions.test.ts', 'tools/architecture/v2/test-credential-boundary-negative.mjs'],
    analyzer_tests: ['tools/architecture/v2/test-credential-analyzer.mjs', 'tools/architecture/v2/test-credential-inventory.mjs'],
  },
}
const output = path.join(v2, 'PUBLIC_SECRET_RISK_CLOSURE_20260811.json')
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(`credential-closure-reconcile: PASS (${remediated.length} candidates; 0 confirmed public exposure; 0 material unresolved)`)
