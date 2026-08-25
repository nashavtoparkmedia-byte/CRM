#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  assertCleanExactCandidateCheckout,
  CURRENT_DEPENDENCY_PATH,
  deriveExecutablePathOwnershipCoverage,
  loadExecutablePathOwnershipDependencies,
  materializeReviewedExecutablePathOwnershipCoverage,
  REVIEWED_BASELINE_PATH,
  REVIEWED_BASELINE_SHA256,
  REVIEWED_DECISION_PATH,
  validateExecutablePathOwnershipProvenance,
  validateExecutablePathOwnershipCoverage,
  validateExecutablePathOwnershipDependencies,
} from './validate-executable-path-ownership.mjs'
import { inventoryTrackedSurfaces } from './v2/tracked-surface-inventory.mjs'

const execFileAsync = promisify(execFile)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const inventory = {
  schema: 'yoko.crm.tracked-executable-surface-inventory.v2',
  controls: {},
  surfaces: [
    { path: 'app/owned.ts', lifecycle: 'APPLICATION_RUNTIME', disposition: null },
    { path: 'legacy/job.sh', lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE' },
  ],
}
const manifests = [{ context: { id: 'owner' }, owned_paths: ['app'] }]
const base = {
  schema: 'yoko.crm.executable-path-ownership-coverage.v1',
  version: 1,
  functional_owner_registry: [{
    id: 'repository_operations', owner_class: 'OPERATIONS', allowed_lifecycles: ['OPERATIONAL_SCRIPT', 'TEST'],
    accountability: 'fixture repository operations owner',
  }],
  governed_exclusions: [{
    id: 'legacy', path_prefix: 'legacy', functional_owner: 'repository_operations',
    rationale: 'fixture governed legacy surface', review_artifact: 'fixture',
  }],
}
const derived = deriveExecutablePathOwnershipCoverage(inventory, manifests, base)
const coverage = {
  ...base,
  source: { tracked_executable_surfaces: derived.tracked_executable_surfaces, tracked_inventory_sha256: derived.tracked_inventory_sha256 },
  coverage_sha256: derived.coverage_sha256,
  summary: {
    context_owned_paths: derived.context_owned_paths,
    governed_exclusion_paths: derived.governed_exclusion_paths,
    tracked_executable_surfaces: derived.tracked_executable_surfaces,
  },
}
assert.equal(validateExecutablePathOwnershipCoverage(inventory, manifests, coverage).records.length, 2)
assert.throws(
  () => validateExecutablePathOwnershipCoverage(inventory, manifests, null),
  /coverage identity mismatch/,
  'missing current authority must fail closed',
)

const adaptedInventory = structuredClone(inventory)
adaptedInventory.surfaces.push({ path: 'legacy/next.sh', lifecycle: 'OPERATIONAL_SCRIPT', disposition: 'ACTIVE' })
const adaptedDerived = deriveExecutablePathOwnershipCoverage(adaptedInventory, manifests, base)
const adaptedCoverage = {
  ...base,
  source: {
    tracked_executable_surfaces: adaptedDerived.tracked_executable_surfaces,
    tracked_inventory_sha256: adaptedDerived.tracked_inventory_sha256,
  },
  coverage_sha256: adaptedDerived.coverage_sha256,
  summary: {
    context_owned_paths: adaptedDerived.context_owned_paths,
    governed_exclusion_paths: adaptedDerived.governed_exclusion_paths,
    tracked_executable_surfaces: adaptedDerived.tracked_executable_surfaces,
  },
}
assert.equal(
  validateExecutablePathOwnershipCoverage(adaptedInventory, manifests, adaptedCoverage).records.length,
  3,
  'a controlled live denominator change must consume the updated authority without synchronized test literals',
)
const adaptedMismatch = structuredClone(adaptedCoverage)
adaptedMismatch.source.tracked_inventory_sha256 = '0'.repeat(64)
assert.throws(
  () => validateExecutablePathOwnershipCoverage(adaptedInventory, manifests, adaptedMismatch),
  /source inventory drift/,
  'an authoritative/live mismatch must remain fail-closed',
)

const parentChildOverlap = [
  { context: { id: 'parent_owner' }, owned_paths: ['app'] },
  { context: { id: 'nested_owner' }, owned_paths: ['app/future'] },
]
assert.throws(
  () => deriveExecutablePathOwnershipCoverage(inventory, parentChildOverlap, coverage),
  /manifest owned_paths overlap across contexts/,
  'parent/child ownership must fail even when no current executable occupies the nested path',
)

const exactDuplicateOwnership = [
  { context: { id: 'first_owner' }, owned_paths: ['app'] },
  { context: { id: 'second_owner' }, owned_paths: ['future/module'] },
  { context: { id: 'third_owner' }, owned_paths: ['future/module'] },
]
assert.throws(
  () => deriveExecutablePathOwnershipCoverage(inventory, exactDuplicateOwnership, coverage),
  /manifest owned_paths overlap across contexts/,
  'exact duplicate ownership must fail independently of the current executable denominator',
)

const missing = structuredClone(coverage)
missing.governed_exclusions = []
assert.throws(() => validateExecutablePathOwnershipCoverage(inventory, manifests, missing), /governed executable exclusions missing/)

const unowned = structuredClone(inventory)
unowned.surfaces.push({ path: 'unknown/live.ts', lifecycle: 'APPLICATION_RUNTIME', disposition: null })
assert.throws(() => validateExecutablePathOwnershipCoverage(unowned, manifests, coverage), /lacks context owner or governed exclusion/)

const ambiguous = structuredClone(coverage)
ambiguous.governed_exclusions.push({
  id: 'legacy_duplicate', path_prefix: 'legacy', functional_owner: 'repository_operations',
  rationale: 'fixture duplicate selector', review_artifact: 'fixture',
})
assert.throws(() => validateExecutablePathOwnershipCoverage(inventory, manifests, ambiguous), /ambiguous governed exclusions/)

const denominator = structuredClone(coverage)
denominator.source.tracked_executable_surfaces = 0
assert.throws(() => validateExecutablePathOwnershipCoverage(inventory, manifests, denominator), /denominator drift/)

const runtimeInventory = {
  ...inventory,
  surfaces: [{ path: 'gravity-mvp/src/legacy.ts', lifecycle: 'APPLICATION_RUNTIME', disposition: null }],
}
const broadRuntime = {
  schema: 'yoko.crm.executable-path-ownership-coverage.v1',
  version: 1,
  functional_owner_registry: [{
    id: 'generic_operations', owner_class: 'OPERATIONS', allowed_lifecycles: ['APPLICATION_RUNTIME'],
    accountability: 'generic fixture operations owner',
  }],
  governed_exclusions: [{
    id: 'broad_runtime', path_prefix: 'gravity-mvp/src', functional_owner: 'generic_operations',
    rationale: 'invalid broad runtime laundering fixture', review_artifact: 'fixture',
  }],
}
assert.throws(() => deriveExecutablePathOwnershipCoverage(runtimeInventory, [], broadRuntime), /application-runtime path requires exact legacy\/evidence inventory ownership/)

const undeclaredOwner = structuredClone(base)
undeclaredOwner.governed_exclusions[0].functional_owner = 'not_in_registry'
assert.throws(() => deriveExecutablePathOwnershipCoverage(inventory, manifests, undeclaredOwner), /executable exclusion governance incomplete/)

const migrationPaths = ['archive/one/migration.sql', 'archive/two/migration.sql']
const exactMigration = {
  schema: 'yoko.crm.executable-path-ownership-coverage.v1',
  version: 1,
  functional_owner_registry: [{
    id: 'migration_authority', owner_class: 'MIGRATION_AUTHORITY', allowed_lifecycles: ['MIGRATION'],
    accountability: 'finite fixture migration authority',
  }],
  governed_exclusions: [{
    id: 'migration_archive', path_prefix: 'archive', lifecycles: ['MIGRATION'], functional_owner: 'migration_authority',
    rationale: 'finite fixture migration inventory', review_artifact: 'fixture',
    exact_path_inventory: { path_count: 2, path_sha256: 'df00f0f32ae896d64ae1e88a849b9cb1ebcff8beee558252879dc01751a57571' },
  }],
}
const migrationInventory = {
  schema: 'yoko.crm.tracked-executable-surface-inventory.v2',
  controls: {},
  surfaces: migrationPaths.map((migrationPath) => ({ path: migrationPath, lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY' })),
}
assert.equal(deriveExecutablePathOwnershipCoverage(migrationInventory, [], exactMigration).records.length, 2)
const migrationDrift = structuredClone(migrationInventory)
migrationDrift.surfaces.push({ path: 'archive/three/migration.sql', lifecycle: 'MIGRATION', disposition: 'MIGRATION_ONLY' })
assert.throws(() => deriveExecutablePathOwnershipCoverage(migrationDrift, [], exactMigration), /exact path inventory drift/)
assert.equal(
  deriveExecutablePathOwnershipCoverage(migrationDrift, [], exactMigration, { allowExactInventoryRefresh: true }).records.length,
  3,
  'review validation needs a provisional view but this view grants no materialization authority',
)

const provisionalMigrationDrift = deriveExecutablePathOwnershipCoverage(migrationDrift, [], exactMigration, { allowExactInventoryRefresh: true })
const fixtureSource = (surfacePath) => `fixture-source:${surfacePath}\n`
const sourceSha256ByPath = Object.fromEntries(migrationDrift.surfaces.map((surface) => [surface.path, sha256(fixtureSource(surface.path))]))
const baselineCoverageSha256 = sha256(JSON.stringify(exactMigration))
const baselineCoveragePath = 'architecture/contexts/v1/executable-path-ownership-baseline-fixture.json'
const decisionRegistryPath = 'architecture/contexts/v1/reviewed-executable-path-ownership-fixture.json'
const reviewedMigrationDrift = {
  schema: 'yoko.crm.reviewed-executable-path-ownership-decisions.v1',
  version: 1,
  review: {
    status: 'COMPLETED_EXACT_PATH_REVIEW',
    reviewed_by: 'INTERNAL_EXECUTOR_REVIEW_20260813',
    role: 'SOL_HIGH_INTERNAL_REVIEW',
    external_acceptance: false,
    independent_acceptance: false,
    decision: 'Every current path in the changed exact migration inventory was reviewed one-to-one.',
  },
  baseline: {
    coverage_path: baselineCoveragePath,
    coverage_sha256: baselineCoverageSha256,
  },
  current: {
    tracked_inventory_sha256: provisionalMigrationDrift.tracked_inventory_sha256,
    tracked_executable_surfaces: provisionalMigrationDrift.tracked_executable_surfaces,
    coverage_sha256: provisionalMigrationDrift.coverage_sha256,
  },
  exact_inventory_changes: [{
    exclusion: 'migration_archive',
    inventory_kind: 'exact_path_inventory',
    review_decision: 'APPROVED_EXACT_INVENTORY_TRANSITION',
    review_rationale: 'The exact finite migration inventory change was reviewed against every prior and current path.',
    previous_inventory: { ...exactMigration.governed_exclusions[0].exact_path_inventory },
    previous_paths: [...migrationPaths],
    current_inventory: {
      path_count: 3,
      path_sha256: '8c2c0c625d4c2de8d07796c72936c5cdcdf30e1494726878a956c3e705d29166',
    },
  }],
  assignments: migrationDrift.surfaces.map((surface) => ({
    path: surface.path,
    lifecycle: surface.lifecycle,
    functional_owner: 'migration_authority',
    exclusion: 'migration_archive',
    inventory_kind: 'exact_path_inventory',
    source_sha256: sourceSha256ByPath[surface.path],
    review_decision: 'APPROVED_CURRENT_ASSIGNMENT',
    review_rationale: 'This exact source path, lifecycle, owner, exclusion and current source hash were reviewed together.',
  })),
}
const materialize = (decisions) => materializeReviewedExecutablePathOwnershipCoverage(migrationDrift, [], exactMigration, decisions, {
  baselineCoverageSha256,
  baselineCoveragePath,
  sourceSha256ByPath,
  decisionRegistryPath,
  decisionRegistrySha256: sha256(JSON.stringify(decisions)),
})
const refreshedMigration = materialize(reviewedMigrationDrift)
assert.deepEqual(refreshedMigration.governed_exclusions[0].exact_path_inventory, reviewedMigrationDrift.exact_inventory_changes[0].current_inventory)
assert.equal(refreshedMigration.reviewed_exact_inventory_materialization.reviewed_assignment_count, 3)
assert.throws(() => materialize(null), /explicit reviewed executable ownership decisions are required/)

const provenanceRoot = await mkdtemp(path.join(os.tmpdir(), 'yoko-executable-ownership-provenance-'))
await mkdir(path.join(provenanceRoot, path.dirname(baselineCoveragePath)), { recursive: true })
await mkdir(path.join(provenanceRoot, path.dirname(decisionRegistryPath)), { recursive: true })
for (const surface of migrationDrift.surfaces) {
  await mkdir(path.join(provenanceRoot, path.dirname(surface.path)), { recursive: true })
  await writeFile(path.join(provenanceRoot, surface.path), fixtureSource(surface.path))
}
const baselineBytes = `${JSON.stringify(exactMigration)}\n`
const decisionsWithByteBaseline = structuredClone(reviewedMigrationDrift)
decisionsWithByteBaseline.baseline.coverage_sha256 = sha256(baselineBytes)
const decisionBytes = `${JSON.stringify(decisionsWithByteBaseline)}\n`
const materializedWithProvenance = materializeReviewedExecutablePathOwnershipCoverage(migrationDrift, [], exactMigration, decisionsWithByteBaseline, {
  baselineCoverageSha256: sha256(baselineBytes),
  baselineCoveragePath,
  sourceSha256ByPath,
  decisionRegistryPath,
  decisionRegistrySha256: sha256(decisionBytes),
})
await writeFile(path.join(provenanceRoot, baselineCoveragePath), baselineBytes)
await writeFile(path.join(provenanceRoot, decisionRegistryPath), decisionBytes)
const provenanceOptions = {
  expectedDecisionRegistryPath: decisionRegistryPath,
  expectedBaselineCoveragePath: baselineCoveragePath,
  expectedBaselineCoverageSha256: sha256(baselineBytes),
}
await validateExecutablePathOwnershipProvenance(provenanceRoot, materializedWithProvenance, migrationDrift, [], provenanceOptions)
await assert.rejects(() => validateExecutablePathOwnershipProvenance(provenanceRoot, exactMigration, migrationDrift, [], provenanceOptions), /materialization provenance missing/)
await writeFile(path.join(provenanceRoot, decisionRegistryPath), `${decisionBytes} `)
await assert.rejects(() => validateExecutablePathOwnershipProvenance(provenanceRoot, materializedWithProvenance, migrationDrift, [], provenanceOptions), /decision registry hash drift/)
await writeFile(path.join(provenanceRoot, decisionRegistryPath), decisionBytes)
await writeFile(path.join(provenanceRoot, baselineCoveragePath), `${baselineBytes} `)
await assert.rejects(() => validateExecutablePathOwnershipProvenance(provenanceRoot, materializedWithProvenance, migrationDrift, [], provenanceOptions), /baseline hash drift/)
await writeFile(path.join(provenanceRoot, baselineCoveragePath), baselineBytes)
await writeFile(path.join(provenanceRoot, migrationDrift.surfaces[0].path), 'tampered-current-source\n')
await assert.rejects(() => validateExecutablePathOwnershipProvenance(provenanceRoot, materializedWithProvenance, migrationDrift, [], provenanceOptions), /assignment source_sha256 mismatch/)
await writeFile(path.join(provenanceRoot, migrationDrift.surfaces[0].path), fixtureSource(migrationDrift.surfaces[0].path))
const coupledForgery = structuredClone(decisionsWithByteBaseline)
coupledForgery.assignments[0].functional_owner = 'self_authorized_owner'
const coupledForgeryBytes = `${JSON.stringify(coupledForgery)}\n`
const coupledForgeryCoverage = structuredClone(materializedWithProvenance)
coupledForgeryCoverage.reviewed_exact_inventory_materialization.decision_registry_sha256 = sha256(coupledForgeryBytes)
await writeFile(path.join(provenanceRoot, decisionRegistryPath), coupledForgeryBytes)
await assert.rejects(() => validateExecutablePathOwnershipProvenance(provenanceRoot, coupledForgeryCoverage, migrationDrift, [], provenanceOptions), /assignment functional_owner mismatch/)

const missingAssignment = structuredClone(reviewedMigrationDrift)
missingAssignment.assignments.pop()
assert.throws(() => materialize(missingAssignment), /missing reviewed exact inventory assignment/)

const duplicateAssignment = structuredClone(reviewedMigrationDrift)
duplicateAssignment.assignments.push({ ...duplicateAssignment.assignments[0] })
assert.throws(() => materialize(duplicateAssignment), /duplicate reviewed exact inventory assignment/)

const unreviewedAssignment = structuredClone(reviewedMigrationDrift)
delete unreviewedAssignment.assignments[0].review_decision
assert.throws(() => materialize(unreviewedAssignment), /assignment lacks an explicit internal decision/)

const mismatchedLifecycle = structuredClone(reviewedMigrationDrift)
mismatchedLifecycle.assignments[0].lifecycle = 'APPLICATION_RUNTIME'
assert.throws(() => materialize(mismatchedLifecycle), /assignment lifecycle mismatch/)

const mismatchedOwner = structuredClone(reviewedMigrationDrift)
mismatchedOwner.assignments[0].functional_owner = 'self_authorized_owner'
assert.throws(() => materialize(mismatchedOwner), /assignment functional_owner mismatch/)

const mismatchedExclusion = structuredClone(reviewedMigrationDrift)
mismatchedExclusion.assignments[0].exclusion = 'different_exclusion'
assert.throws(() => materialize(mismatchedExclusion), /assignment exclusion mismatch/)

const mismatchedInventoryKind = structuredClone(reviewedMigrationDrift)
mismatchedInventoryKind.assignments[0].inventory_kind = 'exact_runtime_inventory'
assert.throws(() => materialize(mismatchedInventoryKind), /assignment inventory_kind mismatch/)

const mismatchedSource = structuredClone(reviewedMigrationDrift)
mismatchedSource.assignments[0].source_sha256 = 'f'.repeat(64)
assert.throws(() => materialize(mismatchedSource), /assignment source_sha256 mismatch/)

const mismatchedChangeSet = structuredClone(reviewedMigrationDrift)
mismatchedChangeSet.exact_inventory_changes[0].current_inventory.path_count = 2
assert.throws(() => materialize(mismatchedChangeSet), /change current_inventory mismatch/)

const mismatchedPreviousPaths = structuredClone(reviewedMigrationDrift)
mismatchedPreviousPaths.exact_inventory_changes[0].previous_paths[0] = 'archive/forged/migration.sql'
assert.throws(() => materialize(mismatchedPreviousPaths), /previous exact path inventory mismatch/)

const dishonestReviewer = structuredClone(reviewedMigrationDrift)
dishonestReviewer.review.reviewed_by = 'INDEPENDENT_EXTERNAL_REVIEWER'
assert.throws(() => materialize(dishonestReviewer), /decision metadata incomplete/)

const staleBaseline = structuredClone(reviewedMigrationDrift)
staleBaseline.baseline.coverage_sha256 = '0'.repeat(64)
assert.throws(() => materialize(staleBaseline), /stale for the baseline coverage/)

const staleCurrent = structuredClone(reviewedMigrationDrift)
staleCurrent.current.tracked_inventory_sha256 = '0'.repeat(64)
assert.throws(() => materialize(staleCurrent), /stale for the current denominator/)

const staleAssignment = structuredClone(reviewedMigrationDrift)
staleAssignment.assignments[0].path = 'archive/stale/migration.sql'
assert.throws(() => materialize(staleAssignment), /stale reviewed exact inventory assignment/)

async function gitFixture(relativePath = 'tracked.txt', contents = 'accepted\n') {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'yoko-clean-materialization-'))
  const git = (...args) => execFileAsync('git', args, { cwd: fixture, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  await git('init', '--quiet')
  await git('config', 'user.name', 'Yoko Materialization Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await mkdir(path.join(fixture, path.dirname(relativePath)), { recursive: true })
  await writeFile(path.join(fixture, relativePath), contents)
  await git('add', relativePath)
  await git('commit', '--quiet', '-m', 'fixture')
  const candidate = (await git('rev-parse', 'HEAD^{commit}')).stdout.trim()
  return { candidate, fixture, git }
}

const cleanFixture = await gitFixture()
assert.deepEqual(
  await assertCleanExactCandidateCheckout(cleanFixture.fixture, cleanFixture.candidate),
  { candidate: cleanFixture.candidate, status_porcelain_bytes: 0 },
)
await assert.rejects(
  () => assertCleanExactCandidateCheckout(cleanFixture.fixture, '0'.repeat(40)),
  /materialization candidate mismatch/,
)

const modifiedFixture = await gitFixture()
await writeFile(path.join(modifiedFixture.fixture, 'tracked.txt'), 'modified\n')
await assert.rejects(
  () => assertCleanExactCandidateCheckout(modifiedFixture.fixture, modifiedFixture.candidate),
  /clean exact candidate checkout; tracked_modified=1; no source was cleaned or materialized/,
)

const stagedFixture = await gitFixture()
await writeFile(path.join(stagedFixture.fixture, 'tracked.txt'), 'staged\n')
await stagedFixture.git('add', 'tracked.txt')
await assert.rejects(
  () => assertCleanExactCandidateCheckout(stagedFixture.fixture, stagedFixture.candidate),
  /clean exact candidate checkout; tracked_modified=1, staged_changes=1; no source was cleaned or materialized/,
)

const deletedFixture = await gitFixture()
await unlink(path.join(deletedFixture.fixture, 'tracked.txt'))
await assert.rejects(
  () => assertCleanExactCandidateCheckout(deletedFixture.fixture, deletedFixture.candidate),
  /clean exact candidate checkout; working_tree_deleted=1; no source was cleaned or materialized/,
)

const untrackedFixture = await gitFixture()
await writeFile(path.join(untrackedFixture.fixture, 'untracked.txt'), 'untracked\n')
await assert.rejects(
  () => assertCleanExactCandidateCheckout(untrackedFixture.fixture, untrackedFixture.candidate),
  /clean exact candidate checkout; untracked_files=1; no source was cleaned or materialized/,
)

const byteDirectionFixture = await gitFixture('tools/ownership-probe.mjs', 'export const fixture = 1\n')
const inventoryBeforeSourceByteChange = await inventoryTrackedSurfaces(byteDirectionFixture.fixture)
await writeFile(path.join(byteDirectionFixture.fixture, 'tools/ownership-probe.mjs'), 'export const fixture = 2\n')
const inventoryAfterSourceByteChange = await inventoryTrackedSurfaces(byteDirectionFixture.fixture)
assert.deepEqual(
  inventoryAfterSourceByteChange,
  inventoryBeforeSourceByteChange,
  'ordinary source bytes must not create an ownership-inventory fixed point; tracked path/mode/lifecycle remain the identity',
)

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [currentRegistry, currentIndex, currentDecisionBytes, currentBaselineBytes] = await Promise.all([
  readFile(path.join(repositoryRoot, 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'), 'utf8').then(JSON.parse),
  readFile(path.join(repositoryRoot, 'architecture/contexts/v1/context-index.json'), 'utf8').then(JSON.parse),
  readFile(path.join(repositoryRoot, REVIEWED_DECISION_PATH)),
  readFile(path.join(repositoryRoot, REVIEWED_BASELINE_PATH)),
])
const { bytes: currentDependencyBytes, value: currentDependencies } = await loadExecutablePathOwnershipDependencies(repositoryRoot, { contextIndex: currentIndex })
const currentCoverage = JSON.parse(await readFile(path.join(repositoryRoot, currentDependencies.current_live.authority.path), 'utf8'))
assert.equal(sha256(currentDependencyBytes), currentIndex.outputs.executable_path_ownership_current_dependencies.sha256)

const missingAuthorityDependencies = structuredClone(currentDependencies)
delete missingAuthorityDependencies.current_live.authority
assert.throws(() => validateExecutablePathOwnershipDependencies(missingAuthorityDependencies), /current authority mismatch/)
const malformedConsumers = structuredClone(currentDependencies)
malformedConsumers.current_live.consumers.pop()
assert.throws(() => validateExecutablePathOwnershipDependencies(malformedConsumers), /current consumers denominator mismatch/)
const historicalIncident = currentDependencies.historical_negative_fixtures[0]
assert.equal(historicalIncident.mutation.kind, 'working_tree_deleted')
assert.equal(historicalIncident.expected_failure, 'materialization requires a clean exact candidate checkout')

const currentManifests = await Promise.all(currentIndex.contexts.map(async (entry) => JSON.parse(await readFile(path.join(repositoryRoot, entry.path), 'utf8'))))
const [firstCleanInventory, secondCleanInventory] = await Promise.all([
  inventoryTrackedSurfaces(repositoryRoot, { registry: currentRegistry }),
  inventoryTrackedSurfaces(repositoryRoot, { registry: currentRegistry }),
])
assert.deepEqual(firstCleanInventory, secondCleanInventory, 'clean exact inventory must be deterministic across repeated derivations')
assert.deepEqual(firstCleanInventory.controls.working_tree_deleted, [])
assert.equal(firstCleanInventory.summary.tracked_executable_surfaces, currentCoverage.source.tracked_executable_surfaces)
const currentDerived = deriveExecutablePathOwnershipCoverage(firstCleanInventory, currentManifests, currentCoverage)
assert.equal(currentDerived.tracked_inventory_sha256, currentCoverage.source.tracked_inventory_sha256)
assert.equal(currentDerived.coverage_sha256, currentCoverage.coverage_sha256)

for (const consumer of currentDependencies.current_live.consumers) {
  const consumerSource = await readFile(path.join(repositoryRoot, consumer.path), 'utf8')
  assert.equal(
    new RegExp(`tracked_executable_surfaces\\s*,\\s*${currentCoverage.source.tracked_executable_surfaces}(?:\\D|$)`, 'u').test(consumerSource),
    false,
    `undeclared current-live ownership denominator literal remains in ${consumer.path}`,
  )
  for (const digestLiteral of [currentCoverage.source.tracked_inventory_sha256, currentCoverage.coverage_sha256]) {
    assert.equal(consumerSource.includes(digestLiteral), false, `undeclared current-live ownership digest literal remains in ${consumer.path}`)
  }
}
const currentDecisions = JSON.parse(currentDecisionBytes.toString('utf8'))
const currentBaseline = JSON.parse(currentBaselineBytes.toString('utf8'))
assert.equal(sha256(currentBaselineBytes), REVIEWED_BASELINE_SHA256)
const currentSourceSha256ByPath = new Map(await Promise.all(currentDecisions.assignments.map(async ({ path: relativePath }) => [
  relativePath,
  sha256(await readFile(path.join(repositoryRoot, relativePath))),
])))
const currentMaterializationOptions = {
  baselineCoveragePath: REVIEWED_BASELINE_PATH,
  baselineCoverageSha256: REVIEWED_BASELINE_SHA256,
  sourceSha256ByPath: currentSourceSha256ByPath,
  decisionRegistryPath: REVIEWED_DECISION_PATH,
  decisionRegistrySha256: sha256(currentDecisionBytes),
}
const firstMaterialization = materializeReviewedExecutablePathOwnershipCoverage(
  firstCleanInventory, currentManifests, currentBaseline, currentDecisions, currentMaterializationOptions,
)
const secondMaterialization = materializeReviewedExecutablePathOwnershipCoverage(
  secondCleanInventory, currentManifests, currentBaseline, currentDecisions, currentMaterializationOptions,
)
assert.deepEqual(firstMaterialization, secondMaterialization, 'clean exact materialization must be deterministic across repeated executions')
assert.deepEqual(firstMaterialization, currentCoverage, 'committed coverage must be the exact deterministic clean materialization')
process.stdout.write('executable path ownership coverage: PASS\n')
