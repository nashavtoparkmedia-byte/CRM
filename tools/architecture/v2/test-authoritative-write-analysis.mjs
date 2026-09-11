#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { verifyAuthoritativeWriteAnalysis } from './verify-authoritative-write-analysis.mjs'

const triageSignature = 'accepted-ambiguous'
const acceptedAmbiguousSite = {
  classification: 'AMBIGUOUS', site_signature: triageSignature,
  file: 'script.js', line: 1, column: 1, kind: 'ambiguous_model', method: '$queryRaw',
}
const reviewRecordFor = (site, semanticState = 'OWNER_VALID_WRITE', extra = {}) => ({
  ...site,
  record_id: site.site_signature,
  semantic_state: semanticState,
  disposition: semanticState === 'RESOLVED_NON_WRITE'
    ? 'CONFIRMED_NON_WRITE'
    : semanticState === 'MATERIAL_UNRESOLVED_WRITE_RISK'
      ? 'MATERIAL_UNRESOLVED_WRITE_RISK'
      : 'CONFIRMED_WRITE_OWNER_RESOLVED',
  rationale: 'Exact fixture review.',
  ...extra,
})
const triage = {
  summary: { RECONCILIATION_EXACT: true, MATERIAL_UNRESOLVED_WRITE_RISK: 0 },
  current_exact_review: {
    ambiguous_denominator: 1,
    sorted_site_signatures_sha256: createHash('sha256').update(`${triageSignature}\n`).digest('hex'),
  },
  records: [reviewRecordFor(acceptedAmbiguousSite)],
}
const capabilities = { capabilities: [] }
const analysis = {
  schema: 'yoko.crm.whole-repository-write-analysis.v2',
  execution: { complete: true, worker_failures: 0, worker_timeouts: 0 },
  summary: {
    tracked_executable_surfaces: 10,
    discovered_write_sites: 3,
    foreign_writes: 0,
    parse_findings: 0,
    unreviewed_operational_surfaces: 0,
  },
  write_sites: [
    { classification: 'OWNER', site_signature: 'owner' },
    { classification: 'OWNER', site_signature: 'second-owner' },
    acceptedAmbiguousSite,
  ],
}

assert.equal(verifyAuthoritativeWriteAnalysis(analysis, triage, analysis, capabilities).status, 'PASS')
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  summary: { ...analysis.summary, foreign_writes: 1 },
}, triage, analysis, capabilities), /confirmed foreign write/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  write_sites: [...analysis.write_sites, {
    classification: 'AMBIGUOUS', site_signature: 'new-ambiguous', file: 'new.js', line: 2, method: 'dynamic',
  }],
}, triage, analysis, capabilities), /one-to-one/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  execution: { ...analysis.execution, worker_timeouts: 1 },
}, triage, analysis, capabilities), /worker timeout/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  summary: { ...analysis.summary, unreviewed_operational_surfaces: 1 },
}, triage, analysis, capabilities), /operational surface bypass/)

assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  summary: { ...analysis.summary, tracked_executable_surfaces: 0, discovered_write_sites: 0 },
}, triage, analysis, capabilities), /surface denominator shrank/)

assert.throws(() => verifyAuthoritativeWriteAnalysis(analysis, {
  ...triage,
  records: [...triage.records, triage.records[0]],
}, analysis, capabilities), /duplicate site signatures/)
assert.throws(() => verifyAuthoritativeWriteAnalysis(analysis, {
  ...triage,
  current_exact_review: { ...triage.current_exact_review, sorted_site_signatures_sha256: 'stale' },
}, analysis, capabilities), /signature digest is stale/)

