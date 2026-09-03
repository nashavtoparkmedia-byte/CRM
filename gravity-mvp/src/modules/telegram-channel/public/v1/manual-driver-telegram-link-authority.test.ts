import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findChat: vi.fn(),
    prepareOutbound: vi.fn(),
    isConfirmedMainDriver: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: { chat: { findUnique: mocks.findChat } },
}))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: mocks.prepareOutbound,
}))
vi.mock('@/modules/contacts/public/v1', () => ({
    isContactConfirmedMainDriverV1: mocks.isConfirmedMainDriver,
}))

import {
    prepareManualDriverTelegramLinkAuthorityV1,
    revalidatePreparedManualDriverTelegramLinkAuthorityV1,
} from './manual-driver-telegram-link-authority'

const chat = {
    id: 'chat-42',
    driverId: null,
    contactId: 'contact-1',
    contactIdentityId: 'identity-42',
    channel: 'telegram',
    externalChatId: 'telegram:42',
    chatType: 'private',
    metadata: {
        chatKind: 'private',
        providerAccountId: 'telegram-account-1',
        connectionId: 'telegram-connection-1',
    },
}

const outbound = {
    chatId: 'chat-42',
    channel: 'telegram',
    contactId: 'contact-1',
    contactIdentityId: 'identity-42',
    providerAccountId: 'telegram-account-1',
    connectionId: 'telegram-connection-1',
    identityTarget: '42',
    target: '42',
    isMaxPersonal: false,
}

const prepared = {
    chatId: outbound.chatId,
    contactId: outbound.contactId,
    contactIdentityId: outbound.contactIdentityId,
    providerAccountId: outbound.providerAccountId,
    connectionId: outbound.connectionId,
    identityTarget: outbound.identityTarget,
    target: outbound.target,
}

function serializedAuthorityClient(overrides: {
    chat?: Record<string, unknown> | null
    identity?: Record<string, unknown> | null
    contact?: Record<string, unknown> | null
} = {}) {
    return {
        chat: {
            findUnique: vi.fn(async () => overrides.chat === undefined ? chat : overrides.chat),
        },
        contactIdentity: {
            findUnique: vi.fn(async () => overrides.identity === undefined ? {
                id: 'identity-42',
                contactId: 'contact-1',
                channel: 'telegram',
                externalId: '42',
                isActive: true,
                reachabilityStatus: 'confirmed',
                metadata: {
                    providerAccountId: 'telegram-account-1',
                    conflictState: 'clear',
                },
            } : overrides.identity),
        },
        contact: {
            findUnique: vi.fn(async () => overrides.contact === undefined ? {
                id: 'contact-1',
                isArchived: false,
                mainDriverId: 'driver-1',
                customFields: {
                    driverConfirmations: [{
                        status: 'confirmed',
                        representativeDriverId: 'driver-1',
                    }],
                    identityConflicts: [],
                },
            } : overrides.contact),
        },
    }
}

describe('manual DriverTelegram authority preparation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findChat.mockResolvedValue(chat)
        mocks.prepareOutbound.mockResolvedValue(outbound)
        mocks.isConfirmedMainDriver.mockResolvedValue(true)
    })

    test('returns only an exact admitted private Telegram binding with a confirmed main Driver', async () => {
        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).resolves.toEqual({
            chatId: 'chat-42',
            contactId: 'contact-1',
            contactIdentityId: 'identity-42',
            providerAccountId: 'telegram-account-1',
            connectionId: 'telegram-connection-1',
            identityTarget: '42',
            target: '42',
        })
        expect(mocks.findChat).toHaveBeenCalledWith({
            where: { externalChatId: 'telegram:42' },
            select: {
                id: true,
                driverId: true,
                contactId: true,
                contactIdentityId: true,
                channel: true,
                externalChatId: true,
                chatType: true,
                metadata: true,
            },
        })
        expect(mocks.prepareOutbound).toHaveBeenCalledWith(chat)
        expect(mocks.isConfirmedMainDriver).toHaveBeenCalledWith('contact-1', 'driver-1')
    })

    test('fails closed when no exact persisted Chat exists', async () => {
        mocks.findChat.mockResolvedValue(null)

        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
        expect(mocks.prepareOutbound).not.toHaveBeenCalled()
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test.each([
        { chatType: 'group' },
        { metadata: { ...chat.metadata, chatKind: 'group' } },
        { driverId: 'different-driver' },
    ])('rejects a non-private or contradictory persisted Chat: %j', async patch => {
        mocks.findChat.mockResolvedValue({ ...chat, ...patch })

        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
        expect(mocks.prepareOutbound).not.toHaveBeenCalled()
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test('rejects a prepared identity bound to a different peer or account path', async () => {
        mocks.prepareOutbound.mockResolvedValue({ ...outbound, target: '99' })

        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test('rejects when Contacts does not confirm the requested Driver as main', async () => {
        mocks.isConfirmedMainDriver.mockResolvedValue(false)

        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    })
})

describe('serialized manual DriverTelegram authority revalidation', () => {
    test('accepts the unchanged exact Chat, identity, transport, and confirmed Driver proof', async () => {
        const client = serializedAuthorityClient()

        await expect(revalidatePreparedManualDriverTelegramLinkAuthorityV1(
            client as never,
            { driverId: 'driver-1', telegramId: 42n },
            prepared,
        )).resolves.toBeUndefined()

        expect(client.chat.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { externalChatId: 'telegram:42' },
        }))
        expect(client.contactIdentity.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'identity-42' },
        }))
        expect(client.contact.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'contact-1' },
        }))
    })

    test.each([
        ['main Driver changed', {
            contact: {
                id: 'contact-1', isArchived: false, mainDriverId: 'driver-2',
                customFields: { driverConfirmations: [] },
            },
        }, 'DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'],
        ['Driver contradiction opened', {
            contact: {
                id: 'contact-1', isArchived: false, mainDriverId: 'driver-1',
                customFields: {
                    driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-1' }],
                    identityConflicts: [{
                        status: 'open', conflictType: 'fleet_authoritative_person_contradiction',
                    }],
                },
            },
        }, 'DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'],
        ['Chat transport changed', {
            chat: {
                ...chat,
                metadata: { ...chat.metadata, connectionId: 'telegram-connection-2' },
            },
        }, 'DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'],
        ['identity moved', {
            identity: {
                id: 'identity-42', contactId: 'contact-2', channel: 'telegram', externalId: '42',
                isActive: true, reachabilityStatus: 'confirmed',
                metadata: { providerAccountId: 'telegram-account-1', conflictState: 'clear' },
            },
        }, 'DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'],
    ])('rejects when %s after the initial authority proof', async (_label, overrides, error) => {
        await expect(revalidatePreparedManualDriverTelegramLinkAuthorityV1(
            serializedAuthorityClient(overrides) as never,
            { driverId: 'driver-1', telegramId: 42n },
            prepared,
        )).rejects.toThrow(error)
    })
})
