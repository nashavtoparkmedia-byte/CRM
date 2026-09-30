// M3A4 S1 — the one Contacts-owned identity-conflict semantic.
//
// Contacts keeps identity conflicts in TWO places and every authoritative runtime
// reader ORs them: the append-only journal in Contact.customFields.identityConflicts,
// and a per-identity latch in ContactIdentity.metadata.conflictState. Reading only
// one of them under-reports the runtime — measured: no production identity carries
// the latch, while a production Contact really does carry an open blocking journal
// entry.
//
// This module is the single place either store is interpreted. ContactCardSummary,
// ContactIdentityConflictView.v1 and any later Contact Card surface project from the
// state it returns; none of them may re-implement a conflict rule. The blocking
// rules themselves are NOT reinvented here either: they come from
// ContactEvidenceState, so this projection cannot disagree with the deny paths.

import {
  hasOpenDriverPersonContradictionV1,
  identityEvidenceState,
  isPersonBlockingIdentityConflictEntryV1,
  isProvenTransportOnlyIdentityConflictV1,
  jsonRecord,
} from './contact-evidence-state'

/** Where a projected conflict came from. */
export type ContactIdentityConflictOriginV1 = 'journal' | 'identity_latch'

/**
 * Provider-neutral conflict classes. Every value is either a stored
 * Contacts-owned conflictType, the synthetic latch class, or `unknown` for a
 * historical or malformed entry whose type cannot be recognised.
 */
export type ContactIdentityConflictClassV1 =
  | 'channel_identity_collision'
  | 'provider_identity_alias_collision'
  | 'stable_identity_phone_contradiction'
  | 'confirmed_driver_cluster_contradiction'
  | 'fleet_authoritative_person_contradiction'
  | 'identity_conflict_flag'
  | 'unknown'

/** Whether the conflict, as recorded, is about the person or only about a transport. */
export type ContactIdentityConflictScopeV1 = 'person' | 'transport_only'

export type ContactIdentityConflictStatusV1 = 'open' | 'closed'

/**
 * What the conflict's `identityId` resolves to on this Contact right now.
 * `contact` means the entry names no identity at all; `missing` means it names
 * one this Contact no longer has.
 */
export type ContactIdentityConflictTargetV1 = 'active' | 'inactive' | 'missing' | 'contact'

export type ContactIdentityConflictRecordV1 = {
  origin: ContactIdentityConflictOriginV1
  /** Position in the stored journal, or null for a synthetic latch record. */
  journalIndex: number | null
  identityId: string | null
  identityState: ContactIdentityConflictTargetV1
  channel: string | null
  conflictClass: ContactIdentityConflictClassV1
  scope: ContactIdentityConflictScopeV1
  status: ContactIdentityConflictStatusV1
  personBlocking: boolean
  detectedAt: string | null
}

export type ContactIdentityConflictCountsV1 = {
  open: number
  personBlocking: number
}

export type ContactIdentityConflictStateV1 = {
  entries: ContactIdentityConflictRecordV1[]
  hasOpenConflict: boolean
  hasPersonBlockingConflict: boolean
  openCount: number
  closedCount: number
  byIdentityId: Record<string, ContactIdentityConflictCountsV1>
  byChannel: Record<string, ContactIdentityConflictCountsV1>
}

/**
 * The exact identity facts the projection needs.
 *
 * `externalId` is required, not optional: the transport-only classifier compares
 * it to the recorded collision details, and without it a genuine transport-only
 * collision cannot be proven and would be reported as person-blocking. Making it
 * optional to spare callers would silently change a blocking verdict.
 */
export type ContactIdentityConflictIdentityV1 = {
  id: string
  channel: string
  externalId: string
  isActive?: boolean
  /** ContactIdentity.metadata — read only through Contacts-owned accessors. */
  metadata?: unknown
}

/** Stored conflictTypes this projection recognises. Anything else is `unknown`. */
const KNOWN_JOURNAL_CONFLICT_CLASSES_V1: ReadonlySet<string> = new Set([
  'channel_identity_collision',
  'provider_identity_alias_collision',
  'stable_identity_phone_contradiction',
  'confirmed_driver_cluster_contradiction',
  'fleet_authoritative_person_contradiction',
])

/** Classes whose blocking is decided for the whole Contact rather than one identity. */
const CONTACT_SCOPED_CONFLICT_CLASSES_V1: ReadonlySet<string> = new Set([
  'confirmed_driver_cluster_contradiction',
  'fleet_authoritative_person_contradiction',
])

const PROJECTED_CHANNELS_V1: ReadonlySet<string> = new Set(['telegram', 'whatsapp', 'max'])

function presentString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isoTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function conflictClassOf(value: unknown): ContactIdentityConflictClassV1 {
  return typeof value === 'string' && KNOWN_JOURNAL_CONFLICT_CLASSES_V1.has(value)
    ? value as ContactIdentityConflictClassV1
    : 'unknown'
}

function identityStateOf(identity: ContactIdentityConflictIdentityV1): ContactIdentityConflictTargetV1 {
  return identity.isActive === false ? 'inactive' : 'active'
}

function bump(
  counts: Record<string, ContactIdentityConflictCountsV1>,
  key: string,
  entry: ContactIdentityConflictRecordV1,
): void {
  const current = counts[key] ?? { open: 0, personBlocking: 0 }
  counts[key] = {
    open: current.open + (entry.status === 'open' ? 1 : 0),
    personBlocking: current.personBlocking + (entry.personBlocking ? 1 : 0),
  }
}

