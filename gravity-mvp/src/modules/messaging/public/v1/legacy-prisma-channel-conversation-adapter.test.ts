import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  chatUpsert: vi.fn(),
  chatUpdate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: {
      upsert: mocks.chatUpsert,
      update: mocks.chatUpdate,
    },
  },
}))

import { legacyPrismaChannelConversationPortV1 } from './legacy-prisma-channel-conversation-adapter'

describe('channel conversation provider-bound upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatUpsert.mockResolvedValue({ id: 'chat-1' })
  })

  test('keeps the conflict arm mutation-free when account and transport are exact', async () => {
    await legacyPrismaChannelConversationPortV1.upsert({
      externalChatId: 'telegram:42',
      channel: 'telegram',
      name: '@new-name',
      chatType: 'private',
      metadata: {
        providerAccountId: 'telegram-bot-1',
        connectionId: 'telegram-connection-1',
      },
    })

    expect(mocks.chatUpsert).toHaveBeenCalledWith({
      where: { externalChatId: 'telegram:42' },
      update: {},
      create: {
        externalChatId: 'telegram:42',
        channel: 'telegram',
        name: '@new-name',
        chatType: 'private',
        metadata: {
          providerAccountId: 'telegram-bot-1',
          connectionId: 'telegram-connection-1',
        },
      },
    })
  })

  test('retains the legacy rename behavior without a complete exact binding', async () => {
    await legacyPrismaChannelConversationPortV1.upsert({
      externalChatId: 'telegram:42',
      channel: 'telegram',
      name: '@new-name',
      chatType: 'private',
      metadata: { connectionId: 'telegram-connection-1' },
    })

    expect(mocks.chatUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { name: '@new-name', chatType: 'private' },
    }))
  })
})
