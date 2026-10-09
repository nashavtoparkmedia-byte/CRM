import { prisma } from '@/lib/prisma'
import { resolveContactLineageV1 } from '@/modules/contacts/public/v1'
import type { ContactConversationsPortV1 } from './contact-conversations-query-handler'

export const legacyPrismaContactConversationsQueryPortV1: ContactConversationsPortV1 = {
  async canonicalContactId(contactId) {
    const lineage = await resolveContactLineageV1(contactId)
    return lineage ? lineage.canonicalContactId : null
  },
  async findPrivateConversations(contactIds, limit) {
    const chats = await prisma.chat.findMany({
      where: { contactId: { in: [...contactIds] }, chatType: 'private' },
      select: { id: true, channel: true, lastMessageAt: true, createdAt: true },
      // The contract's total order, stated in full so the database never picks
      // among equal rows by its own default.
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      take: limit,
    })
    return chats.map(chat => ({
      conversationId: chat.id,
      channel: chat.channel,
      lastActivityAt: chat.lastMessageAt,
      createdAt: chat.createdAt,
    }))
  },
}
