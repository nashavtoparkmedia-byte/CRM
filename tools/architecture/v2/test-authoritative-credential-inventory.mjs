#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  credentialReviewScope,
  isGovernedImmutableCredentialEvidence,
  verifyCredentialInventorySourceIntegrity,
  verifyAuthoritativeCredentialInventory,
  verifyCredentialEvidenceDependencyBindings,
  verifyRuntimeBoundaryReviews,
} from './verify-authoritative-credential-inventory.mjs'
import { materializeCredentialReviewScopes } from './materialize-credential-review-scopes.mjs'

const sourceSha = (label) => createHash('sha256').update(label).digest('hex')
const publicClassificationBytes = Buffer.from('exact public classification artifact')
const credentialClosureBytes = Buffer.from('exact credential closure artifact')
const dependencyBoundPublicRisk = {
  source_artifact: 'PUBLIC_SECRET_RISK_CLASSIFICATION_20260811.json',
  source_sha256: createHash('sha256').update(publicClassificationBytes).digest('hex'),
}
const dependencyBoundCrossDomain = {
  source_inventory: 'CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json',
  source_sha256: createHash('sha256').update(credentialClosureBytes).digest('hex'),
}
assert.deepEqual(
  verifyCredentialEvidenceDependencyBindings(
    dependencyBoundPublicRisk,
    publicClassificationBytes,
    dependencyBoundCrossDomain,
    credentialClosureBytes,
  ),
  {
    public_risk_source_sha256: dependencyBoundPublicRisk.source_sha256,
    cross_domain_source_sha256: dependencyBoundCrossDomain.source_sha256,
  },
)
assert.throws(
  () => verifyCredentialEvidenceDependencyBindings(
    { ...dependencyBoundPublicRisk, source_sha256: '0'.repeat(64) },
    publicClassificationBytes,
    dependencyBoundCrossDomain,
    credentialClosureBytes,
  ),
  /public credential-risk closure source artifact SHA-256 drift/,
  'a stale public-risk transitive source pointer must fail closed',
)
assert.throws(
  () => verifyCredentialEvidenceDependencyBindings(
    dependencyBoundPublicRisk,
    publicClassificationBytes,
    { ...dependencyBoundCrossDomain, source_sha256: '0'.repeat(64) },
    credentialClosureBytes,
  ),
  /cross-domain credential review source artifact SHA-256 drift/,
  'a stale cross-domain transitive source pointer must fail closed',
)
const publicSourceSha = sourceSha('public-reviewed-source')
const unknownSourceSha = sourceSha('unknown-reviewed-source')
const publicAccess = {
  site_signature: 'accepted-public',
  source_sha256: publicSourceSha,
  public_secret_risk: true,
  public_boundary: true,
  access: 'READ',
  credential_exposure: 'SECRET_READ',
  exposed_sensitive_field_names: ['apiKey'],
  file: 'a.ts',
  line: 1,
  context_classification: 'OWNER_DIRECT_DB_ACCESS',
  source_context: 'owner_context',
  owner_context: 'owner_context',
}
const unknownAccess = {
  site_signature: 'accepted-unknown',
  source_sha256: unknownSourceSha,
  access: 'UNKNOWN',
  intended_access: 'READ',
  credential_exposure: 'AMBIGUOUS',
  ambiguous: true,
  ambiguity_reasons: ['unresolved_model_read_may_access_credential_entity'],
  candidate_entities: ['NonCredentialEntity'],
  exposed_sensitive_field_names: [],
  file: 'b.ts',
  line: 2,
}
const publicRiskKey = `a.ts|1|||READ||accepted-public|${publicSourceSha}`
const publicRisk = {
  current_exact_review: {
    risk_denominator: 1,
    sorted_review_keys_sha256: createHash('sha256').update(`${publicRiskKey}\n`).digest('hex'),
  },
  current_candidate_classifications: [{
    site_signature: 'accepted-public',
    source_sha256: publicSourceSha,
    access: 'READ',
    file: 'a.ts',
    line: 1,
    classification: 'SAFE_OWNER_INTERNAL',
    resolved_semantics: 'OWNER_INTERNAL_VALID_NO_PUBLIC_SECRET_FLOW',
    evidence: ['reviewed server-side use'],
    review_scope: credentialReviewScope(publicAccess),
  }],
}
const unknown = {
  summary: { total: 1 },
  current_exact_review: {
    sorted_review_keys_sha256: createHash('sha256').update(`accepted-unknown|${unknownSourceSha}\n`).digest('hex'),
  },
  records: [{
    site_signature: 'accepted-unknown',
    source_sha256: unknownSourceSha,
    classification: 'ANALYZER_FALSE_POSITIVE',
    resolved_semantics: 'NON_CREDENTIAL_ENTITY_READ',
    resolved_target: {
      kind: 'prisma_or_drizzle_model',
      entity: 'NonCredentialEntity',
      credential_entities_in_scope: false,
    },
    evidence: 'reviewed exact source delegate',
    review_scope: credentialReviewScope(unknownAccess),
  }],
}
const emptyCrossDomain = {
  exact_coverage: true,
  summary: { confirmed_unapproved_secret_reads: 0, material_capability_gap_remaining: 0 },
  current_exact_review: {
    secret_read_denominator: 0,
    sorted_review_keys_sha256: createHash('sha256').update('\n').digest('hex'),
  },
  current_records: [],
}
const reviewedCrossDomainAttempt = {
  exact_coverage: true,
  summary: { confirmed_unapproved_secret_reads: 0, material_capability_gap_remaining: 0 },
  current_exact_review: {
    secret_read_denominator: 1,
    sorted_review_keys_sha256: createHash('sha256').update('c.ts|3|||||accepted-foreign\n').digest('hex'),
  },
  current_records: [{
    site_signature: 'accepted-foreign',
    file: 'c.ts',
    line: 3,
    classification: 'PROTECTED_DEBUG_OWNER_OPERATION',
    approved_architecture_path: 'owner capability',
  }],
}
const fields = { records: Array.from({ length: 15 }, (_, index) => ({ id: index })) }
const inventory = {
  schema: 'yoko.crm.whole-repository-credential-database-access.v2',
  summary: {
    parse_findings: 0,
    unreviewed_operational_surfaces: 0,
    tracked_executable_surfaces: 3,
    credential_database_accesses: 2,
    secret_reads: 0,
    metadata_only_reads: 1,
    ambiguous_credential_accesses: 1,
  },
  inventory_controls: { stale_registry_entries: [] },
  accesses: [publicAccess, unknownAccess],
}
const sourceIntegrityContext = {
  readSource: (relative) => ({
    'a.ts': Buffer.from('public-reviewed-source'),
    'b.ts': Buffer.from('unknown-reviewed-source'),
  })[relative],
}
assert.deepEqual(verifyCredentialInventorySourceIntegrity(inventory, sourceIntegrityContext), {
  exact_source_files: 2,
  exact_source_bound_accesses: 2,
})
assert.throws(() => verifyCredentialInventorySourceIntegrity({
  ...inventory,
  accesses: inventory.accesses.map((entry) => entry.file === 'b.ts'
    ? { ...entry, source_sha256: sourceSha('stale-inventory-source') }
    : entry),
}, sourceIntegrityContext), /analysis source-byte drift/, 'credential analysis must fail after source-byte drift')
assert.throws(() => verifyCredentialInventorySourceIntegrity({
  ...inventory,
  accesses: inventory.accesses.map((entry) => entry.file === 'b.ts'
    ? { ...entry, source_sha256: null }
    : entry),
}, sourceIntegrityContext), /lacks an exact source hash/, 'credential analysis must fail without a source hash')

