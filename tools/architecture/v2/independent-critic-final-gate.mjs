#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { authorizeMaintenanceWrite, validateCapabilityRegistry } from './maintenance-capability-policy.mjs'

const root = new URL('../../../', import.meta.url).pathname
const readJson = (path) => JSON.parse(readFileSync(`${root}${path}`, 'utf8'))
const sha256 = (path) => createHash('sha256').update(readFileSync(`${root}${path}`)).digest('hex')

const baseline = readJson('architecture/recovery/whole-project-dod/v2/CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json')
const triage = readJson('architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_FINAL_CLOSURE.json')
const capabilities = readJson('architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json')
const credentialClosure = readJson('architecture/recovery/whole-project-dod/v2/PUBLIC_SECRET_RISK_CLOSURE_20260811.json')
const credentialMigration = readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_DYNAMIC_MIGRATION_BOUNDARY_20260811.json')
const credentialFields = readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_SENSITIVE_FIELD_REGISTRY.json')
const crossDomain = readJson('architecture/recovery/whole-project-dod/v2/CROSS_DOMAIN_CREDENTIAL_REVIEW_20260811.json')

assert.equal(baseline.execution.complete, true, 'authoritative scan incomplete')
assert.equal(baseline.execution.worker_failures, 0, 'worker failures present')
assert.equal(baseline.execution.worker_timeouts, 0, 'worker timeouts present')
assert.equal(baseline.inventory.summary.tracked_executable_surfaces, 1725, 'tracked denominator drift')
assert.equal(baseline.summary.tracked_executable_surfaces, 1725, 'scan denominator drift')
assert.equal(baseline.summary.foreign_writes, 0, 'foreign write false negative risk')
assert.equal(baseline.summary.unreviewed_operational_surfaces, 0, 'operational bypass remains unclassified')
assert.equal(triage.summary.RECONCILIATION_EXACT, true, 'ambiguous denominator reconciliation is not exact')
assert.equal(triage.summary.MATERIAL_UNRESOLVED_WRITE_RISK, 0, 'material ambiguity remains')
assert.equal(triage.summary.DYNAMIC_DELEGATE_UNRESOLVED, 0, 'dynamic delegate ambiguity remains')
assert.equal(triage.summary.DYNAMIC_SQL_UNRESOLVED, 0, 'dynamic SQL ambiguity remains')
assert.equal(triage.summary.QUERY_RAW_SIDE_EFFECT_UNRESOLVED, 0, 'queryRaw ambiguity remains')
assert.equal(sha256('architecture/recovery/whole-project-dod/v2/CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json'), sha256('architecture/recovery/whole-project-dod/v2/AUTHORITATIVE_WRITE_SCAN_20260811T131500Z.json'), 'stale baseline artifact')

assert.deepEqual(validateCapabilityRegistry(capabilities), [], 'capability registry invalid')
const approved = { capabilities: [{ capability_id: 'critic.exact.v1', status: 'APPROVED', approved: true, source: { path: 'scripts/owner.js', site_signatures: ['site-a'] }, target: { data_owner: 'messages', exact_names: ['chat'], operations: ['update'] } }] }
assert.equal(authorizeMaintenanceWrite(approved, { source_path: 'scripts/owner.js', site_signature: 'site-a', data_owner: 'messages', target: 'chat', operation: 'update' }), true)
assert.equal(authorizeMaintenanceWrite(approved, { source_path: 'scripts/owner.js', site_signature: 'site-a', data_owner: 'messages', target: 'user', operation: 'update' }), false, 'unrelated writer operation authorized')

assert.equal(existsSync(`${root}gravity-mvp/src/app/api/debug-db/list-connections/route.ts`), false, 'debug DB endpoint still exposed')
assert.equal(existsSync(`${root}tg-bot/tg-bot-frontend/pages/api/export.js`), false, 'unauthenticated export endpoint still exposed')
assert.equal(existsSync(`${root}gravity-mvp/src/modules/messaging/public/v1`), true, 'protected Messages owner path missing')
assert.equal(existsSync(`${root}gravity-mvp/src/lib/ai-call`), true, 'protected AI Calls path missing')
assert.equal(credentialClosure.summary.candidate_total, 150, 'credential candidate denominator drift')
assert.equal(credentialClosure.summary.confirmed_public_secret_exposure, 0, 'public secret exposure remains')
assert.equal(credentialClosure.summary.unresolved, 0, 'credential candidate unresolved records remain')
assert.equal(credentialClosure.summary.material_credential_unresolved, 0, 'material credential ambiguity remains')
assert.equal(credentialMigration.summary.material_credential_unresolved, 0, 'dynamic migration materiality unresolved')
assert.equal(credentialFields.records.length, 14, 'sensitive-field registry drift')
assert.equal(crossDomain.exact_coverage, true, 'cross-domain credential coverage drift')
assert.equal(crossDomain.summary.confirmed_unapproved_secret_reads, 0, 'confirmed unapproved cross-domain secret read remains')

const criticStatus = crossDomain.summary.material_capability_gap_remaining === 0
  ? 'PASS'
  : 'PASS_WITH_OPEN_CROSS_DOMAIN_CAPABILITY_GAPS'
console.log(`independent final-gate critic: ${criticStatus} (denominator, ambiguity, credential fields, public serialization, cross-domain capability, ownership, capability scope, operational bypass, debug boundary, protected paths)`)