/**
 * Projects one Contact's conflict state from the journal and the identity latches.
 *
 * Total: no input throws. A non-array journal reads as empty, non-object members
 * are skipped, and every emitted field is an enum, a boolean, a number, a
 * Contacts-owned id or an ISO date — never a stored free-text value.
 *
 * Two deliberate asymmetries are carried over from the runtime rather than
 * improved on: an unrecognised conflictType still blocks (fail closed), while a
 * status that is not exactly 'open' does not block (the deny paths require the
 * exact literal). A conflict whose identity no longer exists reports
 * `identityState: 'missing'` and does NOT block, because that is precisely what
 * the runtime does today; surfacing the weakness is this slice's job, repairing
 * it is not.
 */
export function resolveContactIdentityConflictStateV1(input: {
  customFields: unknown
  identities: ReadonlyArray<ContactIdentityConflictIdentityV1>
}): ContactIdentityConflictStateV1 {
  const fields = jsonRecord(input.customFields)
  const stored = Array.isArray(fields.identityConflicts) ? fields.identityConflicts : []
  const identities = Array.isArray(input.identities) ? input.identities : []
  const identityById = new Map(identities.map(identity => [identity.id, identity]))
  // Contact-scoped: evaluated once, by the same predicate the driver authorities use.
  const driverContradiction = hasOpenDriverPersonContradictionV1(input.customFields)
  const entries: ContactIdentityConflictRecordV1[] = []

  for (const [journalIndex, item] of stored.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = jsonRecord(item)
    const status: ContactIdentityConflictStatusV1 = record.status === 'open' ? 'open' : 'closed'
    const identityId = presentString(record.identityId)
    const identity = identityId === null ? undefined : identityById.get(identityId)
    const conflictClass = conflictClassOf(record.conflictType)
    const identityState: ContactIdentityConflictTargetV1 = identityId === null
      ? 'contact'
      : identity === undefined ? 'missing' : identityStateOf(identity)
    // Transport-only is a proof, never a guess: without the live identity the
    // details cannot be checked against it, so the entry stays person-scoped.
    const scope: ContactIdentityConflictScopeV1 = identity !== undefined
      && isProvenTransportOnlyIdentityConflictV1(record, identity)
      ? 'transport_only'
      : 'person'
    // The identity's own channel when it resolves; otherwise only a recorded
    // channel this domain actually projects, never an arbitrary stored string.
    const detailsChannel = presentString(jsonRecord(record.details).channel)
    const channel = identity !== undefined
      ? identity.channel
      : detailsChannel !== null && PROJECTED_CHANNELS_V1.has(detailsChannel) ? detailsChannel : null
    // With a live identity the entry-level primitive decides. Without one, only
    // the two contact-scoped classes can still block, and the shared predicate is
    // kept in the condition on purpose: it is the authority the driver surfaces
    // use, so if it ever narrows this projection narrows with it instead of
    // quietly disagreeing. Everything else — an advisory entry with no identity,
    // or one naming an identity this Contact no longer has — does not block,
    // which is exactly what the runtime does today.
    const personBlocking = identity !== undefined
      ? isPersonBlockingIdentityConflictEntryV1(record, identity)
      : status === 'open' && CONTACT_SCOPED_CONFLICT_CLASSES_V1.has(conflictClass) && driverContradiction
    entries.push({
      origin: 'journal',
      journalIndex,
      identityId,
      identityState,
      channel,
      conflictClass,
      scope,
      status,
      personBlocking,
      detectedAt: isoTimestamp(record.detectedAt),
    })
  }

  // The latch is an independent runtime blocker, so it must be representable on
  // its own. It is emitted only when no OPEN PERSON-BLOCKING journal entry
  // already explains this identity: every writer that sets the latch also appends
  // a journal entry in the same transaction, so emitting unconditionally would
  // double-report the normal case — while suppressing on any open entry would
  // lose the real one, because an open transport-only entry does not explain a
  // person-blocking latch. Only this exact condition keeps the per-identity
  // blocking count equal to the runtime's own disjunction.
  for (const identity of identities) {
    if (identityEvidenceState(identity.metadata).conflictState !== 'conflicted') continue
    const alreadyExplained = entries.some(entry => (
      entry.origin === 'journal'
      && entry.identityId === identity.id
      && entry.status === 'open'
      && entry.personBlocking
    ))
    if (alreadyExplained) continue
    entries.push({
      origin: 'identity_latch',
      journalIndex: null,
      identityId: identity.id,
      identityState: identityStateOf(identity),
      channel: identity.channel,
      conflictClass: 'identity_conflict_flag',
      scope: 'person',
      status: 'open',
      personBlocking: true,
      detectedAt: null,
    })
  }

  const byIdentityId: Record<string, ContactIdentityConflictCountsV1> = {}
  const byChannel: Record<string, ContactIdentityConflictCountsV1> = {}
  let openCount = 0
  let closedCount = 0
  for (const entry of entries) {
    if (entry.status === 'open') openCount += 1
    else closedCount += 1
    if (entry.identityId !== null && identityById.has(entry.identityId)) bump(byIdentityId, entry.identityId, entry)
    if (entry.channel !== null) bump(byChannel, entry.channel, entry)
  }

  return {
    entries,
    hasOpenConflict: openCount > 0,
    hasPersonBlockingConflict: entries.some(entry => entry.personBlocking),
    openCount,
    closedCount,
    byIdentityId,
    byChannel,
  }
}
