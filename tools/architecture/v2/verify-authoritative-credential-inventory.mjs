#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractImports } from '../enforce-architecture.mjs'

export function riskReviewKey(entry) {
  return [entry.file, entry.line, entry.column, entry.method, entry.access, entry.entity, entry.site_signature, entry.source_sha256 ?? entry.review_scope?.source_sha256].join('|')
}

export function ambiguityReviewKey(entry) {
  return [entry.site_signature, entry.source_sha256].join('|')
}

function hasExactSourceSha256(entry) {
  return typeof entry?.source_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.source_sha256)
}

function assertExactSourceBinding(record, current, label) {
  assert.equal(hasExactSourceSha256(record), true, `${label} is missing an exact source SHA-256 binding`)
  assert.equal(hasExactSourceSha256(current), true, `${label} current analyzer record is missing an exact source SHA-256 binding`)
  assert.equal(record.source_sha256, current.source_sha256, `${label} source-byte binding drift`)
}

const nullable = (value) => value ?? null
const normalizedStrings = (values) => Array.isArray(values)
  ? [...new Set(values.map(String))].sort()
  : []

export function credentialReviewScope(entry) {
  return {
    schema: 'yoko.crm.credential-review-scope.v1',
    source_sha256: nullable(entry.source_sha256),
    file: nullable(entry.file),
    line: Number.isInteger(entry.line) ? entry.line : null,
    column: Number.isInteger(entry.column) ? entry.column : null,
    site_signature: nullable(entry.site_signature),
    scope: nullable(entry.scope),
    method: nullable(entry.method),
    access: nullable(entry.access),
    intended_access: nullable(entry.intended_access),
    database_command_intent: nullable(entry.database_command_intent),
    entity: nullable(entry.entity),
    candidate_entities: normalizedStrings(entry.candidate_entities),
    policy_id: nullable(entry.policy_id),
    owner_context: nullable(entry.owner_context),
    sensitive_field_names: normalizedStrings(entry.sensitive_field_names),
    exposed_sensitive_field_names: normalizedStrings(entry.exposed_sensitive_field_names),
    credential_exposure: nullable(entry.credential_exposure),
    ambiguous: entry.ambiguous === true,
    ambiguity_reasons: normalizedStrings(entry.ambiguity_reasons),
    public_boundary: entry.public_boundary === true,
    public_secret_risk: entry.public_secret_risk === true,
    context_classification: nullable(entry.context_classification),
    source_context: nullable(entry.source_context),
    source_technical_module: nullable(entry.source_technical_module),
    source_identity: nullable(entry.source_identity),
    lifecycle: nullable(entry.surface?.lifecycle),
    disposition: nullable(entry.surface?.disposition),
    production_capability: nullable(entry.surface?.production_capability),
    functional_owner: nullable(entry.surface?.functional_owner),
    registered_source_sha256: nullable(entry.surface?.registered_source_sha256),
    registry_classified: entry.surface?.registry_classified === true,
  }
}

const IMMUTABLE_PROVENANCE_SNAPSHOT = /^architecture\/migrations\/v1\/provenance\/snapshot\/[^/]+\/files\//u

export function isGovernedImmutableCredentialEvidence(entry, lifecycleRegistry = null) {
  const registryRows = lifecycleRegistry instanceof Map
    ? lifecycleRegistry
    : new Map((lifecycleRegistry?.surfaces ?? []).map((surface) => [surface.path, surface]))
  const reviewed = registryRows.get(entry.file)
  const snapshotMatch = /^(architecture\/migrations\/v1\/provenance\/snapshot\/([^/]+))\/files\//u.exec(entry.file ?? '')
  return Boolean(snapshotMatch)
    && IMMUTABLE_PROVENANCE_SNAPSHOT.test(entry.file ?? '')
    && entry.context_classification === 'HISTORICAL_DEAD'
    && entry.surface?.lifecycle === 'DEAD_HISTORICAL'
    && entry.surface?.disposition === 'DEAD_HISTORICAL'
    && entry.surface?.production_capability === 'NONE'
    && entry.surface?.functional_owner === 'architecture_recovery_evidence'
    && entry.surface?.registry_classified === true
    && hasExactSourceSha256(entry)
    && entry.surface?.registered_source_sha256 === entry.source_sha256
    && reviewed?.path === entry.file
    && reviewed.lifecycle === entry.surface.lifecycle
    && reviewed.disposition === entry.surface.disposition
    && reviewed.production_capability === entry.surface.production_capability
    && reviewed.functional_owner === entry.surface.functional_owner
    && reviewed.source_sha256 === entry.source_sha256
    && reviewed.classification_artifact === `${snapshotMatch?.[1]}/manifest.json`
    && typeof reviewed.rationale === 'string'
    && reviewed.rationale.length > 0
}

function assertCredentialReviewScope(record, current, label) {
  assert(record.review_scope && typeof record.review_scope === 'object', `${label} is missing an exact semantic review scope`)
  assertExactSourceBinding(record.review_scope, current, label)
  assert.deepEqual(record.review_scope, credentialReviewScope(current), `${label} semantic review scope drift`)
}

function sha256Lines(values) {
  return createHash('sha256').update(`${[...values].sort().join('\n')}\n`).digest('hex')
}

export function verifyCredentialInventorySourceIntegrity(inventory, context) {
  assert(context && typeof context.readSource === 'function', 'credential source-integrity verification requires an exact source reader')
  const sourceHashes = new Map()
  for (const entry of inventory.accesses ?? []) {
    assert.equal(hasExactSourceSha256(entry), true, `credential inventory access lacks an exact source hash: ${entry.file}:${entry.line}`)
    if (!sourceHashes.has(entry.file)) sourceHashes.set(entry.file, sha256Bytes(context.readSource(entry.file)))
    assert.equal(entry.source_sha256, sourceHashes.get(entry.file), `credential inventory analysis source-byte drift: ${entry.file}:${entry.line}`)
  }
  return {
    exact_source_files: sourceHashes.size,
    exact_source_bound_accesses: (inventory.accesses ?? []).length,
  }
}

function governedEvidenceIdentity(entry) {
  return {
    file: entry.file,
    line: entry.line,
    column: entry.column,
    method: entry.method,
    site_signature: entry.site_signature,
    source_sha256: entry.source_sha256,
    access: entry.access,
    credential_exposure: entry.credential_exposure,
    public_secret_risk: entry.public_secret_risk === true,
  }
}

