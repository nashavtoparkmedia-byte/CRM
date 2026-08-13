#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryTrackedSurfaces } from './v2/tracked-surface-inventory.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const COVERAGE_PATH = 'architecture/contexts/v1/executable-path-ownership-coverage.json'
export const REGISTRY_PATH = 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'
export const REVIEWED_DECISION_SCHEMA = 'yoko.crm.reviewed-executable-path-ownership-decisions.v1'
export const REVIEWED_BASELINE_SCHEMA = 'yoko.crm.executable-path-ownership-coverage.v1'
export const INTERNAL_REVIEWER = 'INTERNAL_EXECUTOR_REVIEW_20260813'
export const INTERNAL_REVIEW_ROLE = 'SOL_HIGH_INTERNAL_REVIEW'
export const REVIEWED_DECISION_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_REVIEW_20260813.json'
export const REVIEWED_BASELINE_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_COVERAGE_BASELINE_2108.json'
export const REVIEWED_BASELINE_SHA256 = '429a48c9d257408025bbc273a4d6f1413ed78196549ed889118422b6caba5730'

const SHA256 = /^[0-9a-f]{64}$/u

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const byteDigest = (value) => createHash('sha256').update(value).digest('hex')
const assert = (value, message) => { if (!value) throw new Error(message) }
const contains = (ownerPath, candidatePath) => candidatePath === ownerPath || candidatePath.startsWith(`${ownerPath}/`)

function matchesExclusion(surface, rule) {
  if (rule.lifecycles && !rule.lifecycles.includes(surface.lifecycle)) return false
  if (rule.path && surface.path !== rule.path) return false
  if (rule.path_prefix && !contains(rule.path_prefix, surface.path)) return false
  return Boolean(rule.path || rule.path_prefix)
}

