#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AMENDMENT_COMPOSITION_DECISION,
  AMENDMENT_MERGE_COMPOSITION_KIND,
  COMPOSITION_ANCHOR_AUTHORITY,
  COMPOSITION_MERGED_AUTHORITY,
  resolveReviewedOwnershipExtension,
} from './reviewed-ownership-amendments.mjs'

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
  denominator: 2441,
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
const PROBE_ANCHOR_COMMIT = `${'0'.repeat(39)}1`
const PROBE_MERGED_COMMIT = `${'0'.repeat(39)}2`
const PROBE_AMENDMENTS_PATH = 'architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_REVIEW_AMENDMENTS.json'
// Linear amendments resolve with no trusted anchors, which is the ordinary case
// for a repository whose reviewed denominator was never an upstream authority.
// The composition probes below supply anchors explicitly.
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

// 4/12. A fingerprint rebind carries both exact fingerprints and an explicit
// decision, and it must actually move the bytes. Binding the previous
// fingerprint to the reviewed assignment it extends is the validator's job, not
// this pure resolver's, and the passing --validate run above exercises it; the
// label below therefore claims only what these probes prove.
assert.equal(extended.rebinds.get('a/route.ts')?.previous_source_sha256, hash('f6'))
assert.equal(extended.rebinds.get('a/route.ts')?.current_source_sha256, hash('07'))
const rebindOf = (overrides) => chainOf({
  ...baseAmendment(),
  source_hash_rebinds: [{ path: 'a/route.ts', previous_source_sha256: hash('f6'), current_source_sha256: hash('07'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale, ...overrides }],
})
rejects(rebindOf({ previous_source_sha256: undefined }), /rebind invalid/u, 'a rebind must carry the exact previous fingerprint')
rejects(rebindOf({ current_source_sha256: undefined }), /rebind invalid/u, 'a rebind must carry the exact current fingerprint')
rejects(rebindOf({ previous_source_sha256: 'not-a-digest' }), /rebind invalid/u, 'a malformed previous fingerprint must fail')
rejects(rebindOf({ current_source_sha256: hash('f6') }), /rebind invalid/u, 'a rebind that does not move the bytes must fail')
rejects(rebindOf({ path: '' }), /rebind invalid/u, 'a rebind must name its path')
rejects(rebindOf({ review_decision: 'APPROVED_CURRENT_ASSIGNMENT' }), /rebind lacks an explicit decision/u, 'a rebind must carry its own decision constant')
rejects(rebindOf({ review_rationale: 'too short' }), /rebind lacks an explicit decision/u, 'a rebind must carry an explicit rationale')
rejects(
  chainOf({
    ...baseAmendment(),
    source_hash_rebinds: [
      { path: 'a/route.ts', previous_source_sha256: hash('f6'), current_source_sha256: hash('07'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale },
      { path: 'a/route.ts', previous_source_sha256: hash('11'), current_source_sha256: hash('22'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale },
    ],
  }),
  /duplicate reviewed executable ownership amendment rebind/u,
  'one path may not be rebound twice',
)
amendmentProbes.rebind_carries_exact_moving_fingerprints_and_a_decision = 'ENFORCED'

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

// ---------------------------------------------------------------------------
// Accepted-authority merge composition.
//
// Integrating one accepted ownership authority into another is not a
// per-surface review. These probes pin that a composition must name both
// accepted inputs, bind the upstream input to the chain anchor, carry the
// merged input's already accepted amendment verbatim, state its exact
// arithmetic in both directions, and declare in machine-checked form that it
// performs no primary per-surface review.
// ---------------------------------------------------------------------------
const compositionProbes = {}
const upstreamCurrent = { ...historicalDecisions.current }
const mergedAuthorityCurrent = { tracked_executable_surfaces: 140, tracked_inventory_sha256: hash('a8'), coverage_sha256: hash('b9') }
const compositionCurrent = { tracked_executable_surfaces: 152, tracked_inventory_sha256: hash('ca'), coverage_sha256: hash('db') }
const acceptedAmendment = () => ({
  amendment_id: 'probe-accepted-amendment',
  reviewed_at: '2026-09-09T00:00:00Z',
  reviewed_by: 'OWNER_AUTHORIZED_OWNERSHIP_REVIEW_20260909',
  role: 'PRODUCT_OWNER_AUTHORIZED_REVIEW',
  authorization: 'PRODUCT_OWNER_AUTHORIZED_EXECUTABLE_OWNERSHIP_REVIEW_EXTENSION',
  reason: rationale,
  predecessor: { tracked_executable_surfaces: 138, tracked_inventory_sha256: hash('ec'), coverage_sha256: hash('fd') },
  current: { ...mergedAuthorityCurrent },
  unassigned_tracked_surfaces: [{ path: 'identity/route.test.ts', lifecycle: 'TEST', review_decision: 'APPROVED_NO_EXPLICIT_OWNERSHIP_ASSIGNMENT', review_rationale: rationale }],
  source_hash_rebinds: [{ path: 'identity/route.ts', previous_source_sha256: hash('1e'), current_source_sha256: hash('2f'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale }],
})
const upstreamInput = () => ({
  authority: COMPOSITION_ANCHOR_AUTHORITY,
  commit: PROBE_ANCHOR_COMMIT,
  accepted_evidence_path: REGISTRY_PATH,
  accepted_evidence_sha256: hash('3a'),
  current: { ...upstreamCurrent },
})
const mergedInput = () => ({
  authority: COMPOSITION_MERGED_AUTHORITY,
  commit: PROBE_MERGED_COMMIT,
  accepted_evidence_path: PROBE_AMENDMENTS_PATH,
  accepted_evidence_sha256: hash('4b'),
  current: { ...mergedAuthorityCurrent },
  accepted_amendment: acceptedAmendment(),
})
const canonical = (value) => (Array.isArray(value)
  ? value.map(canonical)
  : (!value || typeof value !== 'object' ? value : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))))
const carriedDigest = createHash('sha256').update(JSON.stringify(canonical(acceptedAmendment()))).digest('hex')
const compositionAnchors = () => new Map([
  ['UPSTREAM_MAIN', {
    commit: PROBE_ANCHOR_COMMIT,
    accepted_evidence_path: REGISTRY_PATH,
    accepted_evidence_sha256: hash('3a'),
    current: { ...upstreamCurrent },
  }],
  ['IDENTITY_CANDIDATE', {
    commit: PROBE_MERGED_COMMIT,
    accepted_evidence_path: PROBE_AMENDMENTS_PATH,
    accepted_evidence_sha256: hash('4b'),
    carried_amendment_sha256: carriedDigest,
    current: { ...mergedAuthorityCurrent },
  }],
])
const compositionContext = (anchors = compositionAnchors()) => ({ ...amendmentContext, acceptedAuthorityAnchors: anchors })
const resolveComposed = (chain, anchors) => resolveReviewedOwnershipExtension(historicalDecisions, chain, compositionContext(anchors))
const rejectsComposed = (chain, expected, label, anchors) => assert.throws(() => resolveComposed(chain, anchors), expected, label)
const composition = (overrides = {}) => ({
  amendment_id: 'probe-composition',
  amendment_kind: AMENDMENT_MERGE_COMPOSITION_KIND,
  reviewed_at: '2026-09-10T00:00:00Z',
  reviewed_by: 'OWNER_AUTHORIZED_OWNERSHIP_REVIEW_20260910',
  role: 'PRODUCT_OWNER_AUTHORIZED_REVIEW',
  authorization: 'PRODUCT_OWNER_AUTHORIZED_MAIN_INTEGRATION_OWNERSHIP_AUTHORITY_COMPOSITION',
  reason: rationale,
  predecessor: { ...upstreamCurrent },
  current: { ...compositionCurrent },
  authority_composition: {
    review_decision: AMENDMENT_COMPOSITION_DECISION,
    claims_primary_surface_review: false,
    composition_scope: rationale,
    accepted_authority_inputs: [upstreamInput(), mergedInput()],
    merge_delta: {
      net_surfaces_relative_to_identity_current: 12,
      net_surfaces_relative_to_upstream_main_current: 52,
      surface_movement: {
        relative_to_identity_current: { added: 12, retired: 0 },
        relative_to_upstream_main_current: { added: 53, retired: 1 },
      },
    },
    ...overrides,
  },
  source_hash_rebinds: [{ path: 'upstream/route.ts', previous_source_sha256: hash('5c'), current_source_sha256: hash('6d'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale }],
})

// 16. A valid composition advances the denominator and carries BOTH accepted
// authorities' decisions forward instead of restating either of them.
const composed = resolveComposed(chainOf(composition()))
assert.deepEqual(composed.current, compositionCurrent, 'valid composition must resolve to the merged denominator')
assert.equal(composed.compositions, 1)
assert.equal(composed.rebinds.get('identity/route.ts')?.current_source_sha256, hash('2f'), 'merged authority rebind must survive composition')
assert.equal(composed.rebinds.get('upstream/route.ts')?.current_source_sha256, hash('6d'), 'composition rebind must be applied')
assert.equal(composed.unassigned.get('identity/route.test.ts')?.lifecycle, 'TEST', 'merged authority unassigned surface must survive composition')
compositionProbes.both_accepted_authorities_survive = 'PRESERVED'

// 17. A composition may never present itself as a primary per-surface review.
for (const claim of [true, undefined, 'false']) {
  rejectsComposed(
    chainOf(composition({ claims_primary_surface_review: claim })),
    /must state that it performs no primary per-surface review/u,
    'composition must not claim a primary per-surface review',
  )
}
rejectsComposed(chainOf(composition({ review_decision: 'APPROVED_CURRENT_ASSIGNMENT' })), /lacks its explicit decision/u, 'composition must carry its explicit decision')
rejectsComposed(chainOf(composition({ composition_scope: 'too short' })), /lacks an explicit scope statement/u, 'composition must carry an explicit scope statement')
compositionProbes.cannot_claim_primary_surface_review = 'REJECTED'

// 18. Dropping either accepted authority input fails closed.
rejectsComposed(chainOf(composition({ accepted_authority_inputs: [upstreamInput()] })), /requires exactly two accepted authority inputs/u, 'dropping the merged authority must fail')
rejectsComposed(chainOf(composition({ accepted_authority_inputs: [mergedInput()] })), /requires exactly two accepted authority inputs/u, 'dropping the upstream authority must fail')
rejectsComposed(chainOf(composition({ accepted_authority_inputs: [upstreamInput(), upstreamInput()] })), /duplicate accepted authority input/u, 'restating one authority twice must fail')
rejectsComposed(chainOf(composition({ accepted_authority_inputs: [] })), /requires exactly two accepted authority inputs/u, 'an empty authority input set must fail')
compositionProbes.neither_authority_can_be_dropped = 'REJECTED'

// 19. Editing either accepted authority invalidates the composition proof.
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [{ ...upstreamInput(), current: { ...upstreamCurrent, tracked_executable_surfaces: 99 } }, mergedInput()] })),
  /denominator does not match the trusted anchor/u,
  'editing the upstream authority denominator must fail',
)
// The chain-anchor binding still guards independently: a trusted anchor whose
// own triple disagrees with the historical registry cannot authorise a
// composition, so a compromised anchor cannot detach the chain from history.
rejectsComposed(
  chainOf(composition()),
  /denominator does not match the trusted anchor|does not bind the upstream authority to its exact predecessor/u,
  'an anchor that disagrees with the historical registry must not authorise a composition',
  new Map([
    ['UPSTREAM_MAIN', { ...compositionAnchors().get('UPSTREAM_MAIN'), current: { ...upstreamCurrent, tracked_executable_surfaces: 99 } }],
    ['IDENTITY_CANDIDATE', compositionAnchors().get('IDENTITY_CANDIDATE')],
  ]),
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), current: { ...mergedAuthorityCurrent, coverage_sha256: hash('99') } }] })),
  /denominator does not match the trusted anchor/u,
  'editing the merged authority denominator must fail',
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: { ...acceptedAmendment(), current: { ...mergedAuthorityCurrent, tracked_inventory_sha256: hash('99') } } }] })),
  /does not produce the declared merged authority denominator/u,
  'editing the carried accepted amendment must fail',
)
for (const field of ['commit', 'accepted_evidence_sha256']) {
  rejectsComposed(
    chainOf(composition({ accepted_authority_inputs: [{ ...upstreamInput(), [field]: undefined }, mergedInput()] })),
    /lacks its exact commit|lacks its accepted evidence digest/u,
    `composition must pin the upstream ${field}`,
  )
}
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: undefined }] })),
  /lacks its accepted amendment evidence/u,
  'the merged authority must carry its accepted amendment',
)
compositionProbes.both_authority_inputs_are_bound = 'ENFORCED'

