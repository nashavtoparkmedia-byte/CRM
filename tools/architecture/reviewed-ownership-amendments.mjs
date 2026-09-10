// Pure, IO-free resolution of additive reviewed executable ownership
// amendments.
//
// A dated internal ownership review is historical evidence: it records what a
// named reviewer actually examined on a given date. It can never be rewritten
// to claim that reviewer also examined a surface added afterwards. When the
// tracked executable denominator legitimately moves, an append-only amendment
// records the movement under its own current review identity while pinning the
// exact immutable predecessor it extends.
//
// An amendment may only:
//   - move the current denominator triple forward from an exact predecessor,
//   - rebind an already reviewed source fingerprint whose semantic ownership
//     fields are unchanged,
//   - record a tracked surface that receives no explicit ownership assignment.
//
// An amendment can never create, alter or remove an ownership assignment, a
// lifecycle, a functional owner, a governed exclusion, an exact-inventory
// transition or a reviewed rationale. Those remain the exclusive product of the
// historical reviewed decisions.
//
// MERGE COMPOSITION
//
// Integrating one accepted authority line into another is not a per-surface
// review event and must never be recorded as one. When two already accepted
// ownership authorities are composed, the linear predecessor model cannot
// describe the result without attributing the whole arithmetic difference to a
// single reviewer who never examined it. A composition amendment therefore
// declares both accepted inputs explicitly, carries the superseded accepted
// amendment of the non-anchor input verbatim as its evidence, and states in
// machine-checked form that it performs no primary per-surface review. The
// upstream input is bound to the chain anchor by exact triple, so neither input
// can be dropped, swapped or edited without failing closed.

export const REVIEWED_AMENDMENTS_SCHEMA = 'yoko.crm.reviewed-executable-path-ownership-amendments.v1'
export const AMENDMENT_REBIND_DECISION = 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND'
export const AMENDMENT_UNASSIGNED_DECISION = 'APPROVED_NO_EXPLICIT_OWNERSHIP_ASSIGNMENT'
export const AMENDMENT_MERGE_COMPOSITION_KIND = 'ACCEPTED_AUTHORITY_MERGE_COMPOSITION'
export const AMENDMENT_COMPOSITION_DECISION = 'APPROVED_ACCEPTED_AUTHORITY_MERGE_COMPOSITION'
export const COMPOSITION_ANCHOR_AUTHORITY = 'UPSTREAM_MAIN'
export const COMPOSITION_MERGED_AUTHORITY = 'IDENTITY_CANDIDATE'