export function deriveExecutablePathOwnershipCoverage(inventory, manifests, coverage, options = {}) {
  assert(inventory?.schema === 'yoko.crm.tracked-executable-surface-inventory.v2' && Array.isArray(inventory.surfaces), 'tracked executable inventory identity mismatch')
  assert(coverage?.schema === 'yoko.crm.executable-path-ownership-coverage.v1' && coverage.version === 1, 'executable ownership coverage identity mismatch')
  assert(Array.isArray(coverage.governed_exclusions) && coverage.governed_exclusions.length > 0, 'governed executable exclusions missing')
  assert(Array.isArray(coverage.functional_owner_registry) && coverage.functional_owner_registry.length > 0, 'functional owner registry missing')
  const owners = new Map()
  for (const owner of coverage.functional_owner_registry) {
    assert(typeof owner.id === 'string' && owner.id.length > 0 && !owners.has(owner.id), 'duplicate or invalid functional owner id')
    assert(['CONTEXT', 'LEGACY_RUNTIME', 'MIGRATION_AUTHORITY', 'OPERATIONS', 'EVIDENCE'].includes(owner.owner_class) && Array.isArray(owner.allowed_lifecycles) && owner.allowed_lifecycles.length > 0 && typeof owner.accountability === 'string' && owner.accountability.length > 0, `functional owner vocabulary invalid: ${owner.id}`)
    owners.set(owner.id, owner)
  }
  const exclusionIds = new Set()
  for (const rule of coverage.governed_exclusions) {
    assert(typeof rule.id === 'string' && rule.id.length > 0 && !exclusionIds.has(rule.id), 'duplicate or invalid executable exclusion id')
    exclusionIds.add(rule.id)
    assert((typeof rule.path === 'string' && rule.path.length > 0) !== (typeof rule.path_prefix === 'string' && rule.path_prefix.length > 0), `executable exclusion selector invalid: ${rule.id}`)
    assert(typeof rule.functional_owner === 'string' && owners.has(rule.functional_owner) && typeof rule.rationale === 'string' && rule.rationale.length > 0 && typeof rule.review_artifact === 'string' && rule.review_artifact.length > 0, `executable exclusion governance incomplete: ${rule.id}`)
    assert(!(rule.exact_runtime_inventory && rule.exact_path_inventory), `executable exclusion has ambiguous exact inventory kinds: ${rule.id}`)
    if (rule.exact_runtime_inventory) assert(typeof rule.exact_runtime_inventory.path_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rule.exact_runtime_inventory.path_sha256) && Number.isInteger(rule.exact_runtime_inventory.path_count) && rule.exact_runtime_inventory.path_count >= 0, `exact runtime inventory invalid: ${rule.id}`)
    if (rule.exact_path_inventory) assert(typeof rule.exact_path_inventory.path_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rule.exact_path_inventory.path_sha256) && Number.isInteger(rule.exact_path_inventory.path_count) && rule.exact_path_inventory.path_count >= 0, `exact path inventory invalid: ${rule.id}`)
  }
  const ownershipClaims = []
  for (const manifest of manifests) {
    const context = manifest?.context?.id
    assert(typeof context === 'string' && context.length > 0 && Array.isArray(manifest.owned_paths), 'manifest executable ownership declaration invalid')
    for (const ownedPath of manifest.owned_paths) {
      assert(typeof ownedPath === 'string' && ownedPath.length > 0, `manifest owned path invalid: ${context}`)
      ownershipClaims.push({ context, path: ownedPath })
    }
  }
  for (let leftIndex = 0; leftIndex < ownershipClaims.length; leftIndex += 1) {
    const left = ownershipClaims[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < ownershipClaims.length; rightIndex += 1) {
      const right = ownershipClaims[rightIndex]
      if (left.context === right.context) continue
      assert(
        !contains(left.path, right.path) && !contains(right.path, left.path),
        `manifest owned_paths overlap across contexts: ${left.context}:${left.path} <> ${right.context}:${right.path}`,
      )
    }
  }
  const records = inventory.surfaces.map((surface) => {
    const contextOwners = manifests.filter((manifest) => manifest.owned_paths.some((ownedPath) => contains(ownedPath, surface.path))).map((manifest) => manifest.context.id)
    assert(contextOwners.length <= 1, `executable path has overlapping context ownership: ${surface.path}`)
    if (contextOwners.length === 1) return { context: contextOwners[0], path: surface.path, type: 'context' }
    const exclusions = coverage.governed_exclusions.filter((rule) => matchesExclusion(surface, rule))
    assert(exclusions.length > 0, `executable path lacks context owner or governed exclusion: ${surface.path}`)
    const specificity = (rule) => (rule.path ?? rule.path_prefix).length
    const best = Math.max(...exclusions.map(specificity))
    const selected = exclusions.filter((rule) => specificity(rule) === best)
    assert(selected.length === 1, `executable path has ambiguous governed exclusions: ${surface.path}`)
    const rule = selected[0]
    const owner = owners.get(rule.functional_owner)
    assert(owner.allowed_lifecycles.includes(surface.lifecycle), `functional owner lifecycle incompatible: ${rule.functional_owner}/${surface.path}`)
    if (surface.lifecycle === 'APPLICATION_RUNTIME' && owner.owner_class !== 'CONTEXT') {
      assert(rule.exact_runtime_inventory && owner.owner_class === 'LEGACY_RUNTIME' || rule.exact_runtime_inventory && owner.owner_class === 'EVIDENCE', `application-runtime path requires exact legacy/evidence inventory ownership: ${surface.path}`)
    }
    return { exclusion: rule.id, functional_owner: rule.functional_owner, lifecycle: surface.lifecycle, path: surface.path, type: 'governed_exclusion' }
  }).sort((left, right) => left.path.localeCompare(right.path))
  for (const rule of coverage.governed_exclusions.filter((candidate) => candidate.exact_runtime_inventory)) {
    const paths = records.filter((record) => record.type === 'governed_exclusion' && record.exclusion === rule.id && record.lifecycle === 'APPLICATION_RUNTIME').map((record) => record.path)
    if (!options.allowExactInventoryRefresh) assert(paths.length === rule.exact_runtime_inventory.path_count && digest(paths) === rule.exact_runtime_inventory.path_sha256, `exact runtime inventory drift: ${rule.id} (${paths.length}/${digest(paths)})`)
  }
  for (const rule of coverage.governed_exclusions.filter((candidate) => candidate.exact_path_inventory)) {
    const paths = records.filter((record) => record.type === 'governed_exclusion' && record.exclusion === rule.id).map((record) => record.path)
    if (!options.allowExactInventoryRefresh) assert(paths.length === rule.exact_path_inventory.path_count && digest(paths) === rule.exact_path_inventory.path_sha256, `exact path inventory drift: ${rule.id} (${paths.length}/${digest(paths)})`)
  }
  const contextOwned = records.filter((record) => record.type === 'context').length
  const governedExcluded = records.length - contextOwned
  return {
    coverage_sha256: digest(records),
    governed_exclusion_paths: governedExcluded,
    records,
    tracked_executable_surfaces: records.length,
    tracked_inventory_sha256: digest(inventory),
    context_owned_paths: contextOwned,
  }
}

