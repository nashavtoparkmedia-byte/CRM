export const CONTACT_CONVERSATIONS_QUERY_V1 = 'messaging.ContactConversationsQuery.v1' as const
export const CONTACT_CONVERSATIONS_RESULT_V1 = 'messaging.ContactConversationsResult.v1' as const

/** At most this many Contacts in one query: one ContactLookup.v1 page. */
export const CONTACT_CONVERSATIONS_MAX_CONTACTS_V1 = 25
/** At most this many conversations are returned for one Contact; past it the entry is `truncated`. */
export const CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1 = 50

/** The channels a persisted conversation can be on (the stored `Chat.channel` values). */
export const CONTACT_CONVERSATIONS_CHANNELS_V1 = ['telegram', 'whatsapp', 'max', 'phone', 'avito'] as const
export type ContactConversationsChannelV1 = typeof CONTACT_CONVERSATIONS_CHANNELS_V1[number]

/**
 * Which persisted conversations belong to each of these Contacts, by channel.
 * Read-only: it never writes, backfills or creates a conversation, and it
 * makes no provider call.
 */
export interface ContactConversationsQueryV1 {
  contract: typeof CONTACT_CONVERSATIONS_QUERY_V1
  /** 1..25 distinct, non-empty Contact ids. The answer has one entry per id, in this order. */
  contactIds: string[]
}

/** One persisted conversation. `conversationId` is the exact `Chat.id`, the only handle that crosses. */
export interface ContactConversationRefV1 {
  conversationId: string
  /** The conversation's last activity, ISO-8601 UTC; null when it has never been active. */
  lastActivityAt: string | null
}

/** The Contact's conversations on one channel, most recent first. */
export interface ContactChannelConversationsV1 {
  channel: ContactConversationsChannelV1
  /** Always `conversations[0].conversationId`: the conversation to open on this channel. */
  primaryConversationId: string
  /** At least one; ordered by `compareContactConversationsV1`. */
  conversations: ContactConversationRefV1[]
}

export interface ContactConversationsFoundV1 {
  contactId: string
  status: 'found'
  /** The surviving Contact, as Contacts' public merge lineage defines it; equals `contactId` when it was never merged. */
  canonicalContactId: string
  /**
   * An ordered ARRAY of channel contexts, never a keyed record: the channel of
   * the most recent conversation first. Empty when the Contact has no
   * conversation. A channel appears at most once.
   */
  channels: ContactChannelConversationsV1[]
  /** The most recent conversation over every channel (`channels[0].primaryConversationId`), or null when there is none. */
  latestConversationId: string | null
  /**
   * True exactly when more eligible conversations exist than the 50 returned.
   * A truncated entry is PARTIAL: a channel or a conversation missing from it
   * may still exist, so it never proves absence.
   */
  truncated: boolean
}

export interface ContactConversationsNotFoundV1 {
  contactId: string
  status: 'not_found'
}

export type ContactConversationsEntryV1 = ContactConversationsFoundV1 | ContactConversationsNotFoundV1

/**
 * One entry per requested id, in request order (`contacts[i].contactId === contactIds[i]`).
 *
 * What counts as the Contact's conversation, exactly:
 *   - the persisted conversation's own Messaging link, `Chat.contactId`, equals
 *     the requested id or its canonical survivor (from Contacts'
 *     `resolveContactLineageV1`) — never a phone, a ChannelIdentity, a provider
 *     identity or any other relation;
 *   - it is a private (one-to-one) conversation: a group conversation is never
 *     a person's conversation;
 *   - its workflow status (new, open, waiting, resolved) never hides it.
 * Not promised in v1: conversations still linked to OTHER merged-away ids of the
 * same person (siblings or older aliases that were not the requested id) are
 * not looked for. Merges move a merged-away Contact's conversations to the
 * survivor, so this only matters after a failed merge.
 * No provider, account, route, transport, external identity, display name or
 * workflow detail crosses this contract.
 */
export interface ContactConversationsResultV1 {
  contract: typeof CONTACT_CONVERSATIONS_RESULT_V1
  contacts: ContactConversationsEntryV1[]
}

/**
 * The one total order of conversations, used for the order inside a channel
 * (and so the primary one), the order of channels and the latest conversation:
 * last activity DESC with never-active last, then creation DESC, then
 * conversation id ASC in ordinal string order (for the ASCII ids stored, the
 * same order as the database's C collation).
 */
export function compareContactConversationsV1(
  left: { conversationId: string; lastActivityAt: string | null; createdAt: string },
  right: { conversationId: string; lastActivityAt: string | null; createdAt: string },
): number {
  if (left.lastActivityAt !== right.lastActivityAt) {
    if (left.lastActivityAt === null) return 1
    if (right.lastActivityAt === null) return -1
    return left.lastActivityAt > right.lastActivityAt ? -1 : 1
  }
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1
  if (left.conversationId === right.conversationId) return 0
  return left.conversationId < right.conversationId ? -1 : 1
}

/**
 * What one entry proves about one channel, for a consumer that must not act on
 * incomplete evidence:
 *   present   — the channel has a conversation; open `primaryConversationId`;
 *   absent    — the Contact is known and the complete answer has no conversation on it;
 *   unknown   — the answer is truncated and does not show the channel: it may exist,
 *               so nothing may be created or concluded from it;
 *   not_found — no such Contact.
 */
export type ContactChannelConversationsLookupV1 =
  | { kind: 'present'; primaryConversationId: string; conversations: ContactConversationRefV1[] }
  | { kind: 'absent' }
  | { kind: 'unknown' }
  | { kind: 'not_found' }

export function contactChannelConversationsV1(
  entry: ContactConversationsEntryV1,
  channel: ContactConversationsChannelV1,
): ContactChannelConversationsLookupV1 {
  if (entry.status === 'not_found') return { kind: 'not_found' }
  const context = entry.channels.find(candidate => candidate.channel === channel)
  if (context) return { kind: 'present', primaryConversationId: context.primaryConversationId, conversations: context.conversations }
  return entry.truncated ? { kind: 'unknown' } : { kind: 'absent' }
}

export class ContactConversationsQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: ContactConversationsQueryValidationError['code'], message: string) {
    super(message)
    this.name = 'ContactConversationsQueryValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ContactConversationsQueryValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseContactConversationsQueryV1(input: unknown): ContactConversationsQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')

  const supportedFields = ['contract', 'contactIds']
  const extraFields = Object.keys(input).filter(key => !supportedFields.includes(key))
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)

  if (input.contract !== CONTACT_CONVERSATIONS_QUERY_V1) {
    if (typeof input.contract === 'string' && input.contract.startsWith('messaging.ContactConversationsQuery.')) {
      throw new ContactConversationsQueryValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${CONTACT_CONVERSATIONS_QUERY_V1}`)
  }

  const { contactIds } = input
  if (!Array.isArray(contactIds)) invalid('contactIds must be an array')
  if (contactIds.length === 0) invalid('contactIds must name at least one Contact')
  if (contactIds.length > CONTACT_CONVERSATIONS_MAX_CONTACTS_V1) {
    invalid(`contactIds may name at most ${CONTACT_CONVERSATIONS_MAX_CONTACTS_V1} Contacts`)
  }
  const seen = new Set<string>()
  for (const contactId of contactIds) {
    if (typeof contactId !== 'string' || contactId.trim() === '') invalid('every contactId must be a non-empty string')
    if (seen.has(contactId)) invalid(`duplicate contactId: ${contactId}`)
    seen.add(contactId)
  }

  return { contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: [...contactIds] as string[] }
}