const scopeFixtureDirectory = await mkdtemp(path.join(tmpdir(), 'yoko-credential-review-scope-test-'))
try {
  const inventoryPath = path.join(scopeFixtureDirectory, 'inventory.json')
  const publicReviewPath = path.join(scopeFixtureDirectory, 'public-review.json')
  const ambiguityReviewPath = path.join(scopeFixtureDirectory, 'ambiguity-review.json')
  const lifecycleRegistryPath = path.join(scopeFixtureDirectory, 'lifecycle-registry.json')
  const publicOutputPath = path.join(scopeFixtureDirectory, 'public-output.json')
  const ambiguityOutputPath = path.join(scopeFixtureDirectory, 'ambiguity-output.json')
  const materializerEvidenceSha256 = sourceSha('materializer-immutable-evidence')
  const materializerEvidence = {
    ...unknownAccess,
    file: 'architecture/migrations/v1/provenance/snapshot/materializer-fixture/files/example/route.ts',
    site_signature: 'materializer-immutable-evidence',
    source_sha256: materializerEvidenceSha256,
    context_classification: 'HISTORICAL_DEAD',
    public_boundary: true,
    public_secret_risk: true,
    surface: {
      lifecycle: 'DEAD_HISTORICAL',
      disposition: 'DEAD_HISTORICAL',
      production_capability: 'NONE',
      functional_owner: 'architecture_recovery_evidence',
      registered_source_sha256: materializerEvidenceSha256,
      registry_classified: true,
    },
  }
  const unscopedPublicRisk = {
    ...publicRisk,
    current_candidate_classifications: publicRisk.current_candidate_classifications.map(({ review_scope: _scope, ...record }) => record),
  }
  const unscopedUnknown = {
    ...unknown,
    records: unknown.records.map(({ review_scope: _scope, ...record }) => record),
  }
  await Promise.all([
    writeFile(inventoryPath, JSON.stringify({ ...inventory, accesses: [...inventory.accesses, materializerEvidence] })),
    writeFile(publicReviewPath, JSON.stringify(unscopedPublicRisk)),
    writeFile(ambiguityReviewPath, JSON.stringify(unscopedUnknown)),
    writeFile(lifecycleRegistryPath, JSON.stringify({ surfaces: [{
      path: materializerEvidence.file,
      lifecycle: 'DEAD_HISTORICAL',
      disposition: 'DEAD_HISTORICAL',
      production_capability: 'NONE',
      functional_owner: 'architecture_recovery_evidence',
      source_sha256: materializerEvidenceSha256,
      classification_artifact: 'architecture/migrations/v1/provenance/snapshot/materializer-fixture/manifest.json',
      rationale: 'Exact materializer exclusion fixture.',
    }] })),
  ])
  const materialized = await materializeCredentialReviewScopes({
    inventory: inventoryPath,
    publicReview: publicReviewPath,
    ambiguityReview: ambiguityReviewPath,
    lifecycleRegistry: lifecycleRegistryPath,
    publicOutput: publicOutputPath,
    ambiguityOutput: ambiguityOutputPath,
  })
  assert.deepEqual(materialized.public_risk_scopes, 1)
  assert.deepEqual(materialized.ambiguity_scopes, 1)
  assert.deepEqual(materialized.governed_historical_public_risks, 1)
  assert.deepEqual(materialized.governed_historical_ambiguities, 1)
  const materializedUnknown = JSON.parse(await readFile(ambiguityOutputPath, 'utf8'))
  assert.deepEqual(materializedUnknown.records[0].review_scope, credentialReviewScope(unknownAccess))
  assert.equal(materializedUnknown.governed_immutable_historical_evidence.identities[0].site_signature, materializerEvidence.site_signature)
  await writeFile(inventoryPath, JSON.stringify({
    ...inventory,
    accesses: [publicAccess, { ...unknownAccess, intended_access: 'WRITE' }],
  }))
  await assert.rejects(
    materializeCredentialReviewScopes({
      inventory: inventoryPath,
      publicReview: publicOutputPath,
      ambiguityReview: ambiguityOutputPath,
      lifecycleRegistry: lifecycleRegistryPath,
      publicOutput: publicOutputPath,
      ambiguityOutput: ambiguityOutputPath,
    }),
    /semantic scope drift requires independent re-review/,
    'materializer must not refresh an existing review over same-key semantic drift',
  )
} finally {
  await rm(scopeFixtureDirectory, { recursive: true })
}

