import { prisma } from '@/lib/prisma'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import {
  prepareOutboundConversationV1,
  type PreparedOutboundConversationV1,
} from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

export interface SendMessageParams {
  chatId:         string   // внутренний Chat.id
  externalChatId: string   // Chat.externalChatId (с префиксом или без)
  content:        string
  channel:        string
  connectionId?:  string   // ID соединения/профиля
}

export interface ChannelAdapter {
  send(params: SendMessageParams, binding: PreparedOutboundConversationV1): Promise<void>
}

// ─── MAX ──────────────────────────────────────────────────────────────────────

class MaxAdapter implements ChannelAdapter {
  async send(params: SendMessageParams, binding: PreparedOutboundConversationV1) {
    await getMaxChannelDeliveryV1().sendText({
      target: binding.target,
      content: params.content,
      options: {
        providerAccountId: binding.providerAccountId,
        connectionId: binding.connectionId,
        isPersonal: binding.isMaxPersonal,
      },
    })
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

class TelegramAdapter implements ChannelAdapter {
  async send(params: SendMessageParams, binding: PreparedOutboundConversationV1) {
    await getTelegramChannelDeliveryV1().sendText({
      target: binding.target,
      content: params.content,
      connectionId: binding.connectionId,
      metadata: { chatId: params.chatId },
    })
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

class WhatsAppAdapter implements ChannelAdapter {
  async send(params: SendMessageParams, binding: PreparedOutboundConversationV1) {
    await getWhatsAppChannelDeliveryV1().sendText({
      connectionId: binding.connectionId,
      chatId: binding.target,
      content: params.content,
    })
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** Messaging-owned routing from channel-neutral replies to provider delivery ports. */
class ChannelAdapterRegistry {
  private adapters = new Map<string, ChannelAdapter>([
    ['max',       new MaxAdapter()],
    ['telegram',  new TelegramAdapter()],
    ['whatsapp',  new WhatsAppAdapter()],
  ])

  has(channel: string): boolean {
    return this.adapters.has(channel)
  }

  async send(channel: string, params: SendMessageParams): Promise<void> {
    const adapter = this.adapters.get(channel)
    if (!adapter) throw new Error(`[ChannelRegistry] No adapter for channel: ${channel}`)
    if (params.channel !== channel) {
      throw new Error('CONTACT_CONVERSATION_CHANNEL_MISMATCH')
    }
    const chat = await prisma.chat.findUnique({
      where: { id: params.chatId },
      select: {
        id: true,
        contactId: true,
        contactIdentityId: true,
        channel: true,
        externalChatId: true,
        chatType: true,
        metadata: true,
      },
    })
    if (!chat) throw new Error(`Chat with ID ${params.chatId} not found`)
    const binding = await prepareOutboundConversationV1(chat, params.connectionId)
    if (binding.channel !== channel) {
      throw new Error('CONTACT_CONVERSATION_CHANNEL_MISMATCH')
    }
    await adapter.send(params, binding)
  }
}

export const channelRegistry = new ChannelAdapterRegistry()
