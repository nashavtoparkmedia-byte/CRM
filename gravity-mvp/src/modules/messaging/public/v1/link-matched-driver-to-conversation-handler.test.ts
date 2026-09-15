import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1,
    LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1,
    LinkMatchedDriverToConversationValidationError,
    parseLinkMatchedDriverToConversationCommandV1,
} from '@/contracts/messaging/v1'

import { createLinkMatchedDriverToConversationHandlerV1 } from './link-matched-driver-to-conversation-handler'

const mocks = vi.hoisted(() => ({
    transaction: {
        $queryRaw: vi.fn(),
        chat: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
        contact: {
            findUnique: vi.fn(),
        },
    },
    transactionRunner: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        $transaction: mocks.transactionRunner,
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
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.transactionRunner.mockImplementation(async (operation: (transaction: unknown) => unknown) => (
            operation(mocks.transaction)
        ))
        mocks.transaction.$queryRaw.mockResolvedValue([{ admitted: true }])
        mocks.transaction.chat.findUnique.mockResolvedValue({ contactId: null, driverId: null })
        mocks.transaction.chat.updateMany.mockResolvedValue({ count: 1 })
    })

    it('exposes a bound owner capability that fails closed for a Contactless Chat', async () => {
        await expect(linkMatchedDriverToConversationCapabilityV1({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toEqual({
            contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1,
            linked: false,
        })
        expect(mocks.transaction.chat.updateMany).not.toHaveBeenCalled()
    })

    it('does not turn a Contactless provider match into a canonical Driver link', async () => {
        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(false)

        expect(mocks.transaction.chat.updateMany).not.toHaveBeenCalled()
        expect(mocks.transaction.chat.findUnique).toHaveBeenCalledTimes(1)
        expect(mocks.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.transaction.chat.findUnique.mock.invocationCallOrder[0],
        )
    })

    it('does not overwrite a different existing driver link', async () => {
        mocks.transaction.chat.findUnique.mockResolvedValueOnce({
            contactId: 'contact-1',
            driverId: 'different-driver',
        })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(false)
        expect(mocks.transaction.contact.findUnique).not.toHaveBeenCalled()
        expect(mocks.transaction.chat.updateMany).not.toHaveBeenCalled()
    })

    it('treats the same existing driver link as idempotently linked', async () => {
        mocks.transaction.chat.findUnique.mockResolvedValueOnce({
            contactId: 'contact-1',
            driverId: 'driver-1',
        })
        mocks.transaction.contact.findUnique.mockResolvedValueOnce({
            id: 'contact-1',
            isArchived: false,
            mainDriverId: 'driver-1',
            customFields: {
                driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-1' }],
            },
        })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(true)
        expect(mocks.transaction.contact.findUnique).toHaveBeenCalledOnce()
        expect(mocks.transaction.chat.updateMany).not.toHaveBeenCalled()
    })

    it('links a Contact-owned Chat only with the exact canonical confirmed Driver', async () => {
        mocks.transaction.chat.findUnique.mockResolvedValueOnce({ contactId: 'contact-1', driverId: null })
        mocks.transaction.contact.findUnique.mockResolvedValueOnce({
            id: 'contact-1',
            isArchived: false,
            mainDriverId: 'driver-1',
            customFields: {
                driverConfirmations: [{
                    id: 'confirmation-1',
                    status: 'confirmed',
                    representativeDriverId: 'driver-1',
                }],
            },
        })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(true)

        expect(mocks.transaction.contact.findUnique).toHaveBeenCalledWith({
            where: { id: 'contact-1' },
            select: {
                id: true,
                isArchived: true,
                mainDriverId: true,
                customFields: true,
            },
        })
        expect(mocks.transaction.chat.updateMany).toHaveBeenCalledWith({
            where: { id: 'chat-1', contactId: 'contact-1', driverId: null },
            data: { driverId: 'driver-1' },
        })
    })

    it.each([
        {
            label: 'has no durable confirmation',
            contact: {
                id: 'contact-1', isArchived: false, mainDriverId: 'driver-1', customFields: {},
            },
        },
        {
            label: 'has a different canonical Driver',
            contact: {
                id: 'contact-1',
                isArchived: false,
                mainDriverId: 'driver-2',
                customFields: {
                    driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-1' }],
                },
            },
        },
        {
            label: 'has only a pending confirmation',
            contact: {
                id: 'contact-1',
                isArchived: false,
                mainDriverId: 'driver-1',
                customFields: {
                    driverConfirmations: [{ status: 'needs_reconciliation', representativeDriverId: 'driver-1' }],
                },
            },
        },
        {
            label: 'has only a contradicted confirmation',
            contact: {
                id: 'contact-1',
                isArchived: false,
                mainDriverId: 'driver-1',
                customFields: {
                    driverConfirmations: [{ status: 'contradicted', representativeDriverId: 'driver-1' }],
                },
            },
        },
        {
            label: 'has a confirmation for another representative Driver',
            contact: {
                id: 'contact-1',
                isArchived: false,
                mainDriverId: 'driver-1',
                customFields: {
                    driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-2' }],
                },
            },
        },
        {
            label: 'is archived',
            contact: {
                id: 'contact-1',
                isArchived: true,
                mainDriverId: 'driver-1',
                customFields: {
                    driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-1' }],
                },
            },
        },
    ])('fails closed without a Chat mutation when the Contact $label', async ({ contact }) => {
        mocks.transaction.chat.findUnique.mockResolvedValueOnce({ contactId: 'contact-1', driverId: null })
        mocks.transaction.contact.findUnique.mockResolvedValueOnce(contact)

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(false)

        expect(mocks.transaction.chat.updateMany).not.toHaveBeenCalled()
    })

    it('fails closed if the Contact binding changes before the null-only update', async () => {
        mocks.transaction.chat.findUnique
            .mockResolvedValueOnce({ contactId: 'contact-1', driverId: null })
            .mockResolvedValueOnce({ contactId: 'contact-2', driverId: null })
        mocks.transaction.contact.findUnique.mockResolvedValueOnce({
            id: 'contact-1',
            isArchived: false,
            mainDriverId: 'driver-1',
            customFields: {
                driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-1' }],
            },
        })
        mocks.transaction.chat.updateMany.mockResolvedValueOnce({ count: 0 })

        await expect(legacyPrismaMatchedDriverConversationLinkPortV1.linkMatchedDriverToConversation({
            chatId: 'chat-1',
            driverId: 'driver-1',
        })).resolves.toBe(false)

        expect(mocks.transaction.chat.updateMany).toHaveBeenCalledWith({
            where: { id: 'chat-1', contactId: 'contact-1', driverId: null },
            data: { driverId: 'driver-1' },
        })
    })
})