const SHA256 = /^[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const assert = (value, message) => { if (!value) throw new Error(message) }

const isExactTriple = (triple) => Number.isInteger(triple?.tracked_executable_surfaces)
  && triple.tracked_executable_surfaces > 0
  && SHA256.test(triple?.tracked_inventory_sha256 ?? '')
  && SHA256.test(triple?.coverage_sha256 ?? '')

const sameTriple = (left, right) => left?.tracked_executable_surfaces === right?.tracked_executable_surfaces
  && left?.tracked_inventory_sha256 === right?.tracked_inventory_sha256
  && left?.coverage_sha256 === right?.coverage_sha256

// The historical review is the only source of reviewed ownership semantics, so
// an amendment that carries anything resembling an assignment is rejected
// outright rather than partially honoured.
const FORBIDDEN_AMENDMENT_KEYS = [
  'assignments',
  'exact_inventory_changes',
  'governed_exclusions',
  'lifecycle_changes',
  'functional_owner_changes',
]

function assertAmendmentIdentity(amendment, id, historicalReviewer, historicalReviewRole) {
  for (const forbidden of FORBIDDEN_AMENDMENT_KEYS) {
    assert(amendment[forbidden] === undefined, `reviewed executable ownership amendment may not carry reviewed ownership semantics: ${id}.${forbidden}`)
  }
  assert(typeof amendment.reviewed_by === 'string' && amendment.reviewed_by.length > 0
    && amendment.reviewed_by !== historicalReviewer, `reviewed executable ownership amendment may not restate the historical reviewer: ${id}`)
  assert(typeof amendment.role === 'string' && amendment.role.length > 0
    && amendment.role !== historicalReviewRole, `reviewed executable ownership amendment may not restate the historical review role: ${id}`)
  assert(typeof amendment.reviewed_at === 'string' && amendment.reviewed_at.length > 0, `reviewed executable ownership amendment date missing: ${id}`)
  assert(typeof amendment.authorization === 'string' && amendment.authorization.length > 0, `reviewed executable ownership amendment authorization missing: ${id}`)
  assert(typeof amendment.reason === 'string' && amendment.reason.length >= 48, `reviewed executable ownership amendment lacks an explicit reason: ${id}`)
}

function collectAmendmentDecisions(amendment, id, rebinds, unassigned) {
  for (const rebind of amendment.source_hash_rebinds ?? []) {
    assert(typeof rebind?.path === 'string' && rebind.path.length > 0
      && SHA256.test(rebind.previous_source_sha256 ?? '')
      && SHA256.test(rebind.current_source_sha256 ?? '')
      && rebind.previous_source_sha256 !== rebind.current_source_sha256, `reviewed executable ownership amendment rebind invalid: ${id}`)
    assert(rebind.review_decision === AMENDMENT_REBIND_DECISION
      && typeof rebind.review_rationale === 'string'
      && rebind.review_rationale.length >= 48, `reviewed executable ownership amendment rebind lacks an explicit decision: ${rebind.path}`)
    assert(!rebinds.has(rebind.path), `duplicate reviewed executable ownership amendment rebind: ${rebind.path}`)
    rebinds.set(rebind.path, rebind)
  }

  for (const surface of amendment.unassigned_tracked_surfaces ?? []) {
    assert(typeof surface?.path === 'string' && surface.path.length > 0
      && surface.review_decision === AMENDMENT_UNASSIGNED_DECISION
      && typeof surface.review_rationale === 'string'
      && surface.review_rationale.length >= 48, `reviewed executable ownership amendment unassigned surface lacks an explicit decision: ${surface?.path}`)
    assert(surface.functional_owner === undefined && surface.exclusion === undefined && surface.inventory_kind === undefined, `reviewed executable ownership amendment unassigned surface may not carry an ownership assignment: ${surface.path}`)
    assert(!unassigned.has(surface.path), `duplicate reviewed executable ownership amendment unassigned surface: ${surface.path}`)
    unassigned.set(surface.path, surface)
  }
}

// Resolves one accepted-authority merge composition. The composition does not
// review surfaces; it binds two already accepted authority lines and states the
// exact merged output. Both inputs are mandatory and each is pinned by an exact
// denominator triple, so dropping or editing either one cannot pass silently.
function resolveAuthorityComposition(amendment, id, context, identities, rebinds, unassigned) {
  const { historicalReviewer, historicalReviewRole } = context
  const composition = amendment.authority_composition
  assert(composition && typeof composition === 'object' && !Array.isArray(composition), `accepted authority merge composition is missing: ${id}`)
  assert(composition.review_decision === AMENDMENT_COMPOSITION_DECISION, `accepted authority merge composition lacks its explicit decision: ${id}`)
  assert(composition.claims_primary_surface_review === false, `accepted authority merge composition must state that it performs no primary per-surface review: ${id}`)
  assert(typeof composition.composition_scope === 'string' && composition.composition_scope.length >= 48, `accepted authority merge composition lacks an explicit scope statement: ${id}`)

  const inputs = composition.accepted_authority_inputs
  assert(Array.isArray(inputs) && inputs.length === 2, `accepted authority merge composition requires exactly two accepted authority inputs: ${id}`)
  const byAuthority = new Map()
  for (const input of inputs) {
    assert(input && typeof input === 'object', `accepted authority input malformed: ${id}`)
    assert(input.authority === COMPOSITION_ANCHOR_AUTHORITY || input.authority === COMPOSITION_MERGED_AUTHORITY, `accepted authority input role is not recognised: ${id}.${input.authority}`)
    assert(!byAuthority.has(input.authority), `duplicate accepted authority input: ${id}.${input.authority}`)
    assert(SHA1.test(input.commit ?? ''), `accepted authority input lacks its exact commit: ${id}.${input.authority}`)
    assert(typeof input.accepted_evidence_path === 'string' && input.accepted_evidence_path.length > 0, `accepted authority input lacks its accepted evidence path: ${id}.${input.authority}`)
    assert(SHA256.test(input.accepted_evidence_sha256 ?? ''), `accepted authority input lacks its accepted evidence digest: ${id}.${input.authority}`)
    assert(isExactTriple(input.current), `accepted authority input denominator is not an exact triple: ${id}.${input.authority}`)
    byAuthority.set(input.authority, input)
  }
  const anchor = byAuthority.get(COMPOSITION_ANCHOR_AUTHORITY)
  const merged = byAuthority.get(COMPOSITION_MERGED_AUTHORITY)
  assert(anchor && merged, `accepted authority merge composition must declare both the upstream and the merged authority: ${id}`)

  // The upstream authority is the chain anchor. Binding it to the predecessor
  // triple means an edited or dropped upstream input breaks the chain itself.
  assert(sameTriple(anchor.current, amendment.predecessor), `accepted authority merge composition does not bind the upstream authority to its exact predecessor: ${id}`)
  assert(!sameTriple(merged.current, amendment.predecessor), `accepted authority merge composition restates the upstream authority as the merged authority: ${id}`)
  assert(!sameTriple(merged.current, amendment.current), `accepted authority merge composition does not move past the merged authority: ${id}`)

  // The merged authority carries its own already accepted amendment verbatim.
  // It is validated exactly like a linear amendment, so its reviewer, decisions
  // and rebinds keep their original force instead of being restated.
  const accepted = merged.accepted_amendment
  assert(accepted && typeof accepted === 'object' && !Array.isArray(accepted), `merged authority input lacks its accepted amendment evidence: ${id}`)
  const acceptedId = accepted.amendment_id
  assert(typeof acceptedId === 'string' && acceptedId.length > 0, `accepted amendment evidence identity missing: ${id}`)
  assert(!identities.has(acceptedId), `duplicate reviewed executable ownership amendment: ${acceptedId}`)
  identities.add(acceptedId)
  assert(accepted.authority_composition === undefined && accepted.amendment_kind === undefined, `accepted amendment evidence may not itself be a merge composition: ${acceptedId}`)
  assertAmendmentIdentity(accepted, acceptedId, historicalReviewer, historicalReviewRole)
  assert(isExactTriple(accepted.predecessor), `accepted amendment evidence predecessor is not an exact triple: ${acceptedId}`)
  assert(isExactTriple(accepted.current), `accepted amendment evidence current denominator invalid: ${acceptedId}`)
  assert(!sameTriple(accepted.current, accepted.predecessor), `accepted amendment evidence does not move the reviewed denominator: ${acceptedId}`)
  assert(sameTriple(accepted.current, merged.current), `accepted amendment evidence does not produce the declared merged authority denominator: ${acceptedId}`)
  collectAmendmentDecisions(accepted, acceptedId, rebinds, unassigned)

  // The arithmetic is stated in both directions so neither input's contribution
  // can be silently reattributed to the other.
  const delta = composition.merge_delta
  assert(delta && typeof delta === 'object' && !Array.isArray(delta), `accepted authority merge composition lacks its declared delta: ${id}`)
  const fromMerged = amendment.current.tracked_executable_surfaces - merged.current.tracked_executable_surfaces
  const fromAnchor = amendment.current.tracked_executable_surfaces - anchor.current.tracked_executable_surfaces
  assert(delta.surfaces_added_by_upstream_main_relative_to_identity_current === fromMerged && fromMerged > 0, `accepted authority merge composition upstream delta is not the exact merged arithmetic: ${id}`)
  assert(delta.surfaces_added_by_identity_relative_to_upstream_main_current === fromAnchor && fromAnchor > 0, `accepted authority merge composition identity delta is not the exact merged arithmetic: ${id}`)
}

export function resolveReviewedOwnershipExtension(decisions, amendments, context = {}) {
  const {
    decisionRegistryPath,
    decisionRegistrySha256,
    historicalReviewer,
    historicalReviewRole,
  } = context
  assert(typeof decisionRegistryPath === 'string' && decisionRegistryPath.length > 0, 'reviewed executable ownership amendment context requires the authoritative decision registry path')
  assert(SHA256.test(decisionRegistrySha256 ?? ''), 'reviewed executable ownership amendment context requires the exact decision registry digest')
  assert(typeof historicalReviewer === 'string' && historicalReviewer.length > 0, 'reviewed executable ownership amendment context requires the historical reviewer identity')
  assert(typeof historicalReviewRole === 'string' && historicalReviewRole.length > 0, 'reviewed executable ownership amendment context requires the historical review role')
  assert(isExactTriple(decisions?.current), 'historical reviewed executable ownership denominator is not an exact triple')

  if (amendments === null || amendments === undefined) {
    return { current: decisions.current, rebinds: new Map(), unassigned: new Map(), amendments: 0, compositions: 0 }
  }

  assert(amendments.schema === REVIEWED_AMENDMENTS_SCHEMA && amendments.version === 1, 'reviewed executable ownership amendment registry identity mismatch')
  assert(amendments.base?.decision_registry_path === decisionRegistryPath, 'reviewed executable ownership amendments must pin the authoritative historical review')
  assert(SHA256.test(amendments.base?.decision_registry_sha256 ?? '')
    && amendments.base.decision_registry_sha256 === decisionRegistrySha256, 'reviewed executable ownership amendments do not pin the exact immutable historical review bytes')
  assert(Array.isArray(amendments.amendments) && amendments.amendments.length > 0, 'reviewed executable ownership amendment chain is empty')

  const rebinds = new Map()
  const unassigned = new Map()
  const identities = new Set()
  let previous = decisions.current
  let compositions = 0

  for (const amendment of amendments.amendments) {
    const id = amendment?.amendment_id
    assert(typeof id === 'string' && id.length > 0, 'reviewed executable ownership amendment identity missing')
    assert(!identities.has(id), `duplicate reviewed executable ownership amendment: ${id}`)
    identities.add(id)

    assertAmendmentIdentity(amendment, id, historicalReviewer, historicalReviewRole)

    assert(sameTriple(amendment.predecessor, previous), `reviewed executable ownership amendment does not extend its exact predecessor: ${id}`)
    assert(isExactTriple(amendment.current), `reviewed executable ownership amendment current denominator invalid: ${id}`)
    assert(!sameTriple(amendment.current, amendment.predecessor), `reviewed executable ownership amendment does not move the reviewed denominator: ${id}`)

    const isComposition = amendment.amendment_kind === AMENDMENT_MERGE_COMPOSITION_KIND
    if (isComposition) {
      compositions += 1
      resolveAuthorityComposition(amendment, id, { historicalReviewer, historicalReviewRole }, identities, rebinds, unassigned)
    } else {
      assert(amendment.amendment_kind === undefined, `reviewed executable ownership amendment kind is not recognised: ${id}.${amendment.amendment_kind}`)
      assert(amendment.authority_composition === undefined, `only an accepted authority merge composition may declare authority inputs: ${id}`)
    }

    collectAmendmentDecisions(amendment, id, rebinds, unassigned)

    previous = amendment.current
  }

  return { current: previous, rebinds, unassigned, amendments: amendments.amendments.length, compositions }
}
