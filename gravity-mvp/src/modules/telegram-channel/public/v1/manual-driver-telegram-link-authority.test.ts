import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findChat: vi.fn(),
    findIdentity: vi.fn(),
    findContact: vi.fn(),
    isConfirmedMainDriver: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findUnique: mocks.findChat },
        contactIdentity: { findUnique: mocks.findIdentity },
        contact: { findUnique: mocks.findContact },
    },
}))
vi.mock('@/modules/contacts/public/v1', () => ({
    isContactConfirmedMainDriverV1: mocks.isConfirmedMainDriver,
}))

import {
    prepareDriverTelegramConversationAuthorityV1,
    prepareManualDriverTelegramLinkAuthorityV1,
    revalidatePreparedManualDriverTelegramLinkAuthorityV1,
} from './manual-driver-telegram-link-authority'

const BOT_CONNECTION = 'driver-bot-primary'
/** The single production MTProto personal-account transport. */
const MTPROTO_CONNECTION = '1982527911'

/**
 * The exact production shape: a legacy Telegram Chat carries NO chatKind and NO
 * provider account, and its stored connection — when it has one at all — names
 * the MTProto personal-account transport, not the Driver Bot.
 */
const legacyChat = {
    id: 'chat-42',
    driverId: null,
    contactId: 'contact-1',
    contactIdentityId: 'identity-42',
    channel: 'telegram',
    externalChatId: 'telegram:42',
    chatType: 'private',
}

const identity = {
    id: 'identity-42',
    contactId: 'contact-1',
    channel: 'telegram',
    externalId: '42',
    isActive: true,
    reachabilityStatus: 'confirmed',
    metadata: {},
}

const contact = {
    id: 'contact-1',
    isArchived: false,
    mainDriverId: 'driver-1',
    customFields: {
        driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-1' }],
        identityConflicts: [],
    },
}

const prepared = {
    chatId: 'chat-42',
    contactId: 'contact-1',
    contactIdentityId: 'identity-42',
    providerAccountId: null,
    connectionId: BOT_CONNECTION,
    identityTarget: '42',
    target: '42',
} as const

function serializedAuthorityClient(overrides: {
    chat?: Record<string, unknown> | null
    identity?: Record<string, unknown> | null
    contact?: Record<string, unknown> | null
} = {}) {
    return {
        chat: {
            findUnique: vi.fn(async () => overrides.chat === undefined
                ? { ...legacyChat, metadata: { connectionId: MTPROTO_CONNECTION } }
                : overrides.chat),
        },
        contactIdentity: {
            findUnique: vi.fn(async () => overrides.identity === undefined ? identity : overrides.identity),
        },
        contact: {
            findUnique: vi.fn(async () => overrides.contact === undefined ? contact : overrides.contact),
        },
    }
}