const PUBLIC_RISK_OUTCOMES = new Set(['SAFE_OWNER_INTERNAL', 'ANALYZER_FALSE_POSITIVE', 'CLOSED_REMEDIATED'])
const PUBLIC_SEMANTICS_BY_OUTCOME = new Map([
  ['SAFE_OWNER_INTERNAL', 'OWNER_INTERNAL_VALID_NO_PUBLIC_SECRET_FLOW'],
  ['ANALYZER_FALSE_POSITIVE', 'ANALYZER_FALSE_POSITIVE_NO_PUBLIC_SECRET_FLOW'],
  ['CLOSED_REMEDIATED', 'REMEDIATED_REDACTED_SAFE'],
])
const UNKNOWN_REVIEW_OUTCOMES = new Set([
  'ANALYZER_FALSE_POSITIVE',
  'CONFIRMED_DB_READ',
  'CONFIRMED_DB_WRITE',
  'CONTROLLED_SCHEMA_OPERATION',
  'STATICALLY_RESOLVABLE',
])
const UNKNOWN_SEMANTICS_BY_OUTCOME = new Map([
  ['ANALYZER_FALSE_POSITIVE', new Set(['NON_CREDENTIAL_ENTITY_READ', 'NON_CREDENTIAL_ENTITY_WRITE'])],
  ['CONFIRMED_DB_READ', new Set(['CREDENTIAL_RECORD_READ_BROAD_DATABASE_DUMP'])],
  ['CONFIRMED_DB_WRITE', new Set(['CREDENTIAL_RECORD_WRITE_BROAD_DATABASE_RESTORE'])],
  ['CONTROLLED_SCHEMA_OPERATION', new Set([
    'REPOSITORY_MIGRATION_DEPLOY_NO_CREDENTIAL_VALUE_READ',
    'SQLITE_SCHEMA_SYNC_NO_CREDENTIAL_VALUE_READ',
  ])],
  ['STATICALLY_RESOLVABLE', new Set([
    'AUTHORIZATION_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS',
    'CLIENT_VERSION_QUERY_NO_DATABASE_OR_CREDENTIAL_ACCESS',
    'DATABASE_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS',
    'NON_CREDENTIAL_ENUM_CATALOG_READ',
    'NON_CREDENTIAL_ROW_COUNT_READ_FINITE_TABLE_SET',
    'PRISMA_MIGRATION_METADATA_WRITE_ONLY',
    'SCHEMA_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS',
  ])],
])
const PRODUCTION_SECRET_SEMANTICS_BY_OUTCOME = new Map([
  ['OWNER_INTERNAL_VALID', 'OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW'],
  ['APPROVED_RUNTIME_PROVIDER_CAPABILITY', 'EXACT_SOURCE_BOUND_RUNTIME_PROVIDER_SECRET_USE_AT_REVIEWED_NON_PUBLIC_BOUNDARIES'],
  ['APPROVED_PROVIDER_CAPABILITY', 'EXACT_MANUAL_OPERATOR_PROVIDER_SECRET_USE_NO_PUBLIC_ROUTE'],
  ['REDACTED_SAFE', 'SECRET_BEARING_READ_NOT_EXPOSED_BY_REVIEWED_OPERATOR_FLOW'],
  ['APPROVED_OPERATOR_CREDENTIAL_DIAGNOSTIC', 'EXACT_MANUAL_OPERATOR_CREDENTIAL_DIAGNOSTIC_NO_PUBLIC_ROUTE'],
  ['APPROVED_CREDENTIAL_IMPORT_CAPABILITY', 'EXACT_MANUAL_OPERATOR_LOCAL_CREDENTIAL_IMPORT_NO_PUBLIC_ROUTE'],
])
const PRODUCTION_SECRET_SUMMARY_FIELDS = new Map([
  ['OWNER_INTERNAL_VALID', 'owner_internal_valid'],
  ['APPROVED_RUNTIME_PROVIDER_CAPABILITY', 'approved_runtime_provider_capability'],
  ['APPROVED_PROVIDER_CAPABILITY', 'approved_provider_capability'],
  ['REDACTED_SAFE', 'redacted_safe'],
  ['APPROVED_OPERATOR_CREDENTIAL_DIAGNOSTIC', 'approved_operator_credential_diagnostic'],
  ['APPROVED_CREDENTIAL_IMPORT_CAPABILITY', 'approved_credential_import_capability'],
])
const UNRESOLVED_REVIEW_LANGUAGE = /(?:UNKNOWN|UNRESOLVED|PENDING)/iu
const STATIC_AMBIGUITY_METHODS_BY_SEMANTICS = new Map([
  ['AUTHORIZATION_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS', /^(?:mixed-script-sql:)/u],
  ['CLIENT_VERSION_QUERY_NO_DATABASE_OR_CREDENTIAL_ACCESS', /^dynamic-mixed-database-read:pg_dump$/u],
  ['DATABASE_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS', /^(?:\$executeRawUnsafe|mixed-script-sql:database_heredoc)$/u],
  ['NON_CREDENTIAL_ENUM_CATALOG_READ', /^\$queryRaw$/u],
  ['NON_CREDENTIAL_ROW_COUNT_READ_FINITE_TABLE_SET', /^mixed-script-sql:embedded_database_string$/u],
  ['PRISMA_MIGRATION_METADATA_WRITE_ONLY', /^dynamic-mixed-database-write:prisma migrate resolve$/u],
  ['SCHEMA_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS', /^mixed-script-sql:embedded_database_string$/u],
])

function assertPublicRiskOutcomeCompatibility(record, current) {
  const label = `public credential-risk review ${current.site_signature}`
  assert.equal(current.public_secret_risk, true, `${label} outcome is incompatible with exact analyzer semantics`)
  assert.equal(current.public_boundary, true, `${label} outcome is incompatible with exact analyzer semantics`)
  assert.notEqual(current.context_classification, 'FOREIGN_DIRECT_DB_ACCESS', `${label} outcome cannot authorize a foreign credential boundary`)
  if (record.classification === 'SAFE_OWNER_INTERNAL') {
    assert(['OWNER_DIRECT_DB_ACCESS', 'TEST', 'UNCLASSIFIED'].includes(current.context_classification), `${label} owner-internal outcome contradicts analyzer context`)
    assert.equal(typeof current.source_context, 'string', `${label} owner-internal outcome lacks a source owner context`)
    if (current.owner_context) assert.equal(current.owner_context, current.source_context, `${label} owner-internal outcome crosses credential ownership`)
  }
  if (record.classification === 'CLOSED_REMEDIATED') {
    assert.equal(current.context_classification, 'OWNER_DIRECT_DB_ACCESS', `${label} remediated outcome is not owner-direct`)
    assert.equal(current.owner_context, current.source_context, `${label} remediated outcome crosses credential ownership`)
    assert((current.exposed_sensitive_field_names ?? []).length > 0, `${label} remediated outcome lacks an analyzed sensitive-field exposure to close`)
  }
}

function assertAmbiguityOutcomeCompatibility(record, current) {
  const label = `credential ambiguity review ${current.site_signature}`
  const target = record.resolved_target
  assert(target && typeof target === 'object', `${label} lacks an exact resolved target`)
  assert.equal(typeof target.credential_entities_in_scope, 'boolean', `${label} lacks a credential-scope conclusion`)
  const candidateEntities = normalizedStrings(current.candidate_entities).map((value) => value.toLowerCase())
  if (target.entity && candidateEntities.length > 0) {
    assert(candidateEntities.includes(String(target.entity).toLowerCase()), `${label} resolved target contradicts analyzer candidates`)
  }

  if (record.classification === 'ANALYZER_FALSE_POSITIVE') {
    assert.equal(target.credential_entities_in_scope, false, `${label} false-positive outcome still targets credential entities`)
    if (record.resolved_semantics === 'NON_CREDENTIAL_ENTITY_READ') {
      assert(['READ', 'UNKNOWN'].includes(current.intended_access), `${label} read outcome is incompatible with analyzer intent`)
      assert.notEqual(current.database_command_intent, 'WRITE', `${label} read outcome contradicts a database write command`)
    } else {
      assert(['WRITE', 'READ_OR_WRITE'].includes(current.intended_access), `${label} write outcome is incompatible with analyzer intent`)
    }
    return
  }

  if (record.classification === 'CONFIRMED_DB_READ') {
    assert.equal(target.credential_entities_in_scope, true, `${label} confirmed credential read lacks credential scope`)
    assert.equal(current.database_command_intent, 'READ', `${label} confirmed read contradicts analyzer command intent`)
    assert.equal(current.method, 'dynamic-mixed-database-read:pg_dump', `${label} confirmed read is not the reviewed broad database dump operation`)
    return
  }
  if (record.classification === 'CONFIRMED_DB_WRITE') {
    assert.equal(target.credential_entities_in_scope, true, `${label} confirmed credential write lacks credential scope`)
    assert.equal(current.database_command_intent, 'WRITE', `${label} confirmed write contradicts analyzer command intent`)
    assert.equal(current.method, 'dynamic-mixed-database-write:pg_restore', `${label} confirmed write is not the reviewed broad database restore operation`)
    return
  }

  assert.equal(target.credential_entities_in_scope, false, `${label} non-secret outcome still targets credential entities`)
  if (record.classification === 'CONTROLLED_SCHEMA_OPERATION') {
    assert.equal(current.database_command_intent, 'WRITE', `${label} controlled schema outcome contradicts analyzer command intent`)
    assert(/^dynamic-mixed-database-write:prisma (?:migrate deploy|db push)$/u.test(current.method), `${label} controlled schema outcome is incompatible with the analyzed operation`)
    assert.equal(current.surface?.lifecycle, 'MIGRATION', `${label} controlled schema outcome lacks migration lifecycle`)
    assert(![undefined, null, 'UNKNOWN'].includes(current.surface?.production_capability), `${label} controlled schema outcome lacks exact production reachability`)
    return
  }

  const allowedMethod = STATIC_AMBIGUITY_METHODS_BY_SEMANTICS.get(record.resolved_semantics)
  assert(allowedMethod?.test(current.method), `${label} static outcome is incompatible with the analyzed operation`)
  if (record.resolved_semantics === 'CLIENT_VERSION_QUERY_NO_DATABASE_OR_CREDENTIAL_ACCESS') {
    assert.equal(current.database_command_intent, 'READ', `${label} client-version outcome contradicts analyzer command intent`)
  }
  if (record.resolved_semantics === 'PRISMA_MIGRATION_METADATA_WRITE_ONLY') {
    assert.equal(current.database_command_intent, 'WRITE', `${label} migration-metadata outcome contradicts analyzer command intent`)
    assert.equal(current.surface?.lifecycle, 'MIGRATION', `${label} migration-metadata outcome lacks migration lifecycle`)
    assert(![undefined, null, 'UNKNOWN'].includes(current.surface?.production_capability), `${label} migration-metadata outcome lacks exact production reachability`)
  }
}

