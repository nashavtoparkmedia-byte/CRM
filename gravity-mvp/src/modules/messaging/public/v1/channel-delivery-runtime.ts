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

export interface MaxTextDeliveryResultV1 {
    outcome: 'delivered' | 'pending'
    externalId: string | null
    resolvedChatId: string | null
}

export interface MaxChannelDeliveryV1 {
    sendText(input: { target: string, content: string, options?: { name?: string, connectionId?: string, isPersonal?: boolean, quotedMsgId?: string, quotedText?: string, quotedSentAt?: string, quotedDirection?: string, uiChatId?: string, clientMessageId?: string } }): Promise<MaxTextDeliveryResultV1>
    sendMedia(input: { chatId: number, base64: string, filename: string, mimeType: string, caption: string, mediaType: string, uiChatId?: string, phone?: string }): Promise<{ externalId?: string }>
    sendReaction(input: { chatId: string, messageId: string, emoji: string, remove: boolean }): Promise<{
        reactionConfirmed: boolean
        status?: string
    }>
}

/**
 * The registry is held on globalThis, not in module scope.
 *
 * The production build emits this module into many server chunks, and
 * `instrumentation` lands in its own. Module-level state would therefore give
 * each chunk its own registry: registration would succeed in the instrumentation
 * copy while every route handler still saw an empty one, and every send would
 * fail with "channel delivery capability is not registered". A process-wide slot
 * keyed by a shared symbol is resolved identically from any chunk.
 */
interface ChannelDeliveryRegistryV1 {
    whatsapp: WhatsAppChannelDeliveryV1 | null
    telegram: TelegramChannelDeliveryV1 | null
    max: MaxChannelDeliveryV1 | null
}

const REGISTRY_SLOT = Symbol.for('yoko.messaging.channel-delivery-registry.v1')

function registry(): ChannelDeliveryRegistryV1 {
    const host = globalThis as typeof globalThis & {
        [REGISTRY_SLOT]?: ChannelDeliveryRegistryV1
    }
    if (!host[REGISTRY_SLOT]) {
        host[REGISTRY_SLOT] = { whatsapp: null, telegram: null, max: null }
    }
    return host[REGISTRY_SLOT]
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

/**
 * Which channels can actually deliver right now. Readiness reporting must use
 * this rather than assuming registration succeeded: the failure this guards
 * against is invisible to a liveness probe, because the process serves HTTP
 * perfectly well while being unable to send a single message.
 */
export function channelDeliveryRegistrationStatusV1(): {
    ready: boolean
    registered: Array<'whatsapp' | 'telegram' | 'max'>
    missing: Array<'whatsapp' | 'telegram' | 'max'>
} {
    const current = registry()
    const channels: Array<'whatsapp' | 'telegram' | 'max'> = ['whatsapp', 'telegram', 'max']
    const registered = channels.filter(channel => current[channel] !== null)
    const missing = channels.filter(channel => current[channel] === null)
    return { ready: missing.length === 0, registered, missing }
}
