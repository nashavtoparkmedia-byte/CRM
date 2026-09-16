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
// machine-checked form that it performs no primary per-surface review.
//
// A declared authority input can never be self-attesting. A document that both
// claims an accepted denominator and supplies the only evidence for it proves
// nothing: a coherent co-edit of the input triple, the carried amendment and the
// declared delta would restate history unchallenged. Every input is therefore
// checked against a trusted anchor the caller supplies from reviewed source,
// exactly as the historical coverage baseline is anchored by digest. The anchor
// names the accepted commit, evidence path, evidence digest and exact
// denominator triple of each authority the repository is willing to compose, so
// an input that is dropped, added, swapped or edited fails closed however
// consistently the surrounding document was rewritten.

import { createHash } from 'node:crypto'

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

// Canonical digest over carried evidence. Hashing is a pure computation, so the
// module keeps its IO-free contract while gaining the ability to bind evidence
// it is handed to a digest the caller anchors in reviewed source.
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const canonicalDigest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')

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
  const { historicalReviewer, historicalReviewRole, acceptedAuthorityAnchors } = context
  const composition = amendment.authority_composition
  assert(composition && typeof composition === 'object' && !Array.isArray(composition), `accepted authority merge composition is missing: ${id}`)
  assert(composition.review_decision === AMENDMENT_COMPOSITION_DECISION, `accepted authority merge composition lacks its explicit decision: ${id}`)
  assert(composition.claims_primary_surface_review === false, `accepted authority merge composition must state that it performs no primary per-surface review: ${id}`)
  assert(typeof composition.composition_scope === 'string' && composition.composition_scope.length >= 48, `accepted authority merge composition lacks an explicit scope statement: ${id}`)

  // Trusted anchors come from reviewed source, never from the amendment
  // document, so a self-consistent rewrite of the document cannot restate which
  // authorities were accepted or what they had accepted.
  assert(acceptedAuthorityAnchors instanceof Map && acceptedAuthorityAnchors.size > 0, `accepted authority merge composition requires trusted authority anchors from reviewed source: ${id}`)

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

    const anchor = acceptedAuthorityAnchors.get(input.authority)
    assert(anchor, `accepted authority input is not a trusted composition authority: ${id}.${input.authority}`)
    assert(input.commit === anchor.commit, `accepted authority input commit does not match the trusted anchor: ${id}.${input.authority}`)
    assert(input.accepted_evidence_path === anchor.accepted_evidence_path, `accepted authority input evidence path does not match the trusted anchor: ${id}.${input.authority}`)
    assert(input.accepted_evidence_sha256 === anchor.accepted_evidence_sha256, `accepted authority input evidence digest does not match the trusted anchor: ${id}.${input.authority}`)
    assert(sameTriple(input.current, anchor.current), `accepted authority input denominator does not match the trusted anchor: ${id}.${input.authority}`)

    byAuthority.set(input.authority, { input, anchor })
  }
  const upstream = byAuthority.get(COMPOSITION_ANCHOR_AUTHORITY)
  const mergedEntry = byAuthority.get(COMPOSITION_MERGED_AUTHORITY)
  assert(upstream && mergedEntry, `accepted authority merge composition must declare both the upstream and the merged authority: ${id}`)
  const anchor = upstream.input
  const merged = mergedEntry.input

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
  // The carried evidence is itself anchored. Without this the amendment could
  // rewrite the reviewer, date, authorization, rationales and findings of the
  // authority it claims to be carrying verbatim.
  const anchoredCarriedDigest = mergedEntry.anchor.carried_amendment_sha256
  assert(SHA256.test(anchoredCarriedDigest ?? ''), `trusted anchor lacks the carried amendment digest: ${COMPOSITION_MERGED_AUTHORITY}`)
  assert(canonicalDigest(accepted) === anchoredCarriedDigest, `accepted amendment evidence does not match the trusted anchor digest: ${acceptedId}`)
  collectAmendmentDecisions(accepted, acceptedId, rebinds, unassigned)

  // The arithmetic is stated in both directions so neither input's contribution
  // can be silently reattributed to the other. Both figures are NET denominator
  // movement, which is not the same as a count of added surfaces whenever a
  // retirement is also in flight, so each direction must additionally publish an
  // addition and retirement count that reconciles to it. This resolver holds no
  // tree and cannot confirm the true split; what it forbids is publishing a net
  // figure with no accounting, or an accounting that does not reconcile.
  const delta = composition.merge_delta
  assert(delta && typeof delta === 'object' && !Array.isArray(delta), `accepted authority merge composition lacks its declared delta: ${id}`)
  const fromMerged = amendment.current.tracked_executable_surfaces - merged.current.tracked_executable_surfaces
  const fromAnchor = amendment.current.tracked_executable_surfaces - anchor.current.tracked_executable_surfaces
  assert(delta.net_surfaces_relative_to_identity_current === fromMerged && fromMerged > 0, `accepted authority merge composition upstream delta is not the exact merged arithmetic: ${id}`)
  assert(delta.net_surfaces_relative_to_upstream_main_current === fromAnchor && fromAnchor > 0, `accepted authority merge composition identity delta is not the exact merged arithmetic: ${id}`)

  for (const [field, net] of [['relative_to_identity_current', fromMerged], ['relative_to_upstream_main_current', fromAnchor]]) {
    const movement = delta.surface_movement?.[field]
    assert(movement && typeof movement === 'object' && !Array.isArray(movement), `accepted authority merge composition lacks its surface movement accounting: ${id}.${field}`)
    assert(Number.isInteger(movement.added) && movement.added >= 0
      && Number.isInteger(movement.retired) && movement.retired >= 0, `accepted authority merge composition surface movement is not an exact count: ${id}.${field}`)
    assert(movement.added - movement.retired === net, `accepted authority merge composition surface movement does not account for its net denominator difference: ${id}.${field}`)
  }
}

