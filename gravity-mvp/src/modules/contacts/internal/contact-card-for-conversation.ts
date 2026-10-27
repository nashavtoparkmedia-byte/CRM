// CC-1 Contact Card read model: the Contacts-owned handler behind
// contacts.ContactCardForConversationQuery.v1.
//
// For one exact Chat.id it decides whether a verified server-side principal may
// see one Contact card, and which one. It owns no resolver: which Contact a
// conversation belongs to is Messaging's RCQ1 answer, injected by the
// composition that may depend on both contexts. It reads Contacts-owned state
// for exactly that Contact and writes nothing.
//
// The protocol, in order; every non-confirmed answer returns before any further
// read and carries no data:
//   1. the authority port's verified principal; none → forbidden. A client-held
//      identifier (crm_user_id, a header, a body field) is never an input here;
//   2. the query is parsed; only an exact Chat.id is accepted;
//   3. the principal may read this conversation, else forbidden (RCQ1 is not asked);
//   4. first resolution: not_found → missing, ambiguous → conflict,
//      unresolved → unresolved, an answer that is not exact → refused;
//   5. the principal may read the resolved Contact, else forbidden (nothing is read);
//   6. the card source of exactly that Contact, in one snapshot;
//   7. second resolution: it must name exactly the same Contact. Otherwise the
//      association changed during the read → refused, and what was read is dropped;
//   8. a source that is gone or archived → missing; a source that is not the
//      Contact asked for, or was merged away in the meantime → refused;
//   9. confirmed, with the minimal card.
// Nothing is looked up by phone, name, username or provider id, and no other
// conversation is consulted.

import {
  CONTACT_CARD_FOR_CONVERSATION_RESULT_V1,
  parseContactCardForConversationQueryV1,
  type ContactCardChannelV1,
  type ContactCardForConversationResultV1,
  type ContactCardForConversationStatusV1,
  type ContactCardV1,
} from '@/contracts/contacts/v1'

import { buildCanonicalContactSummary } from '../public/v1/contact-display-policy'
import { contactAutomationState, identityEvidenceState, jsonRecord } from '../public/v1/contact-evidence-state'

/** A principal Identity Access verified from server-side state. Contacts reads only its kind. */
export type ContactCardPrincipalV1 = { readonly kind: string }

export interface ContactCardAuthorityPortV1 {
  /** The verified principal of the current request, or null. Never derived from a client-held identifier. */
  currentPrincipal(): Promise<ContactCardPrincipalV1 | null>
  /** Whether the principal may read this exact conversation. Asked before RCQ1. */
  mayReadConversation(principal: ContactCardPrincipalV1, chatId: string): Promise<boolean>
  /** Whether the principal may read this exact Contact. Asked before any Contact read. */
  mayReadContact(principal: ContactCardPrincipalV1, contactId: string): Promise<boolean>
}

/**
 * Which Contact one exact Chat.id belongs to. The composition binds Messaging's
 * ResolveConversationContactQuery.v1 here; its answer is checked, not trusted:
 * anything but an exact RCQ1 status shape is refused.
 */
export type ContactCardConversationResolverV1 = (chatId: string) => Promise<unknown>

/** Exactly what the card needs from one Contact, Contacts-owned models only. No provider id is part of it. */
export type ContactCardSourceV1 = {
  id: string
  displayName: string | null
  displayNameSource: string
  primaryPhoneId: string | null
  isArchived: boolean
  customFields: unknown
  phones: Array<{ id: string; phone: string; isActive: boolean; lifecycle: string }>
  identities: Array<{ id: string; channel: string; isActive: boolean; metadata: unknown; displayName: string | null }>
  mergedFromCount: number
  /** Read back from Contacts-owned confirmation evidence (confirmedPersonNameV1); never from a Driver row. */
  confirmedPersonName: string | null
}

export interface ContactCardSourcePortV1 {
  /** The card source of exactly this Contact id, or null. One snapshot, reads only. */
  findContactCardSource(contactId: string): Promise<ContactCardSourceV1 | null>
}

type ConversationResolution =
  | { status: 'resolved'; contactId: string }
  | { status: 'unresolved' | 'ambiguous' | 'not_found' }
  | { status: 'not_exact' }

function exactId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.trim() === value ? value : null
}

function readResolution(answer: unknown): ConversationResolution {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return { status: 'not_exact' }
  const record = answer as Record<string, unknown>
  if (record.status === 'resolved') {
    const contactId = exactId(record.contactId)
    return contactId === null ? { status: 'not_exact' } : { status: 'resolved', contactId }
  }
  if (record.status === 'unresolved' || record.status === 'ambiguous' || record.status === 'not_found') {
    return { status: record.status }
  }
  return { status: 'not_exact' }
}

function answer(status: Exclude<ContactCardForConversationStatusV1, 'confirmed'>): ContactCardForConversationResultV1 {
  return { contract: CONTACT_CARD_FOR_CONVERSATION_RESULT_V1, status }
}

function isPrincipal(value: unknown): value is ContactCardPrincipalV1 {
  return typeof value === 'object' && value !== null
    && typeof (value as { kind?: unknown }).kind === 'string' && (value as { kind: string }).kind !== ''
}