const activeMaintenanceSourceSha256 = '9'.repeat(64)
const activeMaintenance = {
  ...analysis,
  summary: { ...analysis.summary, discovered_write_sites: 4 },
  write_sites: [...analysis.write_sites, {
    classification: 'OWNER',
    site_signature: 'maintenance-contact-update',
    file: 'scripts/fix-contact.ts',
    line: 10,
    method: 'update',
    source_sha256: activeMaintenanceSourceSha256,
    model: 'contact',
    candidate_models: ['contact'],
    owner_contexts: ['contacts'],
    surface: {
      lifecycle: 'OPERATIONAL_SCRIPT',
      disposition: 'ACTIVE',
      production_capability: 'CONFIRMED_MANUAL_OPERATOR',
      maintenance_lifecycle: 'RECOVERY',
      registry_classified: true,
    },
  }],
}
const approvedCapabilities = { capabilities: [{
  capability_id: 'mmc.v1.contacts.fixture',
  status: 'APPROVED',
  approved: true,
  source: { path: 'scripts/fix-contact.ts', source_sha256: activeMaintenanceSourceSha256, site_signatures: ['maintenance-contact-update'] },
  lifecycle: 'RECOVERY',
  lifecycle_evidence_status: 'REVIEWED_ACTIVE',
  invocation: { production_reachability: 'CONFIRMED_MANUAL_OPERATOR' },
  target: { kind: 'MODEL', data_owner: 'contacts', exact_names: ['contact'], operations: ['update'] },
}] }
const verifyMaintenance = (
  candidateAnalysis = activeMaintenance,
  candidateCapabilities = approvedCapabilities,
  sourceHashes = { 'scripts/fix-contact.ts': activeMaintenanceSourceSha256 },
) => verifyAuthoritativeWriteAnalysis(candidateAnalysis, triage, analysis, candidateCapabilities, null, sourceHashes)
assert.equal(verifyMaintenance().status, 'PASS')
assert.throws(() => verifyMaintenance(activeMaintenance, capabilities), /exact approved capability/)
assert.throws(() => verifyMaintenance(activeMaintenance, {
  capabilities: [{ ...approvedCapabilities.capabilities[0], target: { ...approvedCapabilities.capabilities[0].target, operations: ['deleteMany'] } }],
}), /exact approved capability/)
assert.throws(() => verifyMaintenance({
  ...activeMaintenance,
  write_sites: activeMaintenance.write_sites.map((site) => site.site_signature === 'maintenance-contact-update'
    ? { ...site, source_sha256: '8'.repeat(64) }
    : site),
}), /analysis source-byte drift/)
assert.throws(() => verifyMaintenance(activeMaintenance, approvedCapabilities, {}), /source hash is missing/)
assert.throws(() => verifyMaintenance(activeMaintenance, approvedCapabilities, {
  'scripts/fix-contact.ts': '8'.repeat(64),
}), /analysis source-byte drift/)
assert.throws(() => verifyMaintenance(activeMaintenance, {
  capabilities: [{ ...approvedCapabilities.capabilities[0], invocation: { production_reachability: 'UNKNOWN' } }],
}), /registry is invalid/)
assert.throws(() => verifyMaintenance({
  ...activeMaintenance,
  write_sites: activeMaintenance.write_sites.map((site) => site.site_signature === 'maintenance-contact-update'
    ? { ...site, surface: { ...site.surface, registry_classified: false } }
    : site),
}), /reviewed lifecycle classification/)
assert.throws(() => verifyMaintenance({
  ...activeMaintenance,
  write_sites: activeMaintenance.write_sites.map((site) => site.site_signature === 'maintenance-contact-update'
    ? { ...site, surface: { ...site.surface, production_capability: 'UNKNOWN' } }
    : site),
}), /production reachability is unknown/)
assert.throws(() => verifyMaintenance({
  ...activeMaintenance,
  write_sites: activeMaintenance.write_sites.map((site) => site.site_signature === 'maintenance-contact-update'
    ? { ...site, surface: { ...site.surface, disposition: 'UNREVIEWED' } }
    : site),
}), /lifecycle disposition is not fail-closed/)