export function resolveReviewedOwnershipExtension(decisions, amendments, context = {}) {
  const {
    decisionRegistryPath,
    decisionRegistrySha256,
    historicalReviewer,
    historicalReviewRole,
    acceptedAuthorityAnchors,
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
  // The historical registry's own denominator is an accepted upstream authority
  // exactly when a trusted anchor says so. That fact, not the document, decides
  // whether the chain is composing.
  const upstreamAnchor = acceptedAuthorityAnchors instanceof Map ? acceptedAuthorityAnchors.get(COMPOSITION_ANCHOR_AUTHORITY) : null
  const anchoredUpstream = Boolean(upstreamAnchor) && sameTriple(upstreamAnchor.current, decisions.current)

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
    // Declaring a composition may never be optional. When the chain anchor is
    // itself a trusted upstream authority, the chain is composing whether or not
    // it says so, and an amendment that simply omitted amendment_kind would
    // otherwise resolve the same movement as an ordinary linear extension with
    // no authority declaration and no anchoring at all.
    if (anchoredUpstream && previous === decisions.current) {
      assert(isComposition, `an amendment extending an accepted upstream authority must be declared a merge composition: ${id}`)
    }
    if (isComposition) {
      compositions += 1
      resolveAuthorityComposition(amendment, id, { historicalReviewer, historicalReviewRole, acceptedAuthorityAnchors }, identities, rebinds, unassigned)
    } else {
      assert(amendment.amendment_kind === undefined, `reviewed executable ownership amendment kind is not recognised: ${id}.${amendment.amendment_kind}`)
      assert(amendment.authority_composition === undefined, `only an accepted authority merge composition may declare authority inputs: ${id}`)
    }

    collectAmendmentDecisions(amendment, id, rebinds, unassigned)

    previous = amendment.current
  }

  return { current: previous, rebinds, unassigned, amendments: amendments.amendments.length, compositions }
}
