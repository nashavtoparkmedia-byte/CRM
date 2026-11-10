import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { conversationPersonBindingStateV1, conversationPersonGroupKeyV1, isConversationPersonTrustedV1 } from '@/modules/messaging/public/v1/conversation-binding-trust-policy'

/**
 * The client a workflow projection runs on. Omitted, it is the shared client;
 * a Messaging transaction passes its own, so the projection commits or rolls
 * back with the message it describes.
 */
export type ConversationWorkflowClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRawUnsafe'>

/** The exact conversations one group operation writes: one person's trusted conversations, or just the one. */
type ConversationGroupSelector = { chatIds: string[] }

const BINDING_FACTS_SELECT = {
  channel: true,
  chatType: true,
  externalChatId: true,
  contactId: true,
  contactIdentityId: true,
  contactIdentity: { select: { id: true, channel: true, externalId: true, contactId: true, isActive: true } },
} as const

type BindingFactsRow = {
  channel: string
  chatType: string
  externalChatId: string
  contactId: string | null
  contactIdentityId: string | null
  contactIdentity: { id: string; channel: string; externalId: string; contactId: string; isActive: boolean } | null
}

function bindingFacts(row: BindingFactsRow) {
  return {
    channel: row.channel,
    chatType: row.chatType,
    externalChatId: row.externalChatId,
    contactId: row.contactId,
    contactIdentityId: row.contactIdentityId,
    linkedIdentity: row.contactIdentity,
  }
}

function bindingState(row: BindingFactsRow) {
  return conversationPersonBindingStateV1(bindingFacts(row))
}

/** The inbox's own person key: null for a group, an unbound or a contradicted conversation. */
function personGroupKey(row: BindingFactsRow) {
  return conversationPersonGroupKeyV1(bindingFacts(row))
}

/**
 * ConversationWorkflowService — единый источник правды для state transitions чата.
 *
 * Valid statuses: new | open | waiting_customer | waiting_internal | resolved
 *
 * Uses $executeRawUnsafe / $queryRawUnsafe because lastInboundAt/lastOutboundAt/assignedToUserId
 * are not in the generated Prisma client (EPERM on prisma generate).
 */
export class ConversationWorkflowService {

  /**
   * Called by ALL inbound handlers (TG, MAX, WA) after saving the message.
   */
  static async onInboundMessage(chatId: string, sentAt: Date, db: ConversationWorkflowClient = prisma): Promise<void> {
    const rows = await db.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return

    const currentStatus = rows[0].status
    let newStatus = currentStatus
    if (currentStatus === 'resolved' || currentStatus === 'waiting_customer') {
      newStatus = 'open'
    }

    await db.$executeRawUnsafe(
      `UPDATE "Chat"
       SET "unreadCount" = "unreadCount" + 1,
           "requiresResponse" = true,
           "lastInboundAt" = $1,
           status = $2,
           "updatedAt" = NOW()
       WHERE id = $3`,
      sentAt,
      newStatus,
      chatId,
    )
  }

  /**
   * Lightweight handler for group chat inbound messages.
   * Only increments unreadCount and updates lastInboundAt.
   * Does NOT set requiresResponse, does NOT transition status.
   */
  static async onGroupInboundMessage(chatId: string, sentAt: Date, db: ConversationWorkflowClient = prisma): Promise<void> {
    await db.$executeRawUnsafe(
      `UPDATE "Chat"
       SET "unreadCount" = "unreadCount" + 1,
           "lastInboundAt" = $1,
           "updatedAt" = NOW()
       WHERE id = $2`,
      sentAt,
      chatId,
    )
  }

  /**
   * Called by MessageService.send() after successful delivery.
   */
  static async onOutboundMessage(chatId: string, sentAt: Date, db: ConversationWorkflowClient = prisma): Promise<void> {
    const rows = await db.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return

    const currentStatus = rows[0].status
    const transitions: Record<string, string> = {
      'new': 'open',
      'open': 'waiting_customer',
      'waiting_internal': 'waiting_customer',
      'resolved': 'open',
    }
    const newStatus = transitions[currentStatus] || currentStatus

    await db.$executeRawUnsafe(
      `UPDATE "Chat"
       SET "requiresResponse" = false,
           "lastOutboundAt" = $1,
           status = $2,
           "updatedAt" = NOW()
       WHERE id = $3`,
      sentAt,
      newStatus,
      chatId,
    )
  }

