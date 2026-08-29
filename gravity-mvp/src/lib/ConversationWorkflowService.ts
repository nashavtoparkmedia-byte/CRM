import { prisma } from '@/lib/prisma'

type ConversationGroupSelector =
  | { kind: 'contact'; value: string }
  | { kind: 'driver'; value: string }
  | { kind: 'chat'; value: string }

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
  static async onInboundMessage(chatId: string, sentAt: Date): Promise<void> {
    const rows = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return

    const currentStatus = rows[0].status
    let newStatus = currentStatus
    if (currentStatus === 'resolved' || currentStatus === 'waiting_customer') {
      newStatus = 'open'
    }

    await prisma.$executeRawUnsafe(
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
  static async onGroupInboundMessage(chatId: string, sentAt: Date): Promise<void> {
    await prisma.$executeRawUnsafe(
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
  static async onOutboundMessage(chatId: string, sentAt: Date): Promise<void> {
    const rows = await prisma.$queryRaw<Array<{ status: string }>>`
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

    await prisma.$executeRawUnsafe(
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
   * Assign chat to a user. Updates all chats sharing the same contactId/driverId.
   * Transitions: new→open
   */
  static async assignChat(chatId: string, userId: string): Promise<void> {
    const rows = await prisma.$queryRaw<Array<{ status: string; contactId: string | null; driverId: string | null }>>`
      SELECT status, "contactId", "driverId" FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return

    const chat = rows[0]
    const newStatus = chat.status === 'new' ? 'open' : chat.status

    const selector: ConversationGroupSelector = chat.contactId
      ? { kind: 'contact', value: chat.contactId }
      : chat.driverId
        ? { kind: 'driver', value: chat.driverId }
        : { kind: 'chat', value: chatId }

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
    const rows = await prisma.$queryRaw<Array<{ contactId: string | null; driverId: string | null }>>`
      SELECT "contactId", "driverId" FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return { kind: 'chat', value: chatId }

    const chat = rows[0]
    if (chat.contactId) return { kind: 'contact', value: chat.contactId }
    if (chat.driverId) return { kind: 'driver', value: chat.driverId }
    return { kind: 'chat', value: chatId }
  }

  private static async _assignGroup(
    selector: ConversationGroupSelector,
    userId: string,
    status: string,
  ): Promise<void> {
    if (selector.kind === 'contact') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "assignedToUserId" = $1, status = $2, "updatedAt" = NOW()
         WHERE "contactId" = $3`,
        userId,
        status,
        selector.value,
      )
      return
    }
    if (selector.kind === 'driver') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "assignedToUserId" = $1, status = $2, "updatedAt" = NOW()
         WHERE "driverId" = $3`,
        userId,
        status,
        selector.value,
      )
      return
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET "assignedToUserId" = $1, status = $2, "updatedAt" = NOW()
       WHERE id = $3`,
      userId,
      status,
      selector.value,
    )
  }

  private static async _unassignGroup(selector: ConversationGroupSelector): Promise<void> {
    if (selector.kind === 'contact') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "assignedToUserId" = NULL, "updatedAt" = NOW()
         WHERE "contactId" = $1`,
        selector.value,
      )
      return
    }
    if (selector.kind === 'driver') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "assignedToUserId" = NULL, "updatedAt" = NOW()
         WHERE "driverId" = $1`,
        selector.value,
      )
      return
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET "assignedToUserId" = NULL, "updatedAt" = NOW()
       WHERE id = $1`,
      selector.value,
    )
  }

  private static async _resolveGroup(selector: ConversationGroupSelector): Promise<void> {
    if (selector.kind === 'contact') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET status = 'resolved', "requiresResponse" = false, "updatedAt" = NOW()
         WHERE "contactId" = $1`,
        selector.value,
      )
      return
    }
    if (selector.kind === 'driver') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET status = 'resolved', "requiresResponse" = false, "updatedAt" = NOW()
         WHERE "driverId" = $1`,
        selector.value,
      )
      return
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET status = 'resolved', "requiresResponse" = false, "updatedAt" = NOW()
       WHERE id = $1`,
      selector.value,
    )
  }

  private static async _markGroupRead(selector: ConversationGroupSelector): Promise<void> {
    if (selector.kind === 'contact') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "unreadCount" = 0, "requiresResponse" = false, "updatedAt" = NOW()
         WHERE "contactId" = $1`,
        selector.value,
      )
      return
    }
    if (selector.kind === 'driver') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "unreadCount" = 0, "requiresResponse" = false, "updatedAt" = NOW()
         WHERE "driverId" = $1`,
        selector.value,
      )
      return
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "Chat" SET "unreadCount" = 0, "requiresResponse" = false, "updatedAt" = NOW()
       WHERE id = $1`,
      selector.value,
    )
  }
}