export function validateExecutablePathOwnershipCoverage(inventory, manifests, coverage) {
  const derived = deriveExecutablePathOwnershipCoverage(inventory, manifests, coverage)
  assert(coverage.source?.tracked_executable_surfaces === derived.tracked_executable_surfaces, 'executable ownership denominator drift')
  assert(coverage.source?.tracked_inventory_sha256 === derived.tracked_inventory_sha256, 'executable ownership source inventory drift')
  assert(coverage.coverage_sha256 === derived.coverage_sha256, 'executable ownership coverage assignment drift')
  assert(coverage.summary?.context_owned_paths === derived.context_owned_paths && coverage.summary?.governed_exclusion_paths === derived.governed_exclusion_paths && coverage.summary?.tracked_executable_surfaces === derived.tracked_executable_surfaces, 'executable ownership coverage summary drift')
  return derived
}

function exactInventoryDrift(coverage, derived) {
  const changes = []
  for (const rule of coverage.governed_exclusions) {
    const inventoryKind = rule.exact_runtime_inventory
      ? 'exact_runtime_inventory'
      : rule.exact_path_inventory
        ? 'exact_path_inventory'
        : null
    if (!inventoryKind) continue
    const records = derived.records.filter((record) => record.type === 'governed_exclusion'
      && record.exclusion === rule.id
      && (inventoryKind !== 'exact_runtime_inventory' || record.lifecycle === 'APPLICATION_RUNTIME'))
    const paths = records.map((record) => record.path)
    const currentInventory = { path_count: paths.length, path_sha256: digest(paths) }
    const previousInventory = rule[inventoryKind]
    if (currentInventory.path_count !== previousInventory.path_count || currentInventory.path_sha256 !== previousInventory.path_sha256) {
      changes.push({
        exclusion: rule.id,
        inventory_kind: inventoryKind,
        previous_inventory: { ...previousInventory },
        current_inventory: currentInventory,
        records,
      })
    }
  }
  return changes.sort((left, right) => left.exclusion.localeCompare(right.exclusion) || left.inventory_kind.localeCompare(right.inventory_kind))
}

function sourceHash(sourceSha256ByPath, relativePath) {
  return sourceSha256ByPath instanceof Map
    ? sourceSha256ByPath.get(relativePath)
    : sourceSha256ByPath?.[relativePath]
}

