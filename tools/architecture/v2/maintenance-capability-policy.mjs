const forbiddenWildcard = value => typeof value === 'string' && /(?:^|[/.*])\*{1,2}(?:$|[/.*])/u.test(value)

export const APPROVED_CAPABILITY_LIFECYCLES = new Set([
  'BACKFILL',
  'CLEANUP',
  'CONTROLLED_MIGRATION',
  'IMPORT',
  'MIGRATION',
  'ONE_SHOT_PENDING_RETIREMENT',
  'RECOVERY',
])

export const APPROVED_PRODUCTION_REACHABILITY = new Set([
  'CONFIRMED_AUTOMATIC_DEPLOYMENT',
  'CONFIRMED_MANUAL_BASELINE',
  'CONFIRMED_MANUAL_DATA_MIGRATION',
  'CONFIRMED_MANUAL_DEPLOYMENT',
  'CONFIRMED_MANUAL_OPERATOR',
  'CONFIRMED_MANUAL_RESTORE',
  'CONTROLLED_MIGRATION',
])

export const CAPABILITY_TARGET_KINDS = new Set(['DATABASE', 'FUNCTION', 'MODEL', 'SCHEMA', 'TABLE', 'TRIGGER', 'TYPE'])

const SHA256 = /^[0-9a-f]{64}$/u
const unresolved = value => /(?:^|[^A-Z])(?:MISSING|PENDING|UNKNOWN|UNREVIEWED)(?:[^A-Z]|$)/iu.test(String(value ?? ''))
const migrationWriteKey = write => `${write.kind}\u0000${write.exact_name}\u0000${write.operation}`

export function analyzedMigrationWrites(site) {
  if ((site.operations ?? []).length > 0) {
    return site.operations.map((operation) => ({
      kind: operation.target_kind ?? (operation.table ? 'TABLE' : null),
      exact_name: operation.table ?? operation.object ?? null,
      operation: operation.operation,
    }))
  }
  const targets = [...new Set([site.model, ...(site.candidate_models ?? []), ...(site.tables ?? [])].filter(Boolean))]
  if (targets.length > 0) {
    return targets.map((exact_name) => ({ kind: 'MODEL', exact_name, operation: site.method }))
  }
  if (site.database_command_intent === 'WRITE') {
    return [{ kind: null, exact_name: null, operation: site.method }]
  }
  return []
}

