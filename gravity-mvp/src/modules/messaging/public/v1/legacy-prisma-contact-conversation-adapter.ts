import { prisma } from '@/lib/prisma'
import type { ContactConversationV1 } from '../../../../contracts/messaging/v1'
import type { ContactConversationPersistencePortV1 } from './contact-conversation-handler'

const CONVERSATION_SELECT = {
  id: true,
  channel: true,
  externalChatId: true,
  status: true,
  contactId: true,
  contactIdentityId: true,
} as const

function withBackfilledLinks(
  conversation: ContactConversationV1,
  input: { contactId: string; contactIdentityId: string },
): ContactConversationV1 {
  return {
    ...conversation,
    contactId: conversation.contactId ?? input.contactId,
    contactIdentityId: conversation.contactIdentityId ?? input.contactIdentityId,
  }
}

async function backfillMissingLinks(
  conversation: ContactConversationV1,
  input: { contactId: string; contactIdentityId: string },
): Promise<ContactConversationV1> {
  const data: { contactId?: string; contactIdentityId?: string } = {}
  if (conversation.contactId === null) data.contactId = input.contactId
  if (conversation.contactIdentityId === null) data.contactIdentityId = input.contactIdentityId
  if (Object.keys(data).length > 0) {
    await prisma.chat.update({
      where: { id: conversation.id },
      data,
    })
  }
  return withBackfilledLinks(conversation, input)
}

export const legacyPrismaContactConversationPortV1: ContactConversationPersistencePortV1 = {
  async findAndBackfill(input) {
    const conversation = await prisma.chat.findFirst({
      where: { contactId: input.contactId, channel: input.channel },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      select: CONVERSATION_SELECT,
    })
    if (!conversation) return null
    return backfillMissingLinks(conversation, input)
  },

  async openFallback(input) {
    let conversation = input.legacyDriverId
      ? await prisma.chat.findFirst({
          where: { driverId: input.legacyDriverId, channel: input.channel },
          orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
          select: CONVERSATION_SELECT,
        })
      : null

    if (!conversation) {
      conversation = await prisma.chat.findUnique({
        where: { externalChatId: input.externalChatId },
        select: CONVERSATION_SELECT,
      })
    }

    if (!conversation) {
      const created = await prisma.chat.create({
        data: {
          channel: input.channel,
          externalChatId: input.externalChatId,
          name: input.name,
          status: 'new',
          contactId: input.contactId,
          contactIdentityId: input.contactIdentityId,
        },
        select: CONVERSATION_SELECT,
      })
      return { conversation: created, isNew: true }
    }

    return {
      conversation: await backfillMissingLinks(conversation, input),
      isNew: false,
    }
  },
}