const productionSecretSemantics = {
  OWNER_INTERNAL_VALID: 'OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW',
  APPROVED_RUNTIME_PROVIDER_CAPABILITY: 'EXACT_SOURCE_BOUND_RUNTIME_PROVIDER_SECRET_USE_AT_REVIEWED_NON_PUBLIC_BOUNDARIES',
  APPROVED_PROVIDER_CAPABILITY: 'EXACT_MANUAL_OPERATOR_PROVIDER_SECRET_USE_NO_PUBLIC_ROUTE',
  REDACTED_SAFE: 'SECRET_BEARING_READ_NOT_EXPOSED_BY_REVIEWED_OPERATOR_FLOW',
  APPROVED_OPERATOR_CREDENTIAL_DIAGNOSTIC: 'EXACT_MANUAL_OPERATOR_CREDENTIAL_DIAGNOSTIC_NO_PUBLIC_ROUTE',
  APPROVED_CREDENTIAL_IMPORT_CAPABILITY: 'EXACT_MANUAL_OPERATOR_LOCAL_CREDENTIAL_IMPORT_NO_PUBLIC_ROUTE',
}
const productionReviewKey = (entry) => [
  entry.file,
  entry.line,
  entry.column,
  entry.method,
  entry.access,
  entry.entity,
  entry.site_signature,
  entry.source_sha256 ?? entry.review_scope?.source_sha256,
].join('|')
const reviewScope = (entry) => ({
  source_sha256: entry.source_sha256,
  credential_exposure: entry.credential_exposure,
  public_secret_risk: entry.public_secret_risk,
  context_classification: entry.context_classification,
  source_context: entry.source_context,
  lifecycle: entry.surface.lifecycle,
  disposition: entry.surface.disposition,
  production_capability: entry.surface.production_capability,
  functional_owner: entry.surface.functional_owner,
  registry_classified: entry.surface.registry_classified,
})
const ownerSecretAccess = {
  file: 'owner/runtime-secret.ts',
  line: 10,
  column: 4,
  method: 'findUnique',
  access: 'READ',
  entity: 'OwnerCredential',
  site_signature: 'synthetic-owner-secret-read',
  source_sha256: sourceSha('owner-runtime-secret-source'),
  credential_exposure: 'SECRET_READ',
  public_secret_risk: false,
  context_classification: 'OWNER_DIRECT_DB_ACCESS',
  source_context: 'owner_context',
  surface: {
    lifecycle: 'APPLICATION_RUNTIME',
    disposition: null,
    production_capability: 'POSSIBLE',
    functional_owner: null,
    registry_classified: false,
  },
}
const operationalSecretAccess = {
  file: 'ops/check-secret.js',
  line: 20,
  column: 6,
  method: 'findFirst',
  access: 'READ',
  entity: 'OperatorCredential',
  site_signature: 'synthetic-operational-secret-read',
  source_sha256: sourceSha('operator-runtime-secret-source'),
  credential_exposure: 'SECRET_READ',
  public_secret_risk: false,
  context_classification: 'UNCLASSIFIED',
  source_context: null,
  surface: {
    lifecycle: 'OPERATIONAL_SCRIPT',
    disposition: 'ACTIVE',
    production_capability: 'POSSIBLE',
    functional_owner: 'owner_operations',
    registry_classified: true,
  },
}
const ownerSecretReview = {
  review_id: 'synthetic-owner-review',
  review_key: productionReviewKey(ownerSecretAccess),
  ...ownerSecretAccess,
  surface: undefined,
  credential_exposure: undefined,
  public_secret_risk: undefined,
  context_classification: undefined,
  source_context: undefined,
  classification: 'OWNER_INTERNAL_VALID',
  resolved_semantics: productionSecretSemantics.OWNER_INTERNAL_VALID,
  credential_owner: 'owner_context',
  capability_id: 'credential.owner.owner_context.application-runtime.v1',
  approved_architecture_path: 'owner-runtime/owner_context',
  invocation_boundary: 'APPLICATION_RUNTIME',
  operator_only: false,
  public_flow: false,
  review_scope: reviewScope(ownerSecretAccess),
  review_basis: 'Execute the exact owner runtime capability without a public secret-bearing response.',
  evidence: [
    'exact-source-location:owner/runtime-secret.ts:10:4',
    'analyzer-site-signature:synthetic-owner-secret-read',
    'owner-context-match:owner_context=owner_context',
  ],
}
const operationalSecretReview = {
  review_id: 'synthetic-operational-review',
  review_key: productionReviewKey(operationalSecretAccess),
  ...operationalSecretAccess,
  surface: undefined,
  credential_exposure: undefined,
  public_secret_risk: undefined,
  context_classification: undefined,
  source_context: undefined,
  classification: 'APPROVED_PROVIDER_CAPABILITY',
  resolved_semantics: productionSecretSemantics.APPROVED_PROVIDER_CAPABILITY,
  credential_owner: 'operator_owner',
  capability_id: 'credential.operator.owner_operations.ops.check.secret.js.v1',
  approved_architecture_path: 'manual-operator-cli/owner_operations/ops/check-secret.js',
  invocation_boundary: 'MANUAL_OPERATOR_CLI',
  operator_only: true,
  public_flow: false,
  review_scope: reviewScope(operationalSecretAccess),
  review_basis: 'Execute the exact operator provider capability at the manual command boundary.',
  evidence: [
    'exact-source-location:ops/check-secret.js:20:6',
    'analyzer-site-signature:synthetic-operational-secret-read',
    'reviewed-operator-capability:credential.operator.owner_operations.ops.check.secret.js.v1',
  ],
}
const productionReview = (records, overrides = {}) => {
  const keys = records.map((record) => productionReviewKey(record))
  const count = (classification) => records.filter((record) => record.classification === classification).length
  return {
    schema: 'yoko.crm.production-secret-read-disposition-review.v1',
    raw_inventory_authorization: false,
    semantics_by_classification: productionSecretSemantics,
    current_exact_review: {
      access_denominator: records.length,
      unique_site_signature_denominator: new Set(records.map((record) => record.site_signature)).size,
      sorted_review_keys_sha256: createHash('sha256').update(`${[...keys].sort().join('\n')}\n`).digest('hex'),
    },
    summary: {
      total: records.length,
      owner_internal_valid: count('OWNER_INTERNAL_VALID'),
      approved_runtime_provider_capability: count('APPROVED_RUNTIME_PROVIDER_CAPABILITY'),
      approved_provider_capability: count('APPROVED_PROVIDER_CAPABILITY'),
      redacted_safe: count('REDACTED_SAFE'),
      approved_operator_credential_diagnostic: count('APPROVED_OPERATOR_CREDENTIAL_DIAGNOSTIC'),
      approved_credential_import_capability: count('APPROVED_CREDENTIAL_IMPORT_CAPABILITY'),
      application_runtime: records.filter((record) => record.review_scope.lifecycle === 'APPLICATION_RUNTIME').length,
      active_operational_script: records.filter((record) => record.review_scope.lifecycle === 'OPERATIONAL_SCRIPT').length,
      unresolved: 0,
      unknown: 0,
      public_secret_risk_records: 0,
      foreign_direct_secret_reads: 0,
    },
    records,
    ...overrides,
  }
}
const withProductionSecrets = (...entries) => ({
  ...inventory,
  summary: {
    ...inventory.summary,
    credential_database_accesses: inventory.summary.credential_database_accesses + entries.length,
    secret_reads: entries.length,
  },
  policies: [
    { entity: 'OwnerCredential', owner_context: 'owner_context' },
    { entity: 'OperatorCredential', owner_context: 'operator_owner' },
  ],
  accesses: [...inventory.accesses, ...entries],
})

