import {
    parseEnvelope,
    requireChannel,
    requireLegacyIdentifier,
    requireNonEmptyString,
    type ContactConversationChannelV1,
    type ContactConversationContactV1,
} from './contact-conversation-commands'

export const RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1 =
    'contacts.ResolveInboundConversationPeerIdentityQuery.v1' as const
export const RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_RESULT_V1 =
    'contacts.ResolveInboundConversationPeerIdentityResult.v1' as const

/**
 * Resolve the identity that an INBOUND message's peer speaks from, inside a conversation
 * that already exists and is already linked to this Contact.
 *
 * A conversation's linked identity is not always the peer's identity. A Chat can legitimately
 * be linked to an identity whose `externalId` is the conversation key, while the peer who
 * speaks in it is a different identity of the same Contact. Proving an inbound peer therefore
 * needs a lookup by the peer's exact external id within one Contact, which is what this query
 * answers.
 *
 * Reachability is deliberately NOT consulted. Reachability answers "can we send to this
 * identity", and this query never authorizes a send: an inbound peer has just spoken, which
 * is stronger evidence than any stored reachability flag. Send authorization stays with
 * `PrepareContactConversationIdentityCommand.v1`, which keeps its reachability gate.
 *
 * `peerIdentity.kind` marks the result as an inbound peer proof so its intent is legible at
 * every call site. That marker is documentation, not enforcement: TypeScript only rejects
 * excess properties on fresh object literals, so nothing in the type system prevents this
 * result being assigned where a send-authorizing prepared identity is expected. The boundary
 * is this contract's name, the tests that pin its callers, and review.
 */
export interface ResolveInboundConversationPeerIdentityQueryV1 {
    contract: typeof RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1
    contactId: string
    channel: ContactConversationChannelV1
    /** The peer's exact provider identifier, as the conversation recorded it. */
    peerExternalId: string
    /** The identity the conversation itself is linked to, which may be a different row. */
    linkedIdentityId: string
}

export interface InboundConversationPeerIdentityV1 {
    kind: 'inbound_peer_identity'
    id: string
    channel: ContactConversationChannelV1
    externalId: string
    providerAccountId: string | null
}

export type ResolveInboundConversationPeerIdentityStatusV1 =
    | 'ready'
    | 'contact_not_found'
    | 'peer_identity_not_found'
    | 'peer_identity_conflicted'
    | 'linked_identity_not_found'

export type ResolveInboundConversationPeerIdentityResultV1 =
    | {
        contract: typeof RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_RESULT_V1
        status: 'ready'
        contact: ContactConversationContactV1
        peerIdentity: InboundConversationPeerIdentityV1
    }
    | {
        contract: typeof RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_RESULT_V1
        status: Exclude<ResolveInboundConversationPeerIdentityStatusV1, 'ready'>
    }

export function parseResolveInboundConversationPeerIdentityQueryV1(
    input: unknown,
): ResolveInboundConversationPeerIdentityQueryV1 {
    const value = parseEnvelope(
        input,
        RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1,
        'contacts.ResolveInboundConversationPeerIdentityQuery.',
        ['contract', 'contactId', 'channel', 'peerExternalId', 'linkedIdentityId'],
    )
    requireLegacyIdentifier(value.contactId, 'contactId')
    requireChannel(value.channel)
    requireNonEmptyString(value.peerExternalId, 'peerExternalId')
    requireLegacyIdentifier(value.linkedIdentityId, 'linkedIdentityId')
    return value as unknown as ResolveInboundConversationPeerIdentityQueryV1
}
