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
    providerAccountId: string
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
