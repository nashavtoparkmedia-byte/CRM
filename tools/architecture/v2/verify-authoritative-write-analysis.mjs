#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  authorizeMaintenanceWrite,
  authorizeMigrationOnlySite,
  validateCapabilityRegistry,
  validateMigrationWriteAuthorizationRegistry,
} from './maintenance-capability-policy.mjs'

const sha256Lines = (values) => createHash('sha256').update(`${[...values].sort().join('\n')}\n`).digest('hex')
const SHA256 = /^[a-f0-9]{64}$/u

// Independent of sql-mutation-analyzer.mjs. A function must be both extracted
// from the exact analyzed SQL and present here before ambiguity can be closed
// as a read. Adding a detector-side "safe" name alone cannot authorize it.
const REVIEWED_READ_ONLY_SQL_FUNCTIONS = new Set([
  'abs', 'array_agg', 'avg', 'bool_or', 'ceil', 'coalesce', 'concat', 'convert_to',
  'count', 'current_database', 'current_setting', 'date', 'date_trunc', 'encode', 'extract', 'floor',
  'format_type', 'greatest', 'json_agg', 'json_build_object', 'jsonb_agg',
  'jsonb_array_elements_text', 'jsonb_build_object', 'least', 'length', 'lower',
  'max', 'md5', 'min', 'now', 'nullif', 'octet_length', 'percentile_cont', 'percentile_disc',
  'pg_control_system', 'pg_get_constraintdef', 'pg_get_expr', 'position',
  'regexp_replace', 'replace', 'right', 'round', 'sha256', 'split_part', 'string_agg',
  'strpos', 'substring', 'sum', 'to_char', 'to_date', 'to_regclass',
  'to_timestamp', 'trim', 'upper',
])

function semanticProjection(value) {
  return {
    source_sha256: value.source_sha256 ?? null,
    file: value.file,
    line: value.line,
    column: value.column,
    kind: value.kind,
    method: value.method ?? null,
    fragment_source: value.fragment_source ?? null,
    database_command_intent: value.database_command_intent ?? null,
    model: value.model ?? null,
    candidate_models: value.candidate_models ?? [],
    tables: value.tables ?? [],
    operations: value.operations ?? [],
    read_tables: value.read_tables ?? [],
    selected_columns: value.selected_columns ?? [],
    called_functions: value.called_functions ?? [],
    sql_sha256: value.sql_sha256 ?? null,
    sql_provenance_sha256: value.sql_provenance_sha256 ?? null,
    source_context: value.source_context ?? null,
    source_technical_module: value.source_technical_module ?? null,
    owner_contexts: value.owner_contexts ?? [],
    receiver_origin: value.receiver_origin ?? null,
    ambiguity_reasons: value.ambiguity_reasons ?? [],
    unresolved_targets: value.unresolved_targets ?? [],
    surface: {
      lifecycle: value.surface?.lifecycle ?? null,
      disposition: value.surface?.disposition ?? null,
      production_capability: value.surface?.production_capability ?? null,
      maintenance_lifecycle: value.surface?.maintenance_lifecycle ?? null,
      registry_classified: value.surface?.registry_classified ?? false,
    },
  }
}

function exactUniqueSignatures(records, label) {
  const signatures = records.map((record) => record.site_signature)
  assert.equal(signatures.every(Boolean), true, `${label} contains a missing site signature`)
  assert.equal(new Set(signatures).size, signatures.length, `${label} contains duplicate site signatures`)
  return signatures.sort()
}