export function validateMigrationWriteAuthorizationRegistry(registry, {
  productionMigrationAuthority,
  productionMigrationAuthoritySha256,
  maintenanceCapabilityRegistry = { capabilities: [] },
  noncanonicalMigrationDecisions,
  noncanonicalMigrationDecisionsSha256,
} = {}) {
  const failures = []
  if (registry?.schema !== 'yoko.crm.reviewed-migration-write-site-authorizations.v1' || registry?.version !== 1) {
    failures.push('migration authorization registry identity mismatch')
  }
  if (!Number.isInteger(registry?.denominator?.non_test_migration_only_sites) || registry.denominator.non_test_migration_only_sites < 0) {
    failures.push('migration authorization registry denominator is missing')
  }
  if (!SHA256.test(registry?.denominator?.sorted_site_signatures_sha256 ?? '')) {
    failures.push('migration authorization registry signature digest is missing')
  }
  if (registry?.review?.status !== 'COMPLETED_EXACT_SITE_REVIEW'
    || typeof registry?.review?.reviewed_by !== 'string'
    || registry.review.reviewed_by.length === 0
    || unresolved(`${registry.review.status}|${registry.review.reviewed_by}`)) {
    failures.push('migration authorization registry lacks completed review evidence')
  }
  if (productionMigrationAuthority) {
    if (registry?.authority?.path !== 'architecture/migrations/v1/production-migration-authority.json'
      || registry?.authority?.inventory_digest !== productionMigrationAuthority.inventory_digest
      || registry?.authority?.migration_count !== productionMigrationAuthority.migrations?.length
      || registry?.authority?.source_sha256 !== productionMigrationAuthoritySha256) {
      failures.push('migration authorization registry authority provenance drift')
    }
  }

  const noncanonicalDecisionPath = 'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json'
  const noncanonicalBySignature = new Map()
  const noncanonicalPathDecisions = new Map()
  if (noncanonicalMigrationDecisions) {
    if (noncanonicalMigrationDecisions.schema !== 'yoko.crm.reviewed-noncanonical-migration-capability-decisions.v1'
      || noncanonicalMigrationDecisions.version !== 1
      || noncanonicalMigrationDecisions.review?.status !== 'COMPLETED_SOURCE_SPECIFIC_REVIEW'
      || unresolved(`${noncanonicalMigrationDecisions.review?.status}|${noncanonicalMigrationDecisions.review?.reviewed_by}`)) {
      failures.push('noncanonical migration decision registry identity/review mismatch')
    }
    for (const decision of noncanonicalMigrationDecisions.path_decisions ?? []) {
      if (!decision?.path || noncanonicalPathDecisions.has(decision.path)) failures.push(`duplicate or missing noncanonical path decision: ${decision?.path ?? '<missing>'}`)
      noncanonicalPathDecisions.set(decision?.path, decision)
    }
    for (const decision of noncanonicalMigrationDecisions.site_decisions ?? []) {
      if (!decision?.site_signature || noncanonicalBySignature.has(decision.site_signature)) failures.push(`duplicate or missing noncanonical site decision: ${decision?.site_signature ?? '<missing>'}`)
      noncanonicalBySignature.set(decision?.site_signature, decision)
    }
    if (registry?.noncanonical_review?.path !== noncanonicalDecisionPath
      || registry?.noncanonical_review?.source_sha256 !== noncanonicalMigrationDecisionsSha256
      || registry?.noncanonical_review?.reviewed_path_count !== noncanonicalPathDecisions.size) {
      failures.push('migration authorization noncanonical review provenance drift')
    }
  }

  const authorityByPath = new Map((productionMigrationAuthority?.migrations ?? []).map(row => [row.provenance?.repository_capture, row]))
  const approvedCapabilities = maintenanceCapabilityRegistry.capabilities ?? []
  const ids = new Set()
  const signatures = new Set()
  for (const row of registry?.authorizations ?? []) {
    const label = row?.capability_id ?? '<missing>'
    if (!row?.capability_id || ids.has(row.capability_id)) failures.push(`duplicate or missing migration capability id: ${label}`)
    ids.add(row?.capability_id)
    if (!row?.site_signature || signatures.has(row.site_signature)) failures.push(`${label}: duplicate or missing migration site signature`)
    signatures.add(row?.site_signature)
    const exactValues = [
      row?.source?.path,
      row?.site_signature,
      row?.functional_owner,
      row?.target?.data_owner,
      ...(row?.target?.writes ?? []).flatMap(write => [write?.kind, write?.exact_name, write?.operation]),
    ]
    if (exactValues.some(forbiddenWildcard)) failures.push(`${label}: wildcard scope is forbidden`)
    if (row?.approved !== true || row?.status !== 'APPROVED') failures.push(`${label}: migration capability is not explicitly approved`)
    if (row?.lifecycle !== 'MIGRATION') failures.push(`${label}: migration lifecycle is not exact`)
    if (!APPROVED_PRODUCTION_REACHABILITY.has(row?.invocation?.production_reachability)) failures.push(`${label}: production reachability is not enumerated`)
    if (unresolved(`${row?.status}|${row?.lifecycle}|${row?.invocation?.production_reachability}|${row?.functional_owner}|${row?.target?.data_owner}`)) {
      failures.push(`${label}: unresolved authorization field is forbidden`)
    }
    if (typeof row?.functional_owner !== 'string' || row.functional_owner.length === 0
      || typeof row?.target?.data_owner !== 'string' || row.target.data_owner.length === 0) {
      failures.push(`${label}: exact owner is missing`)
    }
    if (typeof row?.source?.path !== 'string' || row.source.path.length === 0
      || !SHA256.test(row?.source?.source_sha256 ?? '')
      || !Number.isInteger(row?.source?.line) || row.source.line < 1
      || !Number.isInteger(row?.source?.column) || row.source.column < 1
      || typeof row?.source?.method !== 'string' || row.source.method.length === 0) {
      failures.push(`${label}: exact source path/hash/coordinate/method is missing`)
    }
    const writes = row?.target?.writes ?? []
    if (writes.length === 0 || writes.some(write => (
      !CAPABILITY_TARGET_KINDS.has(write?.kind)
      || typeof write?.exact_name !== 'string' || write.exact_name.length === 0
      || typeof write?.operation !== 'string' || write.operation.length === 0
      || unresolved(`${write?.kind}|${write?.exact_name}|${write?.operation}`)
    ))) failures.push(`${label}: exact target/kind/operation is missing`)
    if (new Set(writes.map(migrationWriteKey)).size !== writes.length) failures.push(`${label}: duplicate exact write tuple`)

    const authorityRow = authorityByPath.get(row?.source?.path)
    if (authorityRow) {
      if (row?.binding?.kind !== 'CANONICAL_PRODUCTION_MIGRATION'
        || row.binding.name !== authorityRow.name
        || row.binding.canonical_ordinal !== authorityRow.canonical_ordinal
        || row.binding.artifact_sha256 !== authorityRow.sha256
        || row.binding.repository_capture !== authorityRow.provenance?.repository_capture
        || row.source.source_sha256 !== authorityRow.sha256) {
        failures.push(`${label}: canonical migration artifact binding drift`)
      }
    } else if (row?.binding?.kind !== 'INDEPENDENT_EXACT_CAPABILITY'
      || typeof row.binding.rationale !== 'string' || row.binding.rationale.length < 24
      || unresolved(row.binding.rationale)
      || !Array.isArray(row.binding.evidence) || row.binding.evidence.length < 2
      || row.binding.evidence.some(value => typeof value !== 'string' || value.length === 0 || unresolved(value))) {
      failures.push(`${label}: noncanonical site lacks an independently justified exact capability`)
    } else {
      const decision = noncanonicalBySignature.get(row.site_signature)
      const pathDecision = noncanonicalPathDecisions.get(row.source?.path)
      if (!noncanonicalMigrationDecisions || !decision || !pathDecision) {
        failures.push(`${label}: noncanonical site lacks an explicit committed exact decision`)
      } else {
        const expectedOwner = noncanonicalMigrationDecisions.site_owner_overrides?.[row.site_signature] ?? pathDecision.functional_owner
        if (decision.path !== row.source.path
          || decision.source_sha256 !== row.source.source_sha256
          || decision.line !== row.source.line
          || decision.column !== row.source.column
          || decision.method !== row.source.method
          || decision.functional_owner !== row.functional_owner
          || decision.functional_owner !== row.target.data_owner
          || decision.functional_owner !== expectedOwner
          || decision.production_reachability !== row.invocation.production_reachability
          || decision.production_reachability !== pathDecision.production_reachability
          || JSON.stringify(decision.writes) !== JSON.stringify(row.target.writes)
          || decision.review_rationale !== row.binding.rationale
          || decision.existing_capability_id !== row.binding.existing_capability_id
          || !pathDecision.expected_site_signatures?.includes(row.site_signature)
          || !row.binding.evidence.includes(`review_decision:${noncanonicalDecisionPath}`)
          || !row.binding.evidence.includes(`lifecycle_evidence_status:${pathDecision.lifecycle_evidence_status}`)) {
          failures.push(`${label}: noncanonical committed decision binding drift`)
        }
      }
    }

    if (row?.binding?.existing_capability_id) {
      const bound = approvedCapabilities.filter(capability => capability.capability_id === row.binding.existing_capability_id)
      if (bound.length !== 1 || writes.some(write => !authorizeMaintenanceWrite(
        maintenanceCapabilityRegistry,
        {
          source_path: row.source.path,
          source_sha256: row.source.source_sha256,
          site_signature: row.site_signature,
          lifecycle: row.lifecycle,
          production_reachability: row.invocation.production_reachability,
          data_owner: row.target.data_owner,
          target_kind: write.kind,
          target: write.exact_name,
          operation: write.operation,
        },
      ))) failures.push(`${label}: existing exact capability binding is invalid`)
    }
  }
  const independentSignatures = (registry?.authorizations ?? [])
    .filter(row => row.binding?.kind === 'INDEPENDENT_EXACT_CAPABILITY')
    .map(row => row.site_signature)
    .sort()
  if (noncanonicalMigrationDecisions && JSON.stringify(independentSignatures) !== JSON.stringify([...noncanonicalBySignature.keys()].sort())) {
    failures.push('noncanonical migration decision denominator drift')
  }
  return failures
}

