// M3A4 S1 ContactIdentityConflictView.v1 — the Contact-owned read the future
// Contact Card channel-state panel consumes.
//
// It answers exactly five questions and nothing more: does this Contact have an
// identity conflict, which Contact-owned identity and channel is affected, what
// class of conflict is it, is it open, and does it block person-level operations.
//
// It carries no provider or runtime detail. No externalId, no ProviderAccount or
// Transport id, no connection, session, sender or peer id, no conversation or
// delivery state, no Driver or Fleet id, and never the stored `reason`, `details`
// or historical `resolution` payload — production's closed records hold a host
// filesystem path, a runtime version and a release sha in that payload, so
// returning stored entries verbatim would publish infrastructure detail. Semantic
// enums replace every stored string.
//
// `identityId` IS carried: it is a Contacts-owned primary key, not provider data,
// and production proves channel alone is insufficient — one Contact there holds
// three MAX identities.
//
// Only OPEN conflicts are returned. Every existing reader of the journal filters
// on `status === 'open'`, no current consumer needs history, and closed payloads
// are where the infrastructure detail lives; `closedConflictCount` is the entire
// history exposure. No conflict rule is implemented here: the whole verdict comes
// from ContactIdentityConflictState.

import {
  resolveContactIdentityConflictStateV1,
  type ContactIdentityConflictClassV1,
  type ContactIdentityConflictIdentityV1,
  type ContactIdentityConflictScopeV1,
  type ContactIdentityConflictTargetV1,
} from './contact-identity-conflict-state'

export type ContactIdentityConflictViewEntryV1 = {
  /** ContactIdentity.id, or null when the conflict is about the person cluster. */
  identityId: string | null
  channel: string | null
  conflictClass: ContactIdentityConflictClassV1
  scope: ContactIdentityConflictScopeV1
  blocksPersonOperations: boolean
  identityState: ContactIdentityConflictTargetV1
  detectedAt: string | null
}

export type ContactIdentityConflictViewChannelV1 = {
  /** Joins ContactCardSummaryV1.channels[].channel. */
  channel: string
  openConflictCount: number
  personBlockingCount: number
}

export type ContactIdentityConflictViewV1 = {
  contactId: string
  hasOpenConflict: boolean
  hasPersonBlockingConflict: boolean
  /** How many conflicts are recorded but no longer open. Their content is never returned. */
  closedConflictCount: number
  channels: ContactIdentityConflictViewChannelV1[]
  /** Open conflicts only. */
  conflicts: ContactIdentityConflictViewEntryV1[]
}

/**
 * The exact input the projection needs. Every field is Contacts-owned state, so a
 * port can satisfy it without reading Messaging, Fleet or any provider.
 */
export type ContactIdentityConflictViewSourceV1 = {
  id: string
  /** Contact.customFields — read only through Contacts-owned accessors. */
  customFields?: unknown
  identities: ReadonlyArray<ContactIdentityConflictIdentityV1>
}

export interface ContactIdentityConflictViewPortV1 {
  findContactIdentityConflictSource(contactId: string): Promise<ContactIdentityConflictViewSourceV1 | null>
}

/**
 * Projects one Contact into ContactIdentityConflictView.v1.
 *
 * Nothing is classified here. The canonical state decides open/closed, person vs
 * transport-only, and what blocks; this function drops the closed entries, drops
 * the internal bookkeeping (`origin`, `journalIndex`, `status`) and renames
 * `personBlocking` to the public field. Channels are sorted for a stable
 * response, and so are conflicts, so two identical Contacts cannot render
 * differently.
 */
export function buildContactIdentityConflictViewV1(
  source: ContactIdentityConflictViewSourceV1,
): ContactIdentityConflictViewV1 {
  const state = resolveContactIdentityConflictStateV1({
    customFields: source.customFields,
    identities: source.identities,
  })
  const conflicts = state.entries
    .filter(entry => entry.status === 'open')
    .map(entry => ({
      identityId: entry.identityId,
      channel: entry.channel,
      conflictClass: entry.conflictClass,
      scope: entry.scope,
      blocksPersonOperations: entry.personBlocking,
      identityState: entry.identityState,
      detectedAt: entry.detectedAt,
    }))
  const channels = Object.entries(state.byChannel)
    .filter(([, counts]) => counts.open > 0)
    .map(([channel, counts]) => ({
      channel,
      openConflictCount: counts.open,
      personBlockingCount: counts.personBlocking,
    }))
    .sort((left, right) => left.channel.localeCompare(right.channel))

  return {
    contactId: source.id,
    hasOpenConflict: state.hasOpenConflict,
    hasPersonBlockingConflict: state.hasPersonBlockingConflict,
    closedConflictCount: state.closedCount,
    channels,
    conflicts,
  }
}

/** Reads one ContactIdentityConflictView.v1 through an injected Contacts-owned port. */
export function createContactIdentityConflictViewHandlerV1(port: ContactIdentityConflictViewPortV1) {
  return async (contactId: string): Promise<ContactIdentityConflictViewV1 | null> => {
    const exactContactId = typeof contactId === 'string' ? contactId.trim() : ''
    if (!exactContactId) return null
    const source = await port.findContactIdentityConflictSource(exactContactId)
    return source === null ? null : buildContactIdentityConflictViewV1(source)
  }
}
