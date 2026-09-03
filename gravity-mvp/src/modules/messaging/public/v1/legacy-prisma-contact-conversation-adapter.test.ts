import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findMany: mocks.findMany,
            findUnique: mocks.findUnique,
            updateMany: mocks.updateMany,
            create: mocks.create,
        },
    },
}))

import { legacyPrismaContactConversationPortV1 as port } from './legacy-prisma-contact-conversation-adapter'

const input = {
    legacyDriverId: null,
    channel: 'telegram' as const,
    identityExternalId: 'opaque-provider-user-42',
    exactExternalChatIds: ['telegram:opaque-provider-user-42'],
    name: 'Mutable Display Name',
    contactId: 'contact-1',
    contactIdentityId: 'identity-1',
    providerAccountId: 'telegram-account-b',
}

function conversation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'chat-1',
        channel: 'telegram',
        externalChatId: 'telegram:opaque-provider-user-42',
        status: 'new',
        contactId: input.contactId,
        contactIdentityId: input.contactIdentityId,
        metadata: {
            providerAccountId: input.providerAccountId,
            connectionId: 'telegram-connection-b',
        },
        ...overrides,
    }
}

function conversationResult(overrides: Record<string, unknown> = {}) {
    const stored = conversation(overrides)
    const metadata = stored.metadata as Record<string, unknown>
    return {
        id: stored.id,
        channel: stored.channel,
        externalChatId: stored.externalChatId,
        status: stored.status,
        contactId: stored.contactId,
        contactIdentityId: stored.contactIdentityId,
        providerAccountId: typeof metadata.providerAccountId === 'string'
            ? metadata.providerAccountId
            : input.providerAccountId,
        transportConnectionId: typeof metadata.connectionId === 'string'
            ? metadata.connectionId
            : null,
    }
}

