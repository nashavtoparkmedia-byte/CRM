import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'

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

    await prisma.$executeRaw`
      UPDATE "Chat"
      SET "unreadCount" = "unreadCount" + 1,
          "requiresResponse" = true,
          "lastInboundAt" = ${sentAt},
          status = ${newStatus},
          "updatedAt" = NOW()
      WHERE id = ${chatId}
    `
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

    await prisma.$executeRaw`
      UPDATE "Chat"
      SET "requiresResponse" = false,
          "lastOutboundAt" = ${sentAt},
          status = ${newStatus},
          "updatedAt" = NOW()
      WHERE id = ${chatId}
    `
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

    // Build group condition
    const condition = chat.contactId
      ? Prisma.sql`"contactId" = ${chat.contactId}`
      : chat.driverId
        ? Prisma.sql`"driverId" = ${chat.driverId}`
        : Prisma.sql`id = ${chatId}`

    await prisma.$executeRaw`
      UPDATE "Chat"
      SET "assignedToUserId" = ${userId},
          status = ${newStatus},
          "updatedAt" = NOW()
      WHERE ${condition}
    `
  }

  /**
   * Unassign chat. Updates all chats in the group.
   */
  static async unassignChat(chatId: string): Promise<void> {
    const condition = await this._getGroupCondition(chatId)

    await prisma.$executeRaw`
      UPDATE "Chat"
      SET "assignedToUserId" = NULL,
          "updatedAt" = NOW()
      WHERE ${condition}
    `
  }

  /**
   * Resolve chat. Updates all chats in the group.
   */
  static async resolveChat(chatId: string): Promise<void> {
    const condition = await this._getGroupCondition(chatId)

    await prisma.$executeRaw`
      UPDATE "Chat"
      SET status = 'resolved',
          "requiresResponse" = false,
          "updatedAt" = NOW()
      WHERE ${condition}
    `
  }

  /**
   * Reopen chat.
   */
  static async reopenChat(chatId: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "Chat"
      SET status = 'open',
          "updatedAt" = NOW()
      WHERE id = ${chatId}
    `
  }

  /**
   * Mark all chats in the group as read (unreadCount=0).
   */
  static async markRead(chatId: string): Promise<void> {
    const condition = await this._getGroupCondition(chatId)

    await prisma.$executeRaw`
      UPDATE "Chat"
      SET "unreadCount" = 0,
          "updatedAt" = NOW()
      WHERE ${condition}
    `
  }

  /**
   * Get SQL condition for group operations (all chats of same person).
   */
  private static async _getGroupCondition(chatId: string): Promise<Prisma.Sql> {
    const rows = await prisma.$queryRaw<Array<{ contactId: string | null; driverId: string | null }>>`
      SELECT "contactId", "driverId" FROM "Chat" WHERE id = ${chatId}
    `
    if (rows.length === 0) return Prisma.sql`id = ${chatId}`

    const chat = rows[0]
    if (chat.contactId) return Prisma.sql`"contactId" = ${chat.contactId}`
    if (chat.driverId) return Prisma.sql`"driverId" = ${chat.driverId}`
    return Prisma.sql`id = ${chatId}`
  }
}
