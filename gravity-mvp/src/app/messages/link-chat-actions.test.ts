import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    driverFindUnique: vi.fn(),
    driverFindMany: vi.fn(),
    ensureLink: vi.fn(),
    linkDriver: vi.fn(),
    revalidatePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findUnique: mocks.chatFindUnique },
        driver: {
            findUnique: mocks.driverFindUnique,
            findMany: mocks.driverFindMany,
        },
    },
}))
vi.mock('@/modules/messaging/public/v1', () => ({
    ensureConversationContactLinkV1: mocks.ensureLink,
    linkMatchedDriverToConversationCapabilityV1: mocks.linkDriver,
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

import { linkChatToDriverManually } from './link-chat-actions'

function linkedChat(overrides: Record<string, unknown> = {}) {
    return {
        id: 'chat-1',
        contactId: 'contact-a',
        contactIdentityId: 'identity-a',
        metadata: {},
        contactIdentity: { contactId: 'contact-a', isActive: true },
        contact: {
            id: 'contact-a',
            isArchived: false,
            mainDriverId: 'driver-a',
            customFields: {
                driverConfirmations: [{
                    id: 'confirmation-a',
                    representativeDriverId: 'driver-a',
                    profileClusterKey: 'vu:123',
                    status: 'confirmed',
                }],
            },
        },
        ...overrides,
    }
}

describe('manual Driver annotation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.driverFindUnique.mockResolvedValue({ id: 'driver-a' })
        mocks.ensureLink.mockResolvedValue({ linked: true })
        mocks.linkDriver.mockResolvedValue({ linked: true })
    })

    test('rejects an arbitrary Driver that is not the Contact confirmed person', async () => {
        mocks.chatFindUnique.mockResolvedValue(linkedChat())
        mocks.driverFindUnique.mockResolvedValue({ id: 'driver-b' })

        await expect(linkChatToDriverManually('chat-1', 'driver-b')).resolves.toEqual({
            error: expect.stringContaining('Это он'),
        })
        expect(mocks.ensureLink).not.toHaveBeenCalled()
        expect(mocks.linkDriver).not.toHaveBeenCalled()
    })

    test('delegates the annotation only for the exact confirmed main Driver', async () => {
        mocks.chatFindUnique.mockResolvedValue(linkedChat())

        await expect(linkChatToDriverManually('chat-1', 'driver-a')).resolves.toEqual({ success: true })
        expect(mocks.ensureLink).toHaveBeenCalledWith(expect.objectContaining({
            chatId: 'chat-1',
            contactId: 'contact-a',
            contactIdentityId: 'identity-a',
        }))
        expect(mocks.linkDriver).toHaveBeenCalledWith({ chatId: 'chat-1', driverId: 'driver-a' })
        expect(mocks.revalidatePath).toHaveBeenCalledWith('/messages')
    })

    test('rejects a pending reconciliation even when mainDriverId is present', async () => {
        const chat = linkedChat()
        ;(chat.contact.customFields.driverConfirmations[0] as Record<string, unknown>).status = 'needs_reconciliation'
        mocks.chatFindUnique.mockResolvedValue(chat)

        await expect(linkChatToDriverManually('chat-1', 'driver-a')).resolves.toEqual({
            error: expect.stringContaining('Это он'),
        })
        expect(mocks.linkDriver).not.toHaveBeenCalled()
    })
})
