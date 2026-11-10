/**
 * Messaging conversation binding trust (R-22). Pure: no IO.
 *
 * Which conversations a person-scoped read may treat as one person's. A
 * conversation's person is its contact binding (`contactId` + the linked
 * `contactIdentityId`), which Contacts proved when the link was made. Its
 * `driverId` is a projection and never joins two conversations on its own: two
 * conversations of one person already share a contact, and two that share only a
 * driver are exactly how a stale projection used to merge different people.
 *
 * A binding is judged from facts the read already holds, without resolving
 * anybody:
 *   unbound      — no contact: the conversation stands alone;
 *   contradicted — hard evidence it is another person's: the linked identity
 *                  belongs to another contact, or a numeric Telegram identity
 *                  names a different peer than the conversation key;
 *   consistent   — the linked identity is the conversation's own Telegram peer;
 *   unverifiable — bound, with nothing that contradicts it (other channels, a
 *                  legacy or inactive identity): kept as it is today.
 * Only consistent and unverifiable conversations join their contact's group.
 */

export interface ConversationLinkedIdentityFactsV1 {
  id: string
  channel: string
  externalId: string
  contactId: string
  isActive: boolean
}

export interface ConversationBindingFactsV1 {
  channel: string
  chatType: string | null | undefined
  externalChatId: string
  contactId: string | null
  contactIdentityId: string | null
  /** The row `contactIdentityId` names, as read; null when the chat names none or the row is absent. */
  linkedIdentity: ConversationLinkedIdentityFactsV1 | null
}

export type ConversationPersonBindingStateV1 = 'unbound' | 'consistent' | 'unverifiable' | 'contradicted'

const TELEGRAM_PRIVATE_KEY = /^telegram:(\d+)$/u
const NUMERIC_PEER = /^\d+$/u

function isPrivate(chatType: string | null | undefined): boolean {
  return chatType === null || chatType === undefined || chatType === 'private'
}

/** The numeric Telegram peer of a private Telegram conversation, or null for any other conversation. */
export function telegramConversationPeerV1(facts: Pick<ConversationBindingFactsV1, 'channel' | 'chatType' | 'externalChatId'>): string | null {
  if (facts.channel !== 'telegram' || !isPrivate(facts.chatType)) return null
  return TELEGRAM_PRIVATE_KEY.exec(facts.externalChatId)?.[1] ?? null
}

export function conversationPersonBindingStateV1(facts: ConversationBindingFactsV1): ConversationPersonBindingStateV1 {
  if (facts.contactId === null) return 'unbound'
  const identity = facts.linkedIdentity
  if (facts.contactIdentityId === null || identity === null || identity.id !== facts.contactIdentityId) return 'unverifiable'
  if (identity.contactId !== facts.contactId) return 'contradicted'
  if (!identity.isActive) return 'unverifiable'
  const peer = telegramConversationPeerV1(facts)
  if (peer !== null && identity.channel === 'telegram' && NUMERIC_PEER.test(identity.externalId)) {
    return identity.externalId === peer ? 'consistent' : 'contradicted'
  }
  return 'unverifiable'
}

/** True when a person-scoped read may treat this conversation as its contact's. */
export function isConversationPersonTrustedV1(state: ConversationPersonBindingStateV1): boolean {
  return state === 'consistent' || state === 'unverifiable'
}

/**
 * The one key that merges conversations into one person's inbox entry, or null
 * when the conversation must stand alone: a group, an unbound conversation, or a
 * contradicted binding. There is no driver key.
 */
export function conversationPersonGroupKeyV1(facts: ConversationBindingFactsV1): string | null {
  if (!isPrivate(facts.chatType)) return null
  const state = conversationPersonBindingStateV1(facts)
  return isConversationPersonTrustedV1(state) ? `c:${facts.contactId}` : null
}
