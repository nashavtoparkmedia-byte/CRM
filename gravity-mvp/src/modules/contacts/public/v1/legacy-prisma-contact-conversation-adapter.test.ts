import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    runTransaction: vi.fn(),
    lockRows: vi.fn(),
}))

vi.mock('@/lib/ContactService', () => ({ ContactService: {} }))
vi.mock('@/lib/contacts/SafeContactResolutionExecutor', () => ({
    isSafeContactResolutionSuccess: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/modules/contacts/internal/contact-ownership-coordinator', () => ({
    runContactOwnershipTransaction: mocks.runTransaction,
    lockContactOwnershipRows: mocks.lockRows,
}))

import { legacyPrismaContactConversationPortV1 as port } from './legacy-prisma-contact-conversation-adapter'

function transaction(
    reachabilityStatus: 'confirmed' | 'unreachable' | 'unknown' | null,
    options: {
        identityConflictState?: string
        openIdentityConflict?: boolean
        providerAccountId?: string
    } = {},
) {
    const contact = {
        findUnique: vi.fn().mockResolvedValue({
            id: 'contact-1',
            displayName: 'Contact One',
            isArchived: false,
            customFields: options.openIdentityConflict ? {
                identityConflicts: [{
                    identityId: 'identity-1',
                    conflictType: 'provider_account_identity_collision',
                    status: 'open',
                }],
            } : {},
        }),
    }
    const contactIdentity = {
        findFirst: vi.fn().mockResolvedValue(reachabilityStatus === null ? null : {
            id: 'identity-1',
            contactId: 'contact-1',
            channel: 'telegram',
            externalId: 'opaque-provider-user-42',
            isActive: true,
            reachabilityStatus,
            metadata: {
                conflictState: options.identityConflictState ?? 'clear',
                providerAccountId: options.providerAccountId ?? 'telegram-account-b',
            },
        }),
        findMany: vi.fn().mockResolvedValue(reachabilityStatus === null ? [] : [{
            id: 'identity-1',
            contactId: 'contact-1',
            channel: 'telegram',
            externalId: 'opaque-provider-user-42',
            isActive: true,
            reachabilityStatus,
            metadata: {
                conflictState: options.identityConflictState ?? 'clear',
                providerAccountId: options.providerAccountId ?? 'telegram-account-b',
            },
        }]),
        create: vi.fn(),
    }
    const contactPhone = {
        findFirst: vi.fn().mockResolvedValue({ id: 'phone-1', phone: '+79990000000' }),
    }
    return { contact, contactIdentity, contactPhone }
}

describe('Contacts outbound conversation identity preparation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lockRows.mockResolvedValue({})
        mocks.runTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
            throw new Error(`transaction not configured: ${String(work)}`)
        })
    })

    test.each([
        ['unreachable', 'identity_unreachable'],
        ['unknown', 'identity_reachability_unknown'],
    ] as const)('fails closed for %s reachability before any Messaging write', async (
        reachabilityStatus,
        expectedStatus,
    ) => {
        const tx = transaction(reachabilityStatus)
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).resolves.toEqual({ status: expectedStatus })

        expect(tx.contactIdentity.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'identity-1',
                contactId: 'contact-1',
                channel: 'telegram',
                isActive: true,
            },
        })
        expect(tx.contactPhone.findFirst).not.toHaveBeenCalled()
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    })

    test('returns the persisted opaque identity only when reachability is confirmed', async () => {
        const tx = transaction('confirmed')
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).resolves.toEqual({
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'Contact One' },
            identity: {
                id: 'identity-1',
                channel: 'telegram',
                externalId: 'opaque-provider-user-42',
                providerAliasValues: [],
                providerAccountId: 'telegram-account-b',
            },
        })
    })

    test('does not expose the legacy provider-account sentinel as exact ownership evidence', async () => {
        const tx = transaction('confirmed', { providerAccountId: 'legacy' })
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).resolves.toMatchObject({
            status: 'ready',
            identity: {
                providerAccountId: null,
            },
        })
    })

    test.each([
        { identityConflictState: 'conflicted' },
        { openIdentityConflict: true },
    ])('fails closed for identity-scoped conflict evidence before Messaging writes: %j', async options => {
        const tx = transaction('confirmed', options)
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).resolves.toEqual({ status: 'identity_conflicted' })

        expect(tx.contactPhone.findFirst).not.toHaveBeenCalled()
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    })

    test('a phone cannot be promoted into a stable provider identity', async () => {
        const tx = transaction(null)
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: null,
            phoneId: 'phone-1',
        })).resolves.toEqual({ status: 'no_identity' })

        expect(tx.contactPhone.findFirst).toHaveBeenCalledWith({
            where: { contactId: 'contact-1', isActive: true, id: 'phone-1' },
            orderBy: { isPrimary: 'desc' },
        })
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    })

    test('requires an exact identity when more than one active identity exists for the channel', async () => {
        const tx = transaction('confirmed')
        tx.contactIdentity.findMany.mockResolvedValue([
            {
                id: 'identity-1',
                contactId: 'contact-1',
                channel: 'telegram',
                externalId: 'opaque-provider-user-1',
                isActive: true,
                reachabilityStatus: 'confirmed',
            },
            {
                id: 'identity-2',
                contactId: 'contact-1',
                channel: 'telegram',
                externalId: 'opaque-provider-user-2',
                isActive: true,
                reachabilityStatus: 'confirmed',
            },
        ])
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: null,
            phoneId: null,
        })).resolves.toEqual({ status: 'identity_ambiguous' })

        expect(tx.contactIdentity.findMany).toHaveBeenCalledWith({
            where: { contactId: 'contact-1', channel: 'telegram', isActive: true },
            orderBy: { createdAt: 'asc' },
            take: 2,
        })
        expect(tx.contactPhone.findFirst).not.toHaveBeenCalled()
    })
})
