import { describe, expect, test, vi } from 'vitest'

import {
    prepareOutboundConversationV1,
    registerOutboundConversationPreparerV1,
} from './outbound-conversation-identity-runtime'

describe('Messaging outbound conversation identity runtime', () => {
    test('delegates the exact snapshot and requested transport to the composed Platform Shell proof', async () => {
        const prepared = {
            chatId: 'chat-1',
            channel: 'telegram' as const,
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            providerAccountId: 'account-1',
            connectionId: 'connection-1',
            identityTarget: 'peer-1',
            target: 'peer-1',
            isMaxPersonal: false,
        }
        const preparer = vi.fn().mockResolvedValue(prepared)
        const snapshot = {
            id: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            channel: 'telegram',
            externalChatId: 'telegram:peer-1',
            metadata: { providerAccountId: 'account-1', connectionId: 'connection-1' },
        }
        const unregister = registerOutboundConversationPreparerV1(preparer)

        await expect(prepareOutboundConversationV1(snapshot, 'connection-1'))
            .resolves.toEqual(prepared)
        expect(preparer).toHaveBeenCalledWith(snapshot, 'connection-1')
        unregister()
        await expect(prepareOutboundConversationV1(snapshot))
            .rejects.toThrow('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
    })

    test('a recorded transport collision does not by itself refuse the conversation\'s own bound route', async () => {
        // Deliberate M1 decision, recorded in docs/design/provider-account-identity-v1.md.
        // A collision audit shows the peer was seen on ANOTHER transport, which is
        // routine once two company numbers share a contact. WhatsApp allows one
        // conversation per peer, so refusing the bound route permanently removes the
        // person's only WhatsApp route. It would also not catch the real hazard: a
        // re-paired bound slot records no collision at all. The contradicting inbound
        // event is refused at ingress, and the bound route stays governed by the
        // preparer's binding and target proof.
        const prepared = {
            chatId: 'chat-wa',
            channel: 'whatsapp' as const,
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            providerAccountId: 'slot-x',
            connectionId: 'slot-x',
            identityTarget: '79990000001@c.us',
            target: '79990000001@c.us',
            isMaxPersonal: false,
        }
        const preparer = vi.fn().mockResolvedValue(prepared)
        const snapshot = {
            id: 'chat-wa',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            channel: 'whatsapp',
            externalChatId: '79990000001@c.us',
            metadata: {
                connectionId: 'slot-x',
                channelIdentityCollisionAudit: [{
                    channel: 'whatsapp',
                    reason: 'transport_mismatch',
                    incomingConnectionId: 'slot-y',
                    existingConnectionId: 'slot-x',
                }],
            },
        }
        const unregister = registerOutboundConversationPreparerV1(preparer)
        try {
            await expect(prepareOutboundConversationV1(snapshot, 'slot-x')).resolves.toEqual(prepared)
            expect(preparer).toHaveBeenCalledWith(snapshot, 'slot-x')
        } finally {
            unregister()
        }
    })
})