  /**
   * Assign chat to a user. Updates every conversation of the same trusted contact (R-22).
   * Transitions: new→open
   */
  static async assignChat(chatId: string, userId: string): Promise<void> {
    const rows = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return

    const newStatus = rows[0].status === 'new' ? 'open' : rows[0].status
    const selector = await this._getGroupSelector(chatId)
    await this._assignGroup(selector, userId, newStatus)
  }

  /**
   * Unassign chat. Updates all chats in the group.
   */
  static async unassignChat(chatId: string): Promise<void> {
    const selector = await this._getGroupSelector(chatId)
    await this._unassignGroup(selector)
  }

  /**
   * Resolve chat. Updates all chats in the group.
   */
  static async resolveChat(chatId: string): Promise<void> {
    const selector = await this._getGroupSelector(chatId)
    await this._resolveGroup(selector)
  }

  /**
   * Reopen chat.
   */
  static async reopenChat(chatId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat"
       SET status = 'open', "updatedAt" = NOW()
       WHERE id = $1`,
      chatId,
    )
  }

  /**
   * Mark all chats in the group as read (unreadCount=0).
   */
  static async markRead(chatId: string): Promise<void> {
    const selector = await this._getGroupSelector(chatId)

    // Per product policy: opening a chat counts as the manager having
    // seen it — clears BOTH unreadCount and requiresResponse. Previously
    // requiresResponse only cleared on outbound, which produced a
    // permanent red marker on incoming-only conversations and confused
    // operators ("ответил/не ответил не важно — увидел = норма").
    await this._markGroupRead(selector)
  }

  /**
   * Resolve the semantic target for group operations (all chats of same person).
   */
  private static async _getGroupSelector(chatId: string): Promise<ConversationGroupSelector> {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, ...BINDING_FACTS_SELECT },
    })
    if (!chat) return { chatIds: [chatId] }

    // R-22: a group operation reaches every conversation of one PERSON, and a
    // person is a trusted contact binding. A driverId alone is a projection, and
    // a binding that is provably another person's is neither the origin of a
    // group operation nor reached by one: it stays on its own conversation.
    // The group is exactly the inbox entry: one person key over private
    // conversations only, so a group chat that names the contact is never
    // reached through that person's private conversation (and vice versa).
    const key = personGroupKey(chat)
    if (!chat.contactId || key === null || !isConversationPersonTrustedV1(bindingState(chat))) return { chatIds: [chatId] }
    const siblings = await prisma.chat.findMany({
      where: { contactId: chat.contactId },
      select: { id: true, ...BINDING_FACTS_SELECT },
    })
    const chatIds = siblings.filter(sibling => personGroupKey(sibling) === key).map(sibling => sibling.id)
    return { chatIds: chatIds.includes(chatId) ? chatIds : [...chatIds, chatId] }
  }

  private static async _assignGroup(
    selector: ConversationGroupSelector,
    userId: string,
    status: string,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET "assignedToUserId" = $1, status = $2, "updatedAt" = NOW()
       WHERE id = ANY($3::text[])`,
      userId,
      status,
      selector.chatIds,
    )
  }

  private static async _unassignGroup(selector: ConversationGroupSelector): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET "assignedToUserId" = NULL, "updatedAt" = NOW()
       WHERE id = ANY($1::text[])`,
      selector.chatIds,
    )
  }

  private static async _resolveGroup(selector: ConversationGroupSelector): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET status = 'resolved', "requiresResponse" = false, "updatedAt" = NOW()
       WHERE id = ANY($1::text[])`,
      selector.chatIds,
    )
  }

  private static async _markGroupRead(selector: ConversationGroupSelector): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET "unreadCount" = 0, "requiresResponse" = false, "updatedAt" = NOW()
       WHERE id = ANY($1::text[])`,
      selector.chatIds,
    )
  }
}