const nonWriteSite = {
  classification: 'AMBIGUOUS',
  site_signature: 'reviewed-read-only-sql',
  file: 'scripts/report.ts',
  line: 20,
  column: 7,
  method: '$queryRaw',
  kind: 'raw',
  operations: [],
  read_tables: ['Contact'],
  selected_columns: ['id'],
  called_functions: [],
  sql_sha256: 'a'.repeat(64),
  source_sha256: 'b'.repeat(64),
  sql_provenance_sha256: 'c'.repeat(64),
  surface: { lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE', production_capability: 'POSSIBLE', registry_classified: true },
}
const nonWriteAnalysis = {
  ...analysis,
  write_sites: [...analysis.write_sites.filter((site) => site.site_signature !== 'accepted-ambiguous'), nonWriteSite],
}
const nonWriteRecord = {
  ...reviewRecordFor(nonWriteSite, 'RESOLVED_NON_WRITE'),
  rationale: 'Exact SQL review proves a read-only projection.',
}
const nonWriteProof = {
  site_signature: nonWriteSite.site_signature,
  classification: 'READ_ONLY_SQL_PROJECTION',
  source: {
    file: nonWriteSite.file, line: nonWriteSite.line, column: nonWriteSite.column, method: nonWriteSite.method,
    source_sha256: nonWriteSite.source_sha256, sql_provenance_sha256: nonWriteSite.sql_provenance_sha256,
  },
  resolved_target: {
    kind: 'SQL_READ_PROJECTION', read_tables: ['Contact'], selected_columns: ['id'],
    sql_sha256: 'a'.repeat(64), reviewed_read_only_functions: [],
  },
  evidence: [
    'scripts/report.ts:20:7', `analysis_site_signature:${nonWriteSite.site_signature}`,
    `sql_sha256:${'a'.repeat(64)}`, `source_sha256:${nonWriteSite.source_sha256}`,
    `sql_provenance_sha256:${nonWriteSite.sql_provenance_sha256}`,
  ],
}
const nonWriteTriage = {
  ...triage,
  current_exact_review: {
    ...triage.current_exact_review,
    sorted_site_signatures_sha256: createHash('sha256').update(`${nonWriteSite.site_signature}\n`).digest('hex'),
  },
  records: [nonWriteRecord],
  non_write_proofs: [nonWriteProof],
}
assert.equal(verifyAuthoritativeWriteAnalysis(nonWriteAnalysis, nonWriteTriage, analysis, capabilities).status, 'PASS')
assert.throws(() => verifyAuthoritativeWriteAnalysis(nonWriteAnalysis, { ...nonWriteTriage, non_write_proofs: [] }, analysis, capabilities), /one-to-one exact proofs/)
assert.throws(() => verifyAuthoritativeWriteAnalysis(nonWriteAnalysis, { ...nonWriteTriage, non_write_proofs: [{ ...nonWriteProof, evidence: [] }] }, analysis, capabilities), /lacks exact evidence/)
assert.throws(() => verifyAuthoritativeWriteAnalysis(nonWriteAnalysis, { ...nonWriteTriage, non_write_proofs: [{ ...nonWriteProof, resolved_target: null }] }, analysis, capabilities), /lacks exact target/)
assert.throws(() => verifyAuthoritativeWriteAnalysis(nonWriteAnalysis, { ...nonWriteTriage, non_write_proofs: [{ ...nonWriteProof, classification: 'PENDING_REVIEW' }] }, analysis, capabilities), /retains unresolved language/)
const statusFlipTriage = {
  ...triage,
  records: [{ ...triage.records[0], semantic_state: 'RESOLVED_NON_WRITE', disposition: 'CONFIRMED_NON_WRITE', rationale: 'status-only mutation' }],
  non_write_proofs: [],
}
assert.throws(() => verifyAuthoritativeWriteAnalysis(analysis, statusFlipTriage, analysis, capabilities), /one-to-one exact proofs/)
const writeSuppressionAnalysis = {
  ...nonWriteAnalysis,
  write_sites: nonWriteAnalysis.write_sites.map((site) => site.site_signature === nonWriteSite.site_signature
    ? { ...site, method: 'update', operations: [{ table: 'Contact' }] }
    : site),
}
const writeSuppressionProof = {
  ...nonWriteProof,
  source: { ...nonWriteProof.source, method: 'update' },
}
assert.throws(() => verifyAuthoritativeWriteAnalysis(writeSuppressionAnalysis, {
  ...nonWriteTriage,
  records: [reviewRecordFor(writeSuppressionAnalysis.write_sites.find((site) => site.site_signature === nonWriteSite.site_signature), 'RESOLVED_NON_WRITE')],
  non_write_proofs: [writeSuppressionProof],
}, analysis, capabilities), /cannot suppress an analyzed write operation/)

const mixedScriptReadSite = {
  classification: 'AMBIGUOUS',
  site_signature: 'reviewed-static-mixed-script-sql',
  file: 'runtime/profile.py',
  line: 40,
  column: 12,
  method: 'mixed-script-sql',
  kind: 'raw',
  fragment_source: 'embedded_database_string',
  operations: [],
  read_tables: ['pg_control_system'],
  selected_columns: ['system_identifier', 'text'],
  called_functions: ['current_setting', 'pg_control_system'],
  sql_sha256: 'b'.repeat(64),
  source_sha256: 'd'.repeat(64),
  sql_provenance_sha256: 'e'.repeat(64),
  ambiguity_reasons: ['dynamic_sql_fragment', 'select_function_side_effect_unresolved'],
  surface: { lifecycle: 'APPLICATION_RUNTIME', disposition: null, production_capability: 'POSSIBLE', registry_classified: false },
}
const mixedScriptReadAnalysis = {
  ...analysis,
  write_sites: [...analysis.write_sites.filter((site) => site.site_signature !== triageSignature), mixedScriptReadSite],
}
const mixedScriptReadRecord = {
  ...reviewRecordFor(mixedScriptReadSite, 'RESOLVED_NON_WRITE'),
  rationale: 'Exact SQL and function review proves a read-only server-identity projection.',
}
const mixedScriptReadProof = {
  site_signature: mixedScriptReadSite.site_signature,
  classification: 'STATIC_MIXED_SCRIPT_SQL_READ',
  source: {
    file: mixedScriptReadSite.file, line: mixedScriptReadSite.line, column: mixedScriptReadSite.column, method: mixedScriptReadSite.method,
    source_sha256: mixedScriptReadSite.source_sha256,
    sql_provenance_sha256: mixedScriptReadSite.sql_provenance_sha256,
  },
  resolved_target: {
    kind: 'STATIC_MIXED_SCRIPT_SQL_READ',
    fragment_source: 'embedded_database_string',
    read_tables: ['pg_control_system'],
    selected_columns: ['system_identifier', 'text'],
    sql_sha256: 'b'.repeat(64),
    reviewed_read_only_functions: ['current_setting', 'pg_control_system'],
  },
  evidence: [
    'runtime/profile.py:40:12', `analysis_site_signature:${mixedScriptReadSite.site_signature}`,
    `sql_sha256:${'b'.repeat(64)}`, `source_sha256:${mixedScriptReadSite.source_sha256}`,
    `sql_provenance_sha256:${mixedScriptReadSite.sql_provenance_sha256}`,
  ],
}
const mixedScriptReadTriage = {
  ...triage,
  current_exact_review: {
    ...triage.current_exact_review,
    sorted_site_signatures_sha256: createHash('sha256').update(`${mixedScriptReadSite.site_signature}\n`).digest('hex'),
  },
  records: [mixedScriptReadRecord],
  non_write_proofs: [mixedScriptReadProof],
}
assert.equal(verifyAuthoritativeWriteAnalysis(mixedScriptReadAnalysis, mixedScriptReadTriage, analysis, capabilities).status, 'PASS')
const escapedHashingReadSite = {
  ...mixedScriptReadSite,
  site_signature: 'reviewed-static-mixed-script-hashing-sql',
  called_functions: ['convert_to', 'encode', 'octet_length', 'sha256'],
  ambiguity_reasons: ['dialect_dependent_string_escape', 'dynamic_sql_fragment', 'select_function_side_effect_unresolved'],
}
const escapedHashingReadAnalysis = {
  ...mixedScriptReadAnalysis,
  write_sites: mixedScriptReadAnalysis.write_sites.map(site => (
    site.site_signature === mixedScriptReadSite.site_signature ? escapedHashingReadSite : site
  )),
}
const escapedHashingReadTriage = {
  ...mixedScriptReadTriage,
  current_exact_review: {
    ...mixedScriptReadTriage.current_exact_review,
    sorted_site_signatures_sha256: createHash('sha256').update(`${escapedHashingReadSite.site_signature}\n`).digest('hex'),
  },
  records: [{
    ...reviewRecordFor(escapedHashingReadSite, 'RESOLVED_NON_WRITE'),
    rationale: 'Exact SQL review proves a read-only hashing projection.',
  }],
  non_write_proofs: [{
    ...mixedScriptReadProof,
    site_signature: escapedHashingReadSite.site_signature,
    resolved_target: {
      ...mixedScriptReadProof.resolved_target,
      reviewed_read_only_functions: escapedHashingReadSite.called_functions,
    },
    evidence: mixedScriptReadProof.evidence.map(value => value === `analysis_site_signature:${mixedScriptReadSite.site_signature}`
      ? `analysis_site_signature:${escapedHashingReadSite.site_signature}`
      : value),
  }],
}
assert.equal(verifyAuthoritativeWriteAnalysis(escapedHashingReadAnalysis, escapedHashingReadTriage, analysis, capabilities).status, 'PASS')
const analyzerResolvedFunctionReadSite = {
  ...mixedScriptReadSite,
  site_signature: 'reviewed-static-mixed-script-analyzer-resolved-functions',
  ambiguity_reasons: ['dynamic_sql_fragment'],
}
const analyzerResolvedFunctionReadAnalysis = {
  ...mixedScriptReadAnalysis,
  write_sites: mixedScriptReadAnalysis.write_sites.map(site => (
    site.site_signature === mixedScriptReadSite.site_signature ? analyzerResolvedFunctionReadSite : site
  )),
}
const analyzerResolvedFunctionReadTriage = {
  ...mixedScriptReadTriage,
  current_exact_review: {
    ...mixedScriptReadTriage.current_exact_review,
    sorted_site_signatures_sha256: createHash('sha256').update(`${analyzerResolvedFunctionReadSite.site_signature}\n`).digest('hex'),
  },
  records: [{
    ...reviewRecordFor(analyzerResolvedFunctionReadSite, 'RESOLVED_NON_WRITE'),
    rationale: 'Exact SQL review proves a read-only projection after the analyzer resolved function side effects.',
  }],
  non_write_proofs: [{
    ...mixedScriptReadProof,
    site_signature: analyzerResolvedFunctionReadSite.site_signature,
    evidence: mixedScriptReadProof.evidence.map(value => value === `analysis_site_signature:${mixedScriptReadSite.site_signature}`
      ? `analysis_site_signature:${analyzerResolvedFunctionReadSite.site_signature}`
      : value),
  }],
}
assert.equal(verifyAuthoritativeWriteAnalysis(
  analyzerResolvedFunctionReadAnalysis,
  analyzerResolvedFunctionReadTriage,
  analysis,
  capabilities,
).status, 'PASS')
const escapedAnalyzerResolvedFunctionReadSite = {
  ...analyzerResolvedFunctionReadSite,
  site_signature: 'reviewed-static-mixed-script-escaped-analyzer-resolved-functions',
  ambiguity_reasons: ['dialect_dependent_string_escape', 'dynamic_sql_fragment'],
}
const escapedAnalyzerResolvedFunctionReadAnalysis = {
  ...analyzerResolvedFunctionReadAnalysis,
  write_sites: analyzerResolvedFunctionReadAnalysis.write_sites.map(site => (
    site.site_signature === analyzerResolvedFunctionReadSite.site_signature ? escapedAnalyzerResolvedFunctionReadSite : site
  )),
}
const escapedAnalyzerResolvedFunctionReadTriage = {
  ...analyzerResolvedFunctionReadTriage,
  current_exact_review: {
    ...analyzerResolvedFunctionReadTriage.current_exact_review,
    sorted_site_signatures_sha256: createHash('sha256').update(`${escapedAnalyzerResolvedFunctionReadSite.site_signature}\n`).digest('hex'),
  },
  records: [{
    ...reviewRecordFor(escapedAnalyzerResolvedFunctionReadSite, 'RESOLVED_NON_WRITE'),
    rationale: 'Exact escaped SQL review proves a read-only projection after the analyzer resolved function side effects.',
  }],
  non_write_proofs: [{
    ...analyzerResolvedFunctionReadTriage.non_write_proofs[0],
    site_signature: escapedAnalyzerResolvedFunctionReadSite.site_signature,
    evidence: analyzerResolvedFunctionReadTriage.non_write_proofs[0].evidence.map(value => (
      value === `analysis_site_signature:${analyzerResolvedFunctionReadSite.site_signature}`
        ? `analysis_site_signature:${escapedAnalyzerResolvedFunctionReadSite.site_signature}`
        : value
    )),
  }],
}
assert.equal(verifyAuthoritativeWriteAnalysis(
  escapedAnalyzerResolvedFunctionReadAnalysis,
  escapedAnalyzerResolvedFunctionReadTriage,
  analysis,
  capabilities,
).status, 'PASS')
const invalidMixedScriptReasonSite = {
  ...analyzerResolvedFunctionReadSite,
  ambiguity_reasons: ['dynamic_sql_fragment', 'unreviewed_reason'],
}
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analyzerResolvedFunctionReadAnalysis,
  write_sites: analyzerResolvedFunctionReadAnalysis.write_sites.map((site) => (
    site.site_signature === analyzerResolvedFunctionReadSite.site_signature ? invalidMixedScriptReasonSite : site
  )),
}, {
  ...analyzerResolvedFunctionReadTriage,
  records: [{
    ...reviewRecordFor(invalidMixedScriptReasonSite, 'RESOLVED_NON_WRITE'),
    rationale: 'Malformed analyzer ambiguity reason must remain fail closed.',
  }],
}, analysis, capabilities), /ambiguity shape drift/)
assert.throws(() => verifyAuthoritativeWriteAnalysis(mixedScriptReadAnalysis, {
  ...mixedScriptReadTriage,
  non_write_proofs: [{ ...mixedScriptReadProof, resolved_target: { ...mixedScriptReadProof.resolved_target, sql_sha256: 'c'.repeat(64) } }],
}, analysis, capabilities), /target drift/)
assert.throws(() => verifyAuthoritativeWriteAnalysis(mixedScriptReadAnalysis, {
  ...mixedScriptReadTriage,
  non_write_proofs: [{ ...mixedScriptReadProof, resolved_target: { ...mixedScriptReadProof.resolved_target, reviewed_read_only_functions: [] } }],
}, analysis, capabilities), /function projection drift/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...mixedScriptReadAnalysis,
  write_sites: mixedScriptReadAnalysis.write_sites.map((site) => site.site_signature === mixedScriptReadSite.site_signature
    ? { ...site, fragment_source: 'database_heredoc' }
    : site),
}, mixedScriptReadTriage, analysis, capabilities), /semantic projection drift/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...mixedScriptReadAnalysis,
  write_sites: mixedScriptReadAnalysis.write_sites.map((site) => site.site_signature === mixedScriptReadSite.site_signature
    ? { ...site, ambiguity_reasons: ['dynamic_sql_fragment'] }
    : site),
}, mixedScriptReadTriage, analysis, capabilities), /semantic projection drift/)

