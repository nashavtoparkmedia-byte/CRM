#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertCleanExactCandidateCheckout,
  deriveExecutablePathOwnershipCoverage,
  deriveHistoricalExecutablePathOwnershipFixture,
  discoverExecutablePathOwnershipConsumers,
  materializeReviewedExecutablePathOwnershipCoverage,
  readCurrentOwnershipCoverage,
  readCurrentOwnershipDependencies,
  readHistoricalOwnershipBaseline,
  readReviewedOwnershipDecisions,
  REVIEWED_BASELINE_SHA256,
  validateExecutablePathOwnershipProvenance,
  validateExecutablePathOwnershipCoverage,
  validateExecutablePathOwnershipConsumerClosure,
  validateExecutablePathOwnershipDependencies,
  validateHistoricalExecutablePathOwnershipFixtures,
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
const currentIndex = JSON.parse(await readFile(path.join(repositoryRoot, 'architecture/contexts/v1/context-index.json'), 'utf8'))
const [currentRegistry, currentDecisionInput, currentBaselineInput, currentCoverageInput, currentDependencyInput, currentValidatorBytes] = await Promise.all([
  readFile(path.join(repositoryRoot, currentIndex.controls.lifecycle_surface_registry.path), 'utf8').then(JSON.parse),
  readReviewedOwnershipDecisions(repositoryRoot),
  readHistoricalOwnershipBaseline(repositoryRoot),
  readCurrentOwnershipCoverage(repositoryRoot),
  readCurrentOwnershipDependencies(repositoryRoot),
  readFile(path.join(repositoryRoot, currentIndex.controls.executable_path_ownership_validator.path)),
])
const { bytes: currentDecisionBytes, value: currentDecisions } = currentDecisionInput
const { bytes: currentBaselineBytes, value: currentBaseline } = currentBaselineInput
const { value: currentCoverage } = currentCoverageInput
const { bytes: currentDependencyBytes, value: currentDependencies } = currentDependencyInput
assert.equal(currentValidatorBytes.includes(Buffer.from('export function readCurrentOwnershipCoverage')), true, 'canonical authority access module source missing')
validateExecutablePathOwnershipDependencies(currentDependencies, { contextIndex: currentIndex, repositoryRoot })
assert.equal(sha256(currentDependencyBytes), currentIndex.outputs.executable_path_ownership_current_dependencies.sha256)

const missingAuthorityDependencies = structuredClone(currentDependencies)
delete missingAuthorityDependencies.current_live.authority
assert.throws(() => validateExecutablePathOwnershipDependencies(missingAuthorityDependencies), /current authority mismatch/)
const malformedConsumers = structuredClone(currentDependencies)
malformedConsumers.current_live.consumers.pop()
assert.throws(() => validateExecutablePathOwnershipDependencies(malformedConsumers), /undeclared current consumers/)
const historicalIncident = currentDependencies.historical_negative_fixtures[0]
assert.equal(historicalIncident.mutation.kind, 'working_tree_deleted')
assert.equal(historicalIncident.expected_failure, 'materialization requires a clean exact candidate checkout')
const reproducedHistorical = validateHistoricalExecutablePathOwnershipFixtures(currentDependencies, repositoryRoot)
assert.deepEqual(reproducedHistorical, historicalIncident.expected, 'the tracked historical fixture must reproduce exactly from pinned Git objects')

const randomHistoricalHashes = structuredClone(currentDependencies)
randomHistoricalHashes.historical_negative_fixtures[0].expected.clean_inventory_sha256 = 'a'.repeat(64)
randomHistoricalHashes.historical_negative_fixtures[0].expected.mutation_provenance_sha256 = 'b'.repeat(64)
assert.throws(
  () => validateHistoricalExecutablePathOwnershipFixtures(randomHistoricalHashes, repositoryRoot),
  /exact reproduction mismatch/,
  'syntactically valid but incorrect historical hashes must fail',
)
const wrongHistoricalCommit = structuredClone(currentDependencies)
wrongHistoricalCommit.historical_negative_fixtures[0].candidate = historicalIncident.expected.candidate_tree
assert.throws(
  () => validateHistoricalExecutablePathOwnershipFixtures(wrongHistoricalCommit, repositoryRoot),
  /historical candidate is not a commit/,
  'a wrong Git object type must fail before accepting fixture identities',
)
const missingHistoricalPath = structuredClone(currentDependencies)
missingHistoricalPath.historical_negative_fixtures[0].path = 'deploy/pm2/does-not-exist.js'
assert.throws(
  () => validateHistoricalExecutablePathOwnershipFixtures(missingHistoricalPath, repositoryRoot),
  /historical path missing from before commit/,
  'a missing historical path must fail',
)
const wrongHistoricalPath = structuredClone(currentDependencies)
wrongHistoricalPath.historical_negative_fixtures[0].path = 'tools/architecture/generate-context-manifests.mjs'
assert.throws(
  () => validateHistoricalExecutablePathOwnershipFixtures(wrongHistoricalPath, repositoryRoot),
  /exact reproduction mismatch/,
  'a different real path from the same pinned repository state must fail the pinned identities',
)
const malformedHistoricalFixture = structuredClone(currentDependencies)
malformedHistoricalFixture.historical_negative_fixtures[0].schema = 'malformed.fixture.v1'
assert.throws(
  () => validateHistoricalExecutablePathOwnershipFixtures(malformedHistoricalFixture, repositoryRoot),
  /historical fixture malformed/,
)
const changedCurrentLive = structuredClone(currentDependencies)
changedCurrentLive.current_live.derived_fields.coverage_sha256 = '/different/current/location'
assert.deepEqual(
  deriveHistoricalExecutablePathOwnershipFixture(repositoryRoot, changedCurrentLive.historical_negative_fixtures[0]),
  reproducedHistorical,
  'current-live authority changes must not redefine the pinned historical fixture',
)

