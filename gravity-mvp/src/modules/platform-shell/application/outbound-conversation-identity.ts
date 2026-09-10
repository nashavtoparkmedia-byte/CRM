import { PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1 } from '@/contracts/contacts/v1'
import { prepareContactConversationIdentityV1 } from '@/modules/contacts/public/v1'
import { getMaxChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { canonicalWhatsAppConversationTargetV1 } from '@/modules/whatsapp-channel/public/v1/identity-canonicalization'

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
    /** Exact ContactIdentity primary/alias accepted by the provider owner. */
    identityTarget: string
    /** Provider conversation destination; for MAX this is not the sender identity. */
    target: string
    isMaxPersonal: boolean
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function exactNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        ? value
        : null
}

function isChannel(value: string | null): value is OutboundConversationChannelV1 {
    return value === 'telegram' || value === 'whatsapp' || value === 'max'
}

function expectedConversationTarget(
    channel: OutboundConversationChannelV1,
    identityExternalId: string,
): string | null {
    if (channel === 'whatsapp') return canonicalWhatsAppConversationTargetV1(identityExternalId)
    if (channel === 'telegram') return `telegram:${identityExternalId}`
    return null
}

function providerTarget(
    channel: OutboundConversationChannelV1,
    externalChatId: string,
    identityExternalId: string,
): string {
    if (channel === 'telegram' || channel === 'whatsapp') return identityExternalId
    const prefix = `${channel}:`
    return externalChatId.startsWith(prefix)
        ? externalChatId.slice(prefix.length)
        : externalChatId
}

function isMaxPersonalConnection(connectionId: string): boolean {
    return connectionId === 'scraper' || connectionId === 'max_scraper'
}

/**
 * Cross-owner proof required immediately before an outbound provider mutation.
 *
 * A Chat id, Driver phone, suffix match, or caller-selected profile is not
 * identity evidence. This capability re-reads the Contacts-owned active
 * identity/reachability state and checks it against Messaging's exact persisted
 * peer, provider-account, and transport binding. It deliberately fails closed
 * for legacy and room rows that have no persisted ContactIdentity.
 */
export async function prepareOutboundConversationV1(
    chat: OutboundConversationSnapshotV1,
    requestedConnectionId?: string,
): Promise<PreparedOutboundConversationV1> {
    const chatId = exactNonEmptyString(chat.id)
    const contactId = exactNonEmptyString(chat.contactId)
    const contactIdentityId = exactNonEmptyString(chat.contactIdentityId)
    const channelValue = exactNonEmptyString(chat.channel)
    const externalChatId = exactNonEmptyString(chat.externalChatId)
    if (!contactIdentityId) throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
    if (!contactId || !isChannel(channelValue) || !externalChatId) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }
    const channel = channelValue

    const prepared = await prepareContactConversationIdentityV1({
        contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
        contactId,
        channel,
        identityId: contactIdentityId,
        phoneId: null,
    })
    if (prepared.status !== 'ready') {
        throw new Error(`CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:${prepared.status}`)
    }

    const metadata = record(chat.metadata)
    if (
        (channel === 'max' || channel === 'telegram')
        && (chat.chatType !== 'private' || metadata.chatKind !== 'private')
    ) {
        throw new Error('CONTACT_CONVERSATION_NOT_PRIVATE')
    }
    const declaredProviderAccountId = exactNonEmptyString(metadata.providerAccountId)
    const connectionId = exactNonEmptyString(metadata.connectionId)
    const requested = requestedConnectionId === undefined
        ? null
        : exactNonEmptyString(requestedConnectionId)
    if (requestedConnectionId !== undefined && !requested) {
        throw new Error('CONTACT_CONVERSATION_TRANSPORT_MISMATCH')
    }
    if (!connectionId) throw new Error('CONTACT_CONVERSATION_TRANSPORT_UNBOUND')
    if (requested && requested !== connectionId) {
        throw new Error('CONTACT_CONVERSATION_TRANSPORT_MISMATCH')
    }

    // A WhatsApp connection is also the provider-account scope. Older live
    // rows wrote only connectionId, so accept that exact owned value; when both
    // fields exist they must agree. Other channels may model account and
    // transport with distinct identifiers and therefore require the explicit
    // providerAccountId.
    if (
        channel === 'whatsapp'
        && declaredProviderAccountId
        && declaredProviderAccountId !== connectionId
    ) {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
    }
    const providerAccountId = channel === 'whatsapp'
        ? declaredProviderAccountId ?? connectionId
        : declaredProviderAccountId
    if (!providerAccountId || providerAccountId === 'legacy') {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN')
    }

    const identityExternalId = exactNonEmptyString(prepared.identity.externalId)
    const identityProviderAccountId = exactNonEmptyString(prepared.identity.providerAccountId)
    const matchedWhatsAppIdentityExternalId = channel === 'whatsapp'
        ? [identityExternalId, ...(prepared.identity.providerAliasValues ?? [])]
            .map(value => {
                const exactIdentityExternalId = exactNonEmptyString(value)
                return {
                    identityExternalId: exactIdentityExternalId,
                    conversationTarget: exactIdentityExternalId
                        ? canonicalWhatsAppConversationTargetV1(exactIdentityExternalId)
                        : null,
                }
            })
            .find(candidate => candidate.conversationTarget === externalChatId)
            ?.identityExternalId ?? null
        : null
    const targetMatches = channel === 'max'
        ? exactNonEmptyString(metadata.senderId) === identityExternalId
        : channel === 'whatsapp'
            ? matchedWhatsAppIdentityExternalId !== null
            : externalChatId === expectedConversationTarget(channel, identityExternalId ?? '')
    if (
        prepared.contact.id !== contactId
        || prepared.identity.id !== contactIdentityId
        || prepared.identity.channel !== channel
        || !identityExternalId
        || !identityProviderAccountId
        || identityProviderAccountId === 'legacy'
        || identityProviderAccountId !== providerAccountId
        || !targetMatches
    ) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }

    const isMaxPersonal = channel === 'max' && isMaxPersonalConnection(connectionId)
    if (channel === 'max') {
        getMaxChannelDeliveryV1().assertTransportBinding({
            providerAccountId,
            connectionId,
            isPersonal: isMaxPersonal,
        })
    }

    return {
        chatId,
        channel,
        contactId,
        contactIdentityId,
        providerAccountId,
        connectionId,
        identityTarget: matchedWhatsAppIdentityExternalId ?? identityExternalId,
        target: providerTarget(
            channel,
            externalChatId,
            matchedWhatsAppIdentityExternalId ?? identityExternalId,
        ),
        isMaxPersonal,
    }
}
