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
    sendMedia(input: { target: string, internalChatId: string, providerAccountId: string | null, identityTarget: string, base64: string, filename: string, mimeType: string, caption?: string, connectionId?: string }): Promise<{ success: boolean, externalId?: string }>
    sendReaction(input: { connectionId?: string, internalChatId: string, providerAccountId: string | null, identityTarget: string, chatId: string, messageId: string, emoji: string, remove: boolean }): Promise<void>
}

export interface MaxTextDeliveryResultV1 {
    outcome: 'delivered' | 'pending'
    externalId: string | null
    resolvedChatId: string | null
}

export interface MaxTransportBindingV1 {
    /** Non-authoritative provider-account metadata; null when none is recorded. */
    providerAccountId: string | null
    connectionId?: string
    isPersonal: boolean
}

export interface MaxChannelDeliveryV1 {
    assertTransportBinding(input: MaxTransportBindingV1): void
    sendText(input: { target: string, content: string, options: { providerAccountId: string | null, name?: string, connectionId?: string, isPersonal?: boolean, quotedMsgId?: string, quotedText?: string, quotedSentAt?: string, quotedDirection?: string, uiChatId?: string, clientMessageId?: string } }): Promise<MaxTextDeliveryResultV1>
    sendMedia(input: MaxTransportBindingV1 & { chatId: string, base64: string, filename: string, mimeType: string, caption: string, mediaType: string }): Promise<{ externalId?: string }>
    sendReaction(input: MaxTransportBindingV1 & { chatId: string, messageId: string, emoji: string, remove: boolean }): Promise<{
        reactionConfirmed: boolean
        status?: string
    }>
    deleteMessage(input: MaxTransportBindingV1 & { chatId: string, messageId: string }): Promise<void>
}

interface ChannelDeliveryRegistryV1 {
    whatsapp: WhatsAppChannelDeliveryV1 | null
    telegram: TelegramChannelDeliveryV1 | null
    max: MaxChannelDeliveryV1 | null
}

/**
 * Next.js can load this module more than once in a single server process, one
 * copy per chunk. Module-scoped slots would then leave the copy that
 * instrumentation registered into populated while every other copy stays empty,
 * so sends fail as "not registered" in a process that is otherwise healthy.
 * A Symbol.for key resolves to the same symbol in every copy, which gives one
 * process-wide registry.
 */
const CHANNEL_DELIVERY_REGISTRY_SLOT = Symbol.for('yoko.messaging.channel-delivery-registry.v1')

function registry(): ChannelDeliveryRegistryV1 {
    const host = globalThis as typeof globalThis & {
        [CHANNEL_DELIVERY_REGISTRY_SLOT]?: ChannelDeliveryRegistryV1
    }
    if (!host[CHANNEL_DELIVERY_REGISTRY_SLOT]) {
        host[CHANNEL_DELIVERY_REGISTRY_SLOT] = { whatsapp: null, telegram: null, max: null }
    }
    return host[CHANNEL_DELIVERY_REGISTRY_SLOT]
}

export function registerWhatsAppChannelDeliveryV1(capability: WhatsAppChannelDeliveryV1): void {
    registry().whatsapp = capability
}

export function registerTelegramChannelDeliveryV1(capability: TelegramChannelDeliveryV1): void {
    registry().telegram = capability
}

export function registerMaxChannelDeliveryV1(capability: MaxChannelDeliveryV1): void {
    registry().max = capability
}

function required<T>(capability: T | null, channel: string): T {
    if (!capability) throw new Error(`${channel} channel delivery capability is not registered`)
    return capability
}

export function getWhatsAppChannelDeliveryV1(): WhatsAppChannelDeliveryV1 {
    return required(registry().whatsapp, 'WhatsApp')
}

export function getTelegramChannelDeliveryV1(): TelegramChannelDeliveryV1 {
    return required(registry().telegram, 'Telegram')
}

export function getMaxChannelDeliveryV1(): MaxChannelDeliveryV1 {
    return required(registry().max, 'MAX')
}