// 19b. An input may never attest to itself. A COHERENT rewrite, one that moves
// the merged authority triple, its carried amendment and the declared delta
// together so the document stays internally consistent, is the attack the
// single-field probes above cannot see. It must fail against the trusted anchor.
const restatedMergedCurrent = { tracked_executable_surfaces: 130, tracked_inventory_sha256: hash('e1'), coverage_sha256: hash('f2') }
rejectsComposed(
  chainOf(composition({
    accepted_authority_inputs: [
      upstreamInput(),
      { ...mergedInput(), current: { ...restatedMergedCurrent }, accepted_amendment: { ...acceptedAmendment(), current: { ...restatedMergedCurrent } } },
    ],
    merge_delta: {
      net_surfaces_relative_to_identity_current: 22,
      net_surfaces_relative_to_upstream_main_current: 52,
      surface_movement: {
        relative_to_identity_current: { added: 22, retired: 0 },
        relative_to_upstream_main_current: { added: 53, retired: 1 },
      },
    },
  })),
  /denominator does not match the trusted anchor/u,
  'a self-consistent rewrite of the merged authority must fail against the trusted anchor',
)
// The same attack aimed at the upstream authority, moved coherently with the
// chain anchor it would otherwise satisfy.
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [{ ...upstreamInput(), accepted_evidence_sha256: hash('aa') }, mergedInput()] })),
  /evidence digest does not match the trusted anchor/u,
  'a restated upstream evidence digest must fail against the trusted anchor',
)
// Forged provenance: well-formed but wrong commit, evidence path or authority.
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [{ ...upstreamInput(), commit: 'd'.repeat(40) }, mergedInput()] })),
  /commit does not match the trusted anchor/u,
  'a well-formed but wrong upstream commit must fail',
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), commit: 'd'.repeat(40) }] })),
  /commit does not match the trusted anchor/u,
  'a well-formed but wrong merged commit must fail',
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_evidence_path: 'architecture/does/not/exist.json' }] })),
  /evidence path does not match the trusted anchor/u,
  'a substituted evidence path must fail',
)
// Without trusted anchors from reviewed source there is nothing to check
// against, so the composition must refuse to resolve at all.
assert.throws(
  () => resolveReviewedOwnershipExtension(historicalDecisions, chainOf(composition()), { ...amendmentContext, acceptedAuthorityAnchors: undefined }),
  /requires trusted authority anchors from reviewed source/u,
  'a composition must not resolve without trusted anchors',
)
assert.throws(
  () => resolveReviewedOwnershipExtension(historicalDecisions, chainOf(composition()), { ...amendmentContext, acceptedAuthorityAnchors: new Map() }),
  /requires trusted authority anchors from reviewed source/u,
  'an empty trusted anchor set must not authorise a composition',
)
assert.throws(
  () => resolveReviewedOwnershipExtension(historicalDecisions, chainOf(composition()), {
    ...amendmentContext,
    acceptedAuthorityAnchors: new Map([['UPSTREAM_MAIN', compositionAnchors().get('UPSTREAM_MAIN')]]),
  }),
  /is not a trusted composition authority/u,
  'composing an authority the repository does not trust must fail',
)
compositionProbes.inputs_cannot_attest_to_themselves = 'ENFORCED'