assert.equal(verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, unknown, emptyCrossDomain, fields).status, 'PASS')
const historicalEvidenceSourceSha256 = sourceSha('immutable-provenance-snapshot')
const historicalEvidenceAccess = {
  ...unknownAccess,
  file: 'architecture/migrations/v1/provenance/snapshot/fixture/files/gravity-mvp/src/app/api/example/route.ts',
  site_signature: 'immutable-historical-credential-evidence',
  source_sha256: historicalEvidenceSourceSha256,
  context_classification: 'HISTORICAL_DEAD',
  public_boundary: true,
  public_secret_risk: true,
  surface: {
    lifecycle: 'DEAD_HISTORICAL',
    disposition: 'DEAD_HISTORICAL',
    production_capability: 'NONE',
    functional_owner: 'architecture_recovery_evidence',
    registered_source_sha256: historicalEvidenceSourceSha256,
    registry_classified: true,
  },
}
const historicalEvidenceRegistry = { surfaces: [{
  path: historicalEvidenceAccess.file,
  lifecycle: 'DEAD_HISTORICAL',
  disposition: 'DEAD_HISTORICAL',
  production_capability: 'NONE',
  functional_owner: 'architecture_recovery_evidence',
  source_sha256: historicalEvidenceSourceSha256,
  classification_artifact: 'architecture/migrations/v1/provenance/snapshot/fixture/manifest.json',
  rationale: 'Exact immutable provenance evidence fixture.',
}] }
assert.equal(isGovernedImmutableCredentialEvidence(historicalEvidenceAccess, historicalEvidenceRegistry), true)
const inventoryWithHistoricalEvidence = {
  ...inventory,
  summary: {
    ...inventory.summary,
    credential_database_accesses: inventory.summary.credential_database_accesses + 1,
  },
  accesses: [...inventory.accesses, historicalEvidenceAccess],
}
assert.equal(
  verifyAuthoritativeCredentialInventory(
    inventoryWithHistoricalEvidence, inventory, publicRisk, unknown, emptyCrossDomain, fields,
    undefined, null, historicalEvidenceRegistry,
  ).governed_immutable_historical_credential_evidence.count,
  1,
)
for (const mutation of [
  { file: 'gravity-mvp/src/app/api/example/route.ts' },
  { surface: { ...historicalEvidenceAccess.surface, lifecycle: 'APPLICATION_RUNTIME' } },
  { surface: { ...historicalEvidenceAccess.surface, production_capability: 'POSSIBLE' } },
  { surface: { ...historicalEvidenceAccess.surface, functional_owner: 'application_owner' } },
  { surface: { ...historicalEvidenceAccess.surface, registered_source_sha256: '0'.repeat(64) } },
  { surface: { ...historicalEvidenceAccess.surface, registry_classified: false } },
  { surface: { ...historicalEvidenceAccess.surface, lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE', production_capability: 'POSSIBLE' } },
]) {
  assert.throws(() => verifyAuthoritativeCredentialInventory({
    ...inventoryWithHistoricalEvidence,
    accesses: [...inventory.accesses, { ...historicalEvidenceAccess, ...mutation }],
  }, inventory, publicRisk, unknown, emptyCrossDomain, fields, undefined, null, historicalEvidenceRegistry), /denominator is stale|one-to-one current-key registry/, 'historical evidence exclusion must require every exact lifecycle/hash control')
}
assert.throws(() => verifyAuthoritativeCredentialInventory(
  inventoryWithHistoricalEvidence, inventory, publicRisk, unknown, emptyCrossDomain, fields,
  undefined, null, { surfaces: [] },
), /denominator is stale|one-to-one current-key registry/, 'raw inventory fields cannot self-authorize historical evidence without the independent registry')
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [{ ...inventory.accesses[0], source_sha256: sourceSha('public-downstream-leak-with-same-db-site') }, inventory.accesses[1]],
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /exact one-to-one current-key registry/, 'a public disposition must fail when downstream source bytes change without moving its database site')
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [inventory.accesses[0], { ...inventory.accesses[1], source_sha256: sourceSha('unknown-downstream-semantics-changed') }],
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /one-to-one reviewed dispositions/, 'an ambiguity disposition must fail when same-site source bytes change')
for (const mutation of [
  { intended_access: 'WRITE' },
  { candidate_entities: ['CredentialRecord'] },
  { ambiguity_reasons: ['dynamic_credential_record_write'] },
  { context_classification: 'FOREIGN_DIRECT_DB_ACCESS' },
  { surface: { lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY', production_capability: 'CONTROLLED_MIGRATION', registry_classified: true } },
]) {
  assert.throws(() => verifyAuthoritativeCredentialInventory({
    ...inventory,
    accesses: [inventory.accesses[0], { ...inventory.accesses[1], ...mutation }],
  }, inventory, publicRisk, unknown, emptyCrossDomain, fields), /semantic review scope drift/, 'same-key ambiguity semantics must remain exact')
}
for (const mutation of [
  { exposed_sensitive_field_names: ['password'] },
  { credential_exposure: 'CREDENTIAL_RECORD_WRITE' },
  { owner_context: 'foreign_owner' },
  { context_classification: 'FOREIGN_DIRECT_DB_ACCESS' },
  { surface: { lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE', production_capability: 'POSSIBLE', registry_classified: true } },
]) {
  assert.throws(() => verifyAuthoritativeCredentialInventory({
    ...inventory,
    accesses: [{ ...inventory.accesses[0], ...mutation }, inventory.accesses[1]],
  }, inventory, publicRisk, unknown, emptyCrossDomain, fields), /semantic review scope drift/, 'same-key public-risk semantics must remain exact')
}
const contradictoryUnknownAccess = { ...unknownAccess, intended_access: 'WRITE' }
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [publicAccess, contradictoryUnknownAccess],
}, inventory, publicRisk, {
  ...unknown,
  records: [{ ...unknown.records[0], review_scope: credentialReviewScope(contradictoryUnknownAccess) }],
}, emptyCrossDomain, fields), /read outcome is incompatible with analyzer intent/, 'scope refresh cannot make a contradictory ambiguity outcome valid')
const foreignPublicAccess = {
  ...publicAccess,
  context_classification: 'FOREIGN_DIRECT_DB_ACCESS',
  owner_context: 'foreign_owner',
}
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [foreignPublicAccess, unknownAccess],
}, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{
    ...publicRisk.current_candidate_classifications[0],
    review_scope: credentialReviewScope(foreignPublicAccess),
  }],
}, unknown, emptyCrossDomain, fields), /cannot authorize a foreign credential boundary/, 'scope refresh cannot make a contradictory public-risk outcome valid')
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'new-public', public_secret_risk: true }],
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /denominator is stale/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'new-unknown', access: 'UNKNOWN' }],
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /one-to-one/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  inventory,
  inventory,
  publicRisk,
  {
    ...unknown,
    current_exact_review: {
      ...unknown.current_exact_review,
      sorted_review_keys_sha256: '0'.repeat(64),
    },
  },
  emptyCrossDomain,
  fields,
), /credential ambiguity review is not exact for the current source-bound inventory/, 'a stale current ambiguity aggregate must fail closed')
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, {
    site_signature: 'new-foreign', context_classification: 'FOREIGN_DIRECT_DB_ACCESS', credential_exposure: 'SECRET_READ',
  }],
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /separately governed owner capability/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  summary: { ...inventory.summary, parse_findings: 1 },
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /credential analyzer parse finding/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  summary: { ...inventory.summary, unreviewed_operational_surfaces: 1 },
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /unreviewed operational surfaces/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  inventory_controls: { stale_registry_entries: ['stale.js'] },
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /stale entries/)

assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  summary: { ...inventory.summary, tracked_executable_surfaces: 0, credential_database_accesses: 0 },
}, inventory, publicRisk, unknown, emptyCrossDomain, fields), /surface denominator shrank/)

assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, {
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'raw-baseline-unknown', access: 'UNKNOWN' }],
}, publicRisk, { ...unknown, records: [] , summary: { total: 0 } }, emptyCrossDomain, fields), /one-to-one/, 'raw inventory rows must not whitelist an ambiguity')
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
  ...unknown,
  summary: { total: 2 },
  records: [...unknown.records, unknown.records[0]],
}, emptyCrossDomain, fields), /duplicate dispositions/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
  ...unknown,
  records: [{ ...unknown.records[0], evidence: '' }],
}, emptyCrossDomain, fields), /incomplete disposition/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
  ...unknown,
  records: [{ ...unknown.records[0], classification: 'ARBITRARY_REVIEW_LABEL' }],
}, emptyCrossDomain, fields), /disallowed outcome/)
for (const mutation of [
  { classification: 'GENUINELY_DYNAMIC_UNRESOLVED' },
  { resolved_semantics: 'RUNTIME_IMPACT_UNKNOWN' },
  { credential_boundary: 'PENDING_OWNER_REVIEW' },
]) {
  assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
    ...unknown,
    records: [{ ...unknown.records[0], ...mutation }],
  }, emptyCrossDomain, fields), /retains unresolved disposition language/)
}
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
  ...unknown,
  records: [{ ...unknown.records[0], classification: 'CONFIRMED_DB_READ' }],
}, emptyCrossDomain, fields), /contradicts resolved semantics/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
  ...unknown,
  records: [{
    ...unknown.records[0],
    resolved_target: { ...unknown.records[0].resolved_target, credential_entities_in_scope: true },
  }],
}, emptyCrossDomain, fields), /false-positive outcome still targets credential entities/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, {
  ...unknown,
  records: [{ ...unknown.records[0], review_scope: null }],
}, emptyCrossDomain, fields), /incomplete disposition/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'baseline-public', public_secret_risk: true }],
}, {
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'baseline-public', public_secret_risk: true }],
}, publicRisk, unknown, emptyCrossDomain, fields), /denominator is stale/, 'raw inventory rows must not whitelist public risk')
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_exact_review: { ...publicRisk.current_exact_review, sorted_review_keys_sha256: 'stale' },
}, unknown, emptyCrossDomain, fields), /not exact for the current inventory/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{ ...publicRisk.current_candidate_classifications[0], evidence: [] }],
}, unknown, emptyCrossDomain, fields), /lacks an explicit reviewed disposition/)

assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [...publicRisk.current_candidate_classifications, publicRisk.current_candidate_classifications[0]],
}, unknown, emptyCrossDomain, fields), /duplicate exact keys/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [...publicRisk.current_candidate_classifications, {
    ...publicRisk.current_candidate_classifications[0], site_signature: 'stale-extra',
  }],
}, unknown, emptyCrossDomain, fields), /exact one-to-one current-key registry/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{ ...publicRisk.current_candidate_classifications[0], line: 99 }],
}, unknown, emptyCrossDomain, fields), /exact one-to-one current-key registry/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{ ...publicRisk.current_candidate_classifications[0], classification: 'PENDING_REVIEW' }],
}, unknown, emptyCrossDomain, fields), /disallowed outcome/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{ ...publicRisk.current_candidate_classifications[0], evidence: ['PENDING owner review'] }],
}, unknown, emptyCrossDomain, fields), /unresolved disposition language/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{ ...publicRisk.current_candidate_classifications[0], resolved_semantics: 'REMEDIATED_REDACTED_SAFE' }],
}, unknown, emptyCrossDomain, fields), /contradicts resolved semantics/)
assert.throws(() => verifyAuthoritativeCredentialInventory(inventory, inventory, {
  ...publicRisk,
  current_candidate_classifications: [{ ...publicRisk.current_candidate_classifications[0], review_scope: null }],
}, unknown, emptyCrossDomain, fields), /without exact semantic scope/)