const EMPTY_PRODUCTION_SECRET_REVIEW = {
  schema: 'yoko.crm.production-secret-read-disposition-review.v1',
  raw_inventory_authorization: false,
  semantics_by_classification: Object.fromEntries(PRODUCTION_SECRET_SEMANTICS_BY_OUTCOME),
  current_exact_review: {
    access_denominator: 0,
    unique_site_signature_denominator: 0,
    sorted_review_keys_sha256: sha256Lines([]),
  },
  summary: {
    total: 0,
    owner_internal_valid: 0,
    approved_runtime_provider_capability: 0,
    approved_provider_capability: 0,
    redacted_safe: 0,
    approved_operator_credential_diagnostic: 0,
    approved_credential_import_capability: 0,
    application_runtime: 0,
    active_operational_script: 0,
    unresolved: 0,
    unknown: 0,
    public_secret_risk_records: 0,
    foreign_direct_secret_reads: 0,
  },
  records: [],
}

function dispositionText(record) {
  return JSON.stringify({
    classification: record.classification,
    resolved_semantics: record.resolved_semantics,
    credential_boundary: record.credential_boundary,
    resolved_target: record.resolved_target,
    trace: record.trace,
  })
}

function completeEvidence(record) {
  return Array.isArray(record.evidence)
    && record.evidence.length > 0
    && record.evidence.every((entry) => typeof entry === 'string' && entry.length > 0)
}

function completeResolvedReview(record) {
  return !UNRESOLVED_REVIEW_LANGUAGE.test(JSON.stringify({
    classification: record.classification,
    resolved_semantics: record.resolved_semantics,
    credential_boundary: record.credential_boundary,
    resolved_target: record.resolved_target,
    trace: record.trace,
    approved_architecture_path: record.approved_architecture_path,
    evidence: record.evidence,
  }))
}

function isProductionRelevantSecretRead(entry) {
  return entry.credential_exposure === 'SECRET_READ'
    && entry.public_secret_risk !== true
    && entry.context_classification !== 'FOREIGN_DIRECT_DB_ACCESS'
    && entry.access !== 'UNKNOWN'
    && (
      entry.surface?.lifecycle === 'APPLICATION_RUNTIME'
      || (
        entry.surface?.lifecycle === 'OPERATIONAL_SCRIPT'
        && entry.surface?.disposition === 'ACTIVE'
      )
    )
}

function productionReviewScope(entry) {
  return {
    source_sha256: entry.source_sha256,
    credential_exposure: entry.credential_exposure,
    public_secret_risk: entry.public_secret_risk,
    context_classification: entry.context_classification,
    source_context: entry.source_context,
    lifecycle: entry.surface?.lifecycle,
    disposition: entry.surface?.disposition,
    production_capability: entry.surface?.production_capability,
    functional_owner: entry.surface?.functional_owner,
    registry_classified: entry.surface?.registry_classified,
  }
}

function capabilitySlug(value) {
  return value.replace(/[^a-z0-9]+/giu, '.').replace(/^\.+|\.+$/gu, '').toLowerCase()
}

const runtimeEdge = (source, exportedSymbol, consumer, boundarySemantics, importedAs = exportedSymbol, importKind = 'static') => ({
  source,
  exported_symbol: exportedSymbol,
  consumer,
  imported_as: importedAs,
  import_kind: importKind,
  boundary_semantics: boundarySemantics,
})

