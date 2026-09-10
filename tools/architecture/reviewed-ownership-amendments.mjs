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

export const REVIEWED_AMENDMENTS_SCHEMA = 'yoko.crm.reviewed-executable-path-ownership-amendments.v1'
export const AMENDMENT_REBIND_DECISION = 'APPROVED_MECHANICAL_SOURCE_HASH_REBIND'
export const AMENDMENT_UNASSIGNED_DECISION = 'APPROVED_NO_EXPLICIT_OWNERSHIP_ASSIGNMENT'

const SHA256 = /^[0-9a-f]{64}$/u
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
    return { current: decisions.current, rebinds: new Map(), unassigned: new Map(), amendments: 0 }
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

  for (const amendment of amendments.amendments) {
    const id = amendment?.amendment_id
    assert(typeof id === 'string' && id.length > 0, 'reviewed executable ownership amendment identity missing')
    assert(!identities.has(id), `duplicate reviewed executable ownership amendment: ${id}`)
    identities.add(id)

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

    assert(sameTriple(amendment.predecessor, previous), `reviewed executable ownership amendment does not extend its exact predecessor: ${id}`)
    assert(isExactTriple(amendment.current), `reviewed executable ownership amendment current denominator invalid: ${id}`)
    assert(!sameTriple(amendment.current, amendment.predecessor), `reviewed executable ownership amendment does not move the reviewed denominator: ${id}`)

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

    previous = amendment.current
  }

  return { current: previous, rebinds, unassigned, amendments: amendments.amendments.length }
}