describe('Driver Telegram person/conversation authority', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', BOT_CONNECTION)
        mocks.findChat.mockResolvedValue(legacyChat)
        mocks.findIdentity.mockResolvedValue(identity)
        mocks.findContact.mockResolvedValue(contact)
        mocks.isConfirmedMainDriver.mockResolvedValue(true)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    test('proves a legacy Chat that carries no chatKind, provider account or Bot transport', async () => {
        await expect(prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).resolves.toEqual({
            chatId: 'chat-42',
            contactId: 'contact-1',
            contactIdentityId: 'identity-42',
            driverId: 'driver-1',
            target: '42',
        })
        expect(mocks.isConfirmedMainDriver).toHaveBeenCalledWith('contact-1', 'driver-1')
    })

    test('returns no transport fields at all', async () => {
        const person = await prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })
        expect(person).not.toHaveProperty('providerAccountId')
        expect(person).not.toHaveProperty('connectionId')
    })

    test('never reads the shared Chat transport metadata', async () => {
        await prepareDriverTelegramConversationAuthorityV1({ driverId: 'driver-1', telegramId: 42n })

        const [[chatQuery]] = mocks.findChat.mock.calls
        expect(chatQuery.where).toEqual({ externalChatId: 'telegram:42' })
        expect(chatQuery.select).not.toHaveProperty('metadata')
    })

    test('fails closed when no exact persisted Chat exists', async () => {
        mocks.findChat.mockResolvedValue(null)

        await expect(prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test.each([
        ['group conversation', { chatType: 'group' }],
        ['foreign channel', { channel: 'max' }],
        ['wrong conversation key', { externalChatId: 'telegram:99' }],
        ['another Driver already owns it', { driverId: 'different-driver' }],
    ])('rejects a non-private or contradictory persisted Chat: %s', async (_label, patch) => {
        mocks.findChat.mockResolvedValue({ ...legacyChat, ...patch })

        await expect(prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test.each([
        ['no Contact bound', { contactId: null }],
        ['no ContactIdentity bound', { contactIdentityId: null }],
    ])('rejects an unbound conversation: %s', async (_label, patch) => {
        mocks.findChat.mockResolvedValue({ ...legacyChat, ...patch })

        await expect(prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test.each([
        ['missing identity', null],
        ['inactive identity', { ...identity, isActive: false }],
        ['identity of another Contact', { ...identity, contactId: 'contact-2' }],
        ['identity on another channel', { ...identity, channel: 'max' }],
        ['identity naming another peer', { ...identity, externalId: '99' }],
        ['unconfirmed reachability', { ...identity, reachabilityStatus: 'unknown' }],
        ['conflicted identity', { ...identity, metadata: { conflictState: 'conflicted' } }],
    ])('rejects a contradictory ContactIdentity: %s', async (_label, row) => {
        mocks.findIdentity.mockResolvedValue(row)

        await expect(prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
        expect(mocks.isConfirmedMainDriver).not.toHaveBeenCalled()
    })

    test('rejects when Contacts does not confirm the requested Driver as main', async () => {
        mocks.isConfirmedMainDriver.mockResolvedValue(false)

        await expect(prepareDriverTelegramConversationAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    })

    test.each([
        ['blank Driver', { driverId: '', telegramId: 42n }, 'DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'],
        ['zero peer', { driverId: 'driver-1', telegramId: 0n }, 'DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED'],
        ['negative peer', { driverId: 'driver-1', telegramId: -1n }, 'DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED'],
    ])('rejects malformed input: %s', async (_label, input, error) => {
        await expect(prepareDriverTelegramConversationAuthorityV1(input))
            .rejects.toThrow(error)
        expect(mocks.findChat).not.toHaveBeenCalled()
    })
})

describe('manual DriverTelegram link authority composition', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', BOT_CONNECTION)
        mocks.findChat.mockResolvedValue(legacyChat)
        mocks.findIdentity.mockResolvedValue(identity)
        mocks.findContact.mockResolvedValue(contact)
        mocks.isConfirmedMainDriver.mockResolvedValue(true)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    test('composes the person proof with the canonical configured Bot transport', async () => {
        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).resolves.toEqual({
            chatId: 'chat-42',
            contactId: 'contact-1',
            contactIdentityId: 'identity-42',
            providerAccountId: null,
            connectionId: BOT_CONNECTION,
            identityTarget: '42',
            target: '42',
        })
    })

    test('never adopts a Chat-derived MTProto transport', async () => {
        const authority = await prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })
        expect(authority.connectionId).not.toBe(MTPROTO_CONNECTION)
        expect(authority.providerAccountId).toBeNull()
    })

    test('fails closed when the canonical Bot transport is unconfigured', async () => {
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', '')

        await expect(prepareManualDriverTelegramLinkAuthorityV1({
            driverId: 'driver-1',
            telegramId: 42n,
        })).rejects.toThrow('TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN')
    })
})

describe('serialized manual DriverTelegram authority revalidation', () => {
    beforeEach(() => {
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', BOT_CONNECTION)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    test('accepts the unchanged exact Chat, identity and confirmed Driver proof', async () => {
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

    test('accepts a Chat whose stored transport names the MTProto personal account', async () => {
        // The shared Chat legitimately carries the other transport. That is not a
        // contradiction, and re-deriving the transport from it is exactly the
        // defect this hotfix removes.
        await expect(revalidatePreparedManualDriverTelegramLinkAuthorityV1(
            serializedAuthorityClient({
                chat: {
                    ...legacyChat,
                    metadata: {
                        connectionId: MTPROTO_CONNECTION,
                        providerAccountId: MTPROTO_CONNECTION,
                    },
                },
            }) as never,
            { driverId: 'driver-1', telegramId: 42n },
            prepared,
        )).resolves.toBeUndefined()
    })

    test('rejects a prepared proof whose transport no longer matches configuration', async () => {
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', 'driver-bot-rotated')

        await expect(revalidatePreparedManualDriverTelegramLinkAuthorityV1(
            serializedAuthorityClient() as never,
            { driverId: 'driver-1', telegramId: 42n },
            prepared,
        )).rejects.toThrow('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    })

    test('rejects a prepared proof that smuggles a provider account', async () => {
        await expect(revalidatePreparedManualDriverTelegramLinkAuthorityV1(
            serializedAuthorityClient() as never,
            { driverId: 'driver-1', telegramId: 42n },
            { ...prepared, providerAccountId: MTPROTO_CONNECTION } as never,
        )).rejects.toThrow('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
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
        ['conversation became a group', {
            chat: { ...legacyChat, chatType: 'group' },
        }, 'DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED'],
        ['Chat rebound to another identity', {
            chat: { ...legacyChat, contactIdentityId: 'identity-99' },
        }, 'DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'],
        ['identity moved', {
            identity: { ...identity, contactId: 'contact-2' },
        }, 'DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'],
        ['identity deactivated', {
            identity: { ...identity, isActive: false },
        }, 'DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'],
        ['identity conflicted', {
            identity: { ...identity, metadata: { conflictState: 'conflicted' } },
        }, 'DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'],
    ])('rejects when %s after the initial authority proof', async (_label, overrides, error) => {
        await expect(revalidatePreparedManualDriverTelegramLinkAuthorityV1(
            serializedAuthorityClient(overrides) as never,
            { driverId: 'driver-1', telegramId: 42n },
            prepared,
        )).rejects.toThrow(error)
    })
})