for (const reviewedFunctions of [
  ['definitely_not_read_only'],
  ['current_setting'],
  ['current_setting', 'pg_control_system', 'to_regclass'],
]) {
  assert.throws(() => verifyAuthoritativeWriteAnalysis(mixedScriptReadAnalysis, {
    ...mixedScriptReadTriage,
    non_write_proofs: [{
      ...mixedScriptReadProof,
      resolved_target: { ...mixedScriptReadProof.resolved_target, reviewed_read_only_functions: reviewedFunctions },
    }],
  }, analysis, capabilities), /function projection drift/)
}
const unsupportedFunctionSite = {
  ...mixedScriptReadSite,
  called_functions: ['mutating_extension_function'],
}
const unsupportedFunctionAnalysis = {
  ...mixedScriptReadAnalysis,
  write_sites: mixedScriptReadAnalysis.write_sites.map((site) => site.site_signature === mixedScriptReadSite.site_signature
    ? unsupportedFunctionSite
    : site),
}
assert.throws(() => verifyAuthoritativeWriteAnalysis(unsupportedFunctionAnalysis, {
  ...mixedScriptReadTriage,
  records: [reviewRecordFor(unsupportedFunctionSite, 'RESOLVED_NON_WRITE')],
  non_write_proofs: [{
    ...mixedScriptReadProof,
    resolved_target: { ...mixedScriptReadProof.resolved_target, reviewed_read_only_functions: unsupportedFunctionSite.called_functions },
  }],
}, analysis, capabilities), /outside the independent read-only allowlist/)
const upstreamMutationSite = {
  ...mixedScriptReadSite,
  source_sha256: 'f'.repeat(64),
  sql_provenance_sha256: '1'.repeat(64),
}
const upstreamMutationAnalysis = {
  ...mixedScriptReadAnalysis,
  write_sites: mixedScriptReadAnalysis.write_sites.map((site) => site.site_signature === mixedScriptReadSite.site_signature
    ? upstreamMutationSite
    : site),
}
assert.throws(() => verifyAuthoritativeWriteAnalysis(upstreamMutationAnalysis, {
  ...mixedScriptReadTriage,
  records: [reviewRecordFor(upstreamMutationSite, 'RESOLVED_NON_WRITE')],
}, analysis, capabilities), /source\/provenance drift/)