const reviewedProductionInventory = withProductionSecrets(ownerSecretAccess, operationalSecretAccess)
const reviewedProductionSecrets = productionReview([ownerSecretReview, operationalSecretReview])
assert.equal(verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  reviewedProductionSecrets,
).reviewed_production_secret_read_accesses, 2)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  withProductionSecrets({ ...ownerSecretAccess, source_sha256: sourceSha('redacted-sink-replaced-with-secret-log') }, operationalSecretAccess),
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  reviewedProductionSecrets,
), /exact-key digest is stale/, 'a production secret-read disposition must fail when same-site downstream source bytes change')
assert.throws(() => verifyAuthoritativeCredentialInventory(
  withProductionSecrets(ownerSecretAccess),
  withProductionSecrets(ownerSecretAccess),
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
), /denominator is stale or missing/, 'a raw owner/application baseline must not authorize its secret read')
assert.throws(() => verifyAuthoritativeCredentialInventory(
  withProductionSecrets(operationalSecretAccess),
  withProductionSecrets(operationalSecretAccess),
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
), /denominator is stale or missing/, 'a raw active operational baseline must not authorize its secret read')
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  reviewedProductionInventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  productionReview([ownerSecretReview]),
), /denominator is stale or missing/, 'a missing production secret-read review must fail')
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  reviewedProductionInventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    current_exact_review: { ...reviewedProductionSecrets.current_exact_review, sorted_review_keys_sha256: 'stale' },
  },
), /exact-key digest is stale/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    records: [ownerSecretReview, { ...ownerSecretReview, review_id: 'duplicate-owner-review' }, operationalSecretReview],
    summary: { ...reviewedProductionSecrets.summary, total: 3, owner_internal_valid: 2 },
  },
), /duplicate exact keys/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    records: [{ ...ownerSecretReview, resolved_semantics: productionSecretSemantics.REDACTED_SAFE }, operationalSecretReview],
  },
), /contradicts resolved semantics/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    records: [{ ...ownerSecretReview, classification: 'UNKNOWN' }, operationalSecretReview],
  },
), /disallowed or unknown outcome/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    records: [{ ...ownerSecretReview, review_basis: 'PENDING owner decision' }, operationalSecretReview],
  },
), /retains unresolved disposition language/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  reviewedProductionInventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    records: [{ ...ownerSecretReview, review_scope: { ...ownerSecretReview.review_scope, source_context: 'wrong_owner' } }, operationalSecretReview],
  },
), /review scope drift/, 'a raw baseline plus a complete but scope-mismatched review must fail')
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  {
    ...reviewedProductionSecrets,
    records: [{ ...ownerSecretReview, evidence: [] }, operationalSecretReview],
  },
), /incomplete disposition/)
assert.throws(() => verifyAuthoritativeCredentialInventory(
  reviewedProductionInventory,
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  { ...reviewedProductionSecrets, raw_inventory_authorization: true },
), /raw credential inventory cannot confer/)
const newOwnerSecretAccess = {
  ...ownerSecretAccess,
  file: 'owner/new-runtime-secret.ts',
  line: 11,
  site_signature: 'new-owner-secret-read',
}
assert.throws(() => verifyAuthoritativeCredentialInventory(
  withProductionSecrets(ownerSecretAccess, operationalSecretAccess, newOwnerSecretAccess),
  inventory,
  publicRisk,
  unknown,
  emptyCrossDomain,
  fields,
  reviewedProductionSecrets,
), /denominator is stale or missing/, 'a newly added production secret read absent from the independent registry must fail')

const foreignSecretInventory = {
  ...inventory,
  summary: { ...inventory.summary, credential_database_accesses: 3, secret_reads: 1 },
  accesses: [...inventory.accesses, {
    site_signature: 'accepted-foreign', context_classification: 'FOREIGN_DIRECT_DB_ACCESS',
    credential_exposure: 'SECRET_READ', file: 'c.ts', line: 3,
  }],
}
assert.throws(() => verifyAuthoritativeCredentialInventory(
  foreignSecretInventory, foreignSecretInventory, publicRisk, unknown, emptyCrossDomain, fields,
), /separately governed owner capability/, 'an unreviewed foreign secret read must fail')
assert.throws(() => verifyAuthoritativeCredentialInventory(
  foreignSecretInventory, foreignSecretInventory, publicRisk, unknown, reviewedCrossDomainAttempt, fields,
), /require a separately governed owner capability/, 'arbitrary review text cannot authorize a foreign secret read')

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runtimeBoundaryReview = JSON.parse(readFileSync(path.join(
  repositoryRoot,
  'architecture/recovery/whole-project-dod/v2/PRODUCTION_SECRET_READ_DISPOSITION_REVIEW_20260813.json',
), 'utf8'))
const runtimeTrackedFiles = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
}).split('\0').filter(Boolean)
const runtimeContext = {
  trackedFiles: runtimeTrackedFiles,
  readSource: (relative) => readFileSync(path.join(repositoryRoot, relative)),
}
assert.equal(
  verifyRuntimeBoundaryReviews(runtimeBoundaryReview, runtimeBoundaryReview.records, runtimeContext).runtime_boundary_accesses,
  8,
)
const runtimeFixtureFiles = [...new Set(runtimeBoundaryReview.runtime_boundary_reviews.flatMap((review) => [
  ...review.source_modules.map((module) => module.path),
  ...review.consumer_edges.map((edge) => edge.consumer),
]))]
const runtimeFixtureContext = { ...runtimeContext, trackedFiles: runtimeFixtureFiles }
const mutateRuntimeReview = (mutator) => {
  const copy = structuredClone(runtimeBoundaryReview)
  mutator(copy)
  return copy
}
assert.throws(() => {
  const changed = mutateRuntimeReview((review) => { review.runtime_boundary_reviews[0].classification = 'OWNER_INTERNAL_VALID' })
  verifyRuntimeBoundaryReviews(changed, changed.records, runtimeFixtureContext)
}, /classification drift/, 'a secret-bearing runtime capability cannot be relabeled owner-internal')
assert.throws(() => {
  const changed = mutateRuntimeReview((review) => { review.runtime_boundary_reviews[0].consumer_edges.pop() })
  verifyRuntimeBoundaryReviews(changed, changed.records, runtimeFixtureContext)
}, /reviewed consumer graph drift/, 'a missing runtime consumer edge must fail closed')
assert.throws(() => {
  const changed = mutateRuntimeReview((review) => { review.runtime_boundary_reviews[0].consumer_edges.push(structuredClone(review.runtime_boundary_reviews[0].consumer_edges[0])) })
  verifyRuntimeBoundaryReviews(changed, changed.records, runtimeFixtureContext)
}, /reviewed consumer graph drift/, 'an extra runtime consumer edge cannot self-authorize')
assert.throws(() => {
  const changed = mutateRuntimeReview((review) => { review.runtime_boundary_reviews[0].consumer_edges[0].consumer_source_sha256 = sourceSha('stale-consumer') })
  verifyRuntimeBoundaryReviews(changed, changed.records, runtimeFixtureContext)
}, /consumer\/projector byte drift/, 'a stale consumer byte hash must fail closed')
assert.throws(() => {
  const changed = mutateRuntimeReview((review) => { review.runtime_boundary_reviews[0].consumer_edges[0].boundary_semantics = 'UNREVIEWED_SECRET_RESPONSE' })
  verifyRuntimeBoundaryReviews(changed, changed.records, runtimeFixtureContext)
}, /reviewed consumer graph drift/, 'consumer boundary semantics cannot be changed by inventory text')
assert.throws(() => verifyRuntimeBoundaryReviews(runtimeBoundaryReview, runtimeBoundaryReview.records, {
  ...runtimeFixtureContext,
  readSource: (relative) => {
    const bytes = runtimeContext.readSource(relative)
    return relative === 'gravity-mvp/src/app/settings/ai/actions.ts'
      ? Buffer.concat([bytes, Buffer.from('\n// projector identity drift\n')])
      : bytes
  },
}), /consumer\/projector byte drift/, 'a sanitizer/projector source change with the same database site must fail closed')
assert.throws(() => {
  const changed = mutateRuntimeReview((review) => { review.runtime_boundary_reviews.pop() })
  verifyRuntimeBoundaryReviews(changed, changed.records, runtimeFixtureContext)
}, /missing or extra/, 'a missing runtime boundary review must fail closed')

