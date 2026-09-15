import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    attachPhoneToIdentity: vi.fn(),
    chatFindMany: vi.fn(),
    patchChannelConversation: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findMany: mocks.chatFindMany,
        },
    },
}))

vi.mock('@/modules/messaging/public/v1', () => ({
    patchChannelConversationV1: mocks.patchChannelConversation,
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    attachPhoneToIdentityV1: mocks.attachPhoneToIdentity,
}))

import { PATCH_CHANNEL_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { enrichWaChatNameFromSibling } from './enrichChatName'

describe('WhatsApp chat-name enrichment', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('keeps a phone-like chat title as display data and never attaches it as phone evidence', async () => {
        mocks.chatFindMany.mockResolvedValue([{
            id: 'donor-chat',
            name: '+7 (922) 123-45-67',
            driverId: null,
        }])
        mocks.patchChannelConversation.mockResolvedValue(undefined)

        await expect(enrichWaChatNameFromSibling(
            'target-chat',
            null,
            'contact-1',
        )).resolves.toBe('+7 (922) 123-45-67')

        expect(mocks.patchChannelConversation).toHaveBeenCalledWith({
            contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1,
            selector: { chatId: 'target-chat' },
            patch: { name: '+7 (922) 123-45-67' },
        })
        expect(mocks.attachPhoneToIdentity).not.toHaveBeenCalled()
    })
})