function exactMaintenanceWrites(site, triageRecord) {
  if (site.surface?.lifecycle === 'MIGRATION') {
    const authority = site.surface.migration_authority
    assert.equal(authority && typeof authority === 'object', true, `active migration write lacks analyzed migration authority: ${site.file}:${site.line}`)
    assert.equal(authority.operation, site.method, `active migration command does not match its exact authority: ${site.file}:${site.line}`)
    assert.equal(typeof authority.data_owner === 'string' && authority.data_owner.length > 0, true, `active migration write lacks an exact data owner: ${site.file}:${site.line}`)
    assert.equal(typeof authority.exact_name === 'string' && authority.exact_name.length > 0, true, `active migration write lacks an exact target: ${site.file}:${site.line}`)
    assert.equal(['DATABASE', 'MODEL', 'SCHEMA', 'TABLE'].includes(authority.target_kind), true, `active migration write lacks an exact target kind: ${site.file}:${site.line}`)
    return [{
      source_path: site.file,
      source_sha256: site.source_sha256,
      site_signature: site.site_signature,
      lifecycle: 'MIGRATION',
      production_reachability: site.surface.production_capability,
      data_owner: authority.data_owner,
      target_kind: authority.target_kind,
      target: authority.exact_name,
      operation: authority.operation,
    }]
  }

  const targets = [...new Set([
    site.model,
    ...(site.candidate_models ?? []),
    ...(site.tables ?? []),
  ].filter(Boolean))]
  const operations = site.operations?.length
    ? site.operations.map((operation) => ({
        target: operation.table,
        target_kind: 'TABLE',
        operation: operation.operation,
      }))
    : targets.map((target) => ({ target, target_kind: 'MODEL', operation: site.method }))
  const ownerContexts = site.owner_contexts?.length
    ? site.owner_contexts
    : (triageRecord?.owner_contexts?.length ? triageRecord.owner_contexts : [])
  assert.equal(typeof site.surface?.maintenance_lifecycle === 'string' && site.surface.maintenance_lifecycle.length > 0, true, `active maintenance write lacks an exact maintenance lifecycle: ${site.file}:${site.line}`)
  assert.equal(targets.length > 0, true, `active maintenance write lacks an exact target: ${site.file}:${site.line}`)
  assert.equal(operations.every((operation) => operation.target && operation.target_kind && operation.operation), true, `active maintenance write lacks an exact target/operation: ${site.file}:${site.line}`)
  assert.equal(ownerContexts.length, 1, `active maintenance write lacks exactly one data owner: ${site.file}:${site.line}`)
  return operations.map(({ target, target_kind, operation }) => ({
    source_path: site.file,
    source_sha256: site.source_sha256,
    site_signature: site.site_signature,
    lifecycle: site.surface.maintenance_lifecycle,
    production_reachability: site.surface.production_capability,
    data_owner: ownerContexts[0],
    target_kind,
    target,
    operation,
  }))
}

