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
    /** Bound transport, or null when a legacy conversation has none and the caller must route it. */
    connectionId: string | null
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

function snapshotRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function concreteConnectionId(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Whether a detected transport collision has quarantined this conversation's
 * outbound route.
 *
 * A transport collision is a fact about a route, never about the person, so it
 * must fail closed on its own conversation. Inbound is refused at ingress. For
 * outbound, only a route whose send path cannot attest the company account is
 * exposed. Telegram MTProto compares the live getMe account with the bound
 * connection, the tg-bot compares the live bot account, and MAX requires the
 * scraper to echo the route account, so a reply there cannot leave through a
 * different company account. A WhatsApp connection id names a mutable pairing
 * slot and sending attests nothing. After ingress observed the peer on a
 * different slot than the one this conversation is bound to, the bound slot can
 * no longer be trusted to be the account the peer talks to, and replying through
 * it would treat that mismatch as normal.
 *
 * The evidence is Messaging's own conversation audit, which every revision of
 * the WhatsApp ingress chain has written. Every entry on a bound WhatsApp
 * conversation is such a mismatch, so trimming the bounded audit always keeps
 * one. Only an entry that names a different, concrete binding is disregarded.
 */
export function isOutboundRouteQuarantinedV1(chat: OutboundConversationSnapshotV1): boolean {
    if (chat.channel !== 'whatsapp') return false
    const metadata = snapshotRecord(chat.metadata)
    const audit = metadata.channelIdentityCollisionAudit
    if (!Array.isArray(audit)) return false
    const boundConnectionId = concreteConnectionId(metadata.connectionId)
    return audit.some(item => {
        const entry = snapshotRecord(item)
        if (entry.channel !== 'whatsapp' || entry.reason !== 'transport_mismatch') return false
        const contradictedConnectionId = concreteConnectionId(entry.existingConnectionId)
        return contradictedConnectionId === null
            || boundConnectionId === null
            || contradictedConnectionId === boundConnectionId
    })
}

export async function prepareOutboundConversationV1(
    chat: OutboundConversationSnapshotV1,
    requestedConnectionId?: string,
): Promise<PreparedOutboundConversationV1> {
    const preparer = globalThis.__outboundConversationPreparerV1
    if (!preparer) {
        throw new Error('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
    }
    if (isOutboundRouteQuarantinedV1(chat)) {
        throw new Error('CONTACT_CONVERSATION_TRANSPORT_COLLISION')
    }
    return preparer(chat, requestedConnectionId)
}
