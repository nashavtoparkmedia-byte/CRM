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

// An amendment normally records a movement of the reviewed denominator. A change that
// only moves the BYTES of an already reviewed exact surface moves no field of the triple:
// the inventory digest covers surface identity, and a coverage record carries path,
// context, exclusion and lifecycle but no content hash. Requiring a movement would make
// such a change impossible to record at all, which is why the only lawful shape for it is
// this one. It is admitted only when it carries nothing besides the rebind, so an
// unchanged triple can never smuggle an ownership change past the denominator rule.
//
// This relaxes the DENOMINATOR rule and no fingerprint rule. Every rebind still has to
// name an already reviewed assignment, start from exactly the fingerprint that assignment
// carries, and end at the bytes on disk - all of which the consuming validator binds.
function assertRebindOnlyAmendment(amendment, id) {
  const rebinds = amendment.source_hash_rebinds ?? []
  // Keep the original message: an amendment that moves nothing and rebinds nothing is
  // exactly the case the denominator rule has always rejected.
  assert(rebinds.length > 0, `reviewed executable ownership amendment does not move the reviewed denominator: ${id}`)
  assert(amendment.amendment_kind === undefined, `a rebind-only reviewed executable ownership amendment may not compose authorities: ${id}`)
  assert((amendment.unassigned_tracked_surfaces ?? []).length === 0, `a rebind-only reviewed executable ownership amendment may not change the tracked surface set: ${id}`)
  const invariants = amendment.invariants
  assert(invariants !== null && typeof invariants === 'object' && !Array.isArray(invariants), `a rebind-only reviewed executable ownership amendment must declare its invariants: ${id}`)
  const declared = Object.entries(invariants)
  assert(declared.length > 0 && declared.every(([, value]) => value === 0), `a rebind-only reviewed executable ownership amendment must declare every other delta zero: ${id}`)
}

