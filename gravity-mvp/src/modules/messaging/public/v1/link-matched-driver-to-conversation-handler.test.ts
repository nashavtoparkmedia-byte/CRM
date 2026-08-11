import { describe, expect, it, vi } from 'vitest'

import {
    LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1,
    LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1,
    LinkMatchedDriverToConversationValidationError,
    parseLinkMatchedDriverToConversationCommandV1,
} from '@/contracts/messaging/v1'

import { createLinkMatchedDriverToConversationHandlerV1 } from './link-matched-driver-to-conversation-handler'

const { chatFindUnique, chatUpdateMany } = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdateMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: chatFindUnique,
            updateMany: chatUpdateMany,
        },
    },
}))

import { legacyPrismaMatchedDriverConversationLinkPortV1 } from './legacy-prisma-matched-driver-conversation-link-adapter'
import { linkMatchedDriverToConversationCapabilityV1 } from './index'

describe('LinkMatchedDriverToConversationCommand.v1', () => {
    it('accepts only the minimal matching-to-conversation command', () => {
        expect(parseLinkMatchedDriverToConversationCommandV1({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1,
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).toEqual({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1,
            chatId: 'chat-1',
            driverId: 'driver-1',
        })
        expect(() => parseLinkMatchedDriverToConversationCommandV1({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1,
            chatId: 'chat-1',
            driverId: 'driver-1',
            force: true,
        })).toThrow('unsupported command field(s): force')
    })

    it('distinguishes unsupported contract versions', () => {
        expect.assertions(2)
        try {
            parseLinkMatchedDriverToConversationCommandV1({
                contract: 'messaging.LinkMatchedDriverToConversationCommand.v2',
                chatId: 'chat-1',
                driverId: 'driver-1',
            })
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(LinkMatchedDriverToConversationValidationError)
            expect((error as LinkMatchedDriverToConversationValidationError).code)
                .toBe('UNSUPPORTED_CONTRACT_VERSION')
        }
    })

    it('delegates the closed command to the Messaging owner and preserves a conflict', async () => {
        const linkMatchedDriverToConversation = vi.fn().mockResolvedValue(false)
        const handler = createLinkMatchedDriverToConversationHandlerV1({
            linkMatchedDriverToConversation,
        })

        await expect(handler({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1,
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toEqual({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1,
            linked: false,
        })
        expect(linkMatchedDriverToConversation).toHaveBeenCalledWith({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })
    })
})

describe('matched-driver conversation persistence', () => {
    it('exposes a bound owner capability without making callers provide a contract', async () => {
        chatUpdateMany.mockResolvedValueOnce({ count: 1 })

        await expect(linkMatchedDriverToConversationCapabilityV1({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toEqual({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1,
            linked: true,
        })
        expect(chatUpdateMany).toHaveBeenCalledWith({
            where: { id: 'chat-1', driverId: null },
            data: { driverId: 'driver-1' },
        })
    })

    it('uses an atomic null-only update for the first driver link', async () => {
        chatUpdateMany.mockResolvedValueOnce({ count: 1 })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(true)

        expect(chatUpdateMany).toHaveBeenCalledWith({
            where: { id: 'chat-1', driverId: null },
            data: { driverId: 'driver-1' },
        })
        expect(chatFindUnique).not.toHaveBeenCalled()
    })

    it('does not overwrite a different existing driver link', async () => {
        chatUpdateMany.mockResolvedValueOnce({ count: 0 })
        chatFindUnique.mockResolvedValueOnce({ driverId: 'different-driver' })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(false)
        expect(chatFindUnique).toHaveBeenCalledWith({
            where: { id: 'chat-1' },
            select: { driverId: true },
        })
    })

    it('treats the same existing driver link as idempotently linked', async () => {
        chatUpdateMany.mockResolvedValueOnce({ count: 0 })
        chatFindUnique.mockResolvedValueOnce({ driverId: 'driver-1' })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(true)
    })
})