// 20. The declared merge arithmetic must be exact in both directions, so
// neither input's contribution can be silently reattributed to the other.
const movement = () => ({
  relative_to_identity_current: { added: 12, retired: 0 },
  relative_to_upstream_main_current: { added: 53, retired: 1 },
})
rejectsComposed(
  chainOf(composition({ merge_delta: { net_surfaces_relative_to_identity_current: 11, net_surfaces_relative_to_upstream_main_current: 52, surface_movement: movement() } })),
  /upstream delta is not the exact merged arithmetic/u,
  'a false upstream delta must fail',
)
rejectsComposed(
  chainOf(composition({ merge_delta: { net_surfaces_relative_to_identity_current: 12, net_surfaces_relative_to_upstream_main_current: 137, surface_movement: movement() } })),
  /identity delta is not the exact merged arithmetic/u,
  'a false identity delta must fail',
)
rejectsComposed(chainOf(composition({ merge_delta: undefined })), /lacks its declared delta/u, 'composition must declare its delta')
// Each direction is NET denominator movement, so it must be accounted for by an
// explicit addition and retirement count that reconciles to it. The resolver
// cannot know the true split without both trees; what it enforces is that a net
// figure is never published without an accounting that reconciles to it.
rejectsComposed(
  chainOf(composition({
    merge_delta: {
      net_surfaces_relative_to_identity_current: 12,
      net_surfaces_relative_to_upstream_main_current: 52,
      surface_movement: { relative_to_identity_current: { added: 12, retired: 0 }, relative_to_upstream_main_current: { added: 52, retired: 1 } },
    },
  })),
  /surface movement does not account for its net denominator difference/u,
  'movement accounting that does not reconcile to the net difference must fail',
)
rejectsComposed(
  chainOf(composition({ merge_delta: { net_surfaces_relative_to_identity_current: 12, net_surfaces_relative_to_upstream_main_current: 52 } })),
  /lacks its surface movement accounting/u,
  'a net figure must never be published without its movement accounting',
)
compositionProbes.merge_delta_is_exact_arithmetic = 'ENFORCED'
compositionProbes.net_movement_reconciles_to_declared_accounting = 'ENFORCED'

