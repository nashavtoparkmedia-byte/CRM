// M3A1 ContactCardSummary.v1 — the Contact-owned read the future Contact Card
// shell and its Contact core panel consume.
//
// It is deliberately narrower than the existing CanonicalContactSummary: it
// carries what Contacts actually owns — the canonical title, the primary phone,
// provider-neutral channel-identity presence, identity conflict, the contact
// source and a lineage count — and nothing a foreign domain owns. No provider
// external id, no ProviderAccount or Transport id, no conversation, no delivery
// state, no runtime readiness, no driver or task data ever appears here, so the
// card cannot become a cross-domain aggregate through this contract.
//
// Canonical title and phone rules are NOT re-derived here: they come from
// ContactDisplayPolicy.v1, which already owns them.

import { buildCanonicalContactSummary } from './contact-display-policy'
import { contactAutomationState } from './contact-evidence-state'
import { resolveContactIdentityConflictStateV1 } from './contact-identity-conflict-state'

export type ContactCardConflictStateV1 = 'clear' | 'conflicted'

/** One channel, described by presence and state only — never by provider id. */
export type ContactCardChannelSummaryV1 = {
  channel: string
  identityCount: number
  hasActiveIdentity: boolean
  conflictState: ContactCardConflictStateV1
}

export type ContactCardSummaryV1 = {
  contactId: string
  displayName: string
  displayTitle: string
  primaryPhone: string | null
  phoneCount: number
  channels: ContactCardChannelSummaryV1[]
  hasIdentityConflict: boolean
  source: string
  lineage: { mergedFromCount: number }
}

/**
 * The exact input the projection needs. Every field is Contacts-owned state, so
 * a port can satisfy it without reading Messaging, Fleet or any provider.
 */
export type ContactCardSummarySourceV1 = {
  id: string
  displayName: string
  displayNameSource: string
  masterSource: string
  primaryPhoneId: string | null
  /** Contact.customFields — read only through Contacts-owned accessors. */
  customFields?: unknown
  phones: Array<{
    id: string
    phone: string
    isPrimary?: boolean
    isActive?: boolean
    lifecycle?: string
  }>
  identities: Array<{
    /**
     * ContactIdentity.id and externalId are required by the canonical conflict
     * projection: it joins journal entries to identities by id, and the
     * transport-only classifier compares the recorded details to externalId.
     * Neither value is ever carried into ContactCardSummaryV1 — the boundary
     * control proves that, and the projection's own contract forbids it.
     */
    id: string
    externalId: string
    channel: string
    isActive?: boolean
    /** ContactIdentity.metadata — read only through Contacts-owned accessors. */
    metadata?: unknown
    displayName?: string | null
  }>
  mergedFromCount: number
  /**
   * The canonical display policy may use a confirmed person name as the contact
   * title. The name is a value, not a Fleet model, and Contacts owns the rule
   * that consumes it — but Contacts owns no source for it, so the M3A1 adapter
   * always leaves it null and the policy falls through to its next rule. A later
   * slice may supply it from the Fleet public surface at the composition site,
   * where that dependency is allowed.
   */
  confirmedPersonName?: string | null
}

export interface ContactCardSummaryPortV1 {
  findContactCardSummarySource(contactId: string): Promise<ContactCardSummarySourceV1 | null>
}

const REMOVED_PHONE_LIFECYCLES = new Set(['removed'])

function isCountablePhone(phone: ContactCardSummarySourceV1['phones'][number]): boolean {
  if (phone.isActive === false) return false
  return !REMOVED_PHONE_LIFECYCLES.has(String(phone.lifecycle ?? ''))
}


/**
 * Projects one contact into ContactCardSummary.v1.
 *
 * The title, the display title and the formatted primary phone are taken from
 * ContactDisplayPolicy.v1 rather than recomputed, and its provider-identity and
 * driver-profile outputs are deliberately discarded.
 */
export function buildContactCardSummaryV1(source: ContactCardSummarySourceV1): ContactCardSummaryV1 {
  const automation = contactAutomationState(source.customFields)
  const confirmedPersonName = source.confirmedPersonName ?? null
  const canonical = buildCanonicalContactSummary({
    contact: {
      displayName: source.displayName,
      displayNameSource: source.displayNameSource,
      primaryPhoneId: source.primaryPhoneId,
      canonicalPinnedAt: automation.canonicalPinnedAt,
      phones: source.phones,
      identities: source.identities,
    },
    // A confirmed person name, when a caller can supply one, is the only reason
    // the policy needs this argument. Nothing else about a driver is passed, and
    // the policy's driver-profile output is dropped below.
    driver: confirmedPersonName === null
      ? null
      : { fullName: confirmedPersonName, personResolutionStatus: 'confirmed' },
    currentChannel: null,
  })

  // Conflict state is NOT decided here. One Contacts-owned projection reads both
  // the journal and the identity latch, and this summary and the detailed
  // ContactIdentityConflictView.v1 both read that same state — so the card's
  // boolean can never disagree with the panel beside it. Before this, the summary
  // saw only the latch, which no production identity carries.
  const conflictState = resolveContactIdentityConflictStateV1({
    customFields: source.customFields,
    identities: source.identities,
  })

  const byChannel = new Map<string, ContactCardChannelSummaryV1>()
  for (const identity of source.identities) {
    const channel = String(identity.channel)
    const existing = byChannel.get(channel)
    if (existing === undefined) {
      byChannel.set(channel, {
        channel,
        identityCount: 1,
        hasActiveIdentity: identity.isActive !== false,
        conflictState: 'clear',
      })
      continue
    }
    existing.identityCount += 1
    if (identity.isActive !== false) existing.hasActiveIdentity = true
  }
  for (const [channel, counts] of Object.entries(conflictState.byChannel)) {
    const existing = byChannel.get(channel)
    if (existing !== undefined && counts.open > 0) existing.conflictState = 'conflicted'
  }
  const channels = [...byChannel.values()].sort((left, right) => left.channel.localeCompare(right.channel))

  return {
    contactId: source.id,
    displayName: canonical.displayName,
    displayTitle: canonical.displayTitle,
    primaryPhone: canonical.primaryPhone,
    phoneCount: source.phones.filter(isCountablePhone).length,
    channels,
    // The Contact-level answer comes from the projection, not from the channel
    // rows: a conflict can name an identity this Contact no longer has, which has
    // no channel row to carry it but is still a real recorded conflict.
    hasIdentityConflict: conflictState.hasOpenConflict,
    source: source.masterSource,
    lineage: { mergedFromCount: Math.max(0, Number(source.mergedFromCount) || 0) },
  }
}

/** Reads one ContactCardSummary.v1 through an injected Contacts-owned port. */
export function createContactCardSummaryHandlerV1(port: ContactCardSummaryPortV1) {
  return async (contactId: string): Promise<ContactCardSummaryV1 | null> => {
    const exactContactId = typeof contactId === 'string' ? contactId.trim() : ''
    if (!exactContactId) return null
    const source = await port.findContactCardSummarySource(exactContactId)
    return source === null ? null : buildContactCardSummaryV1(source)
  }
}