export function validateReviewedExactInventoryDecisions(coverage, derived, decisions, options = {}) {
  assert(decisions && typeof decisions === 'object', 'explicit reviewed executable ownership decisions are required')
  assert(decisions.schema === REVIEWED_DECISION_SCHEMA && decisions.version === 1, 'reviewed executable ownership decision registry identity mismatch')
  assert(decisions.review?.status === 'COMPLETED_EXACT_PATH_REVIEW'
    && decisions.review.reviewed_by === INTERNAL_REVIEWER
    && decisions.review.role === INTERNAL_REVIEW_ROLE
    && decisions.review.external_acceptance === false
    && decisions.review.independent_acceptance === false
    && typeof decisions.review.decision === 'string'
    && decisions.review.decision.length >= 48, 'reviewed executable ownership decision metadata incomplete')
  assert(typeof options.baselineCoverageSha256 === 'string' && SHA256.test(options.baselineCoverageSha256), 'baseline executable ownership coverage hash is required')
  assert(typeof options.baselineCoveragePath === 'string' && options.baselineCoveragePath.length > 0, 'baseline executable ownership coverage path is required')
  assert(decisions.baseline?.coverage_path === options.baselineCoveragePath
    && decisions.baseline?.coverage_sha256 === options.baselineCoverageSha256, 'reviewed executable ownership decisions are stale for the baseline coverage')
  assert(decisions.current?.tracked_inventory_sha256 === derived.tracked_inventory_sha256
    && decisions.current?.tracked_executable_surfaces === derived.tracked_executable_surfaces
    && decisions.current?.coverage_sha256 === derived.coverage_sha256, 'reviewed executable ownership decisions are stale for the current denominator')

  const changes = exactInventoryDrift(coverage, derived)
  assert(Array.isArray(decisions.exact_inventory_changes) && decisions.exact_inventory_changes.length === changes.length, 'reviewed exact inventory change set is missing, mismatched, or stale')
  const decisionChanges = new Map()
  for (const decisionChange of decisions.exact_inventory_changes) {
    const key = `${decisionChange?.exclusion ?? ''}|${decisionChange?.inventory_kind ?? ''}`
    assert(!decisionChanges.has(key), `duplicate reviewed exact inventory change: ${key}`)
    decisionChanges.set(key, decisionChange)
  }
  for (const { records: _records, ...expectedChange } of changes) {
    const key = `${expectedChange.exclusion}|${expectedChange.inventory_kind}`
    const decisionChange = decisionChanges.get(key)
    assert(decisionChange, `missing reviewed exact inventory change: ${key}`)
    assert(decisionChange.review_decision === 'APPROVED_EXACT_INVENTORY_TRANSITION'
      && typeof decisionChange.review_rationale === 'string'
      && decisionChange.review_rationale.length >= 48, `reviewed exact inventory change lacks an explicit internal decision: ${key}`)
    for (const field of ['exclusion', 'inventory_kind', 'previous_inventory', 'current_inventory']) {
      assert(JSON.stringify(stable(decisionChange[field])) === JSON.stringify(stable(expectedChange[field])), `reviewed exact inventory change ${field} mismatch: ${key}`)
    }
    assert(Array.isArray(decisionChange.previous_paths)
      && new Set(decisionChange.previous_paths).size === decisionChange.previous_paths.length
      && decisionChange.previous_paths.every((entry) => typeof entry === 'string' && entry.length > 0)
      && decisionChange.previous_paths.length === expectedChange.previous_inventory.path_count
      && digest([...decisionChange.previous_paths].sort()) === expectedChange.previous_inventory.path_sha256, `reviewed previous exact path inventory mismatch: ${key}`)
  }
  assert(Array.isArray(decisions.assignments), 'reviewed exact inventory assignments missing')

  const expectedByPath = new Map()
  for (const change of changes) {
    for (const record of change.records) {
      assert(!expectedByPath.has(record.path), `exact inventory path is claimed by multiple reviewed denominators: ${record.path}`)
      const currentSourceSha256 = sourceHash(options.sourceSha256ByPath, record.path)
      assert(typeof currentSourceSha256 === 'string' && SHA256.test(currentSourceSha256), `current exact inventory source hash unavailable: ${record.path}`)
      expectedByPath.set(record.path, {
        path: record.path,
        lifecycle: record.lifecycle,
        functional_owner: record.functional_owner,
        exclusion: record.exclusion,
        inventory_kind: change.inventory_kind,
        source_sha256: currentSourceSha256,
      })
    }
  }

  const actualByPath = new Map()
  for (const assignment of decisions.assignments) {
    assert(assignment && typeof assignment.path === 'string' && assignment.path.length > 0, 'reviewed exact inventory assignment path missing')
    assert(!actualByPath.has(assignment.path), `duplicate reviewed exact inventory assignment: ${assignment.path}`)
    assert(assignment.review_decision === 'APPROVED_CURRENT_ASSIGNMENT'
      && typeof assignment.review_rationale === 'string'
      && assignment.review_rationale.length >= 48, `reviewed exact inventory assignment lacks an explicit internal decision: ${assignment.path}`)
    actualByPath.set(assignment.path, assignment)
  }
  for (const [assignmentPath, assignment] of actualByPath) {
    const expected = expectedByPath.get(assignmentPath)
    assert(expected, `stale reviewed exact inventory assignment: ${assignmentPath}`)
    for (const field of ['lifecycle', 'functional_owner', 'exclusion', 'inventory_kind', 'source_sha256']) {
      assert(assignment[field] === expected[field], `reviewed exact inventory assignment ${field} mismatch: ${assignmentPath}`)
    }
  }
  for (const expectedPath of expectedByPath.keys()) {
    assert(actualByPath.has(expectedPath), `missing reviewed exact inventory assignment: ${expectedPath}`)
  }
  assert(actualByPath.size === expectedByPath.size, 'reviewed exact inventory assignment denominator mismatch')
  return { changes, reviewedAssignments: actualByPath.size }
}

