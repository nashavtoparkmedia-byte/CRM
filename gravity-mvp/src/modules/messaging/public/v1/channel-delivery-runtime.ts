/**
 * Runtime-only ports for the three channel owners. Messaging owns the send
 * workflow; channel contexts register the concrete transport capabilities at
 * process startup. This keeps provider SDKs and session state out of Messaging.
 */
export interface WhatsAppChannelDeliveryV1 {
    sendText(input: { connectionId?: string, chatId: string, content: string, quotedMessageId?: string }): Promise<{ externalId: string }>
    sendMedia(input: { connectionId?: string, chatId: string, base64: string, filename: string, mimeType: string, caption?: string, sendAsVoice: boolean, sendAsDocument: boolean }): Promise<{ externalId: string }>
    sendReaction(input: { connectionId?: string, chatId: string, messageId: string, emoji: string, remove: boolean }): Promise<void>
}

export interface TelegramChannelDeliveryV1 {
    sendText(input: { target: string, content: string, connectionId?: string, metadata?: { messageId?: string, chatId?: string, driverId?: string, quotedMsgId?: string } }): Promise<unknown>
    sendMedia(input: { target: string, base64: string, filename: string, mimeType: string, caption?: string, connectionId?: string }): Promise<{ success: boolean, externalId?: string }>
    sendReaction(input: { connectionId?: string, chatId: string, messageId: string, emoji: string, remove: boolean }): Promise<void>
}

export interface MaxChannelDeliveryV1 {
    sendText(input: { target: string, content: string, options?: { name?: string, connectionId?: string, isPersonal?: boolean, quotedMsgId?: string, quotedText?: string, quotedSentAt?: string, quotedDirection?: string, uiChatId?: string, clientMessageId?: string } }): Promise<unknown>
    sendMedia(input: { chatId: number, base64: string, filename: string, mimeType: string, caption: string, mediaType: string, uiChatId?: string, phone?: string }): Promise<{ externalId?: string }>
    sendReaction(input: { chatId: string, messageId: string, emoji: string, remove: boolean }): Promise<{
        reactionConfirmed: boolean
        status?: string
    }>
}

let whatsappDelivery: WhatsAppChannelDeliveryV1 | null = null
let telegramDelivery: TelegramChannelDeliveryV1 | null = null
let maxDelivery: MaxChannelDeliveryV1 | null = null

export function registerWhatsAppChannelDeliveryV1(capability: WhatsAppChannelDeliveryV1): void {
    whatsappDelivery = capability
}

export function registerTelegramChannelDeliveryV1(capability: TelegramChannelDeliveryV1): void {
    telegramDelivery = capability
}

export function registerMaxChannelDeliveryV1(capability: MaxChannelDeliveryV1): void {
    maxDelivery = capability
}

function required<T>(capability: T | null, channel: string): T {
    if (!capability) throw new Error(`${channel} channel delivery capability is not registered`)
    return capability
}

export function getWhatsAppChannelDeliveryV1(): WhatsAppChannelDeliveryV1 {
    return required(whatsappDelivery, 'WhatsApp')
}

export function getTelegramChannelDeliveryV1(): TelegramChannelDeliveryV1 {
    return required(telegramDelivery, 'Telegram')
}

export function getMaxChannelDeliveryV1(): MaxChannelDeliveryV1 {
    return required(maxDelivery, 'MAX')
}