export function authorizeMigrationOnlySite(registry, site, sourceSha256) {
  const matches = (registry?.authorizations ?? []).filter(row => row.site_signature === site.site_signature)
  if (matches.length !== 1) return false
  const row = matches[0]
  if (row.approved !== true || row.status !== 'APPROVED'
    || row.source?.path !== site.file
    || row.source?.source_sha256 !== sourceSha256
    || row.source?.line !== site.line
    || row.source?.column !== site.column
    || row.source?.method !== site.method
    || row.lifecycle !== 'MIGRATION'
    || site.surface?.lifecycle !== 'MIGRATION'
    || site.surface?.disposition !== 'MIGRATION_ONLY') return false
  if (!APPROVED_PRODUCTION_REACHABILITY.has(site.surface?.production_capability)
    || row.invocation?.production_reachability !== site.surface.production_capability) return false

  const analyzed = analyzedMigrationWrites(site)
  const approved = row.target?.writes ?? []
  if (analyzed.length === 0 || approved.length !== analyzed.length) return false
  const available = [...approved]
  for (const write of analyzed) {
    const index = available.findIndex(candidate => (
      candidate.operation === write.operation
      && (write.kind === null || candidate.kind === write.kind)
      && (write.exact_name === null || candidate.exact_name === write.exact_name)
    ))
    if (index < 0) return false
    available.splice(index, 1)
  }
  return available.length === 0
}

