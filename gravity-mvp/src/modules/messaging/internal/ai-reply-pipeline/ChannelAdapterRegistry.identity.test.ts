import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  chatFindUnique: vi.fn(),
  prepareOutbound: vi.fn(),
  maxSendText: vi.fn(),
  telegramSendText: vi.fn(),
  whatsAppSendText: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { chat: { findUnique: mocks.chatFindUnique } },
}))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
  prepareOutboundConversationV1: mocks.prepareOutbound,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
  getMaxChannelDeliveryV1: () => ({ sendText: mocks.maxSendText }),
  getTelegramChannelDeliveryV1: () => ({ sendText: mocks.telegramSendText }),
  getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.whatsAppSendText }),
}))

import { channelRegistry } from '@/modules/messaging/internal/ai-reply-pipeline/ChannelAdapterRegistry'

const chat = {
  id: 'chat-1',
  contactId: 'contact-1',
  contactIdentityId: 'identity-1',
  channel: 'telegram',
  externalChatId: 'telegram:spoofed-peer',
  chatType: 'private',
  metadata: { providerAccountId: 'spoofed-account', connectionId: 'spoofed-connection' },
}

function binding(channel: 'telegram' | 'whatsapp' | 'max') {
  return {
    chatId: 'chat-1',
    channel,
    contactId: 'contact-1',
    contactIdentityId: 'identity-1',
    providerAccountId: 'account-exact',
    connectionId: 'connection-exact',
    identityTarget: 'peer-exact',
    target: 'peer-exact',
    isMaxPersonal: false,
  }
}

function params(channel: 'telegram' | 'whatsapp' | 'max', connectionId?: string) {
  return {
    chatId: 'chat-1',
    externalChatId: `${channel}:spoofed-peer`,
    content: 'reply',
    channel,
    ...(connectionId ? { connectionId } : {}),
  }
}

describe('AI ChannelAdapterRegistry outbound identity preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatFindUnique.mockResolvedValue(chat)
    mocks.maxSendText.mockResolvedValue({ outcome: 'delivered', externalId: 'max-1', resolvedChatId: null })
    mocks.telegramSendText.mockResolvedValue({ externalId: 'telegram-1' })
    mocks.whatsAppSendText.mockResolvedValue({ externalId: 'whatsapp-1' })
  })

  test('fails before provider delivery when the persisted identity is not sendable', async () => {
    mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED'))

    await expect(channelRegistry.send('telegram', params('telegram')))
      .rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_REQUIRED')

    expect(mocks.telegramSendText).not.toHaveBeenCalled()
    expect(mocks.whatsAppSendText).not.toHaveBeenCalled()
    expect(mocks.maxSendText).not.toHaveBeenCalled()
  })

  test('uses only the prepared Telegram target and transport', async () => {
    mocks.prepareOutbound.mockResolvedValue(binding('telegram'))

    await channelRegistry.send('telegram', params('telegram', 'connection-exact'))

    expect(mocks.prepareOutbound).toHaveBeenCalledWith(chat, 'connection-exact')
    expect(mocks.telegramSendText).toHaveBeenCalledWith({
      target: 'peer-exact',
      content: 'reply',
      connectionId: 'connection-exact',
      metadata: { chatId: 'chat-1' },
    })
  })

  test('uses only the prepared WhatsApp target and transport', async () => {
    mocks.prepareOutbound.mockResolvedValue(binding('whatsapp'))

    await channelRegistry.send('whatsapp', params('whatsapp'))

    expect(mocks.whatsAppSendText).toHaveBeenCalledWith({
      connectionId: 'connection-exact',
      chatId: 'peer-exact',
      content: 'reply',
    })
  })

  test('uses only the prepared MAX target/account/transport tuple', async () => {
    mocks.prepareOutbound.mockResolvedValue(binding('max'))

    await channelRegistry.send('max', params('max'))

    expect(mocks.maxSendText).toHaveBeenCalledWith({
      target: 'peer-exact',
      content: 'reply',
      options: {
        providerAccountId: 'account-exact',
        connectionId: 'connection-exact',
        isPersonal: false,
      },
    })
  })

  test('rejects caller channel drift before resolving or delivering', async () => {
    await expect(channelRegistry.send('max', params('telegram')))
      .rejects.toThrow('CONTACT_CONVERSATION_CHANNEL_MISMATCH')

    expect(mocks.prepareOutbound).not.toHaveBeenCalled()
    expect(mocks.maxSendText).not.toHaveBeenCalled()
  })
})