// ---------------------------------------------------------------------------
// Disposable acceptance database setup.
//
// The outcome exists so that a test-only acceptance harness never has to
// masquerade as a MIGRATION surface. Every property below is adversarial: it
// takes the one admissible scenario and breaks a single precondition, proving
// the disposition fails closed rather than inheriting a test-surface exemption.
// ---------------------------------------------------------------------------
const acceptanceWorkflowPath = '.github/workflows/android-acceptance-e2e.yml'
const acceptanceFixturePath = 'android/tools/acceptance-seed.sql'
const acceptanceSchemaPath = 'gravity-mvp/prisma/schema.prisma'
const acceptanceFixtureBytes = Buffer.from([
  '-- synthetic acceptance conversations',
  'INSERT INTO "Chat" (id, channel) VALUES (\'acc_chat\', \'telegram\') ON CONFLICT (id) DO NOTHING;',
  'INSERT INTO "Message" (id, "chatId") VALUES (\'acc_msg\', \'acc_chat\') ON CONFLICT (id) DO NOTHING;',
  '',
].join('\n'))
const acceptanceWorkflowBytes = Buffer.from('acceptance-workflow-source')
const acceptanceWorkflowSha256 = createHash('sha256').update(acceptanceWorkflowBytes).digest('hex')
const acceptanceFixtureSha256 = createHash('sha256').update(acceptanceFixtureBytes).digest('hex')
const acceptanceSurface = {
  lifecycle: 'TEST',
  disposition: 'TEST_SUPPORT',
  production_capability: 'NONE',
  functional_owner: 'platform_engineering',
  registered_source_sha256: acceptanceWorkflowSha256,
  registry_classified: true,
}
const acceptanceAccess = (overrides) => ({
  file: acceptanceWorkflowPath,
  source_sha256: acceptanceWorkflowSha256,
  scope: '<mixed-operational-script>',
  access: 'UNKNOWN',
  intended_access: 'UNKNOWN',
  credential_exposure: 'AMBIGUOUS',
  ambiguous: true,
  ambiguity_reasons: ['sql_not_statically_available'],
  candidate_entities: [],
  sensitive_field_names: [],
  exposed_sensitive_field_names: [],
  public_boundary: false,
  public_secret_risk: false,
  context_classification: 'TEST',
  surface: acceptanceSurface,
  ...overrides,
})
const acceptanceSchemaAccess = acceptanceAccess({
  site_signature: 'acceptance-schema-deploy',
  line: 150,
  column: 39,
  method: 'dynamic-mixed-database-write:prisma migrate deploy',
  database_command_intent: 'WRITE',
})
const acceptanceFixtureAccess = acceptanceAccess({
  site_signature: 'acceptance-fixture-write',
  line: 154,
  column: 33,
  method: 'dynamic-mixed-database-unknown:psql',
  database_command_intent: 'UNKNOWN',
})
const acceptanceTrace = {
  source_owner_context: null,
  capability: '<mixed-operational-script>',
  cross_domain: {
    status: 'TEST_INFRASTRUCTURE_LOCAL_SETUP',
    from: 'platform_engineering',
    to: 'disposable_acceptance_database',
  },
}
const acceptanceSchemaRecord = {
  site_signature: 'acceptance-schema-deploy',
  source_sha256: acceptanceWorkflowSha256,
  classification: 'DISPOSABLE_ACCEPTANCE_DATABASE_SETUP',
  resolved_semantics: 'ACCEPTANCE_SCHEMA_DEPLOY_NO_CREDENTIAL_VALUE_READ',
  credential_boundary: 'disposable_acceptance_database_no_credential_value_access',
  resolved_target: {
    kind: 'disposable_acceptance_database_schema',
    entity: null,
    credential_entities_in_scope: false,
    owner_context: null,
    acceptance_surface: acceptanceWorkflowPath,
    schema_source: acceptanceSchemaPath,
    authorizes_runtime_database_writes: false,
    production_credential_required: false,
    provider_credential_present: false,
  },
  trace: acceptanceTrace,
  evidence: 'committed migrations applied to the disposable acceptance database',
  review_scope: credentialReviewScope(acceptanceSchemaAccess),
}
const acceptanceFixtureRecord = {
  site_signature: 'acceptance-fixture-write',
  source_sha256: acceptanceWorkflowSha256,
  classification: 'DISPOSABLE_ACCEPTANCE_DATABASE_SETUP',
  resolved_semantics: 'SYNTHETIC_ACCEPTANCE_FIXTURE_WRITE_NO_CREDENTIAL_VALUE_ACCESS',
  credential_boundary: 'disposable_acceptance_database_no_credential_value_access',
  resolved_target: {
    kind: 'disposable_acceptance_database_fixture',
    entity: null,
    credential_entities_in_scope: false,
    owner_context: null,
    acceptance_surface: acceptanceWorkflowPath,
    fixture_source: acceptanceFixturePath,
    fixture_sha256: acceptanceFixtureSha256,
    fixture_entities: ['Chat', 'Message'],
    authorizes_generic_database_writes: false,
    production_credential_required: false,
    provider_credential_present: false,
  },
  trace: acceptanceTrace,
  evidence: 'synthetic conversations inserted into the disposable acceptance database',
  review_scope: credentialReviewScope(acceptanceFixtureAccess),
}
const acceptanceCredentialEntities = [
  'Account', 'AiAgentConfig', 'AiProviderSetting', 'ApiConnection', 'Bot', 'MaxConnection',
  'MessagingConnection', 'TelegramConnection', 'WhatsAppConnection', 'avito_accounts',
  'avito_app_settings', 'avito_auth_sessions', 'avito_auth_users', 'cookies',
]
const acceptanceFields = { records: acceptanceCredentialEntities.map((entity) => ({ entity, sensitive_fields: ['token'] })) }
const acceptanceSources = new Map([
  ['a.ts', Buffer.from('public-reviewed-source')],
  ['b.ts', Buffer.from('unknown-reviewed-source')],
  [acceptanceWorkflowPath, acceptanceWorkflowBytes],
  [acceptanceFixturePath, acceptanceFixtureBytes],
])
const acceptanceTrackedFiles = ['a.ts', 'b.ts', acceptanceWorkflowPath, acceptanceFixturePath, acceptanceSchemaPath]
const acceptanceContext = {
  trackedFiles: acceptanceTrackedFiles,
  readSource: (relative) => acceptanceSources.get(relative),
}
const acceptanceContextWithFixture = (bytes) => ({
  trackedFiles: acceptanceTrackedFiles,
  readSource: (relative) => (relative === acceptanceFixturePath ? bytes : acceptanceSources.get(relative)),
})
const ambiguityKey = (entry) => [entry.site_signature, entry.source_sha256].join('|')
const acceptanceArgs = ({
  schemaAccess = acceptanceSchemaAccess,
  fixtureAccess = acceptanceFixtureAccess,
  schemaRecord = acceptanceSchemaRecord,
  fixtureRecord = acceptanceFixtureRecord,
  extraAccesses = [],
  context = acceptanceContext,
  sensitiveFields = acceptanceFields,
} = {}) => {
  const accesses = [publicAccess, unknownAccess, schemaAccess, fixtureAccess, ...extraAccesses]
  const records = [unknown.records[0], schemaRecord, fixtureRecord]
  const ambiguous = [unknownAccess, schemaAccess, fixtureAccess]
  return [
    {
      ...inventory,
      summary: {
        ...inventory.summary,
        credential_database_accesses: accesses.length,
        ambiguous_credential_accesses: ambiguous.length,
      },
      accesses,
    },
    inventory,
    publicRisk,
    {
      summary: { total: records.length },
      current_exact_review: {
        sorted_review_keys_sha256: createHash('sha256')
          .update(`${ambiguous.map(ambiguityKey).sort().join('\n')}\n`)
          .digest('hex'),
      },
      records,
    },
    emptyCrossDomain,
    sensitiveFields,
    undefined,
    context,
    { surfaces: [] },
  ]
}
const withSchemaAccess = (mutation) => {
  const schemaAccess = { ...acceptanceSchemaAccess, ...mutation }
  return { schemaAccess, schemaRecord: { ...acceptanceSchemaRecord, review_scope: credentialReviewScope(schemaAccess) } }
}
const withFixtureAccess = (mutation) => {
  const fixtureAccess = { ...acceptanceFixtureAccess, ...mutation }
  return { fixtureAccess, fixtureRecord: { ...acceptanceFixtureRecord, review_scope: credentialReviewScope(fixtureAccess) } }
}
const withSchemaTarget = (mutation) => ({
  schemaRecord: {
    ...acceptanceSchemaRecord,
    resolved_target: { ...acceptanceSchemaRecord.resolved_target, ...mutation },
  },
})
const withFixtureTarget = (mutation) => ({
  fixtureRecord: {
    ...acceptanceFixtureRecord,
    resolved_target: { ...acceptanceFixtureRecord.resolved_target, ...mutation },
  },
})
const acceptanceRejects = (overrides, pattern, message) => assert.throws(
  () => verifyAuthoritativeCredentialInventory(...acceptanceArgs(overrides)),
  pattern,
  message,
)