export function materializeReviewedExecutablePathOwnershipCoverage(inventory, manifests, coverage, decisions, options = {}) {
  const provisional = deriveExecutablePathOwnershipCoverage(inventory, manifests, coverage, { allowExactInventoryRefresh: true })
  const review = validateReviewedExactInventoryDecisions(coverage, provisional, decisions, options)
  assert(typeof options.decisionRegistryPath === 'string' && options.decisionRegistryPath.length > 0, 'reviewed executable ownership decision registry path is required')
  assert(typeof options.decisionRegistrySha256 === 'string' && SHA256.test(options.decisionRegistrySha256), 'reviewed executable ownership decision registry hash is required')
  const refreshed = structuredClone(coverage)
  for (const change of review.changes) refreshed.governed_exclusions.find((rule) => rule.id === change.exclusion)[change.inventory_kind] = { ...change.current_inventory }
  const derived = deriveExecutablePathOwnershipCoverage(inventory, manifests, refreshed)
  assert(derived.coverage_sha256 === provisional.coverage_sha256, 'mechanical executable ownership materialization changed reviewed assignments')
  refreshed.source = {
    tracked_executable_surfaces: derived.tracked_executable_surfaces,
    tracked_inventory_sha256: derived.tracked_inventory_sha256,
  }
  refreshed.coverage_sha256 = derived.coverage_sha256
  refreshed.summary = {
    tracked_executable_surfaces: derived.tracked_executable_surfaces,
    context_owned_paths: derived.context_owned_paths,
    governed_exclusion_paths: derived.governed_exclusion_paths,
  }
  refreshed.reviewed_exact_inventory_materialization = {
    decision_registry_path: options.decisionRegistryPath,
    decision_registry_sha256: options.decisionRegistrySha256,
    baseline_coverage_path: options.baselineCoveragePath,
    baseline_coverage_sha256: options.baselineCoverageSha256,
    tracked_inventory_sha256: derived.tracked_inventory_sha256,
    exact_inventory_change_count: review.changes.length,
    reviewed_assignment_count: review.reviewedAssignments,
  }
  return refreshed
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}

function repositoryRelative(resolvedPath) {
  const relative = path.relative(root, resolvedPath)
  assert(relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), 'reviewed executable ownership decision registry must be inside the repository')
  return relative.split(path.sep).join('/')
}