function assertResolvedNonWriteProofs(triage, currentAmbiguous) {
  const resolvedRecords = (triage.records ?? []).filter((record) => record.semantic_state === 'RESOLVED_NON_WRITE')
  const proofs = triage.non_write_proofs ?? []
  assert.deepEqual(
    exactUniqueSignatures(proofs, 'non-write proof registry'),
    exactUniqueSignatures(resolvedRecords, 'resolved non-write dispositions'),
    'resolved non-write dispositions require one-to-one exact proofs',
  )
  const sites = new Map(currentAmbiguous.map((site) => [site.site_signature, site]))
  for (const record of resolvedRecords) {
    const proof = proofs.find((candidate) => candidate.site_signature === record.site_signature)
    const site = sites.get(record.site_signature)
    assert.equal(record.disposition, 'CONFIRMED_NON_WRITE', `non-write disposition is not explicit: ${record.site_signature}`)
    assert.equal(typeof record.rationale === 'string' && record.rationale.length > 0, true, `non-write disposition lacks rationale: ${record.site_signature}`)
    assert.equal(/(?:UNKNOWN|UNRESOLVED|PENDING)/iu.test(`${proof?.classification}|${JSON.stringify(proof?.resolved_target)}|${proof?.evidence?.join('|')}`), false, `non-write proof retains unresolved language: ${record.site_signature}`)
    assert.equal(Array.isArray(proof?.evidence) && proof.evidence.length >= 2 && proof.evidence.every((entry) => typeof entry === 'string' && entry.length > 0), true, `non-write proof lacks exact evidence: ${record.site_signature}`)
    assert.equal(proof?.resolved_target && typeof proof.resolved_target === 'object', true, `non-write proof lacks exact target: ${record.site_signature}`)
    assert.equal(SHA256.test(site.source_sha256 ?? ''), true, `non-write proof lacks exact analyzed source hash: ${record.site_signature}`)
    assert.equal(SHA256.test(site.sql_provenance_sha256 ?? ''), true, `non-write proof lacks transitive SQL provenance: ${record.site_signature}`)
    assert.deepEqual(proof.source, {
      file: site.file,
      line: site.line,
      column: site.column,
      method: site.method,
      source_sha256: site.source_sha256,
      sql_provenance_sha256: site.sql_provenance_sha256,
    }, `non-write proof source/provenance drift: ${record.site_signature}`)
    assert.equal(proof.evidence.includes(`source_sha256:${site.source_sha256}`), true, `non-write proof evidence lacks source hash: ${record.site_signature}`)
    assert.equal(proof.evidence.includes(`sql_provenance_sha256:${site.sql_provenance_sha256}`), true, `non-write proof evidence lacks SQL provenance: ${record.site_signature}`)
    assert.equal((site.operations ?? []).length, 0, `non-write proof cannot suppress an analyzed write operation: ${record.site_signature}`)
    const calledFunctions = site.called_functions ?? []
    assert.deepEqual(calledFunctions, [...new Set(calledFunctions)].sort(), `analyzed SQL function set is not exact and sorted: ${record.site_signature}`)
    assert.equal(calledFunctions.every((name) => REVIEWED_READ_ONLY_SQL_FUNCTIONS.has(name)), true, `non-write proof invokes a function outside the independent read-only allowlist: ${record.site_signature}`)
    if ((site.ambiguity_reasons ?? []).includes('select_function_side_effect_unresolved')) {
      assert.equal(calledFunctions.length > 0, true, `function-side-effect ambiguity lacks exact analyzer-derived functions: ${record.site_signature}`)
    }
    const reviewedFunctions = proof.resolved_target?.reviewed_read_only_functions
    assert.deepEqual(reviewedFunctions, calledFunctions, `non-write proof function projection drift: ${record.site_signature}`)
    if (proof.classification === 'READ_ONLY_SQL_PROJECTION') {
      assert.equal(site.kind, 'raw', `read-only SQL proof requires a raw SQL site: ${record.site_signature}`)
      assert.match(site.method, /^\$queryRaw(?:Unsafe)?$/u, `read-only SQL proof requires a query method: ${record.site_signature}`)
      assert.equal(typeof site.sql_sha256 === 'string' && site.sql_sha256.length === 64, true, `read-only SQL proof lacks analyzed SQL hash: ${record.site_signature}`)
      assert.deepEqual(proof.resolved_target, {
        kind: 'SQL_READ_PROJECTION',
        read_tables: site.read_tables,
        selected_columns: site.selected_columns,
        sql_sha256: site.sql_sha256,
        reviewed_read_only_functions: calledFunctions,
      }, `read-only SQL proof target drift: ${record.site_signature}`)
    } else if (proof.classification === 'STATIC_MIXED_SCRIPT_SQL_READ') {
      assert.equal(site.kind, 'raw', `mixed-script SQL proof requires a raw SQL site: ${record.site_signature}`)
      assert.equal(site.method, 'mixed-script-sql', `mixed-script SQL proof requires the exact mixed-script method: ${record.site_signature}`)
      assert.equal(site.fragment_source, 'embedded_database_string', `mixed-script SQL proof requires an embedded database string: ${record.site_signature}`)
      const baseReasons = ['dynamic_sql_fragment', 'select_function_side_effect_unresolved']
      const escapedLiteralReasons = ['dialect_dependent_string_escape', ...baseReasons]
      assert.equal(
        JSON.stringify(site.ambiguity_reasons) === JSON.stringify(baseReasons)
          || JSON.stringify(site.ambiguity_reasons) === JSON.stringify(escapedLiteralReasons),
        true,
        `mixed-script SQL proof ambiguity shape drift: ${record.site_signature}`,
      )
      assert.equal(typeof site.sql_sha256 === 'string' && site.sql_sha256.length === 64, true, `mixed-script SQL proof lacks analyzed SQL hash: ${record.site_signature}`)
      assert.equal(calledFunctions.length > 0, true, `mixed-script SQL proof lacks reviewed read-only functions: ${record.site_signature}`)
      assert.deepEqual(proof.resolved_target, {
        kind: 'STATIC_MIXED_SCRIPT_SQL_READ',
        fragment_source: site.fragment_source,
        read_tables: site.read_tables,
        selected_columns: site.selected_columns,
        sql_sha256: site.sql_sha256,
        reviewed_read_only_functions: calledFunctions,
      }, `mixed-script SQL proof target drift: ${record.site_signature}`)
    } else {
      assert.fail(`non-write proof classification is not permitted: ${String(proof?.classification)}`)
    }
  }
}

