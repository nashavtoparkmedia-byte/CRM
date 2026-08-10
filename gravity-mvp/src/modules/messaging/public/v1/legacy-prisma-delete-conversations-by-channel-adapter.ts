import { prisma } from '@/lib/prisma'
import type { DeleteConversationsByChannelPersistencePortV1 } from './delete-conversations-by-channel-handler'
export const legacyPrismaDeleteConversationsByChannelPortV1: DeleteConversationsByChannelPersistencePortV1 = { async deleteByChannel(channel) { const chats = await prisma.chat.findMany({ where: { channel }, select: { id: true } }); if (chats.length) await prisma.message.deleteMany({ where: { chatId: { in: chats.map((chat) => chat.id) } } }); await prisma.chat.deleteMany({ where: { channel } }) } }