export async function validateExecutablePathOwnershipProvenance(repositoryRoot, coverage, inventory, manifests, options = {}) {
  const provenance = coverage.reviewed_exact_inventory_materialization
  assert(provenance, 'reviewed executable ownership materialization provenance missing')
  const expectedDecisionRegistryPath = options.expectedDecisionRegistryPath ?? REVIEWED_DECISION_PATH
  const expectedBaselineCoveragePath = options.expectedBaselineCoveragePath ?? REVIEWED_BASELINE_PATH
  const expectedBaselineCoverageSha256 = options.expectedBaselineCoverageSha256 ?? REVIEWED_BASELINE_SHA256
  assert(provenance.decision_registry_path === expectedDecisionRegistryPath, 'reviewed executable ownership decision registry path is not authoritative')
  assert(provenance.baseline_coverage_path === expectedBaselineCoveragePath
    && provenance.baseline_coverage_sha256 === expectedBaselineCoverageSha256, 'reviewed executable ownership baseline trust anchor mismatch')
  assert(typeof provenance.decision_registry_path === 'string' && provenance.decision_registry_path.length > 0, 'reviewed executable ownership materialization decision path missing')
  assert(SHA256.test(provenance.decision_registry_sha256 ?? '')
    && SHA256.test(provenance.baseline_coverage_sha256 ?? '')
    && provenance.tracked_inventory_sha256 === coverage.source?.tracked_inventory_sha256
    && Number.isInteger(provenance.exact_inventory_change_count)
    && provenance.exact_inventory_change_count >= 0
    && Number.isInteger(provenance.reviewed_assignment_count)
    && provenance.reviewed_assignment_count >= 0, 'reviewed executable ownership materialization provenance invalid')
  const canonicalRelative = (resolvedPath) => {
    const relative = path.relative(repositoryRoot, resolvedPath)
    assert(relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), 'reviewed executable ownership provenance must stay inside the repository')
    return relative.split(path.sep).join('/')
  }
  const decisionPath = path.resolve(repositoryRoot, provenance.decision_registry_path)
  assert(canonicalRelative(decisionPath) === provenance.decision_registry_path, 'reviewed executable ownership materialization decision path is not canonical')
  const decisionBytes = await readFile(decisionPath)
  assert(byteDigest(decisionBytes) === provenance.decision_registry_sha256, 'reviewed executable ownership decision registry hash drift')
  const decisions = JSON.parse(decisionBytes.toString('utf8'))
  assert(typeof provenance.baseline_coverage_path === 'string' && provenance.baseline_coverage_path.length > 0, 'reviewed executable ownership baseline path missing')
  const baselinePath = path.resolve(repositoryRoot, provenance.baseline_coverage_path)
  assert(canonicalRelative(baselinePath) === provenance.baseline_coverage_path, 'reviewed executable ownership baseline path is not canonical')
  const baselineBytes = await readFile(baselinePath)
  assert(byteDigest(baselineBytes) === provenance.baseline_coverage_sha256, 'reviewed executable ownership baseline hash drift')
  const baseline = JSON.parse(baselineBytes.toString('utf8'))
  assert(baseline.schema === REVIEWED_BASELINE_SCHEMA && baseline.version === 1, 'reviewed executable ownership baseline identity mismatch')
  assert(decisions.schema === REVIEWED_DECISION_SCHEMA && decisions.version === 1
    && decisions.baseline?.coverage_path === provenance.baseline_coverage_path
    && decisions.baseline?.coverage_sha256 === provenance.baseline_coverage_sha256
    && decisions.current?.tracked_inventory_sha256 === provenance.tracked_inventory_sha256
    && decisions.assignments?.length === provenance.reviewed_assignment_count
    && decisions.exact_inventory_changes?.length === provenance.exact_inventory_change_count, 'reviewed executable ownership materialization provenance contradiction')
  assert(inventory?.schema === 'yoko.crm.tracked-executable-surface-inventory.v2' && Array.isArray(manifests), 'current executable ownership inventory/manifests are required for provenance validation')
  const provisional = deriveExecutablePathOwnershipCoverage(inventory, manifests, baseline, { allowExactInventoryRefresh: true })
  const changedPaths = exactInventoryDrift(baseline, provisional).flatMap((change) => change.records.map((record) => record.path))
  const sourceSha256ByPath = new Map(await Promise.all(changedPaths.map(async (relativePath) => [relativePath, byteDigest(await readFile(path.join(repositoryRoot, relativePath)))])))
  const expectedCoverage = materializeReviewedExecutablePathOwnershipCoverage(inventory, manifests, baseline, decisions, {
    baselineCoveragePath: provenance.baseline_coverage_path,
    baselineCoverageSha256: provenance.baseline_coverage_sha256,
    sourceSha256ByPath,
    decisionRegistryPath: provenance.decision_registry_path,
    decisionRegistrySha256: provenance.decision_registry_sha256,
  })
  assert(JSON.stringify(stable(coverage)) === JSON.stringify(stable(expectedCoverage)), 'current executable ownership coverage is not the exact reviewed mechanical materialization')
  return { decisions, baseline, expectedCoverage }
}

