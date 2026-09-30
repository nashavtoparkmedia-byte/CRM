// M3A5 ContactReachabilityEvidenceView.v1 — the Contact-owned read of persisted
// communication reachability EVIDENCE.
//
// It reports what Contacts has recorded, and nothing stronger. Three unrelated
// writers populate ContactIdentity.reachabilityStatus with different rules — a
// provider-proof path that gates on conflicts and the provider target, a phone
// attachment that gates on neither, and a maintenance helper whose only caller
// backfilled the column from historical outbound message status. So a stored
// `confirmed` is a record that some interaction once succeeded, by one of three
// mechanisms, and is NOT proof of a provider check. The public vocabulary says
// `recorded_*` for exactly that reason.
//
// This view therefore cannot and does not answer: is the provider ready now, is
// the channel available, is a message deliverable, is a call possible, is a route
// selected, or is communication permitted. Those belong to the channel domains,
// Messaging, and a separate communication-policy capability.
//
// It also carries no usability verdict. Whether a person may be contacted depends
// on the canonical identity-conflict semantic, which is its own capability
// (ContactIdentityConflictView.v1). This module deliberately does not import it:
// a second place deriving usability is exactly the divergence that capability was
// created to remove. A consumer that needs both composes both.

export type ContactReachabilityEvidenceStatusV1 =
  | 'recorded_confirmed'
  | 'recorded_unreachable'
  | 'no_evidence'

/** Contacts-owned identity lifecycle only. Never conflict, provider or runtime state. */
export type ContactReachabilityIdentityStateV1 = 'active' | 'inactive'

export type ContactReachabilityIdentityEvidenceV1 = {
  /** ContactIdentity.id — a Contacts-owned key, never a provider target. */
  identityId: string
  channel: string
  identityState: ContactReachabilityIdentityStateV1
  evidenceStatus: ContactReachabilityEvidenceStatusV1
  /**
   * The timestamp associated with the stored reachability evidence.
   *
   * It is NOT a current probe time, NOT guaranteed to be the last provider check
   * time, and NOT a freshness boundary. The provider-proof writer deliberately
   * leaves it untouched when it preserves a stronger stored `confirmed` against a
   * newer negative, and the historical backfill wrote an outbound message's
   * `sentAt` into it. Null when nothing is recorded.
   */
  evidenceAt: string | null
}

/**
 * Counts for one channel. Counts only, on purpose.
 *
 * Production holds Contacts with two and three identities on a single channel,
 * six of which carry mixed evidence, so any single channel-level verdict would
 * have to silently choose between a recorded-confirmed and a recorded-unreachable
 * identity. There is no such product decision, so the channel row reports the
 * distribution and the identity rows keep every fact.
 */
export type ContactReachabilityChannelEvidenceV1 = {
  channel: string
  identityCount: number
  activeIdentityCount: number
  recordedConfirmedCount: number
  recordedUnreachableCount: number
  noEvidenceCount: number
  /** The newest evidenceAt across this channel's identities; null when none has one. */
  latestEvidenceAt: string | null
}

export type ContactReachabilityEvidenceViewV1 = {
  contactId: string
  identities: ContactReachabilityIdentityEvidenceV1[]
  channels: ContactReachabilityChannelEvidenceV1[]
}

/**
 * The exact input the projection needs. Every field is Contacts-owned state, so a
 * port can satisfy it without reading Chat, Message, Driver, ProviderAccount,
 * Transport or any provider surface.
 *
 * No provider target reaches this shape at all: unlike the conflict projection,
 * nothing here needs `externalId`, so the adapter never selects it.
 */
export type ContactReachabilityEvidenceSourceV1 = {
  id: string
  identities: ReadonlyArray<{
    id: string
    channel: string
    isActive?: boolean
    /** ContactIdentity.reachabilityStatus as stored. */
    reachabilityStatus?: unknown
    /** ContactIdentity.reachabilityCheckedAt as stored. */
    reachabilityCheckedAt?: unknown
  }>
}

export interface ContactReachabilityEvidenceViewPortV1 {
  findContactReachabilityEvidenceSource(
    contactId: string,
  ): Promise<ContactReachabilityEvidenceSourceV1 | null>
}

/**
 * The stored enum, mapped to the public vocabulary.
 *
 * Fails soft: an unexpected stored value — which the column type should prevent,
 * but a raw write or a future enum member could produce — reads as `no_evidence`
 * rather than throwing or being reported as a recorded fact.
 */