// 21. A carried accepted amendment is still an amendment: it cannot nest another
// composition and it cannot restate the historical reviewer.
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: { ...acceptedAmendment(), amendment_kind: AMENDMENT_MERGE_COMPOSITION_KIND } }] })),
  /may not itself be a merge composition/u,
  'a carried accepted amendment must not nest a composition',
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: { ...acceptedAmendment(), reviewed_by: HISTORICAL_REVIEWER } }] })),
  /may not restate the historical reviewer/u,
  'a carried accepted amendment must not restate the historical reviewer',
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: { ...acceptedAmendment(), assignments: [{ path: 'a/route.ts' }] } }] })),
  /may not carry reviewed ownership semantics/u,
  'a carried accepted amendment must not carry reviewed ownership semantics',
)
rejectsComposed(
  chainOf(composition({ accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: { ...acceptedAmendment(), amendment_id: 'probe-composition' } }] })),
  /duplicate reviewed executable ownership amendment/u,
  'a carried accepted amendment must not reuse the composition identity',
)
compositionProbes.carried_amendment_keeps_amendment_rules = 'ENFORCED'

// 22. Ordinary linear amendments stay valid where no upstream authority is
// anchored, may never declare authority inputs, and an unrecognised kind fails
// closed. These run without anchors, which is the ordinary repository case.
const stillLinear = resolveProbe(chainOf(baseAmendment()))
assert.equal(stillLinear.compositions, 0, 'a linear amendment must not register as a composition')
rejects(
  chainOf({ ...baseAmendment(), authority_composition: composition().authority_composition }),
  /only an accepted authority merge composition may declare authority inputs/u,
  'a linear amendment must not declare authority inputs',
)
rejects(chainOf({ ...baseAmendment(), amendment_kind: 'SOMETHING_ELSE' }), /amendment kind is not recognised/u, 'an unrecognised amendment kind must fail')
rejectsComposed(chainOf({ ...composition(), authority_composition: undefined }), /accepted authority merge composition is missing/u, 'a composition without its authority block must fail')
compositionProbes.linear_amendments_unchanged = 'PRESERVED'