async function dependencyClosureFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'yoko-ownership-structural-closure-'))
  const git = (...args) => execFileAsync('git', args, { cwd: fixture, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  await git('init', '--quiet')
  await git('config', 'user.name', 'Yoko Structural Closure Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  const declaration = structuredClone(currentDependencies)
  const accessPath = declaration.current_live.authority_access.module
  declaration.current_live.authority_access.non_authority_exports = ['validateFixture']
  const capabilityContract = declaration.current_live.authority_access.capabilities
  const capabilityNames = capabilityContract.map((capability) => capability.export)
  const privateConstants = capabilityContract.map((capability, index) => 'const AUTHORITY_' + index + " = '" + capability.artifact_path + "'")
  const capabilityExports = capabilityContract.map((capability, index) => 'export function ' + capability.export + '() { return AUTHORITY_' + index + ' }')
  await mkdir(path.dirname(path.join(fixture, accessPath)), { recursive: true })
  await writeFile(path.join(fixture, accessPath), [...privateConstants, ...capabilityExports, 'export function validateFixture() { return true }', ''].join('\n'))

  const consumers = [
    {
      path: 'tools/architecture/direct-consumer.mjs',
      role: 'direct_consumer',
      capability: capabilityNames[0],
      body: (specifier, capability) => 'import { ' + capability + ' } from ' + JSON.stringify(specifier) + '\n' + capability + '()\n',
    },
    {
      path: 'tools/architecture/alias-consumer.mjs',
      role: 'alias_consumer',
      capability: capabilityNames[0],
      body: (specifier, capability) => 'import { ' + capability + ' as loadCoverage } from ' + JSON.stringify(specifier) + '\nloadCoverage()\n',
    },
    {
      path: 'tools/architecture/assignment-consumer.mjs',
      role: 'assignment_consumer',
      capability: capabilityNames[0],
      body: (specifier, capability) => 'import { ' + capability + ' as x } from ' + JSON.stringify(specifier) + '\nlet y\ny = x\ny()\n',
    },
    {
      path: 'tools/architecture/object-consumer.mjs',
      role: 'object_consumer',
      capability: capabilityNames[0],
      body: (specifier, capability) => 'import { ' + capability + ' } from ' + JSON.stringify(specifier) + '\nconst readers = { load: ' + capability + ' }\nreaders.load()\n',
    },
    {
      path: 'tools/architecture/wrapper-consumer.mjs',
      role: 'wrapper_consumer',
      capability: capabilityNames[0],
      body: (specifier, capability) => 'import { ' + capability + ' } from ' + JSON.stringify(specifier) + '\nconst load = () => ' + capability + '()\nload()\n',
    },
  ]
  const accessSpecifier = './' + path.posix.basename(accessPath)
  for (const consumer of consumers) {
    await writeFile(path.join(fixture, consumer.path), consumer.body(accessSpecifier, consumer.capability))
  }
  const diagnosticPath = 'tools/architecture/non-consumer-diagnostic.mjs'
  await writeFile(path.join(fixture, diagnosticPath), "export const diagnostic = 'ownership coverage authority healthy'\n")
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'structural closure fixture')
  declaration.current_live.consumers = consumers.map((consumer) => ({
    role: consumer.role,
    path: consumer.path,
    capabilities: [consumer.capability],
    terminal_leaf: true,
  }))
  return { accessPath, accessSpecifier, capabilityContract, capabilityNames, consumers, declaration, diagnosticPath, fixture, git }
}

const sourceGrammarMatrix = []
const sourceGrammarRejected = []
const governedEdgeForms = new Set()

async function assertSourceGrammarRejected(name, sourceBody, specifierFor, options = {}) {
  const fixture = await dependencyClosureFixture()
  try {
    const sourcePath = options.sourcePath ?? 'tools/architecture/' + name + '.mjs'
    const specifier = typeof specifierFor === 'function' ? specifierFor(fixture) : specifierFor
    await mkdir(path.dirname(path.join(fixture.fixture, sourcePath)), { recursive: true })
    await writeFile(path.join(fixture.fixture, sourcePath), sourceBody(specifier, fixture.capabilityNames[0]))
    if (options.runtimeExecutes === true) {
      const executed = await execFileAsync(process.execPath, [path.join(fixture.fixture, sourcePath)], { encoding: 'utf8' })
      assert.equal(executed.stdout, fixture.capabilityContract[0].artifact_path, name + ' must reproduce the Node-valid reviewer edge')
    }
    await fixture.git('add', sourcePath)
    assert.throws(
      () => discoverExecutablePathOwnershipConsumers(fixture.fixture, fixture.declaration),
      /acceptance /,
      name + ' must fail at acceptance source-language validation',
    )
    sourceGrammarMatrix.push(name)
    sourceGrammarRejected.push(name)
    if (options.edgeForm) governedEdgeForms.add(options.edgeForm)
  } finally {
    await rm(fixture.fixture, { force: true, recursive: true })
  }
}

async function assertSourceGrammarAllowed(name, sourcePath, sourceBody) {
  const fixture = await dependencyClosureFixture()
  try {
    await mkdir(path.dirname(path.join(fixture.fixture, sourcePath)), { recursive: true })
    await writeFile(path.join(fixture.fixture, sourcePath), sourceBody(fixture))
    await fixture.git('add', sourcePath)
    validateExecutablePathOwnershipConsumerClosure(fixture.declaration, fixture.fixture)
    sourceGrammarMatrix.push(name)
  } finally {
    await rm(fixture.fixture, { force: true, recursive: true })
  }
}

const closurePositive = await dependencyClosureFixture()
try {
  const discovered = discoverExecutablePathOwnershipConsumers(closurePositive.fixture, closurePositive.declaration)
  assert.deepEqual(
    validateExecutablePathOwnershipConsumerClosure(closurePositive.declaration, closurePositive.fixture),
    discovered,
    'declared and direct capability-import consumers must close in both directions',
  )
  const discoveredByPath = new Map(discovered.map((consumer) => [consumer.path, consumer.capabilities]))
  for (const consumer of closurePositive.consumers) {
    assert.deepEqual(discoveredByPath.get(consumer.path), [consumer.capability], 'aliases, local assignment, object storage, and wrappers must not affect structural consumer identity')
  }
  assert.equal(discoveredByPath.has(closurePositive.diagnosticPath), false, 'diagnostic metadata without a raw authority identity must remain a non-consumer')
  sourceGrammarMatrix.push('allowed-canonical-dot-relative')
} finally {
  await rm(closurePositive.fixture, { force: true, recursive: true })
}

await assertSourceGrammarAllowed(
  'allowed-canonical-parent-relative',
  'tools/architecture/nested/parent-relative.mjs',
  () => 'import { diagnostic } from "../non-consumer-diagnostic.mjs"\nvoid diagnostic\n',
)
await assertSourceGrammarAllowed(
  'allowed-canonical-grandparent-relative',
  'tools/architecture/nested/deeper/grandparent-relative.mjs',
  () => 'import { diagnostic } from "../../non-consumer-diagnostic.mjs"\nvoid diagnostic\n',
)
await assertSourceGrammarAllowed('allowed-node-builtin', 'tools/architecture/allowed-node-builtin.mjs', () => "import 'node:path'\n")
await assertSourceGrammarAllowed('allowed-bare-package', 'tools/architecture/allowed-bare-package.mjs', () => "import 'typescript'\n")
await assertSourceGrammarAllowed('allowed-scoped-package', 'tools/architecture/allowed-scoped-package.mjs', () => "import '@scope/package'\n")

const namedAuthorityImport = (specifier, capability) => 'import { ' + capability + ' } from ' + JSON.stringify(specifier) + '\nprocess.stdout.write(' + capability + '())\n'
const diagnosticImport = (specifier) => 'import { diagnostic } from ' + JSON.stringify(specifier) + '\nvoid diagnostic\n'
const sideEffectImport = (specifier) => 'import ' + JSON.stringify(specifier) + '\n'
const reexport = (specifier) => 'export { diagnostic } from ' + JSON.stringify(specifier) + '\n'
const dynamicImport = (specifier) => 'await import(' + JSON.stringify(specifier) + ')\n'

await assertSourceGrammarRejected('reject-lowercase-file-url', namedAuthorityImport,
  (fixture) => pathToFileURL(path.join(fixture.fixture, fixture.accessPath)).href,
  { runtimeExecutes: true, edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-uppercase-file-url', namedAuthorityImport,
  (fixture) => pathToFileURL(path.join(fixture.fixture, fixture.accessPath)).href.replace(/^file:/u, 'FILE:'),
  { runtimeExecutes: true, edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-mixedcase-file-url', namedAuthorityImport,
  (fixture) => pathToFileURL(path.join(fixture.fixture, fixture.accessPath)).href.replace(/^file:/u, 'FiLe:'),
  { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-localhost-file-url', namedAuthorityImport,
  (fixture) => pathToFileURL(path.join(fixture.fixture, fixture.accessPath)).href.replace('file:///', 'file://localhost/'),
  { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-absolute-path', namedAuthorityImport,
  (fixture) => path.join(fixture.fixture, fixture.accessPath), { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reviewer-query-counterexample', namedAuthorityImport,
  (fixture) => fixture.accessSpecifier + '?authority-bypass', { runtimeExecutes: true, edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-fragment', reexport,
  (fixture) => fixture.accessSpecifier + '#fragment', { edgeForm: 'export_from' })
await assertSourceGrammarRejected('reject-query-fragment', dynamicImport,
  (fixture) => fixture.accessSpecifier + '?query#fragment', { edgeForm: 'dynamic_import' })
await assertSourceGrammarRejected('reject-empty-query', sideEffectImport,
  (fixture) => fixture.accessSpecifier + '?', { edgeForm: 'side_effect_import' })
await assertSourceGrammarRejected('reject-empty-fragment', diagnosticImport,
  (fixture) => fixture.accessSpecifier + '#', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-percent-encoded', diagnosticImport,
  (fixture) => fixture.accessSpecifier.replace('ownership', '%6Fwnership'), { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-backslash', diagnosticImport,
  '.\\non-consumer-diagnostic.mjs', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-duplicate-separator', diagnosticImport,
  './nested//module.mjs', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-internal-dot', diagnosticImport,
  './nested/./module.mjs', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-internal-dotdot', diagnosticImport,
  './nested/../non-consumer-diagnostic.mjs', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-noncanonical-equivalent-relative', diagnosticImport,
  '../architecture/non-consumer-diagnostic.mjs', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-unsupported-url-scheme', diagnosticImport,
  'https://example.invalid/module.mjs', { edgeForm: 'static_import' })
await assertSourceGrammarRejected('reject-unsupported-package-import-alias', diagnosticImport,
  '#ownership-diagnostic', { edgeForm: 'static_import' })

const nonliteralDynamic = await dependencyClosureFixture()
try {
  const sourcePath = 'tools/architecture/reject-nonliteral-dynamic.mjs'
  await writeFile(path.join(nonliteralDynamic.fixture, sourcePath), "const target = './non-consumer-diagnostic.mjs'\nawait import(target)\n")
  await nonliteralDynamic.git('add', sourcePath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(nonliteralDynamic.fixture, nonliteralDynamic.declaration),
    /acceptance nonliteral dynamic import forbidden/,
    'nonliteral dynamic import must fail without arbitrary JavaScript dataflow',
  )
  sourceGrammarMatrix.push('reject-nonliteral-dynamic')
  sourceGrammarRejected.push('reject-nonliteral-dynamic')
  governedEdgeForms.add('dynamic_import')
} finally {
  await rm(nonliteralDynamic.fixture, { force: true, recursive: true })
}

const escapedLiteral = await dependencyClosureFixture()
try {
  const sourcePath = 'tools/architecture/escaped-literal-counterexample.mjs'
  await writeFile(path.join(escapedLiteral.fixture, sourcePath),
    'import { ' + escapedLiteral.capabilityNames[0] + ' } from "./validate-executable-path-\\u006fwnership.mjs"\nprocess.stdout.write(' + escapedLiteral.capabilityNames[0] + '())\n')
  const executed = await execFileAsync(process.execPath, [path.join(escapedLiteral.fixture, sourcePath)], { encoding: 'utf8' })
  assert.equal(executed.stdout, escapedLiteral.capabilityContract[0].artifact_path)
  await escapedLiteral.git('add', sourcePath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(escapedLiteral.fixture, escapedLiteral.declaration),
    /acceptance module specifier escape spelling forbidden/,
    'raw JavaScript escape spelling must not be normalized into the acceptance grammar',
  )
} finally {
  await rm(escapedLiteral.fixture, { force: true, recursive: true })
}

const explicitAlias = await dependencyClosureFixture()
try {
  await mkdir(path.join(explicitAlias.fixture, 'gravity-mvp/src/lib'), { recursive: true })
  await writeFile(path.join(explicitAlias.fixture, 'gravity-mvp/tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { '@/*': ['./src/*'] } },
  }))
  await writeFile(path.join(explicitAlias.fixture, 'gravity-mvp/src/lib/alias-target.ts'), 'export const aliasTarget = true\n')
  await writeFile(path.join(explicitAlias.fixture, 'gravity-mvp/src/alias-consumer.ts'), "import { aliasTarget } from '@/lib/alias-target'\nvoid aliasTarget\n")
  await explicitAlias.git('add', 'gravity-mvp')
  validateExecutablePathOwnershipConsumerClosure(explicitAlias.declaration, explicitAlias.fixture)
} finally {
  await rm(explicitAlias.fixture, { force: true, recursive: true })
}

const unreviewedAlias = await dependencyClosureFixture()
try {
  await writeFile(path.join(unreviewedAlias.fixture, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { '#authority': ['./tools/architecture/validate-executable-path-ownership.mjs'] } },
  }))
  await unreviewedAlias.git('add', 'tsconfig.json')
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(unreviewedAlias.fixture, unreviewedAlias.declaration),
    /acceptance unreviewed local alias mapping forbidden/,
    'a newly introduced repository alias mapping must fail before source-edge discovery',
  )
} finally {
  await rm(unreviewedAlias.fixture, { force: true, recursive: true })
}

const createRequireAlias = await dependencyClosureFixture()
try {
  const sourcePath = 'tools/architecture/create-require-alias.mjs'
  const authorityUrl = pathToFileURL(path.join(createRequireAlias.fixture, createRequireAlias.accessPath)).href
  await writeFile(path.join(createRequireAlias.fixture, sourcePath),
    "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nload(" + JSON.stringify(authorityUrl) + ')\n')
  await createRequireAlias.git('add', sourcePath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(createRequireAlias.fixture, createRequireAlias.declaration),
    /acceptance URL\/absolute module specifier forbidden/,
    'a direct createRequire loader alias must use the same source-language grammar',
  )
} finally {
  await rm(createRequireAlias.fixture, { force: true, recursive: true })
}

const aliasedRequireLoader = await dependencyClosureFixture()
try {
  const sourcePath = 'tools/architecture/aliased-require-loader.mjs'
  await writeFile(path.join(aliasedRequireLoader.fixture, sourcePath),
    "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nconst hiddenLoad = load\nhiddenLoad('./non-consumer-diagnostic.mjs')\n")
  await aliasedRequireLoader.git('add', sourcePath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(aliasedRequireLoader.fixture, aliasedRequireLoader.declaration),
    /acceptance require loader aliasing forbidden/,
    'a reviewed createRequire loader cannot be hidden behind callable value-flow',
  )
} finally {
  await rm(aliasedRequireLoader.fixture, { force: true, recursive: true })
}

const computedRequireDrift = await dependencyClosureFixture()
try {
  const sourcePath = 'tools/architecture/computed-require-drift.mjs'
  await writeFile(path.join(computedRequireDrift.fixture, sourcePath),
    "import { createRequire } from 'node:module'\nimport path from 'node:path'\nconst load = createRequire(import.meta.url)\nload(path.join(process.cwd(), 'harmless.js'))\n")
  await computedRequireDrift.git('add', sourcePath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(computedRequireDrift.fixture, computedRequireDrift.declaration),
    /acceptance computed require inventory drift/,
    'computed require inventory must remain exact and fail closed without arbitrary value-flow',
  )
} finally {
  await rm(computedRequireDrift.fixture, { force: true, recursive: true })
}

const closureStale = await dependencyClosureFixture()
try {
  closureStale.declaration.current_live.consumers.push({
    role: 'declared_without_capability_import',
    path: closureStale.diagnosticPath,
    capabilities: [closureStale.capabilityNames[0]],
    terminal_leaf: true,
  })
  assert.throws(
    () => validateExecutablePathOwnershipConsumerClosure(closureStale.declaration, closureStale.fixture),
    /stale declared consumers: tools\/architecture\/non-consumer-diagnostic\.mjs/,
    'a declaration without a matching capability import must fail',
  )
} finally {
  await rm(closureStale.fixture, { force: true, recursive: true })
}

const closureNonTerminalDeclaration = await dependencyClosureFixture()
try {
  delete closureNonTerminalDeclaration.declaration.current_live.consumers[0].terminal_leaf
  assert.throws(
    () => validateExecutablePathOwnershipConsumerClosure(closureNonTerminalDeclaration.declaration, closureNonTerminalDeclaration.fixture),
    /current consumer declaration malformed/,
    'every declared authority consumer must explicitly be a terminal leaf',
  )
} finally {
  await rm(closureNonTerminalDeclaration.fixture, { force: true, recursive: true })
}

const closureUndeclared = await dependencyClosureFixture()
try {
  const roguePath = 'tools/architecture/undeclared-capability-consumer.mjs'
  await writeFile(
    path.join(closureUndeclared.fixture, roguePath),
    'import { ' + closureUndeclared.capabilityNames[0] + ' } from ' + JSON.stringify(closureUndeclared.accessSpecifier) + '\n',
  )
  await closureUndeclared.git('add', roguePath)
  assert.throws(
    () => validateExecutablePathOwnershipConsumerClosure(closureUndeclared.declaration, closureUndeclared.fixture),
    /undeclared current consumers: tools\/architecture\/undeclared-capability-consumer\.mjs/,
    'an actual capability import absent from the declaration must fail',
  )
} finally {
  await rm(closureUndeclared.fixture, { force: true, recursive: true })
}

const closureUnauthorized = await dependencyClosureFixture()
try {
  const unauthorizedPath = 'tools/architecture/unauthorized-capability.mjs'
  await writeFile(
    path.join(closureUnauthorized.fixture, unauthorizedPath),
    'import { readArbitraryOwnershipAuthority } from ' + JSON.stringify(closureUnauthorized.accessSpecifier) + '\n',
  )
  await closureUnauthorized.git('add', unauthorizedPath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureUnauthorized.fixture, closureUnauthorized.declaration),
    /unauthorized canonical authority capability import: tools\/architecture\/unauthorized-capability\.mjs#readArbitraryOwnershipAuthority/,
    'an unauthorized capability import must fail',
  )
} finally {
  await rm(closureUnauthorized.fixture, { force: true, recursive: true })
}

const closureRawImport = await dependencyClosureFixture()
try {
  const rawImportPath = 'tools/architecture/raw-path-import.mjs'
  await writeFile(
    path.join(closureRawImport.fixture, rawImportPath),
    'import { COVERAGE_PATH } from ' + JSON.stringify(closureRawImport.accessSpecifier) + '\n',
  )
  await closureRawImport.git('add', rawImportPath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureRawImport.fixture, closureRawImport.declaration),
    /unauthorized canonical authority capability import: tools\/architecture\/raw-path-import\.mjs#COVERAGE_PATH/,
    'a raw authority path import must fail',
  )
} finally {
  await rm(closureRawImport.fixture, { force: true, recursive: true })
}

const closureRawExport = await dependencyClosureFixture()
try {
  await writeFile(
    path.join(closureRawExport.fixture, closureRawExport.accessPath),
    (await readFile(path.join(closureRawExport.fixture, closureRawExport.accessPath), 'utf8')) + 'export const COVERAGE_PATH = AUTHORITY_0\n',
  )
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureRawExport.fixture, closureRawExport.declaration),
    /raw executable ownership authority path export forbidden/,
    'a raw authority path export must fail',
  )
} finally {
  await rm(closureRawExport.fixture, { force: true, recursive: true })
}

const closureBypass = await dependencyClosureFixture()
try {
  const bypassPath = 'tools/architecture/direct-authority-bypass.mjs'
  const rawPath = closureBypass.capabilityContract[0].artifact_path
  await writeFile(
    path.join(closureBypass.fixture, bypassPath),
    "import { readFileSync } from 'node:fs'\nreadFileSync(" + JSON.stringify(rawPath) + ')\n',
  )
  await closureBypass.git('add', bypassPath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureBypass.fixture, closureBypass.declaration),
    /forbidden raw executable ownership authority identity: tools\/architecture\/direct-authority-bypass\.mjs/,
    'direct literal authority filesystem access outside the canonical module must fail',
  )
} finally {
  await rm(closureBypass.fixture, { force: true, recursive: true })
}

const closureMalformed = await dependencyClosureFixture()
try {
  delete closureMalformed.declaration.current_live.authority_access.capabilities
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureMalformed.fixture, closureMalformed.declaration),
    /canonical authority access declaration malformed/,
    'a malformed canonical dependency manifest must fail',
  )
} finally {
  await rm(closureMalformed.fixture, { force: true, recursive: true })
}

const closureMissingCapability = await dependencyClosureFixture()
try {
  const missingCapability = closureMissingCapability.capabilityNames[0]
  const accessSource = await readFile(path.join(closureMissingCapability.fixture, closureMissingCapability.accessPath), 'utf8')
  await writeFile(
    path.join(closureMissingCapability.fixture, closureMissingCapability.accessPath),
    accessSource.split('\n').filter((line) => !line.startsWith('export function ' + missingCapability + '(')).join('\n'),
  )
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureMissingCapability.fixture, closureMissingCapability.declaration),
    new RegExp('canonical authority capability export missing: ' + missingCapability),
    'a declared capability missing from the access module must fail',
  )
} finally {
  await rm(closureMissingCapability.fixture, { force: true, recursive: true })
}

const closureCapabilityDrift = await dependencyClosureFixture()
try {
  const consumer = closureCapabilityDrift.consumers[0]
  await writeFile(
    path.join(closureCapabilityDrift.fixture, consumer.path),
    'import { ' + closureCapabilityDrift.capabilityNames.slice(0, 2).join(', ') + ' } from ' + JSON.stringify(closureCapabilityDrift.accessSpecifier) + '\n',
  )
  assert.throws(
    () => validateExecutablePathOwnershipConsumerClosure(closureCapabilityDrift.declaration, closureCapabilityDrift.fixture),
    /consumer capability imports drift: tools\/architecture\/direct-consumer\.mjs/,
    'declared and actual capability sets must match exactly',
  )
} finally {
  await rm(closureCapabilityDrift.fixture, { force: true, recursive: true })
}

async function assertTerminalConsumerExportRejected(name, exportBody) {
  const fixture = await dependencyClosureFixture()
  try {
    const consumerPath = 'tools/architecture/' + name + '.mjs'
    const body = 'import { ' + fixture.capabilityNames[0] + ' as x } from ' + JSON.stringify(fixture.accessSpecifier) + '\n' + exportBody
    await writeFile(path.join(fixture.fixture, consumerPath), body)
    await fixture.git('add', consumerPath)
    assert.throws(
      () => discoverExecutablePathOwnershipConsumers(fixture.fixture, fixture.declaration),
      new RegExp('authority consumer has module export: tools/architecture/' + name + '\\.mjs'),
      name + ' must fail solely because an authority consumer has a module export',
    )
  } finally {
    await rm(fixture.fixture, { force: true, recursive: true })
  }
}

await assertTerminalConsumerExportRejected('reviewer-named-reexport', 'export { x }\n')
await assertTerminalConsumerExportRejected('reviewer-exported-const-alias', 'export const forwardedCoverage = x\n')
await assertTerminalConsumerExportRejected('exported-wrapper', 'export function forwarded() { return x() }\n')
await assertTerminalConsumerExportRejected('default-export', 'export default x\n')
await assertTerminalConsumerExportRejected('exported-object', 'export const forwarded = { load: x }\n')
await assertTerminalConsumerExportRejected('unrelated-export', 'export class HarmlessDiagnostic {}\n')
await assertTerminalConsumerExportRejected('export-star', 'export * from "./non-consumer-diagnostic.mjs"\n')
await assertTerminalConsumerExportRejected('commonjs-module-export', 'module.exports = x\n')
await assertTerminalConsumerExportRejected('commonjs-property-export', 'exports.forwarded = x\n')

async function assertTerminalConsumerInboundRejected(name, inboundBody, edgeKind, grammarFailure = false) {
  const fixture = await dependencyClosureFixture()
  try {
    const inboundPath = 'tools/architecture/' + name + '.mjs'
    await writeFile(path.join(fixture.fixture, inboundPath), inboundBody('./direct-consumer.mjs'))
    await fixture.git('add', inboundPath)
    const failure = grammarFailure
      ? 'acceptance '
      : 'authority terminal consumer has inbound tracked module edge: tools/architecture/direct-consumer\\.mjs<-tools/architecture/' + name + '\\.mjs#' + edgeKind
    assert.throws(
      () => discoverExecutablePathOwnershipConsumers(fixture.fixture, fixture.declaration),
      new RegExp(failure),
      name + ' must fail because a terminal authority consumer has an inbound tracked module edge',
    )
  } finally {
    await rm(fixture.fixture, { force: true, recursive: true })
  }
}

await assertTerminalConsumerInboundRejected('static-inbound', (target) => 'import { anything } from ' + JSON.stringify(target) + '\n', 'static_import')
await assertTerminalConsumerInboundRejected('side-effect-inbound', (target) => 'import ' + JSON.stringify(target) + '\n', 'static_import')
await assertTerminalConsumerInboundRejected('reexport-inbound', (target) => 'export * from ' + JSON.stringify(target) + '\n', 'static_reexport')
await assertTerminalConsumerInboundRejected('dynamic-inbound', (target) => 'await import(' + JSON.stringify(target) + ')\n', 'literal_dynamic_import')
await assertTerminalConsumerInboundRejected('module-require-inbound', (target) => 'module.require(' + JSON.stringify(target) + ')\n', 'literal_require')
await assertTerminalConsumerInboundRejected('query-qualified-inbound', (target) => 'import { anything } from ' + JSON.stringify(target + '?query') + '\n', 'static_import', true)
await assertTerminalConsumerInboundRejected('fragment-qualified-inbound', (target) => 'import { anything } from ' + JSON.stringify(target + '#fragment') + '\n', 'static_import', true)
await assertTerminalConsumerInboundRejected('combined-qualified-inbound', (target) => 'import { anything } from ' + JSON.stringify(target + '?query#fragment') + '\n', 'static_import', true)
await assertTerminalConsumerInboundRejected('side-effect-query-qualified-inbound', (target) => 'import ' + JSON.stringify(target + '?side-effect') + '\n', 'static_import', true)
await assertTerminalConsumerInboundRejected('dynamic-query-qualified-inbound', (target) => 'await import(' + JSON.stringify(target + '?dynamic') + ')\n', 'literal_dynamic_import', true)

assert.equal(sourceGrammarMatrix.length, 25, 'acceptance source-language grammar matrix denominator drift')
assert.equal(sourceGrammarRejected.length, 19, 'acceptance source-language rejection matrix denominator drift')
assert.equal(new Set(sourceGrammarMatrix).size, sourceGrammarMatrix.length, 'acceptance source-language cases must be unique')
assert.deepEqual([...governedEdgeForms].sort(), ['dynamic_import', 'export_from', 'side_effect_import', 'static_import'])
process.stdout.write('terminal-leaf structural adversarial matrix: PASS (22/22)\n')
process.stdout.write('acceptance source-language grammar matrix: PASS (' + sourceGrammarMatrix.length + '/' + sourceGrammarMatrix.length + ')\n')
process.stdout.write('uppercase_FILE_reviewer_counterexample_node_executes=true\n')
process.stdout.write('uppercase_FILE_reviewer_counterexample_rejected=true\n')
process.stdout.write('query_qualified_authority_import_rejected=true\n')
process.stdout.write('fragment_qualified_authority_import_rejected=true\n')
process.stdout.write('combined_qualified_authority_import_rejected=true\n')
process.stdout.write('query_qualified_terminal_inbound_rejected=true\n')
process.stdout.write('fragment_qualified_terminal_inbound_rejected=true\n')
process.stdout.write('reviewer_query_counterexample_node_executes=true\n')
process.stdout.write('reviewer_query_counterexample_rejected=true\n')
process.stdout.write('canonical_acceptance_import_grammar_enforced=true\n')
process.stdout.write('file_url_imports_forbidden=true\n')
process.stdout.write('case_variant_file_url_imports_forbidden=true\n')
process.stdout.write('query_fragment_imports_forbidden=true\n')
process.stdout.write('noncanonical_relative_imports_forbidden=true\n')
process.stdout.write('authority_edges_require_canonical_relative_specifier=true\n')
process.stdout.write('terminal_inbound_edges_require_canonical_relative_specifier=true\n')
process.stdout.write('authority_consumer_zero_exports_enforced=true\n')
process.stdout.write('authority_consumer_zero_inbound_edges_enforced=true\n')
process.stdout.write('terminal_leaf_zero_exports_preserved=true\n')
process.stdout.write('terminal_leaf_zero_inbound_edges_preserved=true\n')
process.stdout.write('reviewer_named_reexport_rejected=true\n')
process.stdout.write('reviewer_exported_const_alias_rejected=true\n')
process.stdout.write('exported_wrapper_rejected_without_dataflow=true\n')
process.stdout.write('harmless_export_from_authority_consumer_rejected=true\n')
process.stdout.write('ordinary_nonconsumer_exports_allowed=true\n')
process.stdout.write('arbitrary_js_dataflow_retired=true\n')
process.stdout.write('node_equivalent_identity_enumeration_retired=true\n')

const closureMissingModule = await dependencyClosureFixture()
try {
  await closureMissingModule.git('rm', '--quiet', closureMissingModule.accessPath)
  assert.throws(
    () => discoverExecutablePathOwnershipConsumers(closureMissingModule.fixture, closureMissingModule.declaration),
    /canonical authority access module missing/,
    'a missing canonical access module must fail',
  )
} finally {
  await rm(closureMissingModule.fixture, { force: true, recursive: true })
}

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

const discoveredCurrentConsumers = discoverExecutablePathOwnershipConsumers(repositoryRoot)
assert.deepEqual(
  discoveredCurrentConsumers.map(({ path: consumerPath }) => consumerPath).sort(),
  currentDependencies.current_live.consumers.map(({ path: consumerPath }) => consumerPath).sort(),
  'the canonical declaration must exactly cover every mechanically discovered current authority consumer',
)
const validatorSource = currentValidatorBytes.toString('utf8')
assert.equal(validatorSource.includes('CURRENT_CONSUMERS'), false, 'the validator must not retain a duplicate authoritative consumer list')
for (const retiredAnalyzerMarker of [
  'makeSemanticSourceAnalyzer', 'semanticProgram', 'getTypeChecker', 'CALLABLE_READER', 'CONSUMER_DISCOVERY_CACHE',
  'importedCapabilityBindings', 'unwrappedIdentifier', 'rejectImportedBindingExport',
]) {
  assert.equal(validatorSource.includes(retiredAnalyzerMarker), false, `retired arbitrary-JavaScript dataflow analyzer remains: ${retiredAnalyzerMarker}`)
}
assert.equal(validatorSource.includes('ts.isImportDeclaration'), true, 'structural direct-import validation missing')
assert.equal(validatorSource.includes('moduleExportKinds'), true, 'generic terminal-consumer zero-export validation missing')
assert.equal(validatorSource.includes('validateAcceptanceSourceLanguage'), true, 'repository-wide source-language validation missing')
assert.equal(validatorSource.includes('trackedModuleSpecifierIdentity'), false, 'retired Node-equivalent module-identity resolver remains')
assert.equal(validatorSource.includes('pathToFileURL'), false, 'retired WHATWG file-URL target resolver remains')
assert.equal(currentDependencies.current_live.consumers.every((consumer) => consumer.terminal_leaf === true), true, 'canonical consumer declaration must mark every consumer as a terminal leaf')
assert.equal(discoveredCurrentConsumers.every((consumer) => consumer.terminal_leaf === true), true, 'mechanically discovered consumers must all satisfy the terminal-leaf contract')
for (const consumer of discoveredCurrentConsumers) {
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
assert.equal(sha256(currentBaselineBytes), REVIEWED_BASELINE_SHA256)
const currentSourceSha256ByPath = new Map(await Promise.all(currentDecisions.assignments.map(async ({ path: relativePath }) => [
  relativePath,
  sha256(await readFile(path.join(repositoryRoot, relativePath))),
])))
const currentMaterializationOptions = {
  baselineCoveragePath: currentCoverage.reviewed_exact_inventory_materialization.baseline_coverage_path,
  baselineCoverageSha256: REVIEWED_BASELINE_SHA256,
  sourceSha256ByPath: currentSourceSha256ByPath,
  decisionRegistryPath: currentCoverage.reviewed_exact_inventory_materialization.decision_registry_path,
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
