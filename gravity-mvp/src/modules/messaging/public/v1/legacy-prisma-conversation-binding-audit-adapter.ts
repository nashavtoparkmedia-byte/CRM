import { prisma } from '@/lib/prisma'
import { RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1 } from '@/contracts/contacts/v1'
import { resolveInboundConversationPeerIdentityV1 } from '@/modules/contacts/public/v1'
import type { ConversationBindingAuditPortV1 } from './conversation-binding-audit-handler'

/** Read-only: one page of bound private Telegram conversations, and Contacts' own peer query. */
export const legacyPrismaConversationBindingAuditPortV1: ConversationBindingAuditPortV1 = {
  async listBoundTelegramConversations(input) {
    const rows = await prisma.chat.findMany({
      where: {
        channel: 'telegram',
        chatType: 'private',
        contactId: { not: null },
        ...(input.afterChatId ? { id: { gt: input.afterChatId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: input.limit,
      select: {
        id: true,
        channel: true,
        chatType: true,
        externalChatId: true,
        contactId: true,
        contactIdentityId: true,
        contactIdentity: { select: { id: true, channel: true, externalId: true, contactId: true, isActive: true } },
      },
    })
    return rows.map(row => ({
      id: row.id,
      channel: row.channel,
      chatType: row.chatType,
      externalChatId: row.externalChatId,
      contactId: row.contactId,
      contactIdentityId: row.contactIdentityId,
      linkedIdentity: row.contactIdentity,
    }))
  },
  async resolvePeer(input) {
    const result = await resolveInboundConversationPeerIdentityV1({
      contract: RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1,
      contactId: input.contactId,
      channel: 'telegram',
      peerExternalId: input.peerExternalId,
      linkedIdentityId: input.linkedIdentityId,
    })
    return result.status
  },
}