// 23. Declaring a composition may not be optional. When the chain anchor is a
// trusted upstream authority, the same denominator movement may not be
// re-presented as an undeclared linear extension that carries no authority
// inputs and is therefore anchored to nothing.
const downgraded = () => {
  const source = composition()
  const carried = source.authority_composition.accepted_authority_inputs
    .find((input) => input.authority === COMPOSITION_MERGED_AUTHORITY).accepted_amendment
  return {
    amendment_id: source.amendment_id,
    reviewed_at: source.reviewed_at,
    reviewed_by: source.reviewed_by,
    role: source.role,
    authorization: source.authorization,
    reason: source.reason,
    predecessor: { ...source.predecessor },
    current: { ...source.current },
    unassigned_tracked_surfaces: carried.unassigned_tracked_surfaces,
    source_hash_rebinds: [...carried.source_hash_rebinds, ...source.source_hash_rebinds],
  }
}
// Without anchors it is an ordinary linear amendment and resolves, which is the
// behaviour every non-composing repository depends on.
assert.equal(resolveProbe(chainOf(downgraded())).compositions, 0, 'an unanchored chain still resolves linearly')
// With the upstream authority anchored it is a composition in all but name, and
// must be refused rather than silently losing its authority declaration.
rejectsComposed(
  chainOf(downgraded()),
  /must be declared a merge composition/u,
  'a composition may not be downgraded to an undeclared linear amendment',
)
compositionProbes.composition_declaration_is_not_optional = 'ENFORCED'