export function validateCapabilityRegistry(registry) {
  const failures = []
  const ids = new Set()
  for (const row of registry.capabilities ?? []) {
    if (!row.capability_id || ids.has(row.capability_id)) failures.push(`duplicate or missing capability id: ${row.capability_id ?? '<missing>'}`)
    ids.add(row.capability_id)
    const exactValues = [row.source?.path, ...(row.source?.site_signatures ?? []), ...(row.target?.exact_names ?? []), ...(row.target?.operations ?? [])]
    if (exactValues.some(forbiddenWildcard)) failures.push(`${row.capability_id}: wildcard scope is forbidden`)
    if (row.approved && row.status !== 'APPROVED') failures.push(`${row.capability_id}: approved flag requires APPROVED status`)
    if (row.approved && !APPROVED_CAPABILITY_LIFECYCLES.has(row.lifecycle)) failures.push(`${row.capability_id}: approved capability lifecycle is not enumerated`)
    if (row.approved && (
      typeof row.source?.path !== 'string'
      || row.source.path.length === 0
      || !SHA256.test(row.source?.source_sha256 ?? '')
      || !row.source?.site_signatures?.length
      || !row.source.site_signatures.every(value => typeof value === 'string' && value.length > 0)
      || !row.target?.exact_names?.length
      || !row.target.exact_names.every(value => typeof value === 'string' && value.length > 0)
      || !row.target?.operations?.length
      || !row.target.operations.every(value => typeof value === 'string' && value.length > 0)
    )) failures.push(`${row.capability_id}: approved capability lacks exact source/site/target/operation`)
    if (row.approved && !CAPABILITY_TARGET_KINDS.has(row.target?.kind)) failures.push(`${row.capability_id}: approved capability target kind is not enumerated`)
    if (row.approved && (typeof row.target?.data_owner !== 'string' || row.target.data_owner.length === 0)) failures.push(`${row.capability_id}: approved capability lacks exact target owner`)
    if (row.approved && (!row.lifecycle_evidence_status || /^PENDING|UNKNOWN$/u.test(row.lifecycle_evidence_status))) failures.push(`${row.capability_id}: approved capability lacks reviewed lifecycle evidence`)
    if (row.approved && !APPROVED_PRODUCTION_REACHABILITY.has(row.invocation?.production_reachability)) failures.push(`${row.capability_id}: approved capability production reachability is not enumerated`)
  }
  return failures
}

export function authorizeMaintenanceWrite(registry, write) {
  return (registry.capabilities ?? []).some(row => row.approved === true
    && row.status === 'APPROVED'
    && row.source?.path === write.source_path
    && row.source?.source_sha256 === write.source_sha256
    && row.source?.site_signatures?.includes(write.site_signature)
    && row.lifecycle === write.lifecycle
    && row.invocation?.production_reachability === write.production_reachability
    && row.target?.data_owner === write.data_owner
    && row.target?.kind === write.target_kind
    && row.target?.exact_names?.includes(write.target)
    && row.target?.operations?.includes(write.operation))
}
