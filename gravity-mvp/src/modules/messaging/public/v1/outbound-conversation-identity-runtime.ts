export type OutboundConversationChannelV1 = 'telegram' | 'whatsapp' | 'max'

export interface OutboundConversationSnapshotV1 {
    id?: unknown
    contactId?: unknown
    contactIdentityId?: unknown
    channel?: unknown
    externalChatId?: unknown
    chatType?: unknown
    metadata?: unknown
}

export interface PreparedOutboundConversationV1 {
    chatId: string | null
    channel: OutboundConversationChannelV1
    contactId: string
    contactIdentityId: string
    /** Non-authoritative provider-account metadata; null when the conversation carries none. */
    providerAccountId: string | null
    connectionId: string
    identityTarget: string
    target: string
    isMaxPersonal: boolean
}

export type OutboundConversationPreparerV1 = (
    chat: OutboundConversationSnapshotV1,
    requestedConnectionId?: string,
) => Promise<PreparedOutboundConversationV1>

declare global {
    // Platform Shell supplies the cross-owner proof at process composition;
    // global state keeps the registration stable across Next.js module copies.
    var __outboundConversationPreparerV1: OutboundConversationPreparerV1 | undefined
}

/**
 * Messaging owns this dependency-inversion port; Platform Shell binds the
 * cross-owner Contacts/transport proof during process composition. Keeping the
 * callback here prevents Messaging from depending back on Platform Shell.
 */
export function registerOutboundConversationPreparerV1(
    preparer: OutboundConversationPreparerV1,
): () => void {
    if (typeof preparer !== 'function') throw new TypeError('preparer must be a function')
    const existing = globalThis.__outboundConversationPreparerV1
    if (existing && existing !== preparer) {
        throw new Error('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_ALREADY_REGISTERED')
    }
    globalThis.__outboundConversationPreparerV1 = preparer
    return () => {
        if (globalThis.__outboundConversationPreparerV1 === preparer) {
            globalThis.__outboundConversationPreparerV1 = undefined
        }
    }
}

/**
 * Resolves the ids of every currently active Telegram transport.
 *
 * Conversations created before transport stamping carry no connection binding,
 * and nothing can ever add one to an existing row. Production routes them today
 * by selecting the active default Telegram connection, so that same carrier is
 * the compatibility evidence for them. The resolver returns ALL active ids so
 * the caller can fail closed the moment more than one exists.
 */
export type ActiveTelegramCarrierResolverV1 = () => Promise<string[]>

declare global {
    var __activeTelegramCarrierResolverV1: ActiveTelegramCarrierResolverV1 | undefined
}

export function registerActiveTelegramCarrierResolverV1(
    resolver: ActiveTelegramCarrierResolverV1,
): () => void {
    if (typeof resolver !== 'function') throw new TypeError('resolver must be a function')
    globalThis.__activeTelegramCarrierResolverV1 = resolver
    return () => {
        if (globalThis.__activeTelegramCarrierResolverV1 === resolver) {
            globalThis.__activeTelegramCarrierResolverV1 = undefined
        }
    }
}

export async function activeTelegramCarrierIdsV1(): Promise<string[]> {
    const resolver = globalThis.__activeTelegramCarrierResolverV1
    if (!resolver) return []
    return resolver()
}

export async function prepareOutboundConversationV1(
    chat: OutboundConversationSnapshotV1,
    requestedConnectionId?: string,
): Promise<PreparedOutboundConversationV1> {
    const preparer = globalThis.__outboundConversationPreparerV1
    if (!preparer) {
        throw new Error('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
    }
    return preparer(chat, requestedConnectionId)
}
