#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveReviewedOwnershipExtension } from './reviewed-ownership-amendments.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const validatorRelative = 'tools/architecture/validate-executable-path-ownership.mjs'
const validatorPath = path.join(repositoryRoot, validatorRelative)
const validatorUrl = pathToFileURL(validatorPath).href
const removedAuthorityReaders = [
  'readCurrentOwnershipCoverage',
  'readCurrentOwnershipDependencies',
  'readHistoricalOwnershipBaseline',
  'readReviewedOwnershipDecisions',
]
const formerConsumers = [
  'tools/architecture/__tests__/context-manifests.test.mjs',
  'tools/architecture/generate-context-manifests.mjs',
  'tools/architecture/test-executable-path-ownership.mjs',
  'tools/architecture/v2/independent-critic-final-gate.mjs',
  'tools/architecture/validate-context-manifests.mjs',
]
const pureHelperPaths = [
  'tools/architecture/enrich-context-manifests.mjs',
  'tools/architecture/generate-context-manifests.mjs',
  'tools/architecture/reviewed-ownership-amendments.mjs',
]
async function runNode(args, options = {}) {
  return execFileAsync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

const validatorSource = await readFile(validatorPath, 'utf8')
assert.equal(/^\s*export\s/mu.test(validatorSource), false, 'authority executable must export zero symbols')
assert.equal(
  validatorSource.includes('digest([...decisionChange.previous_paths].sort((left, right) => left.localeCompare(right)))'),
  true,
  'reviewed prior-path evidence must use the live inventory locale ordering',
)
const canonicalNamespace = await import(`${validatorUrl}?authority-export-inventory=${Date.now()}`)
assert.deepEqual(Object.keys(canonicalNamespace), [], 'authority executable module namespace must be empty')
for (const reader of removedAuthorityReaders) {
  assert.equal(Object.hasOwn(canonicalNamespace, reader), false, `raw authority reader remains exported: ${reader}`)
}

for (const relative of formerConsumers) {
  if (relative === 'tools/architecture/test-executable-path-ownership.mjs') continue
  const source = await readFile(path.join(repositoryRoot, relative), 'utf8')
  for (const reader of removedAuthorityReaders) {
    assert.equal(source.includes(reader), false, `former consumer still names raw authority reader: ${relative}#${reader}`)
  }
  assert.equal(source.includes("from './validate-executable-path-ownership.mjs'"), false, `former consumer still imports authority executable: ${relative}`)
  assert.equal(source.includes("from '../validate-executable-path-ownership.mjs'"), false, `former consumer still imports authority executable: ${relative}`)
}

for (const relative of pureHelperPaths) {
  const source = await readFile(path.join(repositoryRoot, relative), 'utf8')
  for (const reader of removedAuthorityReaders) {
    assert.equal(source.includes(reader), false, `pure helper recreates raw authority reader: ${relative}#${reader}`)
  }
}

const validation = await runNode([validatorRelative, '--validate'])
const validationResult = JSON.parse(validation.stdout)
assert.deepEqual({
  schema: validationResult.schema,
  operation: validationResult.operation,
  ok: validationResult.ok,
  singleAuthority: validationResult.single_authority_reader_executable,
  authorityExports: validationResult.authority_capability_exports,
  rawApiRemoved: validationResult.raw_authority_reader_module_api_removed,
  authorityPathsPrivate: validationResult.authority_paths_private_to_orchestrator,
  pureHelpers: validationResult.reusable_helpers_authority_io_free,
  formerConsumersDecoupled: validationResult.historical_consumers_no_longer_import_authority,
  nodeIdentityRetired: validationResult.node_identity_enumeration_retired,
  sourceLanguageRetired: validationResult.source_language_loader_enumeration_retired,
  arbitraryDataflowRetired: validationResult.arbitrary_js_dataflow_retired,
  threatModelExplicit: validationResult.same_trust_source_threat_model_explicit,
  historicalFixture: validationResult.historical_fixture_verified,
  denominator: validationResult.tracked_executable_surfaces,
}, {
  schema: 'yoko.crm.single-authority-process-result.v1',
  operation: 'validate',
  ok: true,
  singleAuthority: true,
  authorityExports: 0,
  rawApiRemoved: true,
  authorityPathsPrivate: true,
  pureHelpers: true,
  formerConsumersDecoupled: true,
  nodeIdentityRetired: true,
  sourceLanguageRetired: true,
  arbitraryDataflowRetired: true,
  threatModelExplicit: true,
  historicalFixture: true,
  denominator: 2429,
})

const attackRoot = await mkdtemp(path.join(os.tmpdir(), 'yoko-authority-api-removal-'))
try {
  const reexportAttack = path.join(attackRoot, 'esm-reexport.mjs')
  await writeFile(reexportAttack, `export { readCurrentOwnershipCoverage } from ${JSON.stringify(validatorUrl)}\n`)
  await assert.rejects(
    () => runNode([reexportAttack]),
    (error) => error.code !== 0 && /does not provide an export named ['"]readCurrentOwnershipCoverage['"]/u.test(error.stderr),
    'ESM re-export attack must fail because the capability does not exist',
  )

  const exportedConstAttack = path.join(attackRoot, 'exported-const.mjs')
  await writeFile(exportedConstAttack, [
    `import * as authority from ${JSON.stringify(validatorUrl)}`,
    'export const exposed = authority.readCurrentOwnershipCoverage',
    'if (exposed !== undefined) process.exit(1)',
    '',
  ].join('\n'))
  await runNode([exportedConstAttack])

  const queryNamespace = await import(`${validatorUrl}?authority-bypass`)
  assert.deepEqual(Object.keys(queryNamespace), [], 'query-qualified import exposed authority capability')

  const uppercaseFileNamespace = await import(`FILE:${validatorUrl.slice('file:'.length)}`)
  assert.deepEqual(Object.keys(uppercaseFileNamespace), [], 'uppercase FILE import exposed authority capability')

  const commonJsAttack = path.join(attackRoot, 'aliased-create-require.cjs')
  await writeFile(commonJsAttack, [
    "const { createRequire: factory } = require('node:module')",
    'const load = factory(__filename)',
    'let authority = null',
    `try { authority = load(${JSON.stringify(validatorPath)}) } catch (error) { if (error.code !== 'ERR_REQUIRE_ESM') throw error }`,
    "const capability = authority && typeof authority.readCurrentOwnershipCoverage === 'function'",
    'if (capability) process.exit(1)',
    "process.stdout.write(JSON.stringify({ capability: false }))",
    '',
  ].join('\n'))
  const commonJs = await runNode([commonJsAttack])
  assert.deepEqual(JSON.parse(commonJs.stdout), { capability: false })
} finally {
  await rm(attackRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Additive reviewed ownership amendments.
//
// A dated internal review is historical evidence and can never be rewritten to
// claim it examined a surface added afterwards. These probes pin the properties
// that make an append-only amendment safe: it extends an exact predecessor, it
// carries its own truthful review identity, and it can move nothing except the
// denominator, an exact source fingerprint, and the record that a tracked
// surface is deliberately unassigned.
// ---------------------------------------------------------------------------
const HISTORICAL_REVIEWER = 'INTERNAL_EXECUTOR_REVIEW_20260813'
const HISTORICAL_ROLE = 'SOL_HIGH_INTERNAL_REVIEW'
const REGISTRY_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_REVIEW_20260813.json'
const hash = (seed) => seed.repeat(64).slice(0, 64)
const REGISTRY_DIGEST = hash('a1')
const amendmentContext = {
  decisionRegistryPath: REGISTRY_PATH,
  decisionRegistrySha256: REGISTRY_DIGEST,
  historicalReviewer: HISTORICAL_REVIEWER,
  historicalReviewRole: HISTORICAL_ROLE,
}
const historicalDecisions = {
  current: { tracked_executable_surfaces: 100, tracked_inventory_sha256: hash('b2'), coverage_sha256: hash('c3') },
}
const rationale = 'Explicit internal decision text that is long enough to satisfy the reviewed rationale minimum length.'
const amendedCurrent = { tracked_executable_surfaces: 101, tracked_inventory_sha256: hash('d4'), coverage_sha256: hash('e5') }
const baseAmendment = () => ({
  amendment_id: 'probe-amendment',
  reviewed_at: '2026-09-09T00:00:00Z',
  reviewed_by: 'OWNER_AUTHORIZED_OWNERSHIP_REVIEW_20260909',
  role: 'PRODUCT_OWNER_AUTHORIZED_REVIEW',
  authorization: 'PRODUCT_OWNER_AUTHORIZED_EXECUTABLE_OWNERSHIP_REVIEW_EXTENSION',
  reason: rationale,
  predecessor: { ...historicalDecisions.current },
  current: { ...amendedCurrent },
  unassigned_tracked_surfaces: [{ path: 'a/route.test.ts', lifecycle: 'TEST', review_decision: 'APPROVED_NO_EXPLICIT_OWNERSHIP_ASSIGNMENT', review_rationale: rationale }],
  source_hash_rebinds: [{ path: 'a/route.ts', previous_source_sha256: hash('f6'), current_source_sha256: hash('07'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale }],
})
const chainOf = (amendment) => ({
  schema: 'yoko.crm.reviewed-executable-path-ownership-amendments.v1',
  version: 1,
  base: { decision_registry_path: REGISTRY_PATH, decision_registry_sha256: REGISTRY_DIGEST },
  amendments: [amendment],
})
const resolveProbe = (chain) => resolveReviewedOwnershipExtension(historicalDecisions, chain, amendmentContext)
const rejects = (chain, expected, label) => assert.throws(() => resolveProbe(chain), expected, label)
const amendmentProbes = {}

// 1. The historical review stands alone and is unchanged when no amendment exists.
const unextended = resolveProbe(null)
assert.deepEqual(unextended.current, historicalDecisions.current, 'absent amendment must resolve to the untouched historical denominator')
assert.equal(unextended.amendments, 0)
amendmentProbes.historical_predecessor_immutable = 'PRESERVED'

// 2. A valid successor amendment moves the denominator forward.
const extended = resolveProbe(chainOf(baseAmendment()))
assert.deepEqual(extended.current, amendedCurrent, 'valid amendment must advance the reviewed denominator')
assert.equal(extended.amendments, 1)
amendmentProbes.successor_advances_denominator = 'ACCEPTED'

// 3. A newly tracked TEST surface stays unassigned and carries no exclusion.
assert.equal(extended.unassigned.get('a/route.test.ts')?.lifecycle, 'TEST')
assert.equal(extended.unassigned.get('a/route.test.ts')?.exclusion, undefined)
amendmentProbes.unassigned_test_surface_without_exclusion = 'ACCEPTED'

// 4/12. A fingerprint rebind is exposed only for the exact reviewed predecessor bytes.
assert.equal(extended.rebinds.get('a/route.ts')?.previous_source_sha256, hash('f6'))
assert.equal(extended.rebinds.get('a/route.ts')?.current_source_sha256, hash('07'))
amendmentProbes.rebind_requires_exact_previous_fingerprint = 'ENFORCED'

// 5/6/7/8/14. An amendment may not carry reviewed ownership semantics at all.
for (const forbidden of ['assignments', 'exact_inventory_changes', 'governed_exclusions', 'lifecycle_changes', 'functional_owner_changes']) {
  rejects(chainOf({ ...baseAmendment(), [forbidden]: [{ path: 'a/route.ts' }] }), /may not carry reviewed ownership semantics/u, `amendment must not carry ${forbidden}`)
}
rejects(
  chainOf({ ...baseAmendment(), unassigned_tracked_surfaces: [{ path: 'a/x.ts', lifecycle: 'TEST', functional_owner: 'legacy_gravity_runtime', exclusion: 'gravity_runtime_remainder', review_decision: 'APPROVED_NO_EXPLICIT_OWNERSHIP_ASSIGNMENT', review_rationale: rationale }] }),
  /may not carry an ownership assignment/u,
  'amendment must not smuggle an assignment through an unassigned surface',
)
amendmentProbes.cannot_change_owner_lifecycle_exclusion_or_rationale = 'REJECTED'

// 9. A fabricated predecessor digest fails closed.
rejects(
  { ...chainOf(baseAmendment()), base: { decision_registry_path: REGISTRY_PATH, decision_registry_sha256: hash('99') } },
  /do not pin the exact immutable historical review bytes/u,
  'fabricated predecessor digest must fail',
)
amendmentProbes.fabricated_predecessor_digest = 'REJECTED'

// 10. A stale predecessor triple fails closed.
rejects(
  chainOf({ ...baseAmendment(), predecessor: { ...historicalDecisions.current, tracked_executable_surfaces: 99 } }),
  /does not extend its exact predecessor/u,
  'stale predecessor denominator must fail',
)
amendmentProbes.stale_predecessor_triple = 'REJECTED'

// 11. Restating the historical reviewer or role fails closed.
rejects(chainOf({ ...baseAmendment(), reviewed_by: HISTORICAL_REVIEWER }), /may not restate the historical reviewer/u, 'historical reviewer restatement must fail')
rejects(chainOf({ ...baseAmendment(), role: HISTORICAL_ROLE }), /may not restate the historical review role/u, 'historical role restatement must fail')
amendmentProbes.historical_reviewer_restatement = 'REJECTED'

// 15. An amendment that does not actually move the denominator is refused, so
// the mechanism cannot be used as a silent bypass of ownership coverage.
rejects(
  chainOf({ ...baseAmendment(), current: { ...historicalDecisions.current } }),
  /does not move the reviewed denominator/u,
  'amendment must not be usable as a no-op coverage bypass',
)
rejects(chainOf({ ...baseAmendment(), reason: 'too short' }), /lacks an explicit reason/u, 'amendment must carry an explicit reason')
rejects({ ...chainOf(baseAmendment()), amendments: [] }, /amendment chain is empty/u, 'empty amendment chain must fail')
amendmentProbes.cannot_bypass_ownership_coverage = 'REJECTED'

assert.equal(validatorSource.includes('directRequireLoaderNames'), false)
assert.equal(validatorSource.includes('trackedModuleSpecifierIdentity'), false)
assert.equal(validatorSource.includes('validateAcceptanceSourceLanguage'), false)
assert.equal(validatorSource.includes('discoverExecutablePathOwnershipConsumers'), false)
assert.equal(validatorSource.includes('createRequire'), false)
assert.equal(validatorSource.includes('pathToFileURL'), false)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  authority_capability_exports: 0,
  former_consumers: formerConsumers.length,
  reusable_helpers_authority_io_free: pureHelperPaths.length,
  historical_fixture_verified: true,
  denominator: validationResult.tracked_executable_surfaces,
  attacks: {
    esm_reexport: 'CAPABILITY_ABSENT',
    exported_const: 'CAPABILITY_ABSENT',
    query_qualified_import: 'CAPABILITY_ABSENT',
    uppercase_file_import: 'CAPABILITY_ABSENT',
    aliased_commonjs_create_require: 'CAPABILITY_ABSENT',
  },
  reviewed_ownership_amendments: amendmentProbes,
})}\n`)