for (const mutation of [
  { owner_contexts: ['foreign_owner'] },
  { model: 'DifferentModel', candidate_models: ['DifferentModel'] },
  { operations: [{ table: 'DifferentTable', operation: 'DELETE' }] },
  { ambiguity_reasons: ['scoped_operation_not_allowed'], unresolved_targets: ['DifferentModel'] },
  { surface: { lifecycle: 'APPLICATION_RUNTIME', production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT', registry_classified: true } },
]) {
  const changed = { ...acceptedAmbiguousSite, ...mutation }
  assert.throws(() => verifyAuthoritativeWriteAnalysis({
    ...analysis,
    write_sites: analysis.write_sites.map((site) => site.site_signature === triageSignature ? changed : site),
  }, triage, analysis, capabilities), /semantic projection drift/)
}

const migrationAuthoritySha256 = 'b'.repeat(64)
const migrationSourceSha256 = 'c'.repeat(64)
const migrationDecisionSha256 = 'd'.repeat(64)
const migrationWrite = {
  ...analysis,
  summary: { ...analysis.summary, discovered_write_sites: 4 },
  write_sites: [...analysis.write_sites, {
    classification: 'MIGRATION_ONLY', site_signature: 'migration-deploy-site',
    file: 'gravity-mvp/Dockerfile', line: 118, column: 23,
    method: 'mixed-script-command:prisma migrate deploy', database_command_intent: 'WRITE',
    source_sha256: migrationSourceSha256,
    operations: [], owner_contexts: [],
    surface: {
      lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY',
      production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT', registry_classified: true,
      migration_authority: {
        data_owner: 'production_migration_authority', target_kind: 'SCHEMA',
        exact_name: 'gravity-mvp/prisma/schema.prisma',
        operation: 'mixed-script-command:prisma migrate deploy',
      },
    },
  }],
}
const approvedMigrationCapability = { capabilities: [{
  capability_id: 'mmc.v1.platform.fixture_migrate_deploy', status: 'APPROVED', approved: true,
  source: { path: 'gravity-mvp/Dockerfile', source_sha256: migrationSourceSha256, site_signatures: ['migration-deploy-site'] },
  lifecycle: 'MIGRATION', lifecycle_evidence_status: 'REVIEWED_ACTIVE_DEPLOYMENT',
  invocation: { production_reachability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT' },
  target: { kind: 'SCHEMA', data_owner: 'production_migration_authority', exact_names: ['gravity-mvp/prisma/schema.prisma'], operations: ['mixed-script-command:prisma migrate deploy'] },
}] }
const migrationAuthorityFixture = { inventory_digest: 'a'.repeat(64), migrations: [] }
const migrationDecisionRationale = 'Committed exact source review and the existing approved deployment capability jointly authorize this site tuple.'
const migrationDecisionFixture = {
  schema: 'yoko.crm.reviewed-noncanonical-migration-capability-decisions.v1',
  version: 1,
  review: { status: 'COMPLETED_SOURCE_SPECIFIC_REVIEW', reviewed_by: 'ARCHITECTURE_REMEDIATION' },
  path_decisions: [{
    path: 'gravity-mvp/Dockerfile',
    functional_owner: 'production_migration_authority',
    production_reachability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT',
    lifecycle_evidence_status: 'REVIEWED_DEPLOYMENT_COMMAND',
    expected_site_signatures: ['migration-deploy-site'],
  }],
  site_decisions: [{
    site_signature: 'migration-deploy-site',
    path: 'gravity-mvp/Dockerfile', source_sha256: migrationSourceSha256,
    line: 118, column: 23, method: 'mixed-script-command:prisma migrate deploy',
    functional_owner: 'production_migration_authority',
    production_reachability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT',
    writes: [{ kind: 'SCHEMA', exact_name: 'gravity-mvp/prisma/schema.prisma', operation: 'mixed-script-command:prisma migrate deploy' }],
    review_rationale: migrationDecisionRationale,
    existing_capability_id: approvedMigrationCapability.capabilities[0].capability_id,
  }],
}
const migrationAuthorizationFixture = {
  schema: 'yoko.crm.reviewed-migration-write-site-authorizations.v1',
  version: 1,
  review: { status: 'COMPLETED_EXACT_SITE_REVIEW', reviewed_by: 'ARCHITECTURE_REMEDIATION' },
  noncanonical_review: {
    path: 'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json',
    source_sha256: migrationDecisionSha256,
    reviewed_path_count: 1,
  },
  authority: {
    path: 'architecture/migrations/v1/production-migration-authority.json',
    source_sha256: migrationAuthoritySha256,
    inventory_digest: migrationAuthorityFixture.inventory_digest,
    migration_count: 0,
  },
  denominator: {
    non_test_migration_only_sites: 1,
    sorted_site_signatures_sha256: createHash('sha256').update('migration-deploy-site\n').digest('hex'),
  },
  authorizations: [{
    capability_id: 'mmc.migration-site.v1.production_migration_authority.fixture',
    site_signature: 'migration-deploy-site',
    status: 'APPROVED',
    approved: true,
    source: {
      path: 'gravity-mvp/Dockerfile', source_sha256: migrationSourceSha256,
      line: 118, column: 23, method: 'mixed-script-command:prisma migrate deploy',
    },
    lifecycle: 'MIGRATION',
    invocation: { production_reachability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT' },
    functional_owner: 'production_migration_authority',
    target: {
      data_owner: 'production_migration_authority',
      writes: [{ kind: 'SCHEMA', exact_name: 'gravity-mvp/prisma/schema.prisma', operation: 'mixed-script-command:prisma migrate deploy' }],
    },
    binding: {
      kind: 'INDEPENDENT_EXACT_CAPABILITY',
      rationale: migrationDecisionRationale,
      evidence: [
        `source_sha256:${migrationSourceSha256}`,
        'site_signature:migration-deploy-site',
        'review_decision:architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json',
        'lifecycle_evidence_status:REVIEWED_DEPLOYMENT_COMMAND',
      ],
      existing_capability_id: approvedMigrationCapability.capabilities[0].capability_id,
    },
  }],
}
const verifyMigration = (
  candidateAnalysis,
  candidateCapabilities = approvedMigrationCapability,
  candidateAuthorization = migrationAuthorizationFixture,
  sourceHashes = { 'gravity-mvp/Dockerfile': migrationSourceSha256 },
) => verifyAuthoritativeWriteAnalysis(
  candidateAnalysis,
  triage,
  analysis,
  candidateCapabilities,
  candidateAuthorization,
  sourceHashes,
  migrationAuthorityFixture,
  migrationAuthoritySha256,
  migrationDecisionFixture,
  migrationDecisionSha256,
)
assert.equal(verifyMigration(migrationWrite).active_maintenance_sites, 1)
assert.equal(verifyMigration(migrationWrite).ordinary_migration_only_sites, 0)
assert.throws(() => verifyMigration(migrationWrite, capabilities), /migration write authorization registry is invalid/)
assert.throws(() => verifyMigration(migrationWrite, {
  capabilities: [{ ...approvedMigrationCapability.capabilities[0], approved: false, status: 'PENDING_EVIDENCE' }],
}), /migration write authorization registry is invalid/)
assert.throws(() => verifyMigration(migrationWrite, {
  capabilities: [{ ...approvedMigrationCapability.capabilities[0], lifecycle: 'NOT_A_REAL_LIFECYCLE' }],
}), /registry is invalid/)
assert.throws(() => verifyMigration(migrationWrite, {
  capabilities: [{ ...approvedMigrationCapability.capabilities[0], invocation: { production_reachability: 'NOT_A_REAL_REACHABILITY_STATE' } }],
}), /registry is invalid/)
assert.throws(() => verifyMigration(migrationWrite, {
  capabilities: [{ ...approvedMigrationCapability.capabilities[0], target: { ...approvedMigrationCapability.capabilities[0].target, data_owner: 'platform_shell' } }],
}), /migration write authorization registry is invalid/)
assert.throws(() => verifyMigration(migrationWrite, {
  capabilities: [{ ...approvedMigrationCapability.capabilities[0], target: { ...approvedMigrationCapability.capabilities[0].target, exact_names: ['yandex-fleet-scraper/prisma/schema.prisma'] } }],
}), /migration write authorization registry is invalid/)
assert.throws(() => verifyMigration({
  ...migrationWrite,
  write_sites: migrationWrite.write_sites.map((site) => site.site_signature === 'migration-deploy-site'
    ? { ...site, surface: { ...site.surface, lifecycle: 'OPERATIONAL_SCRIPT' } }
    : site),
}), /exact approved site capability/)
assert.throws(() => verifyMigration(migrationWrite, approvedMigrationCapability, null), /lacks an exact authorization registry/)
assert.throws(() => verifyMigration(migrationWrite, approvedMigrationCapability, migrationAuthorizationFixture, {
  'gravity-mvp/Dockerfile': 'd'.repeat(64),
}), /analysis source-byte drift/)

const plainSqlSourceSha256 = 'e'.repeat(64)
const plainSqlDecisionSha256 = 'f'.repeat(64)
const plainSqlSite = {
  classification: 'MIGRATION_ONLY',
  site_signature: 'plain-sql-migration-site',
  file: 'gravity-mvp/add_partial_index.sql',
  line: 1,
  column: 1,
  method: 'sql-script',
  source_sha256: plainSqlSourceSha256,
  operations: [{ operation: 'CREATE_INDEX', table: 'tasks', target_kind: 'TABLE' }],
  surface: {
    lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY',
    production_capability: 'CONFIRMED_MANUAL_DATA_MIGRATION', registry_classified: true,
  },
}
const plainSqlAnalysis = {
  ...analysis,
  summary: { ...analysis.summary, discovered_write_sites: 4 },
  write_sites: [...analysis.write_sites, plainSqlSite],
}
const plainSqlDecisionRationale = 'Independent byte-pinned review authorizes this one SQL migration statement and exact write tuple.'
const plainSqlDecisionFixture = {
  schema: 'yoko.crm.reviewed-noncanonical-migration-capability-decisions.v1',
  version: 1,
  review: { status: 'COMPLETED_SOURCE_SPECIFIC_REVIEW', reviewed_by: 'ARCHITECTURE_REMEDIATION' },
  path_decisions: [{
    path: plainSqlSite.file,
    functional_owner: 'task_management',
    production_reachability: 'CONFIRMED_MANUAL_DATA_MIGRATION',
    lifecycle_evidence_status: 'REVIEWED_STANDALONE_SQL',
    expected_site_signatures: [plainSqlSite.site_signature],
  }],
  site_decisions: [{
    site_signature: plainSqlSite.site_signature,
    path: plainSqlSite.file, source_sha256: plainSqlSourceSha256,
    line: plainSqlSite.line, column: plainSqlSite.column, method: plainSqlSite.method,
    functional_owner: 'task_management',
    production_reachability: 'CONFIRMED_MANUAL_DATA_MIGRATION',
    writes: [{ kind: 'TABLE', exact_name: 'tasks', operation: 'CREATE_INDEX' }],
    review_rationale: plainSqlDecisionRationale,
  }],
}
const plainSqlAuthorization = {
  ...migrationAuthorizationFixture,
  noncanonical_review: {
    path: 'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json',
    source_sha256: plainSqlDecisionSha256,
    reviewed_path_count: 1,
  },
  denominator: {
    non_test_migration_only_sites: 1,
    sorted_site_signatures_sha256: createHash('sha256').update(`${plainSqlSite.site_signature}\n`).digest('hex'),
  },
  authorizations: [{
    capability_id: 'mmc.migration-site.v1.task_management.plain_sql',
    site_signature: plainSqlSite.site_signature,
    status: 'APPROVED',
    approved: true,
    source: {
      path: plainSqlSite.file, source_sha256: plainSqlSourceSha256,
      line: plainSqlSite.line, column: plainSqlSite.column, method: plainSqlSite.method,
    },
    lifecycle: 'MIGRATION',
    invocation: { production_reachability: 'CONFIRMED_MANUAL_DATA_MIGRATION' },
    functional_owner: 'task_management',
    target: { data_owner: 'task_management', writes: [{ kind: 'TABLE', exact_name: 'tasks', operation: 'CREATE_INDEX' }] },
    binding: {
      kind: 'INDEPENDENT_EXACT_CAPABILITY',
      rationale: plainSqlDecisionRationale,
      evidence: [
        `source_sha256:${plainSqlSourceSha256}`,
        `site_signature:${plainSqlSite.site_signature}`,
        'review_decision:architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json',
        'lifecycle_evidence_status:REVIEWED_STANDALONE_SQL',
      ],
    },
  }],
}
const verifyPlainSql = (
  candidateAuthorization,
  sourceHashes = { [plainSqlSite.file]: plainSqlSourceSha256 },
  candidateAnalysis = plainSqlAnalysis,
) =>
  verifyAuthoritativeWriteAnalysis(
    candidateAnalysis, triage, analysis, capabilities, candidateAuthorization, sourceHashes,
    migrationAuthorityFixture, migrationAuthoritySha256, plainSqlDecisionFixture, plainSqlDecisionSha256,
  )
assert.throws(() => verifyPlainSql(null), /lacks an exact authorization registry/, 'plain SQL migration without capability must fail')
assert.equal(verifyPlainSql(plainSqlAuthorization).authorized_migration_only_sites, 1)
for (const production_capability of ['UNKNOWN', undefined, 'CONFIRMED_AUTOMATIC_DEPLOYMENT']) {
  const changedAnalysis = {
    ...plainSqlAnalysis,
    write_sites: plainSqlAnalysis.write_sites.map((site) => site.site_signature === plainSqlSite.site_signature
      ? { ...site, surface: { ...site.surface, production_capability } }
      : site),
  }
  assert.throws(() => verifyPlainSql(plainSqlAuthorization, undefined, changedAnalysis), /exact approved site capability/)
}
assert.throws(() => verifyPlainSql(plainSqlAuthorization, {
  [plainSqlSite.file]: '0'.repeat(64),
}), /analysis source-byte drift/)
assert.throws(() => verifyPlainSql({ ...plainSqlAuthorization, authorizations: [] }), /migration write authorization registry is invalid/)
assert.throws(() => verifyPlainSql({ ...plainSqlAuthorization, authorizations: [
  plainSqlAuthorization.authorizations[0], plainSqlAuthorization.authorizations[0],
] }), /migration write authorization registry is invalid/)
assert.throws(() => verifyPlainSql({ ...plainSqlAuthorization, authorizations: [{
  ...plainSqlAuthorization.authorizations[0], status: 'PENDING_EVIDENCE', approved: false,
}] }), /migration write authorization registry is invalid/)
assert.throws(() => verifyPlainSql({ ...plainSqlAuthorization, authorizations: [{
  ...plainSqlAuthorization.authorizations[0], target: {
    ...plainSqlAuthorization.authorizations[0].target,
    writes: [{ kind: 'TABLE', exact_name: 'tasks', operation: 'DROP_TABLE' }],
  },
}] }), /migration write authorization registry is invalid/)

process.stdout.write('authoritative write analysis gate: PASS (42 negative properties)\n')