// 24. The carried accepted amendment is itself anchored, so its reviewer, date,
// authorization, rationales and findings cannot be rewritten while the triples
// are left intact.
for (const forged of [
  { reviewed_by: 'FORGED_REVIEWER_20260910' },
  { reviewed_at: '2020-01-01T00:00:00Z' },
  { authorization: 'FORGED_AUTHORIZATION' },
  { reason: `${rationale} Forged narrative appended to the carried evidence.` },
]) {
  rejectsComposed(
    chainOf(composition({
      accepted_authority_inputs: [upstreamInput(), { ...mergedInput(), accepted_amendment: { ...acceptedAmendment(), ...forged } }],
    })),
    /does not match the trusted anchor digest/u,
    `carried evidence may not be rewritten: ${Object.keys(forged)[0]}`,
  )
}
rejectsComposed(
  chainOf(composition({
    accepted_authority_inputs: [upstreamInput(), {
      ...mergedInput(),
      accepted_amendment: {
        ...acceptedAmendment(),
        source_hash_rebinds: [
          ...acceptedAmendment().source_hash_rebinds,
          { path: 'identity/smuggled.ts', previous_source_sha256: hash('c1'), current_source_sha256: hash('c2'), review_decision: 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND', review_rationale: rationale },
        ],
      },
    }],
  })),
  /does not match the trusted anchor digest/u,
  'a rebind may not be smuggled into the carried evidence',
)
rejectsComposed(
  chainOf(composition()),
  /trusted anchor lacks the carried amendment digest/u,
  'an anchor without a carried evidence digest may not authorise a composition',
  new Map([
    ['UPSTREAM_MAIN', compositionAnchors().get('UPSTREAM_MAIN')],
    ['IDENTITY_CANDIDATE', { ...compositionAnchors().get('IDENTITY_CANDIDATE'), carried_amendment_sha256: undefined }],
  ]),
)
compositionProbes.carried_evidence_is_anchored = 'ENFORCED'

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
  accepted_authority_merge_composition: compositionProbes,
})}\n`)