export const RUNTIME_BOUNDARY_REVIEW_POLICIES = [
  {
    review_id: 'calling-provider-settings-runtime-provider-v1',
    access_review_ids: ['production-secret-read-035'],
    classification: 'APPROVED_RUNTIME_PROVIDER_CAPABILITY',
    resolved_semantics: 'EXACT_SOURCE_BOUND_RUNTIME_PROVIDER_SECRET_USE_AT_REVIEWED_NON_PUBLIC_BOUNDARIES',
    secret_bearing_runtime_flow: true,
    source_modules: [
      { path: 'gravity-mvp/src/lib/ai-call/provider-settings.ts', exported_symbols: ['getAllPlaintext', 'getValue', 'isMockModeEnabled'] },
      { path: 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', exported_symbols: ['getOpenAiRuntimeProviderCredentialV1'] },
    ],
    consumer_edges: [
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getAllPlaintext', 'gravity-mvp/src/app/api/internal/ai-call-keys/route.ts', 'AUTHENTICATED_INTERNAL_AUDIO_BRIDGE_SECRET_RESPONSE'),
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getValue', 'gravity-mvp/src/app/api/settings/ai-call-keys/test/route.ts', 'ADMIN_AUTHORIZED_OUTBOUND_PROVIDER_VALIDATION'),
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getValue', 'gravity-mvp/src/app/settings/integrations/ai-call-scenarios/page.tsx', 'NON_SECRET_SYSTEM_SETTING_READ'),
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getValue', 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'OWNER_PROVIDER_CREDENTIAL_WRAPPER'),
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'isMockModeEnabled', 'gravity-mvp/src/app/api/ai-calls/mock/route.ts', 'NON_SECRET_BOOLEAN_SETTING_READ'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'getOpenAiRuntimeProviderCredentialV1', 'gravity-mvp/src/modules/calling/public/v1/openai-chat-completion.ts', 'OUTBOUND_PROVIDER_CLIENT_CONSTRUCTION'),
    ],
  },
  {
    review_id: 'calling-provider-settings-write-result-discard-v1',
    access_review_ids: ['production-secret-read-036'],
    classification: 'OWNER_INTERNAL_VALID',
    resolved_semantics: 'OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW',
    secret_bearing_runtime_flow: false,
    source_modules: [
      { path: 'gravity-mvp/src/lib/ai-call/provider-settings.ts', exported_symbols: ['saveValue'] },
      { path: 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', exported_symbols: ['saveAiCallProviderSettingV1'] },
    ],
    consumer_edges: [
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'saveValue', 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'SECRET_WRITE_RESULT_DISCARDED'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'saveAiCallProviderSettingV1', 'gravity-mvp/src/app/api/settings/ai-call-keys/route.ts', 'ADMIN_AUTHORIZED_SECRET_WRITE_NO_SECRET_RESPONSE'),
    ],
  },
  {
    review_id: 'calling-provider-settings-masked-status-v1',
    access_review_ids: ['production-secret-read-037'],
    classification: 'OWNER_INTERNAL_VALID',
    resolved_semantics: 'OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW',
    secret_bearing_runtime_flow: false,
    source_modules: [
      { path: 'gravity-mvp/src/lib/ai-call/provider-settings.ts', exported_symbols: ['getStatus'] },
      { path: 'gravity-mvp/src/lib/ai-call/keys-status.ts', exported_symbols: ['getAiCallKeysStatus'] },
      { path: 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', exported_symbols: ['getAiCallProviderStatusV1'] },
    ],
    consumer_edges: [
      runtimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getStatus', 'gravity-mvp/src/lib/ai-call/keys-status.ts', 'MASKED_STATUS_PROJECTION'),
      runtimeEdge('gravity-mvp/src/lib/ai-call/keys-status.ts', 'getAiCallKeysStatus', 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', 'MASKED_STATUS_REEXPORT', 'getAiCallProviderStatusV1', 'export'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', 'getAiCallProviderStatusV1', 'gravity-mvp/src/app/api/settings/ai-call-keys/route.ts', 'ADMIN_AUTHORIZED_MASKED_STATUS_RESPONSE'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', 'getAiCallProviderStatusV1', 'gravity-mvp/src/app/settings/integrations/ai-call-scenarios/page.tsx', 'SERVER_RENDERED_MASKED_STATUS_ONLY'),
    ],
  },
  {
    review_id: 'calling-ai-agent-runtime-provider-v1',
    access_review_ids: ['production-secret-read-044'],
    classification: 'APPROVED_RUNTIME_PROVIDER_CAPABILITY',
    resolved_semantics: 'EXACT_SOURCE_BOUND_RUNTIME_PROVIDER_SECRET_USE_AT_REVIEWED_NON_PUBLIC_BOUNDARIES',
    secret_bearing_runtime_flow: true,
    source_modules: [
      { path: 'gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', exported_symbols: ['getAiAgentProviderConfigV1'] },
    ],
    consumer_edges: [
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/app/messages/improve-draft-actions.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/app/messages/proposed-reply-actions.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/app/settings/ai/actions.ts', 'MIXED_SANITIZED_ADMIN_METADATA_AND_OUTBOUND_PROVIDER_USE'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/lib/ai/knowledge/Extractor.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/lib/ai/knowledge/Retriever.rerank.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ContextBuilder.ts', 'SERVER_INTERNAL_AI_PIPELINE_PROVIDER_USE'),
    ],
  },
  {
    review_id: 'fleet-yandex-runtime-provider-v1',
    access_review_ids: ['production-secret-read-053', 'production-secret-read-054', 'production-secret-read-075'],
    classification: 'APPROVED_RUNTIME_PROVIDER_CAPABILITY',
    resolved_semantics: 'EXACT_SOURCE_BOUND_RUNTIME_PROVIDER_SECRET_USE_AT_REVIEWED_NON_PUBLIC_BOUNDARIES',
    secret_bearing_runtime_flow: true,
    source_modules: [
      { path: 'gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', exported_symbols: ['getYandexConnectionCredentialsV1', 'listYandexConnectionCredentialsV1'] },
    ],
    consumer_edges: [
      runtimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'getYandexConnectionCredentialsV1', 'gravity-mvp/src/app/api/webhooks/bot/route.ts', 'MIXED_OUTBOUND_PROVIDER_USE_AND_NONSECRET_PARK_NAME_PROJECTION'),
      runtimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'getYandexConnectionCredentialsV1', 'gravity-mvp/src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'listYandexConnectionCredentialsV1', 'gravity-mvp/src/app/api/webhooks/bot/route.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'listYandexConnectionCredentialsV1', 'gravity-mvp/src/modules/fleet-operations/internal/legacy-prisma-yandex-fleet-reconciler-adapter.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      runtimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'listYandexConnectionCredentialsV1', 'gravity-mvp/src/modules/fleet-operations/public/v1/park-phone-search.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
    ],
  },
]

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function verifyCredentialEvidenceDependencyBindings(
  publicRisk,
  publicRiskClassificationBytes,
  crossDomain,
  credentialClosureBytes,
) {
  assert.equal(
    publicRisk.source_artifact,
    'PUBLIC_SECRET_RISK_CLASSIFICATION_20260811.json',
    'public credential-risk closure source artifact drift',
  )
  assert.equal(
    publicRisk.source_sha256,
    sha256Bytes(publicRiskClassificationBytes),
    'public credential-risk closure source artifact SHA-256 drift',
  )
  assert.equal(
    crossDomain.source_inventory,
    'CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json',
    'cross-domain credential review source artifact drift',
  )
  assert.equal(
    crossDomain.source_sha256,
    sha256Bytes(credentialClosureBytes),
    'cross-domain credential review source artifact SHA-256 drift',
  )
  return {
    public_risk_source_sha256: publicRisk.source_sha256,
    cross_domain_source_sha256: crossDomain.source_sha256,
  }
}

function edgeIdentity(edge) {
  return [edge.source, edge.exported_symbol, edge.consumer, edge.imported_as, edge.import_kind].join('|')
}

