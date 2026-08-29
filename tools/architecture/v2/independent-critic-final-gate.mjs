#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { extractImports } from '../enforce-architecture.mjs'
import { CREDENTIAL_ENTITY_POLICIES, analyzeCredentialAccess } from './credential-analyzer.mjs'
import { inventoryCredentialAccess } from './credential-inventory.mjs'
import { authorizeMaintenanceWrite, validateCapabilityRegistry } from './maintenance-capability-policy.mjs'
import { inventoryTrackedSurfaces } from './tracked-surface-inventory.mjs'

const root = new URL('../../../', import.meta.url).pathname
const readJson = (relative) => JSON.parse(readFileSync(`${root}${relative}`, 'utf8'))
const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex')
const sha256File = (relative) => sha256Bytes(readFileSync(`${root}${relative}`))
const sha256Lines = (values) => sha256Bytes(`${[...values].sort().join('\n')}\n`)
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const exactUnique = (values, label) => {
  assert.equal(values.every((value) => typeof value === 'string' && value.length > 0), true, `${label} contains a missing identity`)
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate identities`)
  return [...values].sort()
}
const reviewKey = (entry) => [
  entry.file,
  entry.line,
  entry.column,
  entry.method,
  entry.access,
  entry.entity,
  entry.site_signature,
  entry.source_sha256 ?? entry.review_scope?.source_sha256,
].join('|')
const ambiguityReviewKey = (entry) => [entry.site_signature, entry.source_sha256].join('|')
const hasExactSourceSha256 = (entry) => typeof entry?.source_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.source_sha256)
const assertExactSourceBinding = (record, current, label) => {
  assert.equal(hasExactSourceSha256(record), true, `${label} is missing an exact source SHA-256 binding`)
  assert.equal(hasExactSourceSha256(current), true, `${label} current analyzer record is missing an exact source SHA-256 binding`)
  assert.equal(record.source_sha256, current.source_sha256, `${label} source-byte binding drift`)
}
const unresolvedReviewLanguage = /(?:UNKNOWN|UNRESOLVED|PENDING)/iu

const publicSemanticsByOutcome = new Map([
  ['SAFE_OWNER_INTERNAL', 'OWNER_INTERNAL_VALID_NO_PUBLIC_SECRET_FLOW'],
  ['ANALYZER_FALSE_POSITIVE', 'ANALYZER_FALSE_POSITIVE_NO_PUBLIC_SECRET_FLOW'],
  ['CLOSED_REMEDIATED', 'REMEDIATED_REDACTED_SAFE'],
])
const ambiguitySemanticsByOutcome = new Map([
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
const productionSecretSemanticsByOutcome = new Map([
  ['OWNER_INTERNAL_VALID', 'OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW'],
  ['APPROVED_RUNTIME_PROVIDER_CAPABILITY', 'EXACT_SOURCE_BOUND_RUNTIME_PROVIDER_SECRET_USE_AT_REVIEWED_NON_PUBLIC_BOUNDARIES'],
  ['APPROVED_PROVIDER_CAPABILITY', 'EXACT_MANUAL_OPERATOR_PROVIDER_SECRET_USE_NO_PUBLIC_ROUTE'],
  ['REDACTED_SAFE', 'SECRET_BEARING_READ_NOT_EXPOSED_BY_REVIEWED_OPERATOR_FLOW'],
  ['APPROVED_OPERATOR_CREDENTIAL_DIAGNOSTIC', 'EXACT_MANUAL_OPERATOR_CREDENTIAL_DIAGNOSTIC_NO_PUBLIC_ROUTE'],
  ['APPROVED_CREDENTIAL_IMPORT_CAPABILITY', 'EXACT_MANUAL_OPERATOR_LOCAL_CREDENTIAL_IMPORT_NO_PUBLIC_ROUTE'],
])
const productionSecretSummaryFields = new Map([
  ['OWNER_INTERNAL_VALID', 'owner_internal_valid'],
  ['APPROVED_RUNTIME_PROVIDER_CAPABILITY', 'approved_runtime_provider_capability'],
  ['APPROVED_PROVIDER_CAPABILITY', 'approved_provider_capability'],
  ['REDACTED_SAFE', 'redacted_safe'],
  ['APPROVED_OPERATOR_CREDENTIAL_DIAGNOSTIC', 'approved_operator_credential_diagnostic'],
  ['APPROVED_CREDENTIAL_IMPORT_CAPABILITY', 'approved_credential_import_capability'],
])
const isProductionRelevantSecretRead = (entry) => (
  entry.credential_exposure === 'SECRET_READ'
  && entry.public_secret_risk !== true
  && entry.context_classification !== 'FOREIGN_DIRECT_DB_ACCESS'
  && entry.access !== 'UNKNOWN'
  && (
    entry.surface?.lifecycle === 'APPLICATION_RUNTIME'
    || (entry.surface?.lifecycle === 'OPERATIONAL_SCRIPT' && entry.surface?.disposition === 'ACTIVE')
  )
)
const productionReviewScope = (entry) => ({
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
})
const nullable = (value) => value ?? null
const normalizedStrings = (values) => Array.isArray(values) ? [...new Set(values.map(String))].sort() : []
const credentialReviewScope = (entry) => ({
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
})
const immutableEvidence = (entry, lifecycleByPath) => {
  const snapshot = /^(architecture\/migrations\/v1\/provenance\/snapshot\/[^/]+)\/files\//u.exec(entry.file ?? '')
  const reviewed = lifecycleByPath.get(entry.file)
  return Boolean(snapshot)
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
    && reviewed.classification_artifact === `${snapshot?.[1]}/manifest.json`
    && typeof reviewed.rationale === 'string'
    && reviewed.rationale.length > 0
}
const staticMethodsBySemantics = new Map([
  ['AUTHORIZATION_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS', /^(?:mixed-script-sql:)/u],
  ['CLIENT_VERSION_QUERY_NO_DATABASE_OR_CREDENTIAL_ACCESS', /^dynamic-mixed-database-read:pg_dump$/u],
  ['DATABASE_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS', /^(?:\$executeRawUnsafe|mixed-script-sql:database_heredoc)$/u],
  ['NON_CREDENTIAL_ENUM_CATALOG_READ', /^\$queryRaw$/u],
  ['NON_CREDENTIAL_ROW_COUNT_READ_FINITE_TABLE_SET', /^mixed-script-sql:embedded_database_string$/u],
  ['PRISMA_MIGRATION_METADATA_WRITE_ONLY', /^dynamic-mixed-database-write:prisma migrate resolve$/u],
  ['SCHEMA_DDL_WRITE_NO_CREDENTIAL_VALUE_ACCESS', /^mixed-script-sql:embedded_database_string$/u],
])
const assertAmbiguityCompatibility = (record, current) => {
  const target = record.resolved_target
  assert(target && typeof target === 'object' && typeof target.credential_entities_in_scope === 'boolean', `credential ambiguity resolved target is incomplete: ${record.site_signature}`)
  const candidates = normalizedStrings(current.candidate_entities).map((value) => value.toLowerCase())
  if (target.entity && candidates.length > 0) assert(candidates.includes(String(target.entity).toLowerCase()), `credential ambiguity target contradicts candidates: ${record.site_signature}`)
  if (record.classification === 'ANALYZER_FALSE_POSITIVE') {
    assert.equal(target.credential_entities_in_scope, false, `credential ambiguity false positive still targets credentials: ${record.site_signature}`)
    assert(record.resolved_semantics === 'NON_CREDENTIAL_ENTITY_READ'
      ? ['READ', 'UNKNOWN'].includes(current.intended_access) && current.database_command_intent !== 'WRITE'
      : ['WRITE', 'READ_OR_WRITE'].includes(current.intended_access), `credential ambiguity false-positive intent contradiction: ${record.site_signature}`)
  } else if (record.classification === 'CONFIRMED_DB_READ') {
    assert(target.credential_entities_in_scope && current.database_command_intent === 'READ' && current.method === 'dynamic-mixed-database-read:pg_dump', `confirmed credential read contradiction: ${record.site_signature}`)
  } else if (record.classification === 'CONFIRMED_DB_WRITE') {
    assert(target.credential_entities_in_scope && current.database_command_intent === 'WRITE' && current.method === 'dynamic-mixed-database-write:pg_restore', `confirmed credential write contradiction: ${record.site_signature}`)
  } else if (record.classification === 'CONTROLLED_SCHEMA_OPERATION') {
    assert(!target.credential_entities_in_scope && current.database_command_intent === 'WRITE' && /^dynamic-mixed-database-write:prisma (?:migrate deploy|db push)$/u.test(current.method)
      && current.surface?.lifecycle === 'MIGRATION' && ![undefined, null, 'UNKNOWN'].includes(current.surface?.production_capability), `controlled schema operation contradiction: ${record.site_signature}`)
  } else {
    assert(!target.credential_entities_in_scope && staticMethodsBySemantics.get(record.resolved_semantics)?.test(current.method), `static credential ambiguity resolution contradiction: ${record.site_signature}`)
    if (record.resolved_semantics === 'CLIENT_VERSION_QUERY_NO_DATABASE_OR_CREDENTIAL_ACCESS') {
      assert.equal(current.database_command_intent, 'READ', `client-version resolution contradicts command intent: ${record.site_signature}`)
    }
    if (record.resolved_semantics === 'PRISMA_MIGRATION_METADATA_WRITE_ONLY') {
      assert(current.database_command_intent === 'WRITE' && current.surface?.lifecycle === 'MIGRATION'
        && ![undefined, null, 'UNKNOWN'].includes(current.surface?.production_capability), `migration-metadata resolution contradicts lifecycle/reachability: ${record.site_signature}`)
    }
  }
}

const criticRuntimeEdge = (source, exportedSymbol, consumer, boundarySemantics, importedAs = exportedSymbol, importKind = 'static') => ({
  source,
  exported_symbol: exportedSymbol,
  consumer,
  imported_as: importedAs,
  import_kind: importKind,
  boundary_semantics: boundarySemantics,
})
const criticRuntimeBoundaryPolicies = [
  {
    review_id: 'calling-provider-settings-runtime-provider-v1',
    access_review_ids: ['production-secret-read-035'],
    classification: 'APPROVED_RUNTIME_PROVIDER_CAPABILITY', secret_bearing_runtime_flow: true,
    modules: {
      'gravity-mvp/src/lib/ai-call/provider-settings.ts': ['getAllPlaintext', 'getValue', 'isMockModeEnabled'],
      'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts': ['getOpenAiRuntimeProviderCredentialV1'],
    },
    edges: [
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getAllPlaintext', 'gravity-mvp/src/app/api/internal/ai-call-keys/route.ts', 'AUTHENTICATED_INTERNAL_AUDIO_BRIDGE_SECRET_RESPONSE'),
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getValue', 'gravity-mvp/src/app/api/settings/ai-call-keys/test/route.ts', 'ADMIN_AUTHORIZED_OUTBOUND_PROVIDER_VALIDATION'),
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getValue', 'gravity-mvp/src/app/settings/integrations/ai-call-scenarios/page.tsx', 'NON_SECRET_SYSTEM_SETTING_READ'),
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getValue', 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'OWNER_PROVIDER_CREDENTIAL_WRAPPER'),
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'isMockModeEnabled', 'gravity-mvp/src/app/api/ai-calls/mock/route.ts', 'NON_SECRET_BOOLEAN_SETTING_READ'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'getOpenAiRuntimeProviderCredentialV1', 'gravity-mvp/src/modules/calling/public/v1/openai-chat-completion.ts', 'OUTBOUND_PROVIDER_CLIENT_CONSTRUCTION'),
    ],
  },
  {
    review_id: 'calling-provider-settings-write-result-discard-v1',
    access_review_ids: ['production-secret-read-036'],
    classification: 'OWNER_INTERNAL_VALID', secret_bearing_runtime_flow: false,
    modules: {
      'gravity-mvp/src/lib/ai-call/provider-settings.ts': ['saveValue'],
      'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts': ['saveAiCallProviderSettingV1'],
    },
    edges: [
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'saveValue', 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'SECRET_WRITE_RESULT_DISCARDED'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts', 'saveAiCallProviderSettingV1', 'gravity-mvp/src/app/api/settings/ai-call-keys/route.ts', 'ADMIN_AUTHORIZED_SECRET_WRITE_NO_SECRET_RESPONSE'),
    ],
  },
  {
    review_id: 'calling-provider-settings-masked-status-v1',
    access_review_ids: ['production-secret-read-037'],
    classification: 'OWNER_INTERNAL_VALID', secret_bearing_runtime_flow: false,
    modules: {
      'gravity-mvp/src/lib/ai-call/provider-settings.ts': ['getStatus'],
      'gravity-mvp/src/lib/ai-call/keys-status.ts': ['getAiCallKeysStatus'],
      'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts': ['getAiCallProviderStatusV1'],
    },
    edges: [
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/provider-settings.ts', 'getStatus', 'gravity-mvp/src/lib/ai-call/keys-status.ts', 'MASKED_STATUS_PROJECTION'),
      criticRuntimeEdge('gravity-mvp/src/lib/ai-call/keys-status.ts', 'getAiCallKeysStatus', 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', 'MASKED_STATUS_REEXPORT', 'getAiCallProviderStatusV1', 'export'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', 'getAiCallProviderStatusV1', 'gravity-mvp/src/app/api/settings/ai-call-keys/route.ts', 'ADMIN_AUTHORIZED_MASKED_STATUS_RESPONSE'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts', 'getAiCallProviderStatusV1', 'gravity-mvp/src/app/settings/integrations/ai-call-scenarios/page.tsx', 'SERVER_RENDERED_MASKED_STATUS_ONLY'),
    ],
  },
  {
    review_id: 'calling-ai-agent-runtime-provider-v1',
    access_review_ids: ['production-secret-read-044'],
    classification: 'APPROVED_RUNTIME_PROVIDER_CAPABILITY', secret_bearing_runtime_flow: true,
    modules: { 'gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts': ['getAiAgentProviderConfigV1'] },
    edges: [
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/app/messages/improve-draft-actions.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/app/messages/proposed-reply-actions.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/app/settings/ai/actions.ts', 'MIXED_SANITIZED_ADMIN_METADATA_AND_OUTBOUND_PROVIDER_USE'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/lib/ai/knowledge/Extractor.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/lib/ai/knowledge/Retriever.rerank.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      criticRuntimeEdge('gravity-mvp/src/modules/calling/public/v1/ai-agent-provider-capability.ts', 'getAiAgentProviderConfigV1', 'gravity-mvp/src/modules/messaging/internal/ai-reply-pipeline/ContextBuilder.ts', 'SERVER_INTERNAL_AI_PIPELINE_PROVIDER_USE'),
    ],
  },
  {
    review_id: 'fleet-yandex-runtime-provider-v1',
    access_review_ids: ['production-secret-read-053', 'production-secret-read-054'],
    classification: 'APPROVED_RUNTIME_PROVIDER_CAPABILITY', secret_bearing_runtime_flow: true,
    modules: { 'gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts': ['getYandexConnectionCredentialsV1', 'listYandexConnectionCredentialsV1'] },
    edges: [
      criticRuntimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'getYandexConnectionCredentialsV1', 'gravity-mvp/src/app/api/webhooks/bot/route.ts', 'MIXED_OUTBOUND_PROVIDER_USE_AND_NONSECRET_PARK_NAME_PROJECTION'),
      criticRuntimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'getYandexConnectionCredentialsV1', 'gravity-mvp/src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      criticRuntimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'listYandexConnectionCredentialsV1', 'gravity-mvp/src/app/api/webhooks/bot/route.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
      criticRuntimeEdge('gravity-mvp/src/modules/fleet-operations/public/v1/yandex-connection-capability.ts', 'listYandexConnectionCredentialsV1', 'gravity-mvp/src/modules/fleet-operations/public/v1/park-phone-search.ts', 'OUTBOUND_PROVIDER_REQUEST_ONLY'),
    ],
  },
]
const runtimeEdgeIdentity = (edge) => [edge.source, edge.exported_symbol, edge.consumer, edge.imported_as, edge.import_kind].join('|')
const resolveCriticRuntimeImport = (consumer, specifier, trackedFileSet) => {
  let base
  if (specifier.startsWith('@/') && consumer.startsWith('gravity-mvp/')) base = `gravity-mvp/src/${specifier.slice(2)}`
  else if (specifier.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(consumer), specifier))
  else return null
  return [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ].find((candidate) => trackedFileSet.has(candidate)) ?? null
}
const deriveCriticRuntimeEdges = (policy, trackedFiles) => {
  const trackedFileSet = new Set(trackedFiles)
  const modules = new Map(Object.entries(policy.modules).map(([file, symbols]) => [file, new Set(symbols)]))
  const edges = []
  for (const consumer of trackedFiles.filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file))) {
    for (const imported of extractImports(readFileSync(`${root}${consumer}`, 'utf8'))) {
      const source = resolveCriticRuntimeImport(consumer, imported.specifier, trackedFileSet)
      const protectedSymbols = modules.get(source)
      if (!protectedSymbols) continue
      let matched = false
      for (const binding of imported.imports ?? []) {
        if (!protectedSymbols.has(binding.imported) && !['*', 'default'].includes(binding.imported)) continue
        matched = true
        edges.push({ source, exported_symbol: binding.imported, consumer, imported_as: binding.local, import_kind: imported.kind })
      }
      if (!matched && ['dynamic', 'require', 'export'].includes(imported.kind)) {
        edges.push({ source, exported_symbol: '*', consumer, imported_as: '*', import_kind: imported.kind })
      }
    }
  }
  return edges.sort((left, right) => runtimeEdgeIdentity(left).localeCompare(runtimeEdgeIdentity(right)))
}

const baselinePath = 'architecture/recovery/whole-project-dod/v2/CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json'
const acceptedBaselinePath = 'architecture/recovery/whole-project-dod/v2/AUTHORITATIVE_WRITE_SCAN_POST_MESSAGES_20260811T0450Z.json'
const baseline = readJson(baselinePath)
const triage = readJson('architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_FINAL_CLOSURE.json')
const capabilities = readJson('architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json')
const reviewedCapabilities = readJson('architecture/recovery/whole-project-dod/v2/ACTIVE_MAINTENANCE_CAPABILITY_REVIEW_20260813.json')
const credentialClosure = readJson('architecture/recovery/whole-project-dod/v2/PUBLIC_SECRET_RISK_CLOSURE_20260811.json')
const credentialAmbiguities = readJson('architecture/recovery/whole-project-dod/v2/credential-unknown-access-resolution.json')
const credentialMigration = readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_DYNAMIC_MIGRATION_BOUNDARY_20260811.json')
const credentialFields = readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_SENSITIVE_FIELD_REGISTRY.json')
const crossDomain = readJson('architecture/recovery/whole-project-dod/v2/CROSS_DOMAIN_CREDENTIAL_REVIEW_20260811.json')
const productionSecretReview = readJson('architecture/recovery/whole-project-dod/v2/PRODUCTION_SECRET_READ_DISPOSITION_REVIEW_20260813.json')
const lifecycleRegistry = readJson('architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json')
const contextIndex = readJson('architecture/contexts/v1/context-index.json')

assert.equal(baseline.execution.complete, true, 'accepted authoritative scan incomplete')
assert.equal(baseline.execution.worker_failures, 0, 'accepted authoritative scan has worker failures')
assert.equal(baseline.execution.worker_timeouts, 0, 'accepted authoritative scan has worker timeouts')
assert.equal(baseline.summary.parse_findings, 0, 'accepted authoritative scan has parse findings')
assert.equal(baseline.summary.foreign_writes, 0, 'accepted authoritative scan retains a foreign write')
assert.equal(baseline.summary.unreviewed_operational_surfaces, 0, 'accepted authoritative scan retains an operational bypass')
assert.equal(baseline.execution.files_discovered, baseline.execution.files_completed, 'accepted scan file denominator is incomplete')
assert.equal(baseline.execution.files_discovered, baseline.inventory.summary.tracked_executable_surfaces, 'accepted scan inventory denominator is inconsistent')
assert.equal(baseline.execution.files_discovered, baseline.summary.tracked_executable_surfaces, 'accepted scan summary denominator is inconsistent')
assert.equal(baseline.execution.writes_discovered, baseline.write_sites.length, 'accepted write-site array denominator is inconsistent')
assert.equal(baseline.execution.writes_discovered, baseline.summary.discovered_write_sites, 'accepted write-site summary denominator is inconsistent')
const recordedAnalysisSha256 = baseline.analysis_sha256
const baselineSemanticAnalysis = Object.fromEntries(
  Object.entries(baseline).filter(([key]) => !['analysis_sha256', 'execution'].includes(key)),
)
assert.equal(
  sha256Bytes(`${JSON.stringify(stable(baselineSemanticAnalysis))}\n`),
  recordedAnalysisSha256,
  'accepted write analysis semantic hash drift',
)
assert.equal(sha256File(baselinePath), sha256File(acceptedBaselinePath), 'accepted write baseline provenance drift')
assert.equal(triage.baseline?.baseline_sha256, sha256File(baselinePath), 'write ambiguity review baseline byte hash drift')
assert.equal(triage.baseline?.analysis_sha256, baseline.analysis_sha256, 'write ambiguity review baseline semantic hash drift')

const [trackedInventory, currentCredentialInventory] = await Promise.all([
  inventoryTrackedSurfaces(root, { registry: lifecycleRegistry }),
  inventoryCredentialAccess(root, { registry: lifecycleRegistry }),
])
const authorityProcess = spawnSync(process.execPath, ['tools/architecture/validate-executable-path-ownership.mjs', '--validate'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
})
assert.equal(authorityProcess.status, 0, `single executable ownership authority failed: ${authorityProcess.stderr}`)
const authorityResult = JSON.parse(authorityProcess.stdout)
assert.equal(authorityResult.schema, 'yoko.crm.single-authority-process-result.v1')
assert.equal(authorityResult.operation, 'validate')
assert.equal(authorityResult.authority_capability_exports, 0)
assert.equal(authorityResult.raw_authority_reader_module_api_removed, true)
assert.equal(authorityResult.historical_fixture_verified, true)
assert(
  authorityResult.tracked_executable_surfaces >= baseline.summary.tracked_executable_surfaces,
  'current executable denominator shrank below the accepted write baseline',
)

const triageRecords = triage.records ?? []
const triageStates = new Set(['RESOLVED_NON_WRITE', 'OWNER_VALID_WRITE', 'CONTROLLED_MIGRATION_WRITE', 'MATERIAL_UNRESOLVED_WRITE_RISK'])
exactUnique(triageRecords.map((record) => record.record_id), 'write ambiguity review record IDs')
exactUnique(triageRecords.map((record) => record.site_signature), 'write ambiguity review site signatures')
assert.equal(triageRecords.every((record) => triageStates.has(record.semantic_state)), true, 'write ambiguity review contains an invalid semantic state')
const triageCounts = Object.fromEntries([...triageStates].map((state) => [state, triageRecords.filter((record) => record.semantic_state === state).length]))
assert.equal(triage.summary.RECONCILIATION_EXACT, true, 'write ambiguity reconciliation is not exact')
assert.equal(triage.summary.RAW_BASELINE_AMBIGUOUS, triageRecords.length, 'write ambiguity review denominator is stale')
assert.equal(triage.summary.RECONCILIATION_TOTAL, triageRecords.length, 'write ambiguity reconciliation total is stale')
assert.equal(triage.current_exact_review?.ambiguous_denominator, triageRecords.length, 'write ambiguity exact-review denominator is stale')
assert.equal(triage.current_exact_review?.sorted_site_signatures_sha256, sha256Lines(triageRecords.map((record) => record.site_signature)), 'write ambiguity exact-review signature digest is stale')
assert.equal(triage.summary.RESOLVED_NON_WRITE, triageCounts.RESOLVED_NON_WRITE, 'resolved non-write denominator is stale')
assert.equal(triage.summary.OWNER_VALID_WRITE, triageCounts.OWNER_VALID_WRITE, 'owner-valid write denominator is stale')
assert.equal(triage.summary.CONTROLLED_MIGRATION_WRITE, triageCounts.CONTROLLED_MIGRATION_WRITE, 'controlled migration denominator is stale')
assert.equal(triage.summary.MATERIAL_UNRESOLVED_WRITE_RISK, triageCounts.MATERIAL_UNRESOLVED_WRITE_RISK, 'material write-risk denominator is stale')
for (const field of [
  'CONFIRMED_WRITE_OWNER_UNRESOLVED',
  'DYNAMIC_DELEGATE_UNRESOLVED',
  'DYNAMIC_SQL_UNRESOLVED',
  'QUERY_RAW_SIDE_EFFECT_UNRESOLVED',
  'SOURCE_FAMILY_REVIEW_REQUIRED',
  'GENUINELY_DYNAMIC_UNRESOLVED',
  'MATERIAL_UNRESOLVED_WRITE_RISK',
]) assert.equal(triage.summary[field], 0, `${field} remains nonzero`)
const resolvedNonWrites = triageRecords.filter((record) => record.semantic_state === 'RESOLVED_NON_WRITE')
const nonWriteProofs = triage.non_write_proofs ?? []
assert.deepEqual(
  exactUnique(nonWriteProofs.map((record) => record.site_signature), 'non-write proof signatures'),
  exactUnique(resolvedNonWrites.map((record) => record.site_signature), 'resolved non-write signatures'),
  'resolved non-writes lack one-to-one proof records',
)
assert.equal(nonWriteProofs.every((proof) => (
  ['READ_ONLY_SQL_PROJECTION', 'STATIC_MIXED_SCRIPT_SQL_READ', 'ANALYZER_DETECTOR_LITERAL'].includes(proof.classification)
  && proof.resolved_target && typeof proof.resolved_target === 'object'
  && Array.isArray(proof.evidence) && proof.evidence.length >= 2
  && !unresolvedReviewLanguage.test(JSON.stringify(proof))
)), true, 'non-write proof registry contains an incomplete or unresolved disposition')

const combinedCapabilities = {
  capabilities: [...(capabilities.capabilities ?? []), ...(reviewedCapabilities.capabilities ?? [])],
}
assert.deepEqual(validateCapabilityRegistry(combinedCapabilities), [], 'combined maintenance capability registry invalid')
assert.equal((reviewedCapabilities.capabilities ?? []).length > 0, true, 'reviewed active maintenance capability registry is empty')
assert.equal((reviewedCapabilities.capabilities ?? []).every((record) => record.approved === true && record.status === 'APPROVED'), true, 'reviewed active capability is not explicitly approved')
const approved = { capabilities: [{
  capability_id: 'critic.exact.v1',
  status: 'APPROVED',
  approved: true,
  source: { path: 'scripts/owner.js', source_sha256: '1'.repeat(64), site_signatures: ['site-a'] },
  lifecycle: 'RECOVERY',
  lifecycle_evidence_status: 'REVIEWED_ACTIVE',
  invocation: { production_reachability: 'CONFIRMED_MANUAL_OPERATOR' },
  target: { kind: 'MODEL', data_owner: 'messages', exact_names: ['chat'], operations: ['update'] },
}] }
const exactWrite = {
  source_path: 'scripts/owner.js',
  source_sha256: '1'.repeat(64),
  site_signature: 'site-a',
  lifecycle: 'RECOVERY',
  production_reachability: 'CONFIRMED_MANUAL_OPERATOR',
  data_owner: 'messages',
  target_kind: 'MODEL',
  target: 'chat',
  operation: 'update',
}
assert.deepEqual(validateCapabilityRegistry(approved), [], 'critic exact capability fixture is invalid')
assert.equal(authorizeMaintenanceWrite(approved, exactWrite), true, 'exact maintenance capability was not authorized')
assert.equal(authorizeMaintenanceWrite(approved, { ...exactWrite, target: 'user' }), false, 'unrelated writer target was authorized')

const lifecycleByPath = new Map(lifecycleRegistry.surfaces.map((surface) => [surface.path, surface]))
const governedCredentialEvidence = currentCredentialInventory.accesses.filter((entry) => (
  immutableEvidence(entry, lifecycleByPath)
  && (entry.public_secret_risk || entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
))
const governedPublicCredentialRisks = governedCredentialEvidence.filter((entry) => entry.public_secret_risk)
const governedCredentialAmbiguities = governedCredentialEvidence.filter((entry) => entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
const publicRiskRecords = credentialClosure.current_candidate_classifications ?? []
const publicRiskKeys = publicRiskRecords.map(reviewKey)
assert.equal(credentialClosure.current_exact_review?.risk_denominator, publicRiskRecords.length, 'public credential-risk review denominator is stale')
assert.equal(credentialClosure.summary?.candidate_total, publicRiskRecords.length, 'public credential-risk summary denominator is stale')
assert.equal(new Set(publicRiskKeys).size, publicRiskKeys.length, 'public credential-risk review contains duplicate exact keys')
assert.equal(credentialClosure.current_exact_review?.sorted_review_keys_sha256, sha256Lines(publicRiskKeys), 'public credential-risk review-key hash drift')
assert.equal(publicRiskRecords.every((record) => (
  publicSemanticsByOutcome.get(record.classification) === record.resolved_semantics
  && hasExactSourceSha256(record)
  && Array.isArray(record.evidence) && record.evidence.length > 0
  && record.evidence.every((entry) => typeof entry === 'string' && entry.length > 0)
  && !unresolvedReviewLanguage.test(JSON.stringify({
    classification: record.classification,
    resolved_semantics: record.resolved_semantics,
    evidence: record.evidence,
  }))
)), true, 'public credential-risk review contains an invalid, contradictory, or unresolved disposition')
for (const [classification, summaryField] of [
  ['SAFE_OWNER_INTERNAL', 'safe_owner_internal'],
  ['ANALYZER_FALSE_POSITIVE', 'analyzer_false_positive'],
  ['CLOSED_REMEDIATED', 'closed_remediated'],
]) assert.equal(credentialClosure.summary?.[summaryField], publicRiskRecords.filter((record) => record.classification === classification).length, `public credential-risk ${classification} denominator is stale`)
assert.equal(credentialClosure.summary.confirmed_public_secret_exposure, 0, 'public secret exposure remains')
assert.equal(credentialClosure.summary.unresolved, 0, 'public credential-risk unresolved records remain')
assert.equal(credentialClosure.summary.material_credential_unresolved, 0, 'material public credential ambiguity remains')
const currentPublicCredentialRisks = currentCredentialInventory.accesses.filter((entry) => entry.public_secret_risk && !immutableEvidence(entry, lifecycleByPath))
assert.equal(credentialClosure.current_exact_review?.raw_risk_denominator, currentPublicCredentialRisks.length + governedPublicCredentialRisks.length, 'raw public credential-risk denominator is hidden or stale')
assert.equal(credentialClosure.governed_immutable_historical_evidence?.count, governedPublicCredentialRisks.length, 'governed historical public-risk count is hidden or stale')
assert.deepEqual(
  credentialClosure.governed_immutable_historical_evidence?.identities?.map((entry) => entry.review_key).sort(),
  governedPublicCredentialRisks.map(reviewKey).sort(),
  'governed historical public-risk identities are hidden or stale',
)
assert.deepEqual(
  publicRiskKeys.sort(),
  currentPublicCredentialRisks.map(reviewKey).sort(),
  'public credential-risk review is stale against fresh source analysis',
)
for (const record of publicRiskRecords) {
  const current = currentPublicCredentialRisks.find((entry) => reviewKey(entry) === reviewKey(record))
  assert(current, `stale public credential-risk disposition: ${record.site_signature}`)
  assertExactSourceBinding(record, current, `public credential-risk review ${record.site_signature}`)
  assert.deepEqual(record.review_scope, credentialReviewScope(current), `public credential-risk semantic scope drift: ${record.site_signature}`)
  assert.equal(current.public_boundary, true, `public credential-risk boundary contradiction: ${record.site_signature}`)
  assert.notEqual(current.context_classification, 'FOREIGN_DIRECT_DB_ACCESS', `public credential-risk review authorizes a foreign boundary: ${record.site_signature}`)
  if (record.classification === 'SAFE_OWNER_INTERNAL') {
    assert.equal(typeof current.source_context, 'string', `safe owner-internal review lacks source ownership: ${record.site_signature}`)
    if (current.owner_context) assert.equal(current.owner_context, current.source_context, `safe owner-internal review crosses ownership: ${record.site_signature}`)
  }
  if (record.classification === 'CLOSED_REMEDIATED') {
    assert.equal(current.context_classification, 'OWNER_DIRECT_DB_ACCESS', `remediated review is not owner-direct: ${record.site_signature}`)
    assert((current.exposed_sensitive_field_names ?? []).length > 0, `remediated review lacks an analyzed sensitive field: ${record.site_signature}`)
  }
}

const ambiguityRecords = credentialAmbiguities.records ?? []
exactUnique(ambiguityRecords.map(ambiguityReviewKey), 'credential ambiguity review source-bound keys')
assert.equal(credentialAmbiguities.summary?.total, ambiguityRecords.length, 'credential ambiguity review denominator is stale')
assert.deepEqual(Object.keys(credentialAmbiguities.classification_definitions ?? {}).sort(), [...ambiguitySemanticsByOutcome.keys()].sort(), 'credential ambiguity classification vocabulary drift')
assert.equal(ambiguityRecords.every((record) => (
  ambiguitySemanticsByOutcome.get(record.classification)?.has(record.resolved_semantics)
  && hasExactSourceSha256(record)
  && typeof record.evidence === 'string' && record.evidence.length > 0
  && !unresolvedReviewLanguage.test(JSON.stringify({
    classification: record.classification,
    resolved_semantics: record.resolved_semantics,
    credential_boundary: record.credential_boundary,
    resolved_target: record.resolved_target,
    trace: record.trace,
  }))
)), true, 'credential ambiguity review contains an invalid, contradictory, or unresolved disposition')
for (const classification of ambiguitySemanticsByOutcome.keys()) {
  assert.equal(credentialAmbiguities.summary?.[classification], ambiguityRecords.filter((record) => record.classification === classification).length, `credential ambiguity ${classification} denominator is stale`)
}
const currentCredentialAmbiguities = currentCredentialInventory.accesses.filter((entry) => (
  (entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
  && !immutableEvidence(entry, lifecycleByPath)
))
assert.equal(credentialAmbiguities.current_exact_review?.raw_ambiguous_denominator, currentCredentialAmbiguities.length + governedCredentialAmbiguities.length, 'raw credential ambiguity denominator is hidden or stale')
assert.equal(credentialAmbiguities.governed_immutable_historical_evidence?.count, governedCredentialAmbiguities.length, 'governed historical ambiguity count is hidden or stale')
assert.deepEqual(
  credentialAmbiguities.governed_immutable_historical_evidence?.identities?.map((entry) => entry.review_key).sort(),
  governedCredentialAmbiguities.map(ambiguityReviewKey).sort(),
  'governed historical ambiguity identities are hidden or stale',
)
assert.deepEqual(
  ambiguityRecords.map(ambiguityReviewKey).sort(),
  currentCredentialAmbiguities.map(ambiguityReviewKey).sort(),
  'credential ambiguity review is stale against fresh source analysis',
)
assert.equal(
  credentialAmbiguities.current_exact_review?.sorted_review_keys_sha256,
  sha256Lines(currentCredentialAmbiguities.map(ambiguityReviewKey)),
  'credential ambiguity review-key hash drift',
)
for (const record of ambiguityRecords) {
  const current = currentCredentialAmbiguities.find((entry) => ambiguityReviewKey(entry) === ambiguityReviewKey(record))
  assert(current, `stale credential ambiguity disposition: ${record.site_signature}`)
  assertExactSourceBinding(record, current, `credential ambiguity review ${record.site_signature}`)
  assert.deepEqual(record.review_scope, credentialReviewScope(current), `credential ambiguity semantic scope drift: ${record.site_signature}`)
  assertAmbiguityCompatibility(record, current)
}

assert.equal(crossDomain.exact_coverage, true, 'cross-domain credential coverage drift')
assert.equal(crossDomain.current_exact_review?.secret_read_denominator, 0, 'cross-domain secret-read denominator is nonzero')
assert.deepEqual(crossDomain.current_records, [], 'cross-domain secret-read review text cannot authorize a secret read')
assert.equal(crossDomain.current_exact_review?.sorted_review_keys_sha256, sha256Lines([]), 'empty cross-domain secret-read review hash drift')
assert.equal(crossDomain.summary.confirmed_unapproved_secret_reads, 0, 'confirmed unapproved cross-domain secret read remains')
assert.equal(crossDomain.summary.material_capability_gap_remaining, 0, 'cross-domain credential capability gap remains')
const currentForeignSecretReads = currentCredentialInventory.accesses.filter((entry) => (
  entry.context_classification === 'FOREIGN_DIRECT_DB_ACCESS'
  && entry.credential_exposure === 'SECRET_READ'
))
assert.deepEqual(currentForeignSecretReads, [], 'fresh source analysis contains a cross-domain secret read')

const productionSecretRecords = productionSecretReview.records ?? []
const currentProductionSecretReads = currentCredentialInventory.accesses.filter(isProductionRelevantSecretRead)
const currentProductionSecretByKey = new Map(currentProductionSecretReads.map((entry) => [reviewKey(entry), entry]))
const productionSecretKeys = productionSecretRecords.map(reviewKey)
const currentProductionSecretKeys = currentProductionSecretReads.map(reviewKey)
const credentialOwnerByEntity = new Map(currentCredentialInventory.policies.map((policy) => [policy.entity, policy.owner_context]))
assert.equal(productionSecretReview.schema, 'yoko.crm.production-secret-read-disposition-review.v1', 'production secret-read registry schema drift')
assert.equal(productionSecretReview.raw_inventory_authorization, false, 'raw credential inventory is being treated as production secret-read authorization')
assert.deepEqual(
  productionSecretReview.semantics_by_classification,
  Object.fromEntries(productionSecretSemanticsByOutcome),
  'production secret-read review vocabulary drift',
)
exactUnique(productionSecretRecords.map((record) => record.review_id), 'production secret-read review IDs')
exactUnique(productionSecretKeys, 'production secret-read review keys')
assert.equal(productionSecretRecords.every((record) => record.review_key === reviewKey(record)), true, 'production secret-read record identity contradicts its review key')
assert.equal(productionSecretReview.current_exact_review?.access_denominator, currentProductionSecretReads.length, 'production secret-read denominator is stale')
assert.equal(
  productionSecretReview.current_exact_review?.unique_site_signature_denominator,
  new Set(currentProductionSecretReads.map((entry) => entry.site_signature)).size,
  'production secret-read unique-signature denominator is stale',
)
assert.equal(productionSecretReview.current_exact_review?.sorted_review_keys_sha256, sha256Lines(currentProductionSecretKeys), 'production secret-read exact-key hash drift')
assert.deepEqual(productionSecretKeys.sort(), currentProductionSecretKeys.sort(), 'production secret reads lack one-to-one independent dispositions')
assert.equal(productionSecretReview.summary?.total, productionSecretRecords.length, 'production secret-read review summary denominator is stale')
for (const [classification, summaryField] of productionSecretSummaryFields) {
  assert.equal(
    productionSecretReview.summary?.[summaryField],
    productionSecretRecords.filter((record) => record.classification === classification).length,
    `production secret-read ${classification} summary drift`,
  )
}
assert.equal(
  productionSecretRecords.every((record) => (
    productionSecretSemanticsByOutcome.get(record.classification) === record.resolved_semantics
    && typeof record.credential_owner === 'string' && record.credential_owner.length > 0
    && typeof record.capability_id === 'string' && record.capability_id.length > 0
    && typeof record.approved_architecture_path === 'string' && record.approved_architecture_path.length > 0
    && typeof record.review_basis === 'string' && record.review_basis.length > 0
    && Array.isArray(record.evidence) && record.evidence.length >= 3
    && record.evidence.every((entry) => typeof entry === 'string' && entry.length > 0)
    && (
      record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY'
        ? record.public_flow === true && record.external_public_secret_response === false
        : record.public_flow === false
    )
    && !unresolvedReviewLanguage.test(JSON.stringify({
      classification: record.classification,
      resolved_semantics: record.resolved_semantics,
      review_basis: record.review_basis,
      capability_id: record.capability_id,
      approved_architecture_path: record.approved_architecture_path,
      evidence: record.evidence,
    }))
  )),
  true,
  'production secret-read registry contains an incomplete, contradictory, or unresolved disposition',
)
for (const record of productionSecretRecords) {
  const current = currentProductionSecretByKey.get(record.review_key)
  assert(current, `stale production secret-read disposition: ${record.review_key}`)
  assert.deepEqual(record.review_scope, productionReviewScope(current), `production secret-read scope drift: ${record.review_key}`)
  assertExactSourceBinding(record.review_scope, current, `production secret-read review ${record.review_key}`)
  assert.equal(record.credential_owner, credentialOwnerByEntity.get(current.entity), `production secret-read credential owner contradiction: ${record.review_key}`)
  if (record.classification === 'OWNER_INTERNAL_VALID') {
    assert.equal(current.surface.lifecycle, 'APPLICATION_RUNTIME', `owner-internal secret read is not application runtime: ${record.review_key}`)
    assert.equal(current.context_classification, 'OWNER_DIRECT_DB_ACCESS', `owner-internal secret read is not owner-direct: ${record.review_key}`)
    assert.equal(current.source_context, record.credential_owner, `owner-internal secret read crosses credential ownership: ${record.review_key}`)
    assert.equal(record.operator_only, false, `owner-internal secret read claims operator-only scope: ${record.review_key}`)
  } else if (record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY') {
    assert.equal(current.surface.lifecycle, 'APPLICATION_RUNTIME', `runtime provider secret read is not application runtime: ${record.review_key}`)
    assert.equal(current.context_classification, 'OWNER_DIRECT_DB_ACCESS', `runtime provider secret read is not owner-direct: ${record.review_key}`)
    assert.equal(current.source_context, record.credential_owner, `runtime provider secret read crosses credential ownership: ${record.review_key}`)
    assert.equal(record.invocation_boundary, 'APPLICATION_RUNTIME_PROVIDER', `runtime provider invocation boundary drift: ${record.review_key}`)
    assert.equal(record.operator_only, false, `runtime provider secret read claims operator-only scope: ${record.review_key}`)
    assert.equal(record.public_flow, true, `runtime provider secret read hides its exported capability flow: ${record.review_key}`)
    assert.equal(record.external_public_secret_response, false, `runtime provider secret read exposes an external public secret response: ${record.review_key}`)
    assert.equal(record.secret_bearing_runtime_flow, true, `runtime provider secret read hides its secret-bearing flow: ${record.review_key}`)
  } else {
    assert.equal(current.surface.lifecycle, 'OPERATIONAL_SCRIPT', `operator secret read is not an operational script: ${record.review_key}`)
    assert.equal(current.surface.disposition, 'ACTIVE', `operator secret read is not active: ${record.review_key}`)
    assert.equal(current.surface.registry_classified, true, `operator secret read lacks lifecycle classification: ${record.review_key}`)
    assert.equal(typeof current.surface.functional_owner, 'string', `operator secret read lacks a functional owner: ${record.review_key}`)
    assert.equal(record.operator_only, true, `operator secret read is not constrained to its operator boundary: ${record.review_key}`)
  }
}
const runtimeBoundaryReviews = productionSecretReview.runtime_boundary_reviews ?? []
const runtimePolicyAccessIds = criticRuntimeBoundaryPolicies.flatMap((policy) => policy.access_review_ids)
assert.equal(productionSecretReview.runtime_boundary_review_contract?.raw_inventory_authorization, false, 'raw inventory authorizes a runtime credential boundary')
assert.equal(productionSecretReview.runtime_boundary_review_contract?.review_denominator, criticRuntimeBoundaryPolicies.length, 'runtime credential boundary review denominator drift')
assert.equal(productionSecretReview.runtime_boundary_review_contract?.access_denominator, runtimePolicyAccessIds.length, 'runtime credential boundary access denominator drift')
assert.equal(productionSecretReview.runtime_boundary_review_contract?.unreviewed_secret_bearing_runtime_capabilities, 0, 'unreviewed secret-bearing runtime capability remains')
assert.equal(productionSecretReview.summary?.unreviewed_secret_bearing_runtime_capabilities, 0, 'production summary retains an unreviewed secret-bearing runtime capability')
assert.deepEqual(
  runtimeBoundaryReviews.map((review) => review.review_id).sort(),
  criticRuntimeBoundaryPolicies.map((policy) => policy.review_id).sort(),
  'runtime credential boundary review set drift',
)
const productionSecretByReviewId = new Map(productionSecretRecords.map((record) => [record.review_id, record]))
const trackedRuntimeFiles = trackedInventory.surfaces.map((surface) => surface.path)
for (const policy of criticRuntimeBoundaryPolicies) {
  const review = runtimeBoundaryReviews.find((candidate) => candidate.review_id === policy.review_id)
  assert(review, `missing critic runtime credential boundary review: ${policy.review_id}`)
  assert.equal(review.review_authority, 'INDEPENDENT_RUNTIME_CREDENTIAL_BOUNDARY_REVIEW_20260813', `runtime credential boundary authority drift: ${policy.review_id}`)
  assert.equal(review.raw_inventory_authorization, false, `runtime credential boundary raw authorization drift: ${policy.review_id}`)
  assert.deepEqual([...review.access_review_ids].sort(), [...policy.access_review_ids].sort(), `runtime credential boundary access drift: ${policy.review_id}`)
  assert.equal(review.classification, policy.classification, `runtime credential boundary classification drift: ${policy.review_id}`)
  assert.equal(review.secret_bearing_runtime_flow, policy.secret_bearing_runtime_flow, `runtime credential boundary secret-flow truth drift: ${policy.review_id}`)
  for (const accessReviewId of policy.access_review_ids) {
    const record = productionSecretByReviewId.get(accessReviewId)
    assert(record, `runtime credential boundary references missing access: ${accessReviewId}`)
    assert.equal(record.runtime_boundary_review_id, policy.review_id, `runtime credential access link drift: ${accessReviewId}`)
    assert.equal(record.classification, policy.classification, `runtime credential access classification drift: ${accessReviewId}`)
    assert.equal(record.secret_bearing_runtime_flow, policy.secret_bearing_runtime_flow, `runtime credential access flow truth drift: ${accessReviewId}`)
  }
  const expectedModules = Object.entries(policy.modules).map(([modulePath, exportedSymbols]) => ({ path: modulePath, exported_symbols: exportedSymbols })).sort((left, right) => left.path.localeCompare(right.path))
  assert.deepEqual(
    review.source_modules.map(({ source_sha256: ignored, ...module }) => module).sort((left, right) => left.path.localeCompare(right.path)),
    expectedModules,
    `runtime credential source-module policy drift: ${policy.review_id}`,
  )
  for (const module of review.source_modules) {
    assert.equal(module.source_sha256, sha256File(module.path), `runtime credential source bytes drift: ${policy.review_id}:${module.path}`)
  }
  const expectedEdges = policy.edges.map(({ boundary_semantics: ignored, ...edge }) => edge).sort((left, right) => runtimeEdgeIdentity(left).localeCompare(runtimeEdgeIdentity(right)))
  assert.deepEqual(deriveCriticRuntimeEdges(policy, trackedRuntimeFiles), expectedEdges, `runtime credential current consumer graph drift: ${policy.review_id}`)
  assert.deepEqual(
    review.consumer_edges.map(({ consumer_source_sha256: ignored, ...edge }) => edge).sort((left, right) => runtimeEdgeIdentity(left).localeCompare(runtimeEdgeIdentity(right))),
    policy.edges.map((edge) => ({ ...edge })).sort((left, right) => runtimeEdgeIdentity(left).localeCompare(runtimeEdgeIdentity(right))),
    `runtime credential reviewed consumer graph drift: ${policy.review_id}`,
  )
  for (const edge of review.consumer_edges) {
    assert.equal(edge.consumer_source_sha256, sha256File(edge.consumer), `runtime credential consumer/projector bytes drift: ${policy.review_id}:${edge.consumer}`)
  }
}
assert.deepEqual(
  productionSecretRecords.filter((record) => record.runtime_boundary_review_id).map((record) => record.review_id).sort(),
  [...runtimePolicyAccessIds].sort(),
  'runtime credential access review links are missing or extra',
)
assert.deepEqual(
  productionSecretRecords.filter((record) => record.classification === 'APPROVED_RUNTIME_PROVIDER_CAPABILITY').map((record) => record.review_id).sort(),
  ['production-secret-read-035', 'production-secret-read-044', 'production-secret-read-053', 'production-secret-read-054'],
  'runtime provider secret capability classification denominator drift',
)
assert.equal(productionSecretReview.summary?.application_runtime, currentProductionSecretReads.filter((entry) => entry.surface.lifecycle === 'APPLICATION_RUNTIME').length, 'production application secret-read summary drift')
assert.equal(productionSecretReview.summary?.active_operational_script, currentProductionSecretReads.filter((entry) => entry.surface.lifecycle === 'OPERATIONAL_SCRIPT').length, 'production operational secret-read summary drift')
assert.equal(productionSecretReview.summary?.unresolved, 0, 'production secret-read registry retains unresolved records')
assert.equal(productionSecretReview.summary?.unknown, 0, 'production secret-read registry retains unknown records')
assert.equal(productionSecretReview.summary?.public_secret_risk_records, 0, 'production secret-read registry overlaps public risk')
assert.equal(productionSecretReview.summary?.foreign_direct_secret_reads, 0, 'production secret-read registry overlaps cross-domain secret reads')

assert.equal(credentialMigration.summary.records, credentialMigration.records.length, 'dynamic credential-migration denominator is stale')
assert.equal(credentialMigration.summary.controlled_schema_migrations, credentialMigration.records.filter((record) => record.classification === 'CONTROLLED_SCHEMA_MIGRATION').length, 'controlled credential-migration denominator is stale')
assert.equal(credentialMigration.records.every((record) => record.material_credential_unresolved === false), true, 'dynamic credential migration retains unresolved materiality')
assert.equal(credentialMigration.summary.material_credential_unresolved, 0, 'dynamic migration materiality unresolved')
assert.equal(credentialMigration.summary.credential_row_dml_found, 0, 'dynamic migration performs credential-row DML')

assert.equal(credentialFields.schema, 'yoko.crm.credential-sensitive-field-registry.v1')
const implementedCredentialPolicyIds = exactUnique(CREDENTIAL_ENTITY_POLICIES.map((record) => record.id), 'implemented credential policy IDs')
const reviewedCredentialPolicyIds = exactUnique(credentialFields.records.map((record) => record.policy_id), 'credential field registry policy IDs')
assert.deepEqual(reviewedCredentialPolicyIds, implementedCredentialPolicyIds, 'credential field registry/analyzer policy denominator drift')

for (const [file, entity] of [
  ['gravity-mvp/src/app/api/debug-db/tg-import/route.ts', 'TelegramConnection'],
  ['gravity-mvp/src/app/api/debug-db/wa-diag/route.ts', 'WhatsAppConnection'],
]) {
  const analysis = analyzeCredentialAccess(readFileSync(`${root}${file}`, 'utf8'), { fileName: file })
  const connectionReads = analysis.accesses.filter((entry) => entry.entity === entity)
  assert.equal(connectionReads.length, 1, `${file} must retain one exact connection metadata read`)
  assert.equal(connectionReads[0].credential_exposure, 'METADATA_ONLY', `${file} exposes credential values`)
  assert.deepEqual(connectionReads[0].exposed_sensitive_field_names, [], `${file} selects a sensitive field`)
  assert.equal(connectionReads[0].public_secret_risk, false, `${file} retains public credential risk`)
}

assert.equal(existsSync(`${root}gravity-mvp/src/app/api/debug-db/list-connections/route.ts`), false, 'debug DB endpoint still exposed')
assert.equal(existsSync(`${root}tg-bot/tg-bot-frontend/pages/api/export.js`), false, 'unauthenticated export endpoint still exposed')
assert.equal(existsSync(`${root}gravity-mvp/src/modules/messaging/public/v1`), true, 'protected Messages owner path missing')
assert.equal(existsSync(`${root}gravity-mvp/src/lib/ai-call`), true, 'protected AI Calls path missing')

console.log([
  'independent final-gate critic: PASS',
  `(current executable denominator ${authorityResult.tracked_executable_surfaces}`,
  `write ambiguity reviews ${triageRecords.length}`,
  `public credential-risk reviews ${publicRiskRecords.length}`,
  `credential ambiguity reviews ${ambiguityRecords.length}`,
  `governed immutable credential evidence ${governedCredentialEvidence.length} accesses / ${new Set(governedCredentialEvidence.map((entry) => `${entry.site_signature}|${entry.source_sha256}`)).size} signature identities (${governedPublicCredentialRisks.length} public-risk, ${governedCredentialAmbiguities.length} ambiguous)`,
  `production secret-read reviews ${productionSecretRecords.length} accesses / ${new Set(productionSecretRecords.map((record) => record.site_signature)).size} signatures`,
  'cross-domain secret reads 0',
  'exact capability scope and debug metadata boundaries)',
].join('; '))
