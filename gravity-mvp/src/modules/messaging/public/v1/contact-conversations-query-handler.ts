import {
  CONTACT_CONVERSATIONS_CHANNELS_V1,
  CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1,
  CONTACT_CONVERSATIONS_RESULT_V1,
  compareContactConversationsV1,
  parseContactConversationsQueryV1,
  type ContactChannelConversationsV1,
  type ContactConversationsChannelV1,
  type ContactConversationsEntryV1,
  type ContactConversationsQueryV1,
  type ContactConversationsResultV1,
} from '../../../../contracts/messaging/v1'

/** One persisted private conversation, as the port reads it. */
export interface ContactConversationRowV1 {
  conversationId: string
  channel: string
  lastActivityAt: Date | null
  createdAt: Date
}

/** Reads only. It can name exact Contact ids and nothing else: no phone, identity or provider lookup exists here. */
export interface ContactConversationsPortV1 {
  /** The surviving Contact for this id, from Contacts' public merge lineage; null when no such Contact exists. */
  canonicalContactId(contactId: string): Promise<string | null>
  /**
   * Private conversations whose own link `Chat.contactId` is one of these exact
   * ids, ordered by the contract's total order, at most `limit` of them.
   */
  findPrivateConversations(contactIds: readonly string[], limit: number): Promise<ContactConversationRowV1[]>
}

const CHANNELS: ReadonlySet<string> = new Set(CONTACT_CONVERSATIONS_CHANNELS_V1)

type OrderedConversation = { conversationId: string; channel: ContactConversationsChannelV1; lastActivityAt: string | null; createdAt: string }

function ordered(row: ContactConversationRowV1): OrderedConversation {
  if (typeof row.conversationId !== 'string' || row.conversationId === '') {
    throw new Error('CONTACT_CONVERSATIONS_INVALID_CONVERSATION_ID')
  }
  // A channel this contract does not know would be a conversation it cannot
  // name; it fails the query instead of being dropped from the answer.
  if (!CHANNELS.has(row.channel)) throw new Error(`CONTACT_CONVERSATIONS_UNKNOWN_CHANNEL: ${row.channel}`)
  return {
    conversationId: row.conversationId,
    channel: row.channel as ContactConversationsChannelV1,
    lastActivityAt: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * messaging.ContactConversationsQuery.v1 — for each requested Contact, its
 * persisted private conversations by channel. Read-only.
 *
 * For each id, in request order:
 *   1. Contacts' public lineage gives the canonical survivor; no Contact → not_found;
 *   2. the conversations whose `Chat.contactId` is the requested id or that
 *      survivor are read, at most 50 + 1 so that more than 50 is known;
 *   3. they are put in the contract's one total order; the first 50 are kept
 *      and grouped by channel in that order, so each channel's first
 *      conversation is its primary one and the first channel holds the latest.
 * Nothing is written, nothing is created, and no provider is called.
 */
export function createContactConversationsQueryHandlerV1(port: ContactConversationsPortV1) {
  async function entryFor(contactId: string): Promise<ContactConversationsEntryV1> {
    const canonicalContactId = await port.canonicalContactId(contactId)
    if (!canonicalContactId) return { contactId, status: 'not_found' }

    const linkedIds = canonicalContactId === contactId ? [contactId] : [contactId, canonicalContactId]
    const rows = await port.findPrivateConversations(linkedIds, CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1 + 1)
    const conversations = rows.map(ordered)
    if (new Set(conversations.map(conversation => conversation.conversationId)).size !== conversations.length) {
      throw new Error('CONTACT_CONVERSATIONS_DUPLICATE_CONVERSATION')
    }
    conversations.sort(compareContactConversationsV1)
    const truncated = conversations.length > CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1
    const kept = conversations.slice(0, CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1)

    const channels: ContactChannelConversationsV1[] = []
    const byChannel = new Map<ContactConversationsChannelV1, ContactChannelConversationsV1>()
    for (const conversation of kept) {
      const ref = { conversationId: conversation.conversationId, lastActivityAt: conversation.lastActivityAt }
      const context = byChannel.get(conversation.channel)
      if (context) {
        context.conversations.push(ref)
      } else {
        const created: ContactChannelConversationsV1 = {
          channel: conversation.channel,
          primaryConversationId: conversation.conversationId,
          conversations: [ref],
        }
        byChannel.set(conversation.channel, created)
        channels.push(created)
      }
    }

    return {
      contactId,
      status: 'found',
      canonicalContactId,
      channels,
      latestConversationId: kept[0]?.conversationId ?? null,
      truncated,
    }
  }

  return async function contactConversationsV1(
    query: ContactConversationsQueryV1 | unknown,
  ): Promise<ContactConversationsResultV1> {
    const parsed = parseContactConversationsQueryV1(query)
    const contacts: ContactConversationsEntryV1[] = []
    // One Contact at a time: a page of 25 never fans out into parallel reads.
    for (const contactId of parsed.contactIds) contacts.push(await entryFor(contactId))
    return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts }
  }
}