export function verifyAuthoritativeWriteAnalysis(
  analysis,
  triage,
  acceptedAnalysis,
  capabilityRegistry,
  migrationAuthorizationRegistry = null,
  sourceSha256ByPath = {},
  productionMigrationAuthority = null,
  productionMigrationAuthoritySha256 = null,
  noncanonicalMigrationDecisions = null,
  noncanonicalMigrationDecisionsSha256 = null,
) {
  assert.equal(analysis.schema, 'yoko.crm.whole-repository-write-analysis.v2')
  assert.equal(analysis.execution?.complete, true, 'write analysis is incomplete')
  assert.equal(analysis.execution?.worker_failures, 0, 'write analyzer worker failure')
  assert.equal(analysis.execution?.worker_timeouts, 0, 'write analyzer worker timeout')
  assert.equal(analysis.summary?.parse_findings, 0, 'write analyzer parse finding')
  assert.equal(analysis.summary?.unreviewed_operational_surfaces, 0, 'operational surface bypass')
  assert.equal(analysis.summary?.foreign_writes, 0, 'confirmed foreign write')
  assert(
    analysis.summary?.tracked_executable_surfaces >= acceptedAnalysis.summary?.tracked_executable_surfaces,
    'tracked write-analysis surface denominator shrank without a reviewed baseline update',
  )
  assert(
    analysis.summary?.discovered_write_sites >= acceptedAnalysis.summary?.discovered_write_sites,
    'confirmed write-site denominator shrank without a reviewed baseline update',
  )
  assert.equal(triage.summary?.RECONCILIATION_EXACT, true, 'accepted ambiguity reconciliation is not exact')
  assert.equal(triage.summary?.MATERIAL_UNRESOLVED_WRITE_RISK, 0, 'accepted material ambiguity remains')

  const currentAmbiguous = (analysis.write_sites ?? []).filter((site) => site.classification === 'AMBIGUOUS')
  assert.deepEqual(
    exactUniqueSignatures(triage.records ?? [], 'write ambiguity review'),
    exactUniqueSignatures(currentAmbiguous, 'current write ambiguity denominator'),
    'write ambiguity review must reconcile the current denominator one-to-one',
  )
  assert.equal(triage.current_exact_review?.ambiguous_denominator, currentAmbiguous.length, 'write ambiguity review denominator metadata is stale')
  assert.equal(
    triage.current_exact_review?.sorted_site_signatures_sha256,
    sha256Lines(currentAmbiguous.map((site) => site.site_signature)),
    'write ambiguity review signature digest is stale',
  )
  const currentBySignature = new Map(currentAmbiguous.map((site) => [site.site_signature, site]))
  const dispositionsByState = new Map([
    ['RESOLVED_NON_WRITE', 'CONFIRMED_NON_WRITE'],
    ['OWNER_VALID_WRITE', 'CONFIRMED_WRITE_OWNER_RESOLVED'],
    ['CONTROLLED_MIGRATION_WRITE', 'CONFIRMED_WRITE_OWNER_RESOLVED'],
    ['MATERIAL_UNRESOLVED_WRITE_RISK', 'MATERIAL_UNRESOLVED_WRITE_RISK'],
  ])
  for (const record of triage.records ?? []) {
    const site = currentBySignature.get(record.site_signature)
    assert.equal(record.record_id, record.site_signature, `write ambiguity review record identity drift: ${record.site_signature}`)
    assert.equal(dispositionsByState.get(record.semantic_state), record.disposition, `write ambiguity review state/disposition contradiction: ${record.site_signature}`)
    assert.deepEqual(
      semanticProjection(record),
      semanticProjection(site),
      `write ambiguity review semantic projection drift: ${record.site_signature}`,
    )
  }
  assertResolvedNonWriteProofs(triage, currentAmbiguous)

  assert.deepEqual(validateCapabilityRegistry(capabilityRegistry), [], 'maintenance capability registry is invalid')
  const migrationOnlySites = (analysis.write_sites ?? []).filter(site => (
    site.classification === 'MIGRATION_ONLY' && site.classification !== 'TEST'
  ))
  if (migrationOnlySites.length > 0) {
    assert(migrationAuthorizationRegistry, 'MIGRATION_ONLY write denominator lacks an exact authorization registry')
    assert(productionMigrationAuthority, 'MIGRATION_ONLY authorization lacks production migration authority')
    assert.deepEqual(validateMigrationWriteAuthorizationRegistry(migrationAuthorizationRegistry, {
      productionMigrationAuthority,
      productionMigrationAuthoritySha256,
      maintenanceCapabilityRegistry: capabilityRegistry,
      noncanonicalMigrationDecisions,
      noncanonicalMigrationDecisionsSha256,
    }), [], 'migration write authorization registry is invalid')
    const reviewedMigrationSignatures = exactUniqueSignatures(
      migrationAuthorizationRegistry.authorizations ?? [],
      'migration write authorization registry',
    )
    const currentMigrationSignatures = exactUniqueSignatures(migrationOnlySites, 'current MIGRATION_ONLY write denominator')
    assert.deepEqual(
      reviewedMigrationSignatures,
      currentMigrationSignatures,
      'MIGRATION_ONLY writes require one-to-one current site signature review',
    )
    assert.equal(
      migrationAuthorizationRegistry.denominator?.non_test_migration_only_sites,
      migrationOnlySites.length,
      'migration authorization site denominator is stale',
    )
    assert.equal(
      migrationAuthorizationRegistry.denominator?.sorted_site_signatures_sha256,
      sha256Lines(currentMigrationSignatures),
      'migration authorization signature digest is stale',
    )
    for (const site of migrationOnlySites) {
      const sourceSha256 = sourceSha256ByPath instanceof Map
        ? sourceSha256ByPath.get(site.file)
        : sourceSha256ByPath?.[site.file]
      assert.equal(typeof sourceSha256 === 'string' && sourceSha256.length === 64, true, `MIGRATION_ONLY source hash is missing: ${site.file}:${site.line}`)
      assert.equal(site.source_sha256, sourceSha256, `MIGRATION_ONLY analysis source-byte drift: ${site.file}:${site.line}`)
      assert.equal(
        authorizeMigrationOnlySite(migrationAuthorizationRegistry, site, sourceSha256),
        true,
        `MIGRATION_ONLY write lacks an exact approved site capability: ${site.file}:${site.line}`,
      )
    }
  } else if (migrationAuthorizationRegistry) {
    assert.equal((migrationAuthorizationRegistry.authorizations ?? []).length, 0, 'stale migration authorization records exist outside the current denominator')
  }
  const triageBySignature = new Map((triage.records ?? []).map((record) => [record.site_signature, record]))
  const maintenanceSites = (analysis.write_sites ?? []).filter((site) => (
    site.surface?.lifecycle === 'OPERATIONAL_SCRIPT'
    && site.classification !== 'TEST'
    && site.classification !== 'MIGRATION_ONLY'
  ))
  for (const site of maintenanceSites) {
    assert.equal(site.surface?.registry_classified, true, `maintenance write lacks reviewed lifecycle classification: ${site.file}:${site.line}`)
    assert.equal(site.surface?.disposition, 'ACTIVE', `maintenance write lifecycle disposition is not fail-closed: ${site.file}:${site.line}`)
    assert.notEqual(site.surface?.production_capability, 'UNKNOWN', `maintenance write production reachability is unknown: ${site.file}:${site.line}`)
    assert.notEqual(site.surface?.production_capability, undefined, `maintenance write production reachability is missing: ${site.file}:${site.line}`)
  }
  const activeMaintenanceSites = maintenanceSites.filter((site) => (
    site.classification !== 'AMBIGUOUS'
    || triageBySignature.get(site.site_signature)?.semantic_state !== 'RESOLVED_NON_WRITE'
  ))
  const ordinaryMigrationOnlySites = (analysis.write_sites ?? []).filter((site) => (
    site.classification === 'MIGRATION_ONLY'
    && !(site.surface?.lifecycle === 'MIGRATION' && site.database_command_intent === 'WRITE')
  ))
  let authorizedMaintenanceWrites = 0
  for (const site of activeMaintenanceSites) {
    const sourceSha256 = sourceSha256ByPath instanceof Map
      ? sourceSha256ByPath.get(site.file)
      : sourceSha256ByPath?.[site.file]
    assert.equal(SHA256.test(sourceSha256 ?? ''), true, `active maintenance source hash is missing: ${site.file}:${site.line}`)
    assert.equal(site.source_sha256, sourceSha256, `active maintenance analysis source-byte drift: ${site.file}:${site.line}`)
    for (const write of exactMaintenanceWrites(site, triageBySignature.get(site.site_signature))) {
      assert.equal(authorizeMaintenanceWrite(capabilityRegistry, write), true, `active maintenance write lacks an exact approved capability: ${site.file}:${site.line}`)
      authorizedMaintenanceWrites += 1
    }
  }

  return {
    status: 'PASS',
    tracked_executable_surfaces: analysis.summary.tracked_executable_surfaces,
    discovered_write_sites: analysis.summary.discovered_write_sites,
    confirmed_foreign: 0,
    raw_ambiguous: currentAmbiguous.length,
    new_ambiguous: 0,
    active_maintenance_sites: activeMaintenanceSites.length + migrationOnlySites.length,
    authorized_maintenance_writes: authorizedMaintenanceWrites + migrationOnlySites.length,
    migration_only_sites: migrationOnlySites.length,
    authorized_migration_only_sites: migrationOnlySites.length,
    ordinary_migration_only_sites: ordinaryMigrationOnlySites.length,
    ordinary_migration_only_site_report: ordinaryMigrationOnlySites.map((site) => ({
      site_signature: site.site_signature,
      file: site.file,
      line: site.line,
      method: site.method,
      operations: site.operations ?? [],
    })),
    material_unresolved: 0,
    active_operational_surfaces_unclassified: 0,
    worker_failures: 0,
    worker_timeouts: 0,
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const analysisPath = path.resolve(process.argv[2] ?? '')
  assert(process.argv[2], 'usage: verify-authoritative-write-analysis.mjs <fresh-analysis.json> [triage.json] [accepted-analysis.json] [capability-registry.json] [reviewed-capabilities.json] [migration-write-authorizations.json] [production-migration-authority.json] [noncanonical-migration-decisions.json]')
  const triagePath = path.resolve(process.argv[3] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_FINAL_CLOSURE.json',
  ))
  const acceptedPath = path.resolve(process.argv[4] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json',
  ))
  const capabilityPath = path.resolve(process.argv[5] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json',
  ))
  const reviewedCapabilityPath = path.resolve(process.argv[6] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/ACTIVE_MAINTENANCE_CAPABILITY_REVIEW_20260813.json',
  ))
  const migrationAuthorizationPath = path.resolve(process.argv[7] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/MIGRATION_WRITE_SITE_AUTHORIZATION_REVIEW_20260813.json',
  ))
  const productionMigrationAuthorityPath = path.resolve(process.argv[8] ?? path.join(
    root,
    'architecture/migrations/v1/production-migration-authority.json',
  ))
  const noncanonicalMigrationDecisionsPath = path.resolve(process.argv[9] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json',
  ))
  const [analysis, triage, acceptedAnalysis, capabilityRegistry, reviewedCapabilityRegistry, migrationAuthorizationRegistry, productionMigrationAuthorityBytes, noncanonicalMigrationDecisionsBytes] = await Promise.all([
    readFile(analysisPath, 'utf8').then(JSON.parse),
    readFile(triagePath, 'utf8').then(JSON.parse),
    readFile(acceptedPath, 'utf8').then(JSON.parse),
    readFile(capabilityPath, 'utf8').then(JSON.parse),
    readFile(reviewedCapabilityPath, 'utf8').then(JSON.parse),
    readFile(migrationAuthorizationPath, 'utf8').then(JSON.parse),
    readFile(productionMigrationAuthorityPath),
    readFile(noncanonicalMigrationDecisionsPath),
  ])
  const productionMigrationAuthority = JSON.parse(productionMigrationAuthorityBytes.toString('utf8'))
  const noncanonicalMigrationDecisions = JSON.parse(noncanonicalMigrationDecisionsBytes.toString('utf8'))
  const combinedCapabilityRegistry = {
    capabilities: [
      ...(capabilityRegistry.capabilities ?? []),
      ...(reviewedCapabilityRegistry.capabilities ?? []),
    ],
  }
  const exactCapabilitySourcePaths = [...new Set((analysis.write_sites ?? [])
    .filter(site => (
      site.classification === 'MIGRATION_ONLY'
      || (site.surface?.lifecycle === 'OPERATIONAL_SCRIPT'
        && site.classification !== 'TEST'
        && site.classification !== 'MIGRATION_ONLY')
    ))
    .map(site => site.file))]
  const sourceSha256ByPath = Object.fromEntries(await Promise.all(exactCapabilitySourcePaths.map(async relative => [
    relative,
    createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex'),
  ])))
  process.stdout.write(`${JSON.stringify(verifyAuthoritativeWriteAnalysis(
    analysis,
    triage,
    acceptedAnalysis,
    combinedCapabilityRegistry,
    migrationAuthorizationRegistry,
    sourceSha256ByPath,
    productionMigrationAuthority,
    createHash('sha256').update(productionMigrationAuthorityBytes).digest('hex'),
    noncanonicalMigrationDecisions,
    createHash('sha256').update(noncanonicalMigrationDecisionsBytes).digest('hex'),
  ), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
