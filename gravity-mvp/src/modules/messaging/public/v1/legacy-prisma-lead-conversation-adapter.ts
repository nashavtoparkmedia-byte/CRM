import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { LeadConversationPersistencePortV1 } from './lead-conversation-handler'

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function assertExactLeadIdentity(
  input: Parameters<LeadConversationPersistencePortV1['ensure']>[0],
  identity: {
    contactId: string
    channel: string
    isActive: boolean
    metadata: unknown
  } | null,
): void {
  const account = jsonRecord(identity?.metadata).providerAccountId
  if (!identity
    || !identity.isActive
    || identity.contactId !== input.contactId
    || identity.channel !== input.channel
    || account !== input.providerAccountId) {
    throw new Error('LEAD_CONVERSATION_IDENTITY_MISMATCH')
  }
}

function assertExactLeadConversation(
  input: Parameters<LeadConversationPersistencePortV1['ensure']>[0],
  chat: {
    contactId: string | null
    contactIdentityId: string | null
    channel: string
    metadata: unknown
  },
): void {
  const account = jsonRecord(chat.metadata).providerAccountId
  if (chat.contactId !== input.contactId
    || chat.contactIdentityId !== input.contactIdentityId
    || chat.channel !== input.channel
    || account !== input.providerAccountId) {
    throw new Error('LEAD_CONVERSATION_IDENTITY_COLLISION')
  }
}

export const legacyPrismaLeadConversationPortV1: LeadConversationPersistencePortV1 = {
  async ensure(input) {
    const identity = await prisma.contactIdentity.findUnique({
      where: { id: input.contactIdentityId },
      select: {
        contactId: true,
        channel: true,
        isActive: true,
        metadata: true,
      },
    })
    assertExactLeadIdentity(input, identity)

    const existing = await prisma.chat.findUnique({
      where: { externalChatId: input.externalChatId },
      select: {
        id: true,
        channel: true,
        contactId: true,
        contactIdentityId: true,
        metadata: true,
      },
    })
    if (existing) {
      assertExactLeadConversation(input, existing)
      const updated = await prisma.chat.updateMany({
        where: {
          id: existing.id,
          channel: input.channel,
          contactId: input.contactId,
          contactIdentityId: input.contactIdentityId,
          metadata: { equals: existing.metadata ?? undefined },
        },
        data: {
          lastMessageAt: input.receivedAt,
          lastInboundAt: input.receivedAt,
          requiresResponse: true,
          unreadCount: { increment: 1 },
        },
      })
      if (updated.count !== 1) throw new Error('LEAD_CONVERSATION_IDENTITY_COLLISION')
      return { chatId: existing.id }
    }

    const created = await prisma.chat.create({
      data: {
        channel: input.channel,
        externalChatId: input.externalChatId,
        contactId: input.contactId,
        contactIdentityId: input.contactIdentityId,
        name: input.name,
        status: 'new',
        requiresResponse: true,
        lastMessageAt: input.receivedAt,
        lastInboundAt: input.receivedAt,
        metadata: {
          ...input.metadata,
          providerAccountId: input.providerAccountId,
        } as Prisma.InputJsonValue,
      },
    })
    return { chatId: created.id }
  },

  async resolve(chatId) {
    await prisma.chat.update({
      where: { id: chatId },
      data: { requiresResponse: false, status: 'resolved' },
    })
  },
}
