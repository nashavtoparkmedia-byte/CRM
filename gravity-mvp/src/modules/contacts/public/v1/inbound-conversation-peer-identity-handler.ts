import {
    RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_RESULT_V1,
    parseResolveInboundConversationPeerIdentityQueryV1,
    type ContactConversationChannelV1,
    type ContactConversationContactV1,
    type InboundConversationPeerIdentityV1,
    type ResolveInboundConversationPeerIdentityQueryV1,
    type ResolveInboundConversationPeerIdentityResultV1,
} from '../../../../contracts/contacts/v1'

export type ResolveInboundConversationPeerIdentityPersistenceResultV1 =
    | {
        status: 'ready'
        contact: ContactConversationContactV1
        peerIdentity: InboundConversationPeerIdentityV1
    }
    | {
        status:
            | 'contact_not_found'
            | 'peer_identity_not_found'
            | 'peer_identity_conflicted'
            | 'linked_identity_not_found'
    }

export interface InboundConversationPeerIdentityPersistencePortV1 {
    resolveInboundConversationPeerIdentity(input: {
        contactId: string
        channel: ContactConversationChannelV1
        peerExternalId: string
        linkedIdentityId: string
    }): Promise<ResolveInboundConversationPeerIdentityPersistenceResultV1>
}

export function createResolveInboundConversationPeerIdentityHandlerV1(
    port: InboundConversationPeerIdentityPersistencePortV1,
) {
    return async function resolveInboundConversationPeerIdentityV1(
        query: ResolveInboundConversationPeerIdentityQueryV1 | unknown,
    ): Promise<ResolveInboundConversationPeerIdentityResultV1> {
        const parsed = parseResolveInboundConversationPeerIdentityQueryV1(query)
        const resolved = await port.resolveInboundConversationPeerIdentity({
            contactId: parsed.contactId,
            channel: parsed.channel,
            peerExternalId: parsed.peerExternalId,
            linkedIdentityId: parsed.linkedIdentityId,
        })

        if (resolved.status !== 'ready') {
            return {
                contract: RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_RESULT_V1,
                status: resolved.status,
            }
        }

        return {
            contract: RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_RESULT_V1,
            status: 'ready',
            contact: resolved.contact,
            peerIdentity: resolved.peerIdentity,
        }
    }
}