function collectAmendmentDecisions(amendment, id, rebinds, unassigned) {
  const ownRebinds = new Set()
  for (const rebind of amendment.source_hash_rebinds ?? []) {
    assert(typeof rebind?.path === 'string' && rebind.path.length > 0
      && SHA256.test(rebind.previous_source_sha256 ?? '')
      && SHA256.test(rebind.current_source_sha256 ?? '')
      && rebind.previous_source_sha256 !== rebind.current_source_sha256, `reviewed executable ownership amendment rebind invalid: ${id}`)
    assert(rebind.review_decision === AMENDMENT_REBIND_DECISION
      && typeof rebind.review_rationale === 'string'
      && rebind.review_rationale.length >= 48, `reviewed executable ownership amendment rebind lacks an explicit decision: ${rebind.path}`)
    assert(!ownRebinds.has(rebind.path), `duplicate reviewed executable ownership amendment rebind: ${rebind.path}`)
    ownRebinds.add(rebind.path)
    // A path an earlier amendment already rebound may move again only from the
    // exact fingerprint that amendment approved, so the fingerprints stay one
    // unbroken chain from the reviewed assignment to the file. The resolved
    // rebind keeps the chain's first previous fingerprint, which is what the
    // validator binds to the reviewed assignment, and its latest current one.
    const earlier = rebinds.get(rebind.path)
    assert(!earlier || rebind.previous_source_sha256 === earlier.current_source_sha256, `duplicate reviewed executable ownership amendment rebind: ${rebind.path}`)
    rebinds.set(rebind.path, earlier ? { ...rebind, previous_source_sha256: earlier.previous_source_sha256 } : rebind)
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
    if (sameTriple(amendment.current, amendment.predecessor)) assertRebindOnlyAmendment(amendment, id)

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

// NEW EXECUTABLE SURFACE ASSIGNMENT
//
// An amendment can move the denominator and rebind an already reviewed
// fingerprint, but it can never assign ownership to a path no reviewer has ever
// examined: `FORBIDDEN_AMENDMENT_KEYS` rejects `assignments` outright, and a
// source-hash rebind is checked against an assignment that must already exist.
// That is deliberate, and it leaves one legitimate movement unrepresentable —
// a genuinely new executable surface, such as a new API route, which must be
// reviewed by whoever is reviewing today and never backdated into a dated
// historical record.
//
// A current-review epoch is that representation. It is append-only, and it adds
// only paths that no earlier authority assigned. It cannot alter, weaken or
// remove any existing assignment, because it may only introduce paths absent
// from every predecessor, and it carries its own present-day reviewer identity
// which may never restate the historical one.
//
// ORDERING. Amendments and epochs are two append-only streams merged into ONE
// chain. Each epoch anchors to the amendment prefix it follows — the exact count
// and a content digest of those amendments — rather than to the bytes of the
// whole amendment document. So an amendment appended later never invalidates an
// earlier epoch, a forked amendment history still fails the prefix digest, and
// the appended amendment simply continues the chain from the effective tail:
//   immutable historical registry
//     -> amendments[0 .. a1) -> epoch 1
//       -> amendments[a1 .. a2) -> epoch 2 -> ... -> remaining amendments
// with no "latest document wins" anywhere in it. Amendment semantics are not
// changed: every segment is resolved by `resolveReviewedOwnershipExtension`.
//
// REBIND != NEW OWNERSHIP REVIEW. The two live in different documents with
// different keys and different decision constants, and an epoch that tries to
// carry `source_hash_rebinds` is rejected: a fingerprint movement can never be
// the act that creates ownership. Stage order also binds rebinds: a rebind from
// an amendment that precedes an epoch never touches a surface that epoch
// reviews, and a later rebind of such a surface must start from the exact
// fingerprint its reviewer approved.

export const CURRENT_REVIEWS_SCHEMA = 'yoko.crm.executable-path-ownership-current-reviews.v1'
export const NEW_SURFACE_ASSIGNMENT_DECISION = 'APPROVED_NEW_SURFACE_ASSIGNMENT'
export const EXACT_INVENTORY_ADMISSION_DECISION = 'APPROVED_NEW_SURFACE_EXACT_INVENTORY_ADMISSION'

// Keys that belong exclusively to the historical review or to the amendment
// chain. An epoch carrying any of them would be claiming a different authority's
// power under its own identity.
const FORBIDDEN_EPOCH_KEYS = [
  'assignments',
  'exact_inventory_changes',
  'governed_exclusions',
  'lifecycle_changes',
  'functional_owner_changes',
  'source_hash_rebinds',
  'unassigned_tracked_surfaces',
  'amendment_kind',
  'authority_composition',
]

const ASSIGNMENT_FIELDS = ['path', 'lifecycle', 'functional_owner', 'exclusion', 'inventory_kind', 'source_sha256']

const isExactInventory = (inventory) => Number.isInteger(inventory?.path_count)
  && inventory.path_count >= 0
  && SHA256.test(inventory?.path_sha256 ?? '')

const sameInventory = (left, right) => left?.path_count === right?.path_count
  && left?.path_sha256 === right?.path_sha256

const inventoryKey = (exclusion, inventoryKind) => `${exclusion}|${inventoryKind}`

function assertEpochIdentity(epoch, id, historicalReviewer, historicalReviewRole) {
  for (const forbidden of FORBIDDEN_EPOCH_KEYS) {
    assert(epoch[forbidden] === undefined, `current ownership review epoch may not carry foreign authority semantics: ${id}.${forbidden}`)
  }
  assert(typeof epoch.reviewed_by === 'string' && epoch.reviewed_by.length > 0
    && epoch.reviewed_by !== historicalReviewer, `current ownership review epoch may not restate the historical reviewer: ${id}`)
  assert(typeof epoch.role === 'string' && epoch.role.length > 0
    && epoch.role !== historicalReviewRole, `current ownership review epoch may not restate the historical review role: ${id}`)
  assert(typeof epoch.reviewed_at === 'string' && epoch.reviewed_at.length > 0, `current ownership review epoch date missing: ${id}`)
  assert(typeof epoch.authorization === 'string' && epoch.authorization.length > 0, `current ownership review epoch authorization missing: ${id}`)
  assert(typeof epoch.reason === 'string' && epoch.reason.length >= 48, `current ownership review epoch lacks an explicit reason: ${id}`)
}

// Chains per-segment rebinds of one path in stage order. Each segment's entry is
// already merged by `resolveReviewedOwnershipExtension`, so across segments the
// same rule applies: a later rebind must start from the fingerprint the earlier
// one approved, and the result keeps the first previous and the last current.
function chainRebinds(entries) {
  let merged = null
  for (const rebind of entries) {
    if (merged) {
      assert(rebind.previous_source_sha256 === merged.current_source_sha256, `duplicate reviewed executable ownership amendment rebind: ${rebind.path}`)
    }
    merged = merged ? { ...rebind, previous_source_sha256: merged.previous_source_sha256 } : rebind
  }
  return merged
}

/**
 * Pure, IO-free resolution of the one effective ownership state: the immutable
 * historical registry, the amendment chain and the ordered current-review
 * epochs, merged into a single chain by each epoch's amendment anchor.
 *
 * `context` carries the trust anchors the caller read from authoritative
 * source: the historical registry path and digest, the historical reviewer
 * identity and role that may never be restated, the accepted composition
 * anchors, and the amendment document path (undefined when none exists).
 *
 * With no current-review document the result is exactly
 * `resolveReviewedOwnershipExtension`, so historical and amendment behaviour is
 * unchanged wherever no epoch exists.
 */
export function resolveEffectiveOwnershipState(decisions, amendments, currentReviews, context = {}) {
  const {
    decisionRegistryPath,
    decisionRegistrySha256,
    historicalReviewer,
    historicalReviewRole,
    acceptedAuthorityAnchors,
    amendmentsPath,
  } = context
  const amendmentContext = { decisionRegistryPath, decisionRegistrySha256, historicalReviewer, historicalReviewRole, acceptedAuthorityAnchors }

  if (currentReviews === null || currentReviews === undefined) {
    const extension = resolveReviewedOwnershipExtension(decisions, amendments, amendmentContext)
    return { ...extension, epochs: 0, epochAssignments: new Map(), admissions: new Map(), epochRebinds: new Map() }
  }

  assert(typeof decisionRegistryPath === 'string' && decisionRegistryPath.length > 0, 'current ownership review context requires the authoritative decision registry path')
  assert(SHA256.test(decisionRegistrySha256 ?? ''), 'current ownership review context requires the exact decision registry digest')
  assert(typeof historicalReviewer === 'string' && historicalReviewer.length > 0, 'current ownership review context requires the historical reviewer identity')
  assert(typeof historicalReviewRole === 'string' && historicalReviewRole.length > 0, 'current ownership review context requires the historical review role')
  assert(isExactTriple(decisions?.current), 'historical reviewed executable ownership denominator is not an exact triple')
  assert(Array.isArray(decisions.assignments) && Array.isArray(decisions.exact_inventory_changes), 'current ownership review requires the historical assignments and exact inventory state')

  assert(currentReviews.schema === CURRENT_REVIEWS_SCHEMA && currentReviews.version === 1, 'current ownership review registry identity mismatch')
  assert(currentReviews.base?.decision_registry_path === decisionRegistryPath
    && currentReviews.base?.decision_registry_sha256 === decisionRegistrySha256, 'current ownership reviews do not pin the exact immutable historical review bytes')
  assert(Array.isArray(currentReviews.epochs) && currentReviews.epochs.length > 0, 'current ownership review epoch chain is empty')

  const chain = amendments === null || amendments === undefined ? [] : amendments.amendments
  assert(Array.isArray(chain), 'reviewed executable ownership amendment chain is malformed')
  // The chain is resolved in segments, so identity uniqueness is enforced across
  // the whole document here rather than per segment.
  const amendmentIds = new Set()
  for (const amendment of chain) {
    assert(!amendmentIds.has(amendment?.amendment_id), `duplicate reviewed executable ownership amendment: ${amendment?.amendment_id}`)
    amendmentIds.add(amendment?.amendment_id)
  }

  const assignedPaths = new Set(decisions.assignments.map((assignment) => assignment.path))
  const inventories = new Map(decisions.exact_inventory_changes
    .map((change) => [inventoryKey(change.exclusion, change.inventory_kind), change.current_inventory]))
  const epochAssignments = new Map()
  const admissions = new Map()
  const unassigned = new Map()
  const segments = []
  let previous = decisions.current
  let applied = 0
  let compositions = 0
  let stage = 0

  // Resolves the amendments between the last applied index and `until` with the
  // unchanged amendment resolver, continuing the chain from the effective tail.
  const applyAmendments = (until) => {
    if (until <= applied) return
    const segment = resolveReviewedOwnershipExtension(
      { ...decisions, current: previous },
      { ...amendments, amendments: chain.slice(applied, until) },
      amendmentContext,
    )
    previous = segment.current
    compositions += segment.compositions
    for (const [surfacePath, surface] of segment.unassigned) {
      assert(!unassigned.has(surfacePath), `duplicate reviewed executable ownership amendment unassigned surface: ${surfacePath}`)
      unassigned.set(surfacePath, surface)
    }
    segments.push({ stage: stage++, rebinds: segment.rebinds })
    applied = until
  }

  for (const [index, epoch] of currentReviews.epochs.entries()) {
    const expectedEpoch = index + 1
    const id = `epoch:${epoch?.epoch}`
    // Ordinals are contiguous from one, so a skipped, duplicated or reordered
    // epoch is rejected before any of its content is honoured.
    assert(epoch?.epoch === expectedEpoch, `current ownership review epoch is not the next ordinal: expected ${expectedEpoch}, found ${epoch?.epoch}`)
    assertEpochIdentity(epoch, id, historicalReviewer, historicalReviewRole)
    // The epoch names the exact amendment prefix it follows. A content digest of
    // that prefix, not of the whole document, is what makes a forked amendment
    // history fail while an amendment appended later leaves this epoch valid.
    const anchor = epoch.amendment_anchor
    assert(anchor && typeof anchor === 'object', `current ownership review epoch does not anchor the amendment chain it follows: ${id}`)
    assert(anchor.amendments_path === amendmentsPath, `current ownership review epoch anchors a different amendment document: ${id}`)
    assert(Number.isInteger(anchor.amendment_count) && anchor.amendment_count >= applied && anchor.amendment_count <= chain.length, `current ownership review epoch amendment anchor is out of order or out of range: ${id}`)
    assert(anchor.amendments_prefix_sha256 === canonicalDigest(chain.slice(0, anchor.amendment_count)), `current ownership review epoch does not follow the exact amendment chain prefix it names: ${id}`)
    applyAmendments(anchor.amendment_count)
    assert(sameTriple(epoch.predecessor, previous), `current ownership review epoch does not extend its exact predecessor: ${id}`)
    const epochStage = stage++
    assert(isExactTriple(epoch.current), `current ownership review epoch current denominator invalid: ${id}`)
    // An epoch exists to admit new surfaces, so it must move the denominator.
    assert(epoch.current.tracked_executable_surfaces > epoch.predecessor.tracked_executable_surfaces, `current ownership review epoch must advance the executable denominator: ${id}`)

    const admitted = epoch.exact_inventory_admissions ?? []
    assert(Array.isArray(admitted), `current ownership review epoch exact inventory admissions must be an array: ${id}`)
    const ownAdmissions = new Set()
    const ownGrowth = new Map()
    for (const admission of admitted) {
      assert(typeof admission?.exclusion === 'string' && admission.exclusion.length > 0
        && typeof admission?.inventory_kind === 'string' && admission.inventory_kind.length > 0, `current ownership review exact inventory admission is unidentified: ${id}`)
      const key = inventoryKey(admission.exclusion, admission.inventory_kind)
      assert(!ownAdmissions.has(key), `duplicate current ownership review exact inventory admission: ${key}`)
      ownAdmissions.add(key)
      assert(admission.review_decision === EXACT_INVENTORY_ADMISSION_DECISION
        && typeof admission.review_rationale === 'string'
        && admission.review_rationale.length >= 48, `current ownership review exact inventory admission lacks an explicit decision: ${key}`)
      assert(isExactInventory(admission.previous_inventory) && isExactInventory(admission.current_inventory), `current ownership review exact inventory admission is malformed: ${key}`)
      // The admission must continue the exact membership an earlier authority
      // pinned, so a stale admission cannot silently replace current state.
      const pinned = inventories.get(key)
      assert(pinned, `current ownership review admits an exact inventory no authority pins: ${key}`)
      assert(sameInventory(admission.previous_inventory, pinned), `current ownership review exact inventory admission does not extend the pinned membership: ${key}`)
      // Membership may only grow: an admission is an addition of new surfaces,
      // never a removal of reviewed ones.
      assert(admission.current_inventory.path_count > admission.previous_inventory.path_count, `current ownership review exact inventory admission must admit new surfaces: ${key}`)
      ownGrowth.set(key, admission.current_inventory.path_count - admission.previous_inventory.path_count)
      inventories.set(key, admission.current_inventory)
      // Successive epochs may admit into the same inventory. The summary keeps
      // the chain ORIGIN — which must equal what the historical registry pinned —
      // and the LATEST membership, which must equal the derived inventory.
      const earlier = admissions.get(key)
      admissions.set(key, {
        exclusion: admission.exclusion,
        inventory_kind: admission.inventory_kind,
        previous_inventory: earlier ? earlier.previous_inventory : admission.previous_inventory,
        current_inventory: admission.current_inventory,
        epochs: [...(earlier?.epochs ?? []), expectedEpoch],
      })
    }

    const surfaces = epoch.new_surface_assignments ?? []
    assert(Array.isArray(surfaces) && surfaces.length > 0, `current ownership review epoch assigns no new surface: ${id}`)
    const ownPaths = new Set()
    const admittedCounts = new Map()
    for (const surface of surfaces) {
      for (const field of ASSIGNMENT_FIELDS) {
        assert(typeof surface?.[field] === 'string' && surface[field].length > 0, `current ownership review new surface assignment field missing: ${id}.${field}`)
      }
      assert(SHA256.test(surface.source_sha256), `current ownership review new surface assignment source hash invalid: ${surface.path}`)
      assert(surface.review_decision === NEW_SURFACE_ASSIGNMENT_DECISION
        && typeof surface.review_rationale === 'string'
        && surface.review_rationale.length >= 48, `current ownership review new surface assignment lacks an explicit decision: ${surface.path}`)
      assert(!ownPaths.has(surface.path), `conflicting current ownership review assignment within one epoch: ${surface.path}`)
      ownPaths.add(surface.path)
      // The decisive rule. An epoch may only ADD a path no earlier authority
      // assigned, which is simultaneously what forbids a duplicate assignment,
      // a conflicting reassignment and any weakening of reviewed ownership:
      // there is no expressible way to reach an already assigned path.
      assert(!assignedPaths.has(surface.path), `current ownership review may not reassign an already reviewed surface: ${surface.path}`)
      assert(!epochAssignments.has(surface.path), `duplicate current ownership review assignment: ${surface.path}`)
      // Explicit ownership assignment exists only for reviewed exact inventories;
      // every other surface is owned by its context or governed by a pattern and
      // never needed an assignment. So an epoch may only assign a surface that
      // joins a reviewed exact inventory, and only when this same epoch declares
      // that inventory's membership movement — no directory-wide admission.
      const key = inventoryKey(surface.exclusion, surface.inventory_kind)
      assert(inventories.has(key), `current ownership review may only assign a surface that joins a reviewed exact inventory: ${surface.path}`)
      assert(ownAdmissions.has(key), `current ownership review assigns into a reviewed exact inventory without admitting its membership: ${surface.path}`)
      admittedCounts.set(key, (admittedCounts.get(key) ?? 0) + 1)
      epochAssignments.set(surface.path, { ...surface, epoch: expectedEpoch, stage: epochStage })
    }
    // Every admitted membership movement must be accounted for, path for path,
    // by assignments in the same epoch, so an admission can never carry an
    // extra path that no reviewer assigned.
    for (const key of ownAdmissions) {
      assert(admittedCounts.get(key) === ownGrowth.get(key), `current ownership review admission growth is not exactly the reviewed new surfaces: ${key}`)
    }

    previous = epoch.current
  }

  // Amendments appended after the last epoch continue the chain from its tail.
  applyAmendments(chain.length)

  // Stage-ordered rebinds. A surface the historical registry assigned is rebound
  // by every segment in order, exactly as a single amendment chain did. A surface
  // an epoch reviewed is rebound only by amendments that FOLLOW that epoch, and
  // only from the fingerprint its reviewer approved; an earlier rebind naming the
  // same path is an orphan and stays as inert as orphan rebinds always were.
  const byPath = new Map()
  for (const segment of segments) {
    for (const [surfacePath, rebind] of segment.rebinds) {
      if (!byPath.has(surfacePath)) byPath.set(surfacePath, [])
      byPath.get(surfacePath).push({ stage: segment.stage, rebind })
    }
  }
  const rebinds = new Map()
  const epochRebinds = new Map()
  for (const [surfacePath, entries] of byPath) {
    const reviewed = epochAssignments.get(surfacePath)
    if (!reviewed) {
      rebinds.set(surfacePath, chainRebinds(entries.map((entry) => entry.rebind)))
      continue
    }
    const later = entries.filter((entry) => entry.stage > reviewed.stage).map((entry) => entry.rebind)
    if (later.length === 0) continue
    const merged = chainRebinds(later)
    assert(merged.previous_source_sha256 === reviewed.source_sha256, `reviewed executable ownership amendment rebind does not extend the current-review fingerprint: ${surfacePath}`)
    epochRebinds.set(surfacePath, merged)
  }

  return {
    current: previous,
    rebinds,
    unassigned,
    amendments: chain.length,
    compositions,
    epochs: currentReviews.epochs.length,
    epochAssignments,
    admissions,
    epochRebinds,
  }
}