/**
 * Identity ids with an open entry in the Contact's conflict journal. As every
 * runtime reader does, only `status === 'open'` counts; an unknown status does
 * not.
 */
function openJournalConflicts(customFields: unknown): { any: boolean; identityIds: Set<string> } {
  const stored = jsonRecord(customFields).identityConflicts
  const identityIds = new Set<string>()
  let any = false
  if (Array.isArray(stored)) {
    for (const item of stored) {
      const conflict = jsonRecord(item)
      if (conflict.status !== 'open') continue
      any = true
      if (typeof conflict.identityId === 'string') identityIds.add(conflict.identityId)
    }
  }
  return { any, identityIds }
}

function isCountedPhone(phone: ContactCardSourceV1['phones'][number]): boolean {
  return phone.isActive !== false && phone.lifecycle !== 'removed'
}

/**
 * Projects one Contact into the minimal card.
 *
 * The name and the formatted primary phone come from ContactDisplayPolicy, not a
 * second rule. Identities reach the policy without any external id, so its
 * stable-provider-id fallback can never put a provider id into the name.
 *
 * Conflict state reads both Contacts conflict stores with the runtime's own
 * semantics: an open journal entry (`identityConflicts`, status 'open') and the
 * identity latch (`metadata.conflictState === 'conflicted'`). The Contact-level
 * flag is set by any open entry, also one naming an identity the Contact no
 * longer has.
 */
export function buildContactCardV1(source: ContactCardSourceV1): ContactCardV1 {
  const automation = contactAutomationState(source.customFields)
  const canonical = buildCanonicalContactSummary({
    contact: {
      displayName: source.displayName,
      displayNameSource: source.displayNameSource,
      primaryPhoneId: source.primaryPhoneId,
      canonicalPinnedAt: automation.canonicalPinnedAt,
      phones: source.phones,
      identities: source.identities.map(identity => ({ channel: identity.channel, displayName: identity.displayName })),
    },
    driver: source.confirmedPersonName === null
      ? null
      : { fullName: source.confirmedPersonName, personResolutionStatus: 'confirmed' },
    currentChannel: null,
  })

  const journal = openJournalConflicts(source.customFields)
  let latched = false
  const byChannel = new Map<string, ContactCardChannelV1>()
  for (const identity of source.identities) {
    const latch = identityEvidenceState(identity.metadata).conflictState === 'conflicted'
    if (latch) latched = true
    const conflicted = latch || journal.identityIds.has(identity.id)
    const channel = byChannel.get(identity.channel)
    if (channel === undefined) {
      byChannel.set(identity.channel, {
        channel: identity.channel,
        identityCount: 1,
        hasActiveIdentity: identity.isActive !== false,
        hasOpenIdentityConflict: conflicted,
      })
      continue
    }
    channel.identityCount += 1
    if (identity.isActive !== false) channel.hasActiveIdentity = true
    if (conflicted) channel.hasOpenIdentityConflict = true
  }

  return {
    contactId: source.id,
    displayName: canonical.displayName,
    primaryPhone: canonical.primaryPhone,
    phoneCount: source.phones.filter(isCountedPhone).length,
    // Code-point order, never locale order: the same Contact always lists the same way.
    channels: [...byChannel.values()].sort((left, right) => (left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0)),
    hasOpenIdentityConflict: journal.any || latched,
    mergedFromCount: Math.max(0, Math.trunc(Number(source.mergedFromCount) || 0)),
  }
}

export function createContactCardForConversationHandlerV1(ports: {
  authority: ContactCardAuthorityPortV1
  resolveConversation: ContactCardConversationResolverV1
  cardSource: ContactCardSourcePortV1
}) {
  return async function readContactCardForConversationV1(query: unknown): Promise<ContactCardForConversationResultV1> {
    const principal = await ports.authority.currentPrincipal()
    if (!isPrincipal(principal)) return answer('forbidden')

    const { chatId } = parseContactCardForConversationQueryV1(query)
    if (await ports.authority.mayReadConversation(principal, chatId) !== true) return answer('forbidden')

    const first = readResolution(await ports.resolveConversation(chatId))
    if (first.status === 'not_found') return answer('missing')
    if (first.status === 'ambiguous') return answer('conflict')
    if (first.status === 'unresolved') return answer('unresolved')
    if (first.status !== 'resolved') return answer('refused')

    const contactId = first.contactId
    if (await ports.authority.mayReadContact(principal, contactId) !== true) return answer('forbidden')

    const source = await ports.cardSource.findContactCardSource(contactId)

    // The association must still name exactly this Contact after the read;
    // otherwise what was read may describe a person the conversation no longer
    // belongs to, so it is dropped.
    const second = readResolution(await ports.resolveConversation(chatId))
    if (second.status !== 'resolved' || second.contactId !== contactId) return answer('refused')

    if (source === null || source.isArchived === true) return answer('missing')
    if (source.id !== contactId || contactAutomationState(source.customFields).mergedIntoContactId !== null) {
      return answer('refused')
    }
    return { contract: CONTACT_CARD_FOR_CONVERSATION_RESULT_V1, status: 'confirmed', card: buildContactCardV1(source) }
  }
}