describe('Messaging outbound conversation ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findMany.mockResolvedValue([])
        mocks.findUnique.mockResolvedValue(null)
        mocks.updateMany.mockResolvedValue({ count: 1 })
        mocks.create.mockResolvedValue(conversation())
    })

    test.each([
        { links: { contactId: 'other-contact' }, error: 'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH' },
        { links: { contactIdentityId: 'other-identity' }, error: 'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH' },
        { links: { channel: 'max' }, error: 'CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH' },
        {
            links: { externalChatId: 'telegram:other-provider-user' },
            error: 'CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH',
        },
    ])('rejects target reuse outside the exact binding: $links', async ({ links, error }) => {
        mocks.findMany.mockResolvedValueOnce([conversation(links)])

        await expect(port.openFallback(input)).rejects.toThrow(error)
        expect(mocks.updateMany).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('reuses a Telegram target only for the exact Contact and ContactIdentity pair', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation()])

        await expect(port.openFallback(input)).resolves.toEqual({
            status: 'ready',
            conversation: conversationResult(),
            isNew: false,
        })
        expect(mocks.updateMany).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('reuses the canonical WhatsApp phone-JID Chat target supplied by the provider owner', async () => {
        const waInput = {
            ...input,
            channel: 'whatsapp' as const,
            identityExternalId: '79990001122@c.us',
            exactExternalChatIds: ['whatsapp:79990001122'],
            providerAccountId: 'wa-connection-1',
        }
        const waChat = conversation({
            channel: 'whatsapp',
            externalChatId: 'whatsapp:79990001122',
            metadata: {
                providerAccountId: 'wa-connection-1',
                connectionId: 'wa-connection-1',
            },
        })
        mocks.findMany.mockResolvedValueOnce([waChat])

        await expect(port.openFallback(waInput)).resolves.toMatchObject({
            status: 'ready',
            conversation: {
                externalChatId: 'whatsapp:79990001122',
                contactIdentityId: 'identity-1',
            },
        })
    })

    test('accepts an exact WhatsApp alias target without deriving a phone from an opaque LID', async () => {
        const waInput = {
            ...input,
            channel: 'whatsapp' as const,
            identityExternalId: 'opaque-peer@lid',
            exactExternalChatIds: ['opaque-peer@lid', 'whatsapp:79990001122'],
            providerAccountId: 'wa-connection-1',
        }
        mocks.findMany.mockResolvedValueOnce([conversation({
            channel: 'whatsapp',
            externalChatId: 'whatsapp:79990001122',
            metadata: {
                providerAccountId: 'wa-connection-1',
                connectionId: 'wa-connection-1',
            },
        })])

        await expect(port.openFallback(waInput)).resolves.toMatchObject({ status: 'ready' })
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                channel: 'whatsapp',
                externalChatId: { in: ['opaque-peer@lid', 'whatsapp:79990001122'] },
            },
        }))
    })

    test('does not fabricate a WhatsApp target from a bare legacy identity', async () => {
        await expect(port.openFallback({
            ...input,
            channel: 'whatsapp',
            identityExternalId: '79990001122',
            exactExternalChatIds: [],
            providerAccountId: 'wa-connection-1',
        })).resolves.toEqual({ status: 'conversation_target_unproven' })
        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('does not treat provider account ownership as transport proof for creation', async () => {
        await expect(port.openFallback(input))
            .resolves.toEqual({ status: 'transport_unbound' })

        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('finds an exact identity link and projects provider account and transport separately', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation()])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: input.providerAccountId,
            allowContactFallback: false,
        })).resolves.toEqual(conversationResult())

        expect(mocks.findMany).toHaveBeenCalledWith({
            where: { contactIdentityId: 'identity-1', channel: 'telegram' },
            orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
            take: 2,
            select: expect.any(Object),
        })
    })

    test('refuses to backfill a legacy Chat even when mutable metadata claims the provider account', async () => {
        const legacy = conversation({
            contactIdentityId: null,
            metadata: {
                legacy: true,
                providerAccountId: 'telegram-account-b',
                connectionId: 'telegram-connection-b',
            },
        })
        mocks.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([legacy])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: input.providerAccountId,
            allowContactFallback: true,
        })).resolves.toBeNull()

        expect(mocks.updateMany).not.toHaveBeenCalled()
    })

    test('performs zero mutation when an exact identity link is missing', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation({ contactIdentityId: null })])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: input.providerAccountId,
            allowContactFallback: false,
        })).resolves.toBeNull()
        expect(mocks.updateMany).not.toHaveBeenCalled()
    })

    test('does not claim a null identity link when the Chat account scope is missing', async () => {
        mocks.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([conversation({ contactIdentityId: null, metadata: {} })])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: input.providerAccountId,
            allowContactFallback: true,
        })).resolves.toBeNull()

        expect(mocks.updateMany).not.toHaveBeenCalled()
    })

    test('rejects an exact identity chat owned by another provider account', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation({
            metadata: {
                providerAccountId: 'telegram-account-a',
                connectionId: 'telegram-connection-b',
            },
        })])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: input.providerAccountId,
            allowContactFallback: false,
        })).rejects.toThrow('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_MISMATCH')

        expect(mocks.updateMany).not.toHaveBeenCalled()
    })

    test('fails closed when more than one chat claims the exact identity link', async () => {
        mocks.findMany.mockResolvedValueOnce([
            conversation(),
            conversation({ id: 'chat-2' }),
        ])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: input.providerAccountId,
            allowContactFallback: false,
        })).rejects.toThrow('CONTACT_CONVERSATION_AMBIGUOUS')
    })

    test('reuses the live MAX conversation id proven by its sender alias', async () => {
        const maxInput = {
            contactId: 'contact-1',
            contactIdentityId: 'identity-max',
            channel: 'max' as const,
            identityExternalId: 'sender-42',
            exactExternalChatIds: [],
            providerAccountId: 'max-default',
            allowContactFallback: false,
        }
        const maxChat = conversation({
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max-conversation-900',
            contactIdentityId: 'identity-max',
            metadata: {
                senderId: 'sender-42',
                providerAccountId: 'max-default',
                connectionId: 'max_scraper',
            },
        })
        mocks.findMany.mockResolvedValueOnce([maxChat])

        await expect(port.findAndBackfill(maxInput)).resolves.toEqual({
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max-conversation-900',
            status: 'new',
            contactId: 'contact-1',
            contactIdentityId: 'identity-max',
            providerAccountId: 'max-default',
            transportConnectionId: 'max_scraper',
        })

        expect(mocks.updateMany).not.toHaveBeenCalled()
    })

    test('rejects a MAX chat whose channel alias does not prove the identity sender', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation({
            channel: 'max',
            externalChatId: 'max-conversation-900',
            metadata: {
                senderId: 'other-sender',
                providerAccountId: 'max-default',
                connectionId: 'max_scraper',
            },
        })])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: 'max',
            identityExternalId: 'sender-42',
            exactExternalChatIds: [],
            providerAccountId: 'max-default',
            allowContactFallback: false,
        })).rejects.toThrow('CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH')
    })

    test('never creates a synthesized MAX conversation target', async () => {
        await expect(port.openFallback({
            ...input,
            channel: 'max',
            identityExternalId: 'sender-42',
            exactExternalChatIds: [],
            providerAccountId: 'max-default',
        })).resolves.toEqual({ status: 'conversation_target_unproven' })

        expect(mocks.create).not.toHaveBeenCalled()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    test('a live Telegram bot chat remains transport-unbound after provider ownership backfill', async () => {
        const botChat = conversation({
            externalChatId: 'telegram:4242',
            contactIdentityId: 'identity-bot',
            metadata: {},
        })
        mocks.findMany.mockResolvedValueOnce([botChat])

        await expect(port.openFallback({
            ...input,
            identityExternalId: '4242',
            exactExternalChatIds: ['telegram:4242'],
            contactIdentityId: 'identity-bot',
            providerAccountId: 'telegram-default',
        })).resolves.toEqual({ status: 'transport_unbound' })

        expect(mocks.updateMany).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('recovers a missing identity account only from exact existing Chat account evidence', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation()])

        await expect(port.findAndBackfill({
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: input.channel,
            identityExternalId: input.identityExternalId,
            exactExternalChatIds: input.exactExternalChatIds,
            providerAccountId: null,
            allowContactFallback: false,
        })).resolves.toEqual(conversationResult())

        expect(mocks.updateMany).not.toHaveBeenCalled()
    })

    test('does not backfill the legacy sentinel when neither identity nor Chat proves an account', async () => {
        mocks.findMany.mockResolvedValueOnce([conversation({ metadata: {} })])

        await expect(port.openFallback({ ...input, providerAccountId: null }))
            .resolves.toEqual({ status: 'provider_account_unproven' })

        expect(mocks.updateMany).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })
})