assert.equal(
  verifyAuthoritativeCredentialInventory(...acceptanceArgs()).status,
  'PASS',
  'the reviewed disposable acceptance database setup must be admissible',
)

// Ownership class. Only proven test/acceptance infrastructure qualifies.
acceptanceRejects(
  withSchemaAccess({ surface: { ...acceptanceSurface, production_capability: 'POSSIBLE' } }),
  /is production-capable/,
  'an acceptance setup on a production-capable surface must fail closed',
)
acceptanceRejects(
  withSchemaAccess({ surface: { ...acceptanceSurface, production_capability: 'CONFIRMED_AUTOMATIC_DEPLOYMENT' } }),
  /is production-capable/,
  'an acceptance setup with confirmed deployment reachability must fail closed',
)
acceptanceRejects(
  withSchemaAccess({
    surface: { ...acceptanceSurface, lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE' },
    context_classification: 'UNCLASSIFIED',
  }),
  /is not a test-infrastructure surface/,
  'an ordinary ACTIVE operational workflow cannot claim acceptance setup semantics',
)
acceptanceRejects(
  withSchemaAccess({
    surface: {
      ...acceptanceSurface,
      lifecycle: 'MIGRATION',
      disposition: 'MIGRATION_ONLY',
      production_capability: 'CONTROLLED_MIGRATION',
    },
    context_classification: 'MIGRATION_ONLY',
  }),
  /is not a test-infrastructure surface/,
  'a MIGRATION surface cannot be relabelled as disposable acceptance setup',
)
acceptanceRejects(
  withSchemaAccess({ surface: { ...acceptanceSurface, disposition: 'ACTIVE' } }),
  /is not a test-support surface/,
  'a test surface without test-support disposition must fail closed',
)
acceptanceRejects(
  withSchemaAccess({ surface: { ...acceptanceSurface, registry_classified: false } }),
  /lacks a reviewed lifecycle classification/,
  'an unclassified surface cannot claim acceptance setup semantics',
)
acceptanceRejects(
  withSchemaAccess({ context_classification: 'OWNER_DIRECT_DB_ACCESS' }),
  /is not analyzed in a test context/,
  'an acceptance setup outside an analyzed test context must fail closed',
)

// Exact source and review binding.
acceptanceRejects(
  withSchemaAccess({ surface: { ...acceptanceSurface, registered_source_sha256: '0'.repeat(64) } }),
  /not pinned to the registered source bytes/,
  'a registry classification pinned to other bytes must fail closed',
)
acceptanceRejects(
  withSchemaTarget({ acceptance_surface: 'deploy/docker-compose.production.yml' }),
  /is not bound to the analyzed surface/,
  'an acceptance setup bound to another surface must fail closed',
)

// Exact analyzed command shape. Neither semantics may generalize.
acceptanceRejects(
  withSchemaAccess({ method: 'dynamic-mixed-database-write:psql' }),
  /incompatible with the analyzed operation/,
  'schema setup cannot become an arbitrary shell database write',
)
acceptanceRejects(
  withSchemaAccess({ method: 'dynamic-mixed-database-write:prisma db push' }),
  /incompatible with the analyzed operation/,
  'schema setup cannot generalize to another Prisma schema command',
)
acceptanceRejects(
  withFixtureAccess({ method: 'dynamic-mixed-database-write:pg_restore' }),
  /incompatible with the analyzed operation/,
  'the synthetic fixture write cannot become a broad database restore',
)
acceptanceRejects(
  {
    ...withFixtureAccess({ method: 'dynamic-mixed-database-write:prisma migrate deploy' }),
    fixtureRecord: {
      ...acceptanceFixtureRecord,
      review_scope: credentialReviewScope({ ...acceptanceFixtureAccess, method: 'dynamic-mixed-database-write:prisma migrate deploy' }),
    },
  },
  /incompatible with the analyzed operation/,
  'fixture semantics cannot be attached to the schema command shape',
)
acceptanceRejects(
  withSchemaAccess({ database_command_intent: 'READ' }),
  /contradicts analyzer command intent/,
  'schema setup must match the analyzed write intent exactly',
)
acceptanceRejects(
  withFixtureAccess({ database_command_intent: 'WRITE' }),
  /contradicts analyzer command intent/,
  'the fixture write is bound to its exact analyzed intent, not to any intent on a test surface',
)
acceptanceRejects(
  withSchemaAccess({ access: 'WRITE' }),
  /is not the analyzed ambiguous access/,
  'a resolved access cannot be dispositioned as an acceptance ambiguity',
)

// Credential evidence at and around the analyzed site.
acceptanceRejects(
  withSchemaTarget({ credential_entities_in_scope: true }),
  /still targets credential entities/,
  'an acceptance setup in credential scope must fail closed',
)
acceptanceRejects(
  withSchemaAccess({ candidate_entities: ['ApiConnection'] }),
  /has analyzed credential entity candidates/,
  'an acceptance setup with analyzed entity candidates must fail closed',
)
acceptanceRejects(
  withSchemaAccess({ exposed_sensitive_field_names: ['apiKey'] }),
  /exposes analyzed sensitive fields/,
  'an acceptance setup exposing a sensitive field must fail closed',
)
acceptanceRejects(
  withSchemaAccess({ sensitive_field_names: ['sessionString'] }),
  /reaches analyzed sensitive fields/,
  'an acceptance setup reaching a sensitive field must fail closed',
)
acceptanceRejects(
  withSchemaAccess({ public_boundary: true }),
  /crosses a public boundary/,
  'an acceptance setup on a public boundary must fail closed',
)
acceptanceRejects(
  {
    extraAccesses: [{
      file: acceptanceWorkflowPath,
      site_signature: 'acceptance-sibling-credential-read',
      source_sha256: acceptanceWorkflowSha256,
      access: 'READ',
      credential_exposure: 'METADATA_ONLY',
      exposed_sensitive_field_names: ['apiKey'],
      public_secret_risk: false,
      surface: acceptanceSurface,
    }],
  },
  /surface carries a credential-bearing access/,
  'one reviewed ambiguity cannot vouch for a credential-bearing sibling access',
)

// Reviewed target shape.
acceptanceRejects(
  withSchemaTarget({ kind: 'runtime_schema_operation' }),
  /target kind contradicts resolved semantics/,
  'an acceptance setup target kind must match its resolved semantics',
)
acceptanceRejects(
  withSchemaTarget({ entity: 'ApiConnection' }),
  /resolves a database entity/,
  'an acceptance setup that resolves an entity must fail closed',
)
acceptanceRejects(
  withSchemaTarget({ production_credential_required: true }),
  /requires a production credential/,
  'an acceptance setup requiring a production credential must fail closed',
)
acceptanceRejects(
  withSchemaTarget({ provider_credential_present: true }),
  /carries a provider credential/,
  'an acceptance setup carrying a provider credential must fail closed',
)

// Exact source evidence is mandatory: review text alone proves nothing.
acceptanceRejects(
  { context: null },
  /lacks exact source evidence/,
  'an acceptance setup without exact source access must fail closed',
)
acceptanceRejects(
  { context: { readSource: acceptanceContext.readSource } },
  /lacks an exact tracked-file denominator/,
  'an acceptance setup without a tracked-file denominator must fail closed',
)

// Schema preparation authorizes no runtime write and no arbitrary schema.
acceptanceRejects(
  withSchemaTarget({ authorizes_runtime_database_writes: true }),
  /claims runtime database write authority/,
  'schema setup cannot authorize arbitrary runtime database writes',
)
acceptanceRejects(
  withSchemaTarget({ schema_source: 'gravity-mvp/scripts/seed-cells.ts' }),
  /is not a committed Prisma schema/,
  'schema setup must deploy a committed Prisma schema',
)
acceptanceRejects(
  withSchemaTarget({ schema_source: 'untracked/schema.prisma' }),
  /is not a tracked repository file/,
  'schema setup cannot deploy an untracked schema',
)

// The synthetic fixture write is proved from the fixture bytes themselves.
acceptanceRejects(
  withFixtureTarget({ authorizes_generic_database_writes: true }),
  /claims generic database write authority/,
  'the fixture write cannot become a generic database-write exemption',
)
acceptanceRejects(
  withFixtureTarget({ fixture_source: 'untracked/seed.sql' }),
  /is not a tracked repository file/,
  'an untracked fixture must fail closed',
)
acceptanceRejects(
  withFixtureTarget({ fixture_sha256: '0'.repeat(64) }),
  /fixture source-byte binding drift/,
  'a stale fixture byte binding must fail closed',
)
acceptanceRejects(
  withFixtureTarget({ fixture_entities: [] }),
  /declares no synthetic entity/,
  'a fixture review that declares no entity must fail closed',
)
acceptanceRejects(
  withFixtureTarget({ fixture_entities: ['Chat'] }),
  /writes outside the reviewed synthetic entity set/,
  'a fixture writing an undeclared entity must fail closed',
)
const credentialFixtureBytes = Buffer.from('INSERT INTO "Account" (id) VALUES (\'acc\');\n')
acceptanceRejects(
  {
    context: acceptanceContextWithFixture(credentialFixtureBytes),
    ...withFixtureTarget({
      fixture_sha256: createHash('sha256').update(credentialFixtureBytes).digest('hex'),
      fixture_entities: ['Account'],
    }),
  },
  /targets a credential entity/,
  'a fixture writing a credential entity must fail closed',
)
const credentialReadingFixtureBytes = Buffer.from('INSERT INTO "Chat" (id) SELECT id FROM "ApiConnection";\n')
acceptanceRejects(
  {
    context: acceptanceContextWithFixture(credentialReadingFixtureBytes),
    ...withFixtureTarget({
      fixture_sha256: createHash('sha256').update(credentialReadingFixtureBytes).digest('hex'),
      fixture_entities: ['Chat'],
    }),
  },
  /names a credential entity/,
  'a fixture reading a credential entity into a synthetic table must fail closed',
)
const readingFixtureBytes = Buffer.from('SELECT id FROM "Chat";\n')
acceptanceRejects(
  {
    context: acceptanceContextWithFixture(readingFixtureBytes),
    ...withFixtureTarget({ fixture_sha256: createHash('sha256').update(readingFixtureBytes).digest('hex') }),
  },
  /writes outside the reviewed synthetic entity set/,
  'a fixture statement that is not a plain insert must fail closed',
)
acceptanceRejects(
  { sensitiveFields: fields },
  /lacks the authoritative credential entity set/,
  'a fixture disposition without the authoritative credential entity set must fail closed',
)

// Existing migration semantics are untouched: CONTROLLED_SCHEMA_OPERATION still
// requires a MIGRATION surface, and it cannot be reused for acceptance setup.
acceptanceRejects(
  {
    schemaRecord: {
      ...acceptanceSchemaRecord,
      classification: 'CONTROLLED_SCHEMA_OPERATION',
      resolved_semantics: 'REPOSITORY_MIGRATION_DEPLOY_NO_CREDENTIAL_VALUE_READ',
      resolved_target: {
        kind: 'repository_migration_deploy',
        entity: null,
        credential_entities_in_scope: false,
        owner_context: null,
      },
    },
  },
  /controlled schema outcome lacks migration lifecycle/,
  'an existing MIGRATION-only classification cannot be reused on an acceptance surface',
)
const migrationSchemaAccess = acceptanceAccess({
  site_signature: 'acceptance-schema-deploy',
  line: 150,
  column: 39,
  method: 'dynamic-mixed-database-write:prisma migrate deploy',
  database_command_intent: 'WRITE',
  context_classification: 'MIGRATION_ONLY',
  surface: {
    lifecycle: 'MIGRATION',
    disposition: 'MIGRATION_ONLY',
    production_capability: 'CONTROLLED_MIGRATION',
    functional_owner: 'database_operations',
    registered_source_sha256: acceptanceWorkflowSha256,
    registry_classified: true,
  },
})
const migrationSchemaRecord = {
  site_signature: 'acceptance-schema-deploy',
  source_sha256: acceptanceWorkflowSha256,
  classification: 'CONTROLLED_SCHEMA_OPERATION',
  resolved_semantics: 'REPOSITORY_MIGRATION_DEPLOY_NO_CREDENTIAL_VALUE_READ',
  credential_boundary: 'schema_control_no_credential_value_access',
  resolved_target: {
    kind: 'repository_migration_deploy',
    entity: null,
    credential_entities_in_scope: false,
    owner_context: 'database_operations',
  },
  trace: acceptanceTrace,
  evidence: 'committed repository migrations applied by the reviewed migration surface',
  review_scope: credentialReviewScope(migrationSchemaAccess),
}
assert.equal(
  verifyAuthoritativeCredentialInventory(...acceptanceArgs({
    schemaAccess: migrationSchemaAccess,
    schemaRecord: migrationSchemaRecord,
  })).status,
  'PASS',
  'existing controlled schema operation semantics must remain admissible',
)
assert.throws(
  () => verifyAuthoritativeCredentialInventory(...acceptanceArgs({
    schemaAccess: acceptanceSchemaAccess,
    schemaRecord: { ...migrationSchemaRecord, review_scope: credentialReviewScope(acceptanceSchemaAccess) },
  })),
  /controlled schema outcome lacks migration lifecycle/,
  'controlled schema operation still refuses a non-migration surface',
)

process.stdout.write('authoritative credential inventory gate: PASS (76 negative properties; 44 disposable acceptance database properties (40 fail-closed); 2 synthetic production-secret paths; 7 exact runtime-boundary accesses)\n')