function resolveRuntimeImport(source, specifier, trackedFileSet) {
  let base
  if (specifier.startsWith('@/') && source.startsWith('gravity-mvp/')) {
    base = `gravity-mvp/src/${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier))
  } else {
    return null
  }
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ]
  return candidates.find((candidate) => trackedFileSet.has(candidate)) ?? null
}

function deriveRuntimeConsumerEdges(policy, context) {
  const trackedFiles = [...context.trackedFiles].sort()
  const trackedFileSet = new Set(trackedFiles)
  const protectedSymbols = new Map(policy.source_modules.map((module) => [module.path, new Set(module.exported_symbols)]))
  const edges = []
  for (const consumer of trackedFiles.filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file))) {
    const sourceText = String(context.readSource(consumer))
    for (const imported of extractImports(sourceText)) {
      const source = resolveRuntimeImport(consumer, imported.specifier, trackedFileSet)
      const symbols = protectedSymbols.get(source)
      if (!symbols) continue
      let matched = false
      for (const binding of imported.imports ?? []) {
        if (!symbols.has(binding.imported) && !['*', 'default'].includes(binding.imported)) continue
        matched = true
        edges.push({
          source,
          exported_symbol: binding.imported,
          consumer,
          imported_as: binding.local,
          import_kind: imported.kind,
        })
      }
      if (!matched && ['dynamic', 'require', 'export'].includes(imported.kind)) {
        edges.push({
          source,
          exported_symbol: '*',
          consumer,
          imported_as: '*',
          import_kind: imported.kind,
        })
      }
    }
  }
  return edges.sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right)))
}

export function verifyRuntimeBoundaryReviews(productionReview, productionSecretRecords, context) {
  const reviews = productionReview.runtime_boundary_reviews ?? []
  assert(context && Array.isArray(context.trackedFiles) && typeof context.readSource === 'function', 'runtime boundary verification requires the exact tracked source context')
  assert.equal(productionReview.runtime_boundary_review_contract?.raw_inventory_authorization, false, 'raw inventory cannot authorize a runtime credential boundary')
  assert.equal(productionReview.runtime_boundary_review_contract?.review_denominator, RUNTIME_BOUNDARY_REVIEW_POLICIES.length, 'runtime boundary review denominator is stale')
  assert.equal(productionReview.runtime_boundary_review_contract?.access_denominator, RUNTIME_BOUNDARY_REVIEW_POLICIES.flatMap((entry) => entry.access_review_ids).length, 'runtime boundary access denominator is stale')
  assert.deepEqual(
    reviews.map((review) => review.review_id).sort(),
    RUNTIME_BOUNDARY_REVIEW_POLICIES.map((policy) => policy.review_id).sort(),
    'runtime credential boundary reviews are missing or extra',
  )
  const recordById = new Map(productionSecretRecords.map((record) => [record.review_id, record]))
  const linkedAccessIds = []
  for (const policy of RUNTIME_BOUNDARY_REVIEW_POLICIES) {
    const review = reviews.find((candidate) => candidate.review_id === policy.review_id)
    assert(review, `missing runtime credential boundary review: ${policy.review_id}`)
    assert.equal(review.review_authority, 'INDEPENDENT_RUNTIME_CREDENTIAL_BOUNDARY_REVIEW_20260813', `runtime boundary review authority drift: ${policy.review_id}`)
    assert.equal(review.raw_inventory_authorization, false, `runtime boundary raw inventory authorization drift: ${policy.review_id}`)
    assert.deepEqual([...review.access_review_ids].sort(), [...policy.access_review_ids].sort(), `runtime boundary access identity drift: ${policy.review_id}`)
    assert.equal(review.classification, policy.classification, `runtime boundary classification drift: ${policy.review_id}`)
    assert.equal(review.resolved_semantics, policy.resolved_semantics, `runtime boundary semantics drift: ${policy.review_id}`)
    assert.equal(review.secret_bearing_runtime_flow, policy.secret_bearing_runtime_flow, `runtime secret-bearing flow truth drift: ${policy.review_id}`)
    assert.equal(typeof review.authorization_basis, 'string', true, `runtime boundary authorization basis missing: ${policy.review_id}`)
    assert.equal(review.authorization_basis.length > 0, true, `runtime boundary authorization basis empty: ${policy.review_id}`)
    assert.equal(Array.isArray(review.evidence) && review.evidence.length >= 3, true, `runtime boundary evidence incomplete: ${policy.review_id}`)
    for (const accessReviewId of policy.access_review_ids) {
      linkedAccessIds.push(accessReviewId)
      const record = recordById.get(accessReviewId)
      assert(record, `runtime boundary references a missing production access review: ${accessReviewId}`)
      assert.equal(record.runtime_boundary_review_id, policy.review_id, `production secret access lacks its exact runtime boundary review: ${accessReviewId}`)
      assert.equal(record.classification, policy.classification, `production secret access runtime classification drift: ${accessReviewId}`)
      assert.equal(record.resolved_semantics, policy.resolved_semantics, `production secret access runtime semantics drift: ${accessReviewId}`)
      assert.equal(record.secret_bearing_runtime_flow, policy.secret_bearing_runtime_flow, `production secret access runtime-flow truth drift: ${accessReviewId}`)
    }
    assert.deepEqual(
      review.source_modules.map((module) => ({ path: module.path, exported_symbols: module.exported_symbols })).sort((left, right) => left.path.localeCompare(right.path)),
      policy.source_modules.map((module) => ({ path: module.path, exported_symbols: module.exported_symbols })).sort((left, right) => left.path.localeCompare(right.path)),
      `runtime boundary source-module contract drift: ${policy.review_id}`,
    )
    for (const module of review.source_modules) {
      assert.equal(hasExactSourceSha256(module), true, `runtime boundary source module lacks a source hash: ${policy.review_id}:${module.path}`)
      assert.equal(module.source_sha256, sha256Bytes(context.readSource(module.path)), `runtime boundary source module byte drift: ${policy.review_id}:${module.path}`)
    }
    const expectedEdges = policy.consumer_edges.map(({ boundary_semantics: ignored, ...edge }) => edge).sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right)))
    assert.deepEqual(deriveRuntimeConsumerEdges(policy, context), expectedEdges, `runtime boundary current consumer graph drift: ${policy.review_id}`)
    assert.deepEqual(
      review.consumer_edges.map(({ consumer_source_sha256: ignored, ...edge }) => edge).sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right))),
      policy.consumer_edges.map((edge) => ({ ...edge })).sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right))),
      `runtime boundary reviewed consumer graph drift: ${policy.review_id}`,
    )
    for (const edge of review.consumer_edges) {
      assert.equal(hasExactSourceSha256({ source_sha256: edge.consumer_source_sha256 }), true, `runtime boundary consumer lacks a source hash: ${policy.review_id}:${edge.consumer}`)
      assert.equal(edge.consumer_source_sha256, sha256Bytes(context.readSource(edge.consumer)), `runtime boundary consumer/projector byte drift: ${policy.review_id}:${edge.consumer}`)
    }
  }
  assert.equal(new Set(linkedAccessIds).size, linkedAccessIds.length, 'runtime boundary review links a production secret access more than once')
  assert.deepEqual(
    productionSecretRecords.filter((record) => record.runtime_boundary_review_id).map((record) => record.review_id).sort(),
    [...linkedAccessIds].sort(),
    'production secret registry contains an extra or missing runtime boundary link',
  )
  return { status: 'PASS', runtime_boundary_reviews: reviews.length, runtime_boundary_accesses: linkedAccessIds.length }
}

function completeProductionSecretReview(record) {
  return typeof record.review_id === 'string'
    && record.review_id.length > 0
    && typeof record.review_key === 'string'
    && record.review_key.length > 0
    && typeof record.file === 'string'
    && record.file.length > 0
    && Number.isInteger(record.line)
    && record.line > 0
    && Number.isInteger(record.column)
    && record.column > 0
    && typeof record.method === 'string'
    && record.method.length > 0
    && record.access === 'READ'
    && typeof record.entity === 'string'
    && record.entity.length > 0
    && typeof record.site_signature === 'string'
    && record.site_signature.length > 0
    && typeof record.credential_owner === 'string'
    && record.credential_owner.length > 0
    && typeof record.capability_id === 'string'
    && record.capability_id.length > 0
    && typeof record.approved_architecture_path === 'string'
    && record.approved_architecture_path.length > 0
    && typeof record.review_basis === 'string'
    && record.review_basis.length > 0
    && completeEvidence(record)
    && record.evidence.length >= 3
    && (
      record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY'
        ? record.public_flow === true && record.external_public_secret_response === false
        : record.public_flow === false
    )
    && typeof record.operator_only === 'boolean'
    && record.review_scope
    && typeof record.review_scope === 'object'
}

export function verifyAuthoritativeCredentialInventory(
  inventory,
  acceptedInventory,
  acceptedPublicRisk,
  acceptedUnknown,
  acceptedCrossDomain,
  sensitiveFields,
  acceptedProductionSecretReads = EMPTY_PRODUCTION_SECRET_REVIEW,
  runtimeBoundaryContext = null,
  lifecycleRegistry = { surfaces: [] },
) {
  assert.equal(inventory.schema, 'yoko.crm.whole-repository-credential-database-access.v2')
  assert.equal(inventory.summary?.parse_findings, 0, 'credential analyzer parse finding')
  assert.equal(inventory.summary?.unreviewed_operational_surfaces, 0, 'credential inventory has unreviewed operational surfaces')
  assert.deepEqual(inventory.inventory_controls?.stale_registry_entries, [], 'credential inventory lifecycle registry has stale entries')
  assert.equal(sensitiveFields.records?.length, 14, 'sensitive-field registry drift')
  assert(
    inventory.summary?.tracked_executable_surfaces >= acceptedInventory.summary?.tracked_executable_surfaces,
    'credential inventory surface denominator shrank without a reviewed checkpoint update',
  )
  assert(
    inventory.summary?.credential_database_accesses >= acceptedInventory.summary?.credential_database_accesses,
    'credential database-access denominator shrank without a reviewed checkpoint update',
  )
  const sourceIntegrity = runtimeBoundaryContext
    ? verifyCredentialInventorySourceIntegrity(inventory, runtimeBoundaryContext)
    : null

  const publicRiskRecords = acceptedPublicRisk.current_candidate_classifications ?? []
  const publicRiskSignatures = new Set(publicRiskRecords.map((record) => record.site_signature))
  const reviewedUnknown = acceptedUnknown.records ?? []
  const unknownReviewKeys = reviewedUnknown.map(ambiguityReviewKey)
  const crossDomainRecords = acceptedCrossDomain.current_records ?? []
  const crossDomainSignatures = new Set(crossDomainRecords.map((record) => record.site_signature))
  assert.equal(publicRiskSignatures.has(undefined), false, 'public credential-risk review contains a missing signature')
  assert.equal(crossDomainSignatures.has(undefined), false, 'cross-domain credential review contains a missing signature')
  assert.equal(reviewedUnknown.some((record) => typeof record.site_signature !== 'string' || record.site_signature.length === 0), false, 'credential ambiguity review contains a missing signature')
  assert.equal(new Set(unknownReviewKeys).size, reviewedUnknown.length, 'credential ambiguity review contains duplicate dispositions')
  const publicRiskKeys = publicRiskRecords.map(riskReviewKey)
  const crossDomainKeys = crossDomainRecords.map(riskReviewKey)
  assert.equal(new Set(publicRiskKeys).size, publicRiskKeys.length, 'public credential-risk review contains duplicate exact keys')
  assert.equal(new Set(crossDomainKeys).size, crossDomainKeys.length, 'cross-domain credential review contains duplicate exact keys')
  assert.equal(publicRiskRecords.every((record) => PUBLIC_RISK_OUTCOMES.has(record.classification)), true, 'public credential-risk review contains a disallowed outcome')
  assert.equal(publicRiskRecords.every((record) => PUBLIC_SEMANTICS_BY_OUTCOME.get(record.classification) === record.resolved_semantics), true, 'public credential-risk review classification contradicts resolved semantics')
  assert.equal(publicRiskRecords.every(completeResolvedReview), true, 'public credential-risk review retains unresolved disposition language')
  assert.equal(publicRiskRecords.every(hasExactSourceSha256), true, 'public credential-risk review contains a disposition without exact source-byte binding')
  assert.equal(publicRiskRecords.every((record) => record.review_scope && typeof record.review_scope === 'object'), true, 'public credential-risk review contains a disposition without exact semantic scope')
  assert.equal(acceptedUnknown.summary?.total, reviewedUnknown.length, 'credential ambiguity review summary denominator is stale')
  assert.equal(reviewedUnknown.every((record) => (
    typeof record.classification === 'string'
    && record.classification.length > 0
    && typeof record.resolved_semantics === 'string'
    && record.resolved_semantics.length > 0
    && typeof record.evidence === 'string'
    && record.evidence.length > 0
    && record.resolved_target
    && typeof record.resolved_target === 'object'
    && record.review_scope
    && typeof record.review_scope === 'object'
  )), true, 'credential ambiguity review contains an incomplete disposition')
  assert.equal(reviewedUnknown.every((record) => !UNRESOLVED_REVIEW_LANGUAGE.test(dispositionText(record))), true, 'credential ambiguity review retains unresolved disposition language')
  assert.equal(reviewedUnknown.every((record) => UNKNOWN_REVIEW_OUTCOMES.has(record.classification)), true, 'credential ambiguity review contains a disallowed outcome')
  assert.equal(reviewedUnknown.every((record) => UNKNOWN_SEMANTICS_BY_OUTCOME.get(record.classification)?.has(record.resolved_semantics)), true, 'credential ambiguity review classification contradicts resolved semantics')
  assert.equal(reviewedUnknown.every(hasExactSourceSha256), true, 'credential ambiguity review contains a disposition without exact source-byte binding')
  assert.equal(acceptedCrossDomain.exact_coverage, true, 'accepted cross-domain review is incomplete')
  assert.equal(acceptedCrossDomain.summary?.confirmed_unapproved_secret_reads, 0)
  assert.equal(acceptedCrossDomain.summary?.material_capability_gap_remaining, 0)

  const accesses = inventory.accesses ?? []
  const lifecycleByPath = new Map((lifecycleRegistry.surfaces ?? []).map((surface) => [surface.path, surface]))
  const governedHistoricalCredentialEvidence = accesses.filter((entry) => (
    isGovernedImmutableCredentialEvidence(entry, lifecycleByPath)
    && (entry.public_secret_risk || entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
  ))
  const governedHistoricalPublicRisk = governedHistoricalCredentialEvidence.filter((entry) => entry.public_secret_risk)
  const governedHistoricalAmbiguous = governedHistoricalCredentialEvidence.filter((entry) => (
    entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS'
  ))
  const governedHistoricalSignatureIdentities = [...new Set(governedHistoricalCredentialEvidence.map((entry) => (
    `${entry.site_signature}|${entry.source_sha256}`
  )))].sort()
  const currentPublicRisk = accesses.filter((entry) => entry.public_secret_risk && !isGovernedImmutableCredentialEvidence(entry, lifecycleByPath))
  assert.equal(acceptedPublicRisk.current_exact_review?.risk_denominator, currentPublicRisk.length, 'public credential-risk denominator is stale')
  assert.deepEqual([...publicRiskKeys].sort(), currentPublicRisk.map(riskReviewKey).sort(), 'public credential-risk review is not an exact one-to-one current-key registry')
  assert.equal(
    acceptedPublicRisk.current_exact_review?.sorted_review_keys_sha256,
    sha256Lines(currentPublicRisk.map(riskReviewKey)),
    'public credential-risk review is not exact for the current inventory',
  )
  assert.equal(currentPublicRisk.every((entry) => publicRiskRecords.some((record) => (
    riskReviewKey(record) === riskReviewKey(entry)
    && typeof record.classification === 'string'
    && record.classification.length > 0
    && completeEvidence(record)
  ))), true, 'public credential risk lacks an explicit reviewed disposition')
  for (const entry of currentPublicRisk) {
    const record = publicRiskRecords.find((candidate) => riskReviewKey(candidate) === riskReviewKey(entry))
    assert(record, `public credential-risk review is missing current source binding: ${entry.site_signature}`)
    assertExactSourceBinding(record, entry, `public credential-risk review ${entry.site_signature}`)
    assertCredentialReviewScope(record, entry, `public credential-risk review ${entry.site_signature}`)
    assertPublicRiskOutcomeCompatibility(record, entry)
  }
  const currentForeignSecretReads = accesses.filter((entry) => (
    entry.context_classification === 'FOREIGN_DIRECT_DB_ACCESS'
    && entry.credential_exposure === 'SECRET_READ'
  ))
  assert.equal(currentForeignSecretReads.length, 0, 'cross-domain secret reads require a separately governed owner capability; review text cannot authorize them')
  assert.deepEqual(crossDomainRecords, [], 'cross-domain secret-read review must be empty when the exact denominator is zero')
  assert.equal(acceptedCrossDomain.current_exact_review?.secret_read_denominator, currentForeignSecretReads.length, 'cross-domain secret-read denominator is stale')
  assert.deepEqual([...crossDomainKeys].sort(), currentForeignSecretReads.map(riskReviewKey).sort(), 'cross-domain secret-read review is not an exact one-to-one current-key registry')
  assert.equal(
    acceptedCrossDomain.current_exact_review?.sorted_review_keys_sha256,
    sha256Lines(currentForeignSecretReads.map(riskReviewKey)),
    'cross-domain secret-read review is not exact for the current inventory',
  )
  assert.equal(currentForeignSecretReads.every((entry) => crossDomainRecords.some((record) => (
    riskReviewKey(record) === riskReviewKey(entry)
    && typeof record.classification === 'string'
    && record.classification.length > 0
    && typeof record.approved_architecture_path === 'string'
    && record.approved_architecture_path.length > 0
  ))), true, 'cross-domain secret read lacks an explicit reviewed disposition')
  const currentUnknown = accesses.filter((entry) => (
    (entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
    && !isGovernedImmutableCredentialEvidence(entry, lifecycleByPath)
  ))
  const currentUnknownReviewKeys = currentUnknown.map(ambiguityReviewKey)
  assert.equal(new Set(currentUnknownReviewKeys).size, currentUnknownReviewKeys.length, 'current credential ambiguity denominator contains duplicate exact source-bound keys')
  assert.deepEqual(
    [...unknownReviewKeys].sort(),
    [...currentUnknownReviewKeys].sort(),
    'credential ambiguities require one-to-one reviewed dispositions for the current exact denominator',
  )
  assert.equal(
    acceptedUnknown.current_exact_review?.sorted_review_keys_sha256,
    sha256Lines(currentUnknownReviewKeys),
    'credential ambiguity review is not exact for the current source-bound inventory',
  )
  for (const entry of currentUnknown) {
    const record = reviewedUnknown.find((candidate) => ambiguityReviewKey(candidate) === ambiguityReviewKey(entry))
    assert(record, `credential ambiguity review is missing current source binding: ${entry.site_signature}`)
    assertExactSourceBinding(record, entry, `credential ambiguity review ${entry.site_signature}`)
    assertCredentialReviewScope(record, entry, `credential ambiguity review ${entry.site_signature}`)
    assertAmbiguityOutcomeCompatibility(record, entry)
  }
  const currentProductionSecretReads = accesses.filter(isProductionRelevantSecretRead)
  const productionSecretRecords = acceptedProductionSecretReads.records ?? []
  const productionSecretKeys = productionSecretRecords.map(riskReviewKey)
  const currentProductionSecretKeys = currentProductionSecretReads.map(riskReviewKey)
  const productionSecretByKey = new Map(currentProductionSecretReads.map((entry) => [riskReviewKey(entry), entry]))
  const credentialOwnerByEntity = new Map((inventory.policies ?? []).map((policy) => [policy.entity, policy.owner_context]))
  assert.equal(
    acceptedProductionSecretReads.schema,
    'yoko.crm.production-secret-read-disposition-review.v1',
    'production secret-read disposition registry schema drift',
  )
  assert.equal(
    acceptedProductionSecretReads.raw_inventory_authorization,
    false,
    'raw credential inventory cannot confer production secret-read authorization',
  )
  assert.deepEqual(
    acceptedProductionSecretReads.semantics_by_classification,
    Object.fromEntries(PRODUCTION_SECRET_SEMANTICS_BY_OUTCOME),
    'production secret-read disposition vocabulary drift',
  )
  assert.equal(
    acceptedProductionSecretReads.current_exact_review?.access_denominator,
    currentProductionSecretReads.length,
    'production secret-read review denominator is stale or missing',
  )
  assert.equal(
    acceptedProductionSecretReads.current_exact_review?.unique_site_signature_denominator,
    new Set(currentProductionSecretReads.map((entry) => entry.site_signature)).size,
    'production secret-read unique-signature denominator is stale',
  )
  assert.equal(
    acceptedProductionSecretReads.current_exact_review?.sorted_review_keys_sha256,
    sha256Lines(currentProductionSecretKeys),
    'production secret-read exact-key digest is stale',
  )
  assert.equal(
    new Set(productionSecretKeys).size,
    productionSecretKeys.length,
    'production secret-read review contains duplicate exact keys',
  )
  assert.equal(
    new Set(productionSecretRecords.map((record) => record.review_id)).size,
    productionSecretRecords.length,
    'production secret-read review contains duplicate review IDs',
  )
  assert.deepEqual(
    [...productionSecretKeys].sort(),
    [...currentProductionSecretKeys].sort(),
    'production secret reads require an exact one-to-one independent review registry',
  )
  assert.equal(
    productionSecretRecords.every((record) => record.review_key === riskReviewKey(record)),
    true,
    'production secret-read review key contradicts its exact access identity',
  )
  assert.equal(
    productionSecretRecords.every(completeProductionSecretReview),
    true,
    'production secret-read review contains an incomplete disposition',
  )
  assert.equal(
    productionSecretRecords.every((record) => PRODUCTION_SECRET_SEMANTICS_BY_OUTCOME.has(record.classification)),
    true,
    'production secret-read review contains a disallowed or unknown outcome',
  )
  assert.equal(
    productionSecretRecords.every((record) => (
      PRODUCTION_SECRET_SEMANTICS_BY_OUTCOME.get(record.classification) === record.resolved_semantics
    )),
    true,
    'production secret-read review classification contradicts resolved semantics',
  )
  assert.equal(
    productionSecretRecords.every((record) => !UNRESOLVED_REVIEW_LANGUAGE.test(JSON.stringify({
      classification: record.classification,
      resolved_semantics: record.resolved_semantics,
      review_basis: record.review_basis,
      capability_id: record.capability_id,
      approved_architecture_path: record.approved_architecture_path,
      evidence: record.evidence,
    }))),
    true,
    'production secret-read review retains unresolved disposition language',
  )
  for (const record of productionSecretRecords) {
    const current = productionSecretByKey.get(record.review_key)
    assert(current, `stale production secret-read disposition: ${record.review_key}`)
    assertExactSourceBinding(record.review_scope, current, `production secret-read review ${record.review_key}`)
    assert.deepEqual(record.review_scope, productionReviewScope(current), `production secret-read review scope drift: ${record.review_key}`)
    assert.equal(record.credential_owner, credentialOwnerByEntity.get(current.entity), `production secret-read credential owner contradiction: ${record.review_key}`)
    if (record.classification === 'OWNER_INTERNAL_VALID') {
      assert.equal(current.surface?.lifecycle, 'APPLICATION_RUNTIME', `owner-internal production secret-read has non-runtime lifecycle: ${record.review_key}`)
      assert.equal(current.context_classification, 'OWNER_DIRECT_DB_ACCESS', `owner-internal production secret-read is not owner-direct: ${record.review_key}`)
      assert.equal(current.source_context, record.credential_owner, `owner-internal production secret-read source/owner contradiction: ${record.review_key}`)
      assert.equal(record.invocation_boundary, 'APPLICATION_RUNTIME', `owner-internal production secret-read invocation contradiction: ${record.review_key}`)
      assert.equal(record.operator_only, false, `owner-internal production secret-read cannot claim operator-only scope: ${record.review_key}`)
      assert.equal(record.capability_id, `credential.owner.${record.credential_owner}.application-runtime.v1`, `owner-internal production secret-read capability drift: ${record.review_key}`)
      assert.equal(record.approved_architecture_path, `owner-runtime/${record.credential_owner}`, `owner-internal production secret-read architecture path drift: ${record.review_key}`)
    } else if (record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY') {
      assert.equal(current.surface?.lifecycle, 'APPLICATION_RUNTIME', `runtime provider secret-read has non-runtime lifecycle: ${record.review_key}`)
      assert.equal(current.context_classification, 'OWNER_DIRECT_DB_ACCESS', `runtime provider secret-read is not owner-direct: ${record.review_key}`)
      assert.equal(current.source_context, record.credential_owner, `runtime provider secret-read source/owner contradiction: ${record.review_key}`)
      assert.equal(record.invocation_boundary, 'APPLICATION_RUNTIME_PROVIDER', `runtime provider secret-read invocation contradiction: ${record.review_key}`)
      assert.equal(record.operator_only, false, `runtime provider secret-read cannot claim operator-only scope: ${record.review_key}`)
      assert.equal(record.public_flow, true, `runtime provider secret-read must declare its exported secret-bearing capability flow: ${record.review_key}`)
      assert.equal(record.external_public_secret_response, false, `runtime provider secret-read cannot expose an external public secret response: ${record.review_key}`)
      assert.equal(record.secret_bearing_runtime_flow, true, `runtime provider secret-read must honestly declare a secret-bearing runtime flow: ${record.review_key}`)
      assert.equal(
        record.capability_id,
        `credential.runtime.${capabilitySlug(record.runtime_boundary_review_id)}`,
        `runtime provider secret-read capability drift: ${record.review_key}`,
      )
      assert.equal(
        record.approved_architecture_path,
        `runtime-provider/${record.credential_owner}/${record.runtime_boundary_review_id}`,
        `runtime provider secret-read architecture path drift: ${record.review_key}`,
      )
    } else {
      assert.equal(current.surface?.lifecycle, 'OPERATIONAL_SCRIPT', `operator production secret-read has non-operational lifecycle: ${record.review_key}`)
      assert.equal(current.surface?.disposition, 'ACTIVE', `operator production secret-read is not an active surface: ${record.review_key}`)
      assert.equal(current.surface?.registry_classified, true, `operator production secret-read lacks lifecycle review: ${record.review_key}`)
      assert.equal(typeof current.surface?.functional_owner, 'string', `operator production secret-read lacks a functional owner: ${record.review_key}`)
      assert.equal(current.surface.functional_owner.length > 0, true, `operator production secret-read has an empty functional owner: ${record.review_key}`)
      assert.equal(record.invocation_boundary, 'MANUAL_OPERATOR_CLI', `operator production secret-read invocation contradiction: ${record.review_key}`)
      assert.equal(record.operator_only, true, `operator production secret-read must remain operator-only: ${record.review_key}`)
      assert.equal(
        record.capability_id,
        `credential.operator.${current.surface.functional_owner}.${capabilitySlug(current.file)}.v1`,
        `operator production secret-read capability drift: ${record.review_key}`,
      )
      assert.equal(
        record.approved_architecture_path,
        `manual-operator-cli/${current.surface.functional_owner}/${current.file}`,
        `operator production secret-read architecture path drift: ${record.review_key}`,
      )
    }
  }
  const exactRuntimeBoundaryAccessIds = new Set(RUNTIME_BOUNDARY_REVIEW_POLICIES.flatMap((policy) => policy.access_review_ids))
  if (
    productionSecretRecords.some((record) => exactRuntimeBoundaryAccessIds.has(record.review_id))
    || productionSecretRecords.some((record) => record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY')
    || (acceptedProductionSecretReads.runtime_boundary_reviews?.length ?? 0) > 0
  ) {
    verifyRuntimeBoundaryReviews(acceptedProductionSecretReads, productionSecretRecords, runtimeBoundaryContext)
  }
  assert.equal(acceptedProductionSecretReads.summary?.total, productionSecretRecords.length, 'production secret-read review summary denominator is stale')
  for (const [classification, summaryField] of PRODUCTION_SECRET_SUMMARY_FIELDS) {
    assert.equal(
      acceptedProductionSecretReads.summary?.[summaryField],
      productionSecretRecords.filter((record) => record.classification === classification).length,
      `production secret-read ${classification} summary is stale`,
    )
  }
  assert.equal(
    acceptedProductionSecretReads.summary?.application_runtime,
    currentProductionSecretReads.filter((entry) => entry.surface?.lifecycle === 'APPLICATION_RUNTIME').length,
    'production application-runtime secret-read summary is stale',
  )
  assert.equal(
    acceptedProductionSecretReads.summary?.active_operational_script,
    currentProductionSecretReads.filter((entry) => entry.surface?.lifecycle === 'OPERATIONAL_SCRIPT').length,
    'production operational secret-read summary is stale',
  )
  assert.equal(acceptedProductionSecretReads.summary?.unresolved, 0, 'production secret-read review retains unresolved records')
  assert.equal(acceptedProductionSecretReads.summary?.unknown, 0, 'production secret-read review retains unknown records')
  assert.equal(acceptedProductionSecretReads.summary?.public_secret_risk_records, 0, 'production secret-read review overlaps the public-risk registry')
  assert.equal(acceptedProductionSecretReads.summary?.foreign_direct_secret_reads, 0, 'production secret-read review overlaps the cross-domain registry')
  const newPublicRisk = accesses.filter((entry) => (
    entry.public_secret_risk
    && !isGovernedImmutableCredentialEvidence(entry, lifecycleByPath)
    && !publicRiskSignatures.has(entry.site_signature)
  ))
  const newForeignSecretRead = accesses.filter((entry) => (
    entry.context_classification === 'FOREIGN_DIRECT_DB_ACCESS'
    && entry.credential_exposure === 'SECRET_READ'
    && !crossDomainSignatures.has(entry.site_signature)
  ))

  const projection = (entry) => ({
    file: entry.file,
    line: entry.line,
    entity: entry.entity,
    site_signature: entry.site_signature,
  })
  assert.deepEqual(newPublicRisk.map(projection), [], 'new possible public credential exposure requires review')
  assert.deepEqual(newForeignSecretRead.map(projection), [], 'new cross-domain secret read requires an owner capability')

  return {
    status: 'PASS',
    credential_database_accesses: inventory.summary.credential_database_accesses,
    secret_reads: inventory.summary.secret_reads,
    metadata_only_reads: inventory.summary.metadata_only_reads,
    raw_ambiguous_accesses: inventory.summary.ambiguous_credential_accesses,
    reviewed_ambiguous_dispositions: reviewedUnknown.length,
    new_ambiguous: 0,
    new_public_risk: 0,
    reviewed_public_risk_denominator: currentPublicRisk.length,
    new_cross_domain_secret_reads: 0,
    reviewed_cross_domain_secret_reads: currentForeignSecretReads.length,
    reviewed_production_secret_read_accesses: currentProductionSecretReads.length,
    reviewed_production_secret_read_signatures: new Set(currentProductionSecretReads.map((entry) => entry.site_signature)).size,
    reviewed_owner_internal_secret_reads: productionSecretRecords.filter((record) => record.classification === 'OWNER_INTERNAL_VALID').length,
    reviewed_runtime_provider_secret_reads: productionSecretRecords.filter((record) => record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY').length,
    reviewed_operational_secret_reads: productionSecretRecords.filter((record) => record.review_scope.lifecycle === 'OPERATIONAL_SCRIPT').length,
    ...(sourceIntegrity ? { source_integrity: sourceIntegrity } : {}),
    governed_immutable_historical_credential_evidence: {
      count: governedHistoricalCredentialEvidence.length,
      public_risk_count: governedHistoricalPublicRisk.length,
      ambiguous_count: governedHistoricalAmbiguous.length,
      unique_signature_identity_count: governedHistoricalSignatureIdentities.length,
      signature_identities: governedHistoricalSignatureIdentities,
      identities: governedHistoricalCredentialEvidence.map(governedEvidenceIdentity),
    },
    material_unresolved: 0,
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  assert(process.argv[2], 'usage: verify-authoritative-credential-inventory.mjs <fresh-inventory.json>')
  const readJson = (relative) => readFile(path.join(root, relative), 'utf8').then(JSON.parse)
  const [
    inventory,
    acceptedInventory,
    publicRisk,
    unknown,
    crossDomain,
    sensitiveFields,
    productionSecretReads,
    lifecycleRegistry,
    publicRiskClassificationBytes,
    credentialClosureBytes,
  ] = await Promise.all([
    readFile(path.resolve(process.argv[2]), 'utf8').then(JSON.parse),
    readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_DATABASE_ACCESS_ARCHITECTURE_CHECKPOINT_20260811.json'),
    readJson('architecture/recovery/whole-project-dod/v2/PUBLIC_SECRET_RISK_CLOSURE_20260811.json'),
    readJson('architecture/recovery/whole-project-dod/v2/credential-unknown-access-resolution.json'),
    readJson('architecture/recovery/whole-project-dod/v2/CROSS_DOMAIN_CREDENTIAL_REVIEW_20260811.json'),
    readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_SENSITIVE_FIELD_REGISTRY.json'),
    readJson('architecture/recovery/whole-project-dod/v2/PRODUCTION_SECRET_READ_DISPOSITION_REVIEW_20260813.json'),
    readJson('architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'),
    readFile(path.join(root, 'architecture/recovery/whole-project-dod/v2/PUBLIC_SECRET_RISK_CLASSIFICATION_20260811.json')),
    readFile(path.join(root, 'architecture/recovery/whole-project-dod/v2/CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json')),
  ])
  verifyCredentialEvidenceDependencyBindings(
    publicRisk,
    publicRiskClassificationBytes,
    crossDomain,
    credentialClosureBytes,
  )
  process.stdout.write(`${JSON.stringify(verifyAuthoritativeCredentialInventory(
    inventory,
    acceptedInventory,
    publicRisk,
    unknown,
    crossDomain,
    sensitiveFields,
    productionSecretReads,
    {
      trackedFiles: execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean),
      readSource: (relative) => readFileSync(path.join(root, relative)),
    },
    lifecycleRegistry,
  ), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
