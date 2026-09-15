import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  identityFindUnique: vi.fn(),
  chatFindUnique: vi.fn(),
  chatUpdateMany: vi.fn(),
  chatCreate: vi.fn(),
  chatUpdate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contactIdentity: { findUnique: mocks.identityFindUnique },
    chat: {
      findUnique: mocks.chatFindUnique,
      updateMany: mocks.chatUpdateMany,
      create: mocks.chatCreate,
      update: mocks.chatUpdate,
    },
  },
}))

import { legacyPrismaLeadConversationPortV1 as port } from './legacy-prisma-lead-conversation-adapter'

const input = {
  contactId: 'contact-a',
  contactIdentityId: 'identity-a',
  channel: 'avito' as const,
  providerAccountId: 'avito-account-7',
  externalChatId: 'avito:avito-account-7:lead-42',
  name: 'Candidate',
  receivedAt: new Date('2026-09-02T00:00:00.000Z'),
  metadata: { source: 'avito', providerAccountId: 'wrong-caller-value' },
}

const identity = {
  contactId: input.contactId,
  channel: input.channel,
  isActive: true,
  metadata: { providerAccountId: input.providerAccountId },
}

const chat = {
  id: 'chat-a',
  channel: input.channel,
  contactId: input.contactId,
  contactIdentityId: input.contactIdentityId,
  metadata: { providerAccountId: input.providerAccountId, source: 'avito' },
}

describe('lead conversation exact identity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.identityFindUnique.mockResolvedValue(identity)
    mocks.chatFindUnique.mockResolvedValue(null)
    mocks.chatUpdateMany.mockResolvedValue({ count: 1 })
    mocks.chatCreate.mockResolvedValue({ id: 'chat-new' })
  })

  test('creates one conversation bound to the exact identity and provider account', async () => {
    await expect(port.ensure(input)).resolves.toEqual({ chatId: 'chat-new' })

    expect(mocks.chatCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalChatId: input.externalChatId,
        contactId: input.contactId,
        contactIdentityId: input.contactIdentityId,
        metadata: {
          source: 'avito',
          providerAccountId: input.providerAccountId,
        },
      }),
    })
  })

  test('reuses only an exact persisted tuple', async () => {
    mocks.chatFindUnique.mockResolvedValue(chat)

    await expect(port.ensure(input)).resolves.toEqual({ chatId: chat.id })
    expect(mocks.chatUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: chat.id,
        contactId: input.contactId,
        contactIdentityId: input.contactIdentityId,
        channel: input.channel,
      }),
    }))
    expect(mocks.chatCreate).not.toHaveBeenCalled()
  })

  test('does not collapse two identities merely because Contact and channel match', async () => {
    mocks.chatFindUnique.mockResolvedValue({ ...chat, contactIdentityId: 'identity-b' })

    await expect(port.ensure(input)).rejects.toThrow('LEAD_CONVERSATION_IDENTITY_COLLISION')
    expect(mocks.chatUpdateMany).not.toHaveBeenCalled()
    expect(mocks.chatCreate).not.toHaveBeenCalled()
  })

  test('rejects an identity from another provider account before any Chat mutation', async () => {
    mocks.identityFindUnique.mockResolvedValue({
      ...identity,
      metadata: { providerAccountId: 'avito-account-8' },
    })

    await expect(port.ensure(input)).rejects.toThrow('LEAD_CONVERSATION_IDENTITY_MISMATCH')
    expect(mocks.chatFindUnique).not.toHaveBeenCalled()
    expect(mocks.chatCreate).not.toHaveBeenCalled()
  })
})