async function main() {
  const [registry, coverageBytes, index] = await Promise.all([
    readFile(path.join(root, REGISTRY_PATH), 'utf8').then(JSON.parse),
    readFile(path.join(root, COVERAGE_PATH)),
    readFile(path.join(root, 'architecture/contexts/v1/context-index.json'), 'utf8').then(JSON.parse),
  ])
  const coverage = JSON.parse(coverageBytes.toString('utf8'))
  const manifests = await Promise.all(index.contexts.map(async (entry) => JSON.parse(await readFile(path.join(root, entry.path), 'utf8'))))
  const inventory = await inventoryTrackedSurfaces(root, { registry })
  if (process.argv.includes('--materialize-reviewed-current-denominator')) {
    const decisionArgument = option('--reviewed-decisions')
    assert(decisionArgument, 'explicit --reviewed-decisions <registry.json> input is required for materialization')
    const decisionPath = path.resolve(root, decisionArgument)
    const decisionRegistryPath = repositoryRelative(decisionPath)
    assert(decisionRegistryPath === REVIEWED_DECISION_PATH, `materialization requires authoritative reviewed decisions at ${REVIEWED_DECISION_PATH}`)
    const decisionBytes = await readFile(decisionPath)
    const decisions = JSON.parse(decisionBytes.toString('utf8'))
    assert(typeof decisions.baseline?.coverage_path === 'string' && decisions.baseline.coverage_path.length > 0, 'reviewed executable ownership baseline path missing')
    const baselinePath = path.resolve(root, decisions.baseline.coverage_path)
    const baselineCoveragePath = repositoryRelative(baselinePath)
    assert(baselineCoveragePath === REVIEWED_BASELINE_PATH, `materialization requires authoritative baseline at ${REVIEWED_BASELINE_PATH}`)
    const baselineBytes = await readFile(baselinePath)
    assert(byteDigest(baselineBytes) === REVIEWED_BASELINE_SHA256, 'reviewed executable ownership baseline trust anchor mismatch')
    const baselineCoverage = JSON.parse(baselineBytes.toString('utf8'))
    assert(baselineCoverage.schema === REVIEWED_BASELINE_SCHEMA && baselineCoverage.version === 1, 'reviewed executable ownership baseline identity mismatch')
    const provisional = deriveExecutablePathOwnershipCoverage(inventory, manifests, baselineCoverage, { allowExactInventoryRefresh: true })
    const changedPaths = exactInventoryDrift(baselineCoverage, provisional).flatMap((change) => change.records.map((record) => record.path))
    const sourceSha256ByPath = new Map(await Promise.all(changedPaths.map(async (relativePath) => [relativePath, byteDigest(await readFile(path.join(root, relativePath)))])))
    const refreshed = materializeReviewedExecutablePathOwnershipCoverage(inventory, manifests, baselineCoverage, decisions, {
      baselineCoveragePath,
      baselineCoverageSha256: byteDigest(baselineBytes),
      sourceSha256ByPath,
      decisionRegistryPath,
      decisionRegistrySha256: byteDigest(decisionBytes),
    })
    await writeFile(path.join(root, COVERAGE_PATH), `${JSON.stringify(refreshed, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ materialized: true, ...refreshed.summary, coverage_sha256: refreshed.coverage_sha256 })}\n`)
    return
  }
  const result = validateExecutablePathOwnershipCoverage(inventory, manifests, coverage)
  await validateExecutablePathOwnershipProvenance(root, coverage, inventory, manifests)
  process.stdout.write(`${JSON.stringify({ ok: true, ...coverage.summary, coverage_sha256: result.coverage_sha256 })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
