import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ChannelConversationPersistencePortV1 } from './channel-conversation-handler'

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

function concreteString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized !== '' && normalized !== 'legacy' ? normalized : null
}

function hasExactProviderTransportBinding(metadata: unknown): boolean {
  const record = metadataRecord(metadata)
  return concreteString(record.providerAccountId) !== null
    && concreteString(record.connectionId) !== null
}

export const legacyPrismaChannelConversationPortV1: ChannelConversationPersistencePortV1 = {
  async upsert(input) {
    // A caller that supplies an exact provider+transport binding must validate
    // any existing row before changing it. Keep the conflict arm mutation-free
    // so a concurrent create cannot rename/reclassify another account's Chat.
    const update = hasExactProviderTransportBinding(input.metadata)
      ? {}
      : { name: input.name, chatType: input.chatType }
    return prisma.chat.upsert({
      where: { externalChatId: input.externalChatId },
      update,
      create: {
        externalChatId: input.externalChatId,
        channel: input.channel,
        name: input.name,
        chatType: input.chatType,
        metadata: input.metadata as Prisma.InputJsonValue,
      },
    })
  },
  async patch(selector, patch) {
    return prisma.chat.update({
      where: 'chatId' in selector
        ? { id: selector.chatId }
        : { externalChatId: selector.externalChatId },
      data: {
        name: patch.name,
        driverId: patch.driverId,
        externalChatId: patch.externalChatId,
        lastMessageAt: patch.lastMessageAt,
      },
    })
  },
}
