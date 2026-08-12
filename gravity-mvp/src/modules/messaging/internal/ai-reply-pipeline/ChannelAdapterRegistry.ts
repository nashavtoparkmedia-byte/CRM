import { prisma } from '@/lib/prisma'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'

export interface SendMessageParams {
  chatId:         string   // внутренний Chat.id
  externalChatId: string   // Chat.externalChatId (с префиксом или без)
  content:        string
  channel:        string
  connectionId?:  string   // ID соединения/профиля
}

export interface ChannelAdapter {
  send(params: SendMessageParams): Promise<void>
}

// ─── MAX ──────────────────────────────────────────────────────────────────────

class MaxAdapter implements ChannelAdapter {
  async send(params: SendMessageParams) {
    await getMaxChannelDeliveryV1().sendText({
      target: params.externalChatId,
      content: params.content,
      options: { isPersonal: true },
    })
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

class TelegramAdapter implements ChannelAdapter {
  async send(params: SendMessageParams) {
    // externalChatId имеет вид "telegram:XXXXXXX" или просто ID
    const target = params.externalChatId.replace(/^telegram:/, '')
    await getTelegramChannelDeliveryV1().sendText({
      target,
      content: params.content,
      connectionId: params.connectionId,
    })
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

class WhatsAppAdapter implements ChannelAdapter {
  async send(params: SendMessageParams) {
    // externalChatId имеет вид "whatsapp:7XXXXXXXXXX"
    const target = params.externalChatId.replace(/^whatsapp:/, '')
    const connectionId = params.connectionId || await this._resolveConnectionId(params.chatId)
    if (!connectionId) throw new Error(`WhatsApp: no connectionId for chat ${params.chatId}`)
    await getWhatsAppChannelDeliveryV1().sendText({ connectionId, chatId: target, content: params.content })
  }

  private async _resolveConnectionId(chatId: string): Promise<string | null> {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { metadata: true }
    })
    return (chat?.metadata as any)?.connectionId || null
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
    await adapter.send(params)
  }
}

export const channelRegistry = new ChannelAdapterRegistry()