function evidenceStatusOf(stored: unknown): ContactReachabilityEvidenceStatusV1 {
  if (stored === 'confirmed') return 'recorded_confirmed'
  if (stored === 'unreachable') return 'recorded_unreachable'
  return 'no_evidence'
}

/** An ISO timestamp, or null. Accepts a Date or an already-serialized string. */
function evidenceAtOf(stored: unknown): string | null {
  if (stored instanceof Date) return Number.isFinite(stored.getTime()) ? stored.toISOString() : null
  if (typeof stored !== 'string') return null
  const parsed = Date.parse(stored)
  return Number.isFinite(parsed) ? stored : null
}

function emptyChannel(channel: string): ContactReachabilityChannelEvidenceV1 {
  return {
    channel,
    identityCount: 0,
    activeIdentityCount: 0,
    recordedConfirmedCount: 0,
    recordedUnreachableCount: 0,
    noEvidenceCount: 0,
    latestEvidenceAt: null,
  }
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(right) > Date.parse(left) ? right : left
}

/**
 * Projects one Contact's persisted reachability evidence.
 *
 * Total: no input throws. Deterministic: identities are sorted by channel then
 * identity id and channels by channel, so the same Contact produces byte-identical
 * output whatever order the persistence layer returned its rows in.
 *
 * Nothing is aggregated away. An inactive identity keeps its recorded evidence and
 * is reported as `inactive`, because the evidence remains a historical Contacts
 * fact; it counts toward `identityCount` and not toward `activeIdentityCount`.
 */
export function buildContactReachabilityEvidenceViewV1(
  source: ContactReachabilityEvidenceSourceV1,
): ContactReachabilityEvidenceViewV1 {
  const rows = Array.isArray(source.identities) ? source.identities : []
  const identities: ContactReachabilityIdentityEvidenceV1[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const identityId = typeof row.id === 'string' ? row.id : ''
    if (identityId === '') continue
    identities.push({
      identityId,
      channel: String(row.channel ?? ''),
      identityState: row.isActive === false ? 'inactive' : 'active',
      evidenceStatus: evidenceStatusOf(row.reachabilityStatus),
      evidenceAt: evidenceAtOf(row.reachabilityCheckedAt),
    })
  }
  identities.sort((left, right) => (
    left.channel.localeCompare(right.channel) || left.identityId.localeCompare(right.identityId)
  ))

  const byChannel = new Map<string, ContactReachabilityChannelEvidenceV1>()
  for (const identity of identities) {
    const channel = byChannel.get(identity.channel) ?? emptyChannel(identity.channel)
    channel.identityCount += 1
    if (identity.identityState === 'active') channel.activeIdentityCount += 1
    if (identity.evidenceStatus === 'recorded_confirmed') channel.recordedConfirmedCount += 1
    else if (identity.evidenceStatus === 'recorded_unreachable') channel.recordedUnreachableCount += 1
    else channel.noEvidenceCount += 1
    // A null timestamp contributes nothing to the newest evidence date.
    channel.latestEvidenceAt = laterTimestamp(channel.latestEvidenceAt, identity.evidenceAt)
    byChannel.set(identity.channel, channel)
  }
  const channels = [...byChannel.values()].sort((left, right) => left.channel.localeCompare(right.channel))

  return { contactId: source.id, identities, channels }
}

/**
 * Reads one ContactReachabilityEvidenceView.v1 through an injected Contacts-owned port.
 *
 * Reads exactly the requested Contact and follows no merge redirect:
 * ContactLineage.v1 owns canonical redirect resolution, and the other two Contact
 * Card reads behave the same way, so a composition site resolves lineage once for
 * all of them. An archived Contact is returned normally — its recorded evidence is
 * still a historical fact.
 */
export function createContactReachabilityEvidenceViewHandlerV1(
  port: ContactReachabilityEvidenceViewPortV1,
) {
  return async (contactId: string): Promise<ContactReachabilityEvidenceViewV1 | null> => {
    const exactContactId = typeof contactId === 'string' ? contactId.trim() : ''
    if (!exactContactId) return null
    const source = await port.findContactReachabilityEvidenceSource(exactContactId)
    return source === null ? null : buildContactReachabilityEvidenceViewV1(source)
  }
}
