import { describe, expect, test } from 'vitest'

import {
    RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1,
    parseResolveInboundConversationPeerIdentityQueryV1 as parse,
} from './inbound-conversation-peer-identity-query'

const valid = {
    contract: RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1,
    contactId: 'cmr5c2utp00emq52gv9104r2y',
    channel: 'max',
    peerExternalId: '902264026154',
    linkedIdentityId: 'cmr5c1yed00ehq52g2c0sjf06',
}

describe('inbound conversation peer identity query contract', () => {
    test('accepts the exact query', () => {
        expect(parse({ ...valid })).toEqual(valid)
    })

    test('the contract id is the inbound query, never the send-authorizing command', () => {
        expect(RESOLVE_INBOUND_CONVERSATION_PEER_IDENTITY_QUERY_V1)
            .toBe('contacts.ResolveInboundConversationPeerIdentityQuery.v1')
        expect(() => parse({ ...valid, contract: 'contacts.PrepareContactConversationIdentityCommand.v1' })).toThrow()
    })

    test.each([
        ['contract', { contract: 'contacts.SomethingElse.v1' }],
        ['contactId missing', { contactId: undefined }],
        ['contactId empty', { contactId: '' }],
        ['contactId not a string', { contactId: 42 }],
        ['channel unknown', { channel: 'signal' }],
        ['channel missing', { channel: undefined }],
        ['peerExternalId missing', { peerExternalId: undefined }],
        ['peerExternalId empty', { peerExternalId: '' }],
        ['peerExternalId not a string', { peerExternalId: 902264026154 }],
        ['linkedIdentityId missing', { linkedIdentityId: undefined }],
        ['linkedIdentityId empty', { linkedIdentityId: '' }],
        ['linkedIdentityId null', { linkedIdentityId: null }],
    ])('refuses a query whose %s is wrong', (_label, override) => {
        expect(() => parse({ ...valid, ...override })).toThrow()
    })

    test('refuses an unknown key rather than ignoring it', () => {
        expect(() => parse({ ...valid, purpose: 'open_conversation' })).toThrow()
    })

    test('refuses a non-object payload', () => {
        for (const payload of [null, undefined, 'query', 7, []]) {
            expect(() => parse(payload)).toThrow()
        }
    })

    test('a purpose axis cannot be smuggled in, and a future version is refused', () => {
        // Reachability answers "can we send"; this query authorizes no send. A purpose axis is
        // what made the previous candidate reject 141 of 181 production identities, so the
        // parser must refuse the key outright rather than ignore it.
        expect(() => parse({ ...valid, purpose: 'send_in_bound_conversation' })).toThrow()
        expect(() => parse({ ...valid, contract: 'contacts.ResolveInboundConversationPeerIdentityQuery.v2' })).toThrow()
    })
})
