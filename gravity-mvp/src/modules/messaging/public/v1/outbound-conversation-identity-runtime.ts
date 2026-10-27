import { CONTACT_COMMUNICATION_PERMISSION_QUERY_V1 } from '@/contracts/contacts/v1'
import { getContactCommunicationPermissionV1 } from '@/modules/contacts/public/v1'
import { channelDeliveryErrorV1 } from './channel-delivery-runtime'

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

/** The Contacts `message` permission a send was admitted under, read fresh for that one call. */
export interface OutboundContactPermissionV1 {
    canonicalContactId: string
    policyVersion: number
}

/** A proven route that Contacts also allows a message on: the only binding an effect may use. */
export interface GatedOutboundConversationV1 extends PreparedOutboundConversationV1 {
    contactPermission: OutboundContactPermissionV1
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
 * The route proof alone: which person, identity, transport and target this
 * conversation is bound to. It authorizes NO effect. Only retraction of the
 * CRM's own message and SendToContact route discovery may call it; every send
 * goes through prepareOutboundConversationV1.
 */
export async function proveOutboundConversationRouteV1(
    chat: OutboundConversationSnapshotV1,
    requestedConnectionId?: string,
): Promise<PreparedOutboundConversationV1> {
    const preparer = globalThis.__outboundConversationPreparerV1
    if (!preparer) {
        throw new Error('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
    }
    return preparer(chat, requestedConnectionId)
}

/**
 * The one boundary every outbound effect crosses to obtain a target: the
 * route proof, then a fresh Contacts `message` permission read for the
 * Contact the proof names (Contacts resolves its lineage). Nothing is cached
 * and no caller's planning check is trusted.
 *
 * A refusal is a typed delivery error, so it is classified exactly wherever it
 * is thrown, including inside an adapter after a row exists:
 *   - a standing refusal (restricted, unknown, archived, unsupported class) →
 *     terminal, MESSAGING_CONTACT_PERMISSION_REFUSED;
 *   - the store or the lineage could not be established, or the answer is not
 *     one Messaging can read → safe_to_redeliver,
 *     MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED.
 * Which reasons are standing is Contacts' ruling (its `retryable`), never
 * re-derived here.
 */
export async function prepareOutboundConversationV1(
    chat: OutboundConversationSnapshotV1,
    requestedConnectionId?: string,
): Promise<GatedOutboundConversationV1> {
    const binding = await proveOutboundConversationRouteV1(chat, requestedConnectionId)
    return { ...binding, contactPermission: await readContactMessagePermissionV1(binding.contactId) }
}

function permissionNotDispatched(reason: string): Error {
    return channelDeliveryErrorV1(
        `MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:${reason}`,
        'safe_to_redeliver',
        'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED',
    )
}

async function readContactMessagePermissionV1(contactId: string): Promise<OutboundContactPermissionV1> {
    let result: Record<string, unknown>
    try {
        const answer: unknown = await getContactCommunicationPermissionV1({
            contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
            contactId,
            communicationClass: 'message',
        })
        result = answer && typeof answer === 'object' ? answer as Record<string, unknown> : {}
    } catch {
        throw permissionNotDispatched('policy_unavailable')
    }
    const reason = typeof result.reason === 'string' && /^[a-z_]+$/.test(result.reason) ? result.reason : 'unreadable'
    if (result.requestedContactId !== contactId) throw permissionNotDispatched('unreadable')
    if (result.decision === 'allow') {
        const { canonicalContactId, policyVersion } = result
        if (typeof canonicalContactId !== 'string' || canonicalContactId === '' || !Number.isInteger(policyVersion)) {
            throw permissionNotDispatched('unreadable')
        }
        return { canonicalContactId, policyVersion: policyVersion as number }
    }
    if (result.decision === 'deny' && result.retryable === false) {
        throw channelDeliveryErrorV1(
            `MESSAGING_CONTACT_PERMISSION_REFUSED:${reason}`,
            'terminal',
            'MESSAGING_CONTACT_PERMISSION_REFUSED',
        )
    }
    throw permissionNotDispatched(reason)
}
