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
})
