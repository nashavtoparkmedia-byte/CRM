import { prisma } from '@/lib/prisma'

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
    const { sendMaxMessage } = await import('@/app/max-actions')
    await sendMaxMessage(params.externalChatId, params.content, { isPersonal: true })
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

class TelegramAdapter implements ChannelAdapter {
  async send(params: SendMessageParams) {
    const { sendTelegramMessage } = await import('@/app/tg-actions')
    // externalChatId имеет вид "telegram:XXXXXXX" или просто ID
    const target = params.externalChatId.replace(/^telegram:/, '')
    await sendTelegramMessage(target, params.content, params.connectionId)
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

class WhatsAppAdapter implements ChannelAdapter {
  async send(params: SendMessageParams) {
    const { sendMessage } = await import('@/lib/whatsapp/WhatsAppService')
    // externalChatId имеет вид "whatsapp:7XXXXXXXXXX"
    const target = params.externalChatId.replace(/^whatsapp:/, '')
    const connectionId = params.connectionId || await this._resolveConnectionId(params.chatId)
    if (!connectionId) throw new Error(`WhatsApp: no connectionId for chat ${params.chatId}`)
    await sendMessage(connectionId, target, params.content)
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
