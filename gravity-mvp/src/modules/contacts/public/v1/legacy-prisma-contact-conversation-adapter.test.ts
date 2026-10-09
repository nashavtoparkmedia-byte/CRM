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
import { createPrepareContactConversationIdentityHandlerV1 } from './contact-conversation-handler'
import {
    PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
    PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
    parsePrepareContactConversationIdentityCommandV1 as parsePrepare,
} from '@/contracts/contacts/v1'

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

/**
 * The production topology the inbound peer query exists for: one Contact, three active MAX
 * identities - a phone-shaped one, one whose externalId is the conversation key (which the
 * Chat is linked to), and the peer who actually speaks.
 */
function peerTransaction(options: {
    peerOwner?: 'same' | 'other'
    peerActive?: boolean
    peerMissing?: boolean
    peerChannel?: string
    peerConflictState?: string
    openPeerConflict?: boolean
    linkedMissing?: boolean
    linkedOwner?: 'same' | 'other'
    linkedChannel?: string
    archived?: boolean
    contactMissing?: boolean
    providerAccountId?: string | null
} = {}) {
    const peer = options.peerMissing ? null : {
        id: 'identity-peer',
        contactId: options.peerOwner === 'other' ? 'contact-other' : 'contact-1',
        channel: options.peerChannel ?? 'max',
        externalId: '902264026154',
        isActive: options.peerActive !== false,
        metadata: {
            conflictState: options.peerConflictState ?? 'clear',
            providerAccountId: options.providerAccountId === undefined ? 'max-account-a' : options.providerAccountId,
        },
    }
    const linked = options.linkedMissing ? null : {
        id: 'identity-chatkey',
        contactId: options.linkedOwner === 'other' ? 'contact-other' : 'contact-1',
        channel: options.linkedChannel ?? 'max',
        externalId: '902454841098',
        isActive: true,
        metadata: {},
    }
    const contact = {
        findUnique: vi.fn().mockResolvedValue(options.contactMissing ? null : {
            id: 'contact-1',
            displayName: 'User A',
            isArchived: options.archived === true,
            customFields: options.openPeerConflict ? {
                identityConflicts: [{ identityId: 'identity-peer', status: 'open' }],
            } : {},
        }),
    }
    // The fixture holds rows and applies the adapter's OWN where-clause to them, so every
    // predicate the adapter states is what decides the result. A fixture that re-implemented
    // ownership, active or channel itself would keep passing if the adapter dropped them.
    const rows = [linked, peer].filter(Boolean) as Array<Record<string, unknown>>
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
        Object.entries(where).every(([key, value]) => row[key] === value)
    const contactIdentity = {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
            rows.find(row => matches(row, args.where)) ?? null),
        findMany: vi.fn(),
        create: vi.fn(),
    }
    return { contact, contactIdentity, contactPhone: { findFirst: vi.fn() } }
}

describe('Contacts inbound conversation peer identity query', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lockRows.mockResolvedValue({})
    })

    const query = {
        contactId: 'contact-1',
        channel: 'max' as const,
        peerExternalId: '902264026154',
        linkedIdentityId: 'identity-chatkey',
    }

    test('resolves the peer identity while the Chat stays linked to the chat-key identity', async () => {
        const tx = peerTransaction()
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.resolveInboundConversationPeerIdentity(query)).resolves.toEqual({
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'User A' },
            peerIdentity: {
                kind: 'inbound_peer_identity',
                id: 'identity-peer',
                channel: 'max',
                externalId: '902264026154',
                providerAccountId: 'max-account-a',
            },
        })
        // nothing is created and both identity rows are locked for the read
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
        expect(mocks.lockRows).toHaveBeenCalledWith(tx, expect.objectContaining({
            contactIds: ['contact-1'],
            identityIds: ['identity-chatkey'],
            identities: [{ channel: 'max', externalId: '902264026154' }],
        }))
    })

    test('reachability is never consulted, so an unknown peer still resolves', async () => {
        const tx = peerTransaction()
        // the fixture carries no reachabilityStatus at all; a reachability-gated query
        // would have to read one, and 141 of 181 production MAX identities are 'unknown'
        mocks.runTransaction.mockImplementation(async work => work(tx))
        await expect(port.resolveInboundConversationPeerIdentity(query))
            .resolves.toMatchObject({ status: 'ready' })
    })

    test.each([
        ['the peer identity does not exist', { peerMissing: true }, 'peer_identity_not_found'],
        ['the peer identity belongs to another Contact', { peerOwner: 'other' as const }, 'peer_identity_not_found'],
        ['the peer identity is inactive', { peerActive: false }, 'peer_identity_not_found'],
        ['the peer identity is on another channel', { peerChannel: 'telegram' }, 'peer_identity_not_found'],
        ['the peer identity is flagged conflicted', { peerConflictState: 'conflicted' }, 'peer_identity_conflicted'],
        ['the Contact holds an open conflict on the peer', { openPeerConflict: true }, 'peer_identity_conflicted'],
        ["the Chat's linked identity is missing, inactive or foreign", { linkedMissing: true }, 'linked_identity_not_found'],
        // The linked identity must be scoped as strictly as the peer: a row that exists but
        // belongs to another Contact, or sits on another channel, is not this conversation's
        // link, and accepting it would let a foreign link authorize an inbound peer.
        ['the linked identity row belongs to another Contact', { linkedOwner: 'other' as const }, 'linked_identity_not_found'],
        ['the linked identity row is on another channel', { linkedChannel: 'telegram' }, 'linked_identity_not_found'],
        ['the Contact is archived', { archived: true }, 'contact_not_found'],
        ['the Contact does not exist', { contactMissing: true }, 'contact_not_found'],
    ])('refuses when %s', async (_label, options, status) => {
        const tx = peerTransaction(options)
        mocks.runTransaction.mockImplementation(async work => work(tx))
        await expect(port.resolveInboundConversationPeerIdentity(query)).resolves.toEqual({ status })
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    })

    test('a legacy provider-account stamp is reported as null rather than as an account', async () => {
        const tx = peerTransaction({ providerAccountId: 'legacy' })
        mocks.runTransaction.mockImplementation(async work => work(tx))
        await expect(port.resolveInboundConversationPeerIdentity(query))
            .resolves.toMatchObject({ peerIdentity: expect.objectContaining({ providerAccountId: null }) })
    })
})

describe('Contacts outbound conversation identity preparation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lockRows.mockResolvedValue({})
        mocks.runTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
            throw new Error(`transaction not configured: ${String(work)}`)
        })
    })

    test.each(['unreachable', 'unknown'] as const)(
        'admits a reply in an already bound conversation for %s reachability',
        async reachabilityStatus => {
            const tx = transaction(reachabilityStatus)
            mocks.runTransaction.mockImplementation(async work => work(tx))

            // The conversation already exists and is already bound to this exact
            // identity, so its own delivered history is the proof. Every identity
            // starts at 'unknown', so demanding a separate confirmation here
            // would reject ordinary replies on long-running threads.
            await expect(port.prepareContactConversationIdentity({
                contactId: 'contact-1',
                channel: 'telegram',
                purpose: 'send_in_bound_conversation',
                identityId: 'identity-1',
                phoneId: null,
            })).resolves.toMatchObject({ status: 'ready' })
        },
    )

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
            purpose: 'open_conversation',
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
            purpose: 'open_conversation',
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
            purpose: 'open_conversation',
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
            purpose: 'open_conversation',
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
            purpose: 'open_conversation',
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
            purpose: 'open_conversation',
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


/**
 * The exact OUTBOUND selector. The topology it exists for is the same one the inbound peer
 * query exists for: the Chat is linked to the identity whose externalId is the conversation
 * key, while the peer that must be sent to is a different identity of the same Contact. The
 * fixture therefore always holds BOTH rows and applies the adapter's own where-clause to
 * them, so every predicate that decides the answer is one the adapter actually states.
 */
function outboundExternalIdTransaction(options: {
    owner?: 'same' | 'other'
    active?: boolean
    missing?: boolean
    channel?: string
    conflictState?: string
    openConflict?: boolean
    reachabilityStatus?: 'confirmed' | 'unreachable' | 'unknown'
    archived?: boolean
} = {}) {
    const peer = options.missing ? null : {
        id: 'identity-peer',
        contactId: options.owner === 'other' ? 'contact-other' : 'contact-1',
        channel: options.channel ?? 'max',
        externalId: '902264026154',
        phoneId: null,
        isActive: options.active !== false,
        reachabilityStatus: options.reachabilityStatus ?? 'confirmed',
        metadata: {
            conflictState: options.conflictState ?? 'clear',
            providerAccountId: 'max-account-a',
        },
    }
    // The sibling the Chat is linked to. It is active, same-Contact, same-channel and
    // reachable, so it is exactly the row a fallback would wrongly select.
    const chatKey = {
        id: 'identity-chatkey',
        contactId: 'contact-1',
        channel: 'max',
        externalId: '902454841098',
        phoneId: null,
        isActive: true,
        reachabilityStatus: 'confirmed',
        metadata: { conflictState: 'clear', providerAccountId: 'max-account-a' },
    }
    const contact = {
        findUnique: vi.fn().mockResolvedValue({
            id: 'contact-1',
            displayName: 'User A',
            isArchived: options.archived === true,
            customFields: options.openConflict
                ? { identityConflicts: [{ identityId: 'identity-peer', status: 'open' }] }
                : {},
        }),
    }
    const rows = [chatKey, peer].filter(Boolean) as Array<Record<string, unknown>>
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
        Object.entries(where).every(([key, value]) => row[key] === value)
    const contactIdentity = {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
            rows.find(row => matches(row, args.where)) ?? null),
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
            rows.filter(row => matches(row, args.where)).slice(0, 2)),
        create: vi.fn(),
    }
    const contactPhone = {
        findFirst: vi.fn().mockResolvedValue({ id: 'phone-1', phone: '+79990000000' }),
    }
    return { contact, contactIdentity, contactPhone }
}

describe('PrepareContactConversationIdentityCommand.v1 external-id selector contract', () => {
    const legacyIdentityCommand = {
        contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
        contactId: 'contact-1',
        channel: 'max' as const,
        identityId: 'identity-chatkey',
        phoneId: null,
        purpose: 'send_in_bound_conversation' as const,
    }
    const externalIdCommand = {
        contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
        contactId: 'contact-1',
        channel: 'max' as const,
        identityId: null,
        phoneId: null,
        identityExternalId: '902264026154',
        purpose: 'send_in_bound_conversation' as const,
    }

    test('accepts the exact external-id selector and returns it unchanged', () => {
        expect(parsePrepare({ ...externalIdCommand })).toEqual(externalIdCommand)
    })

    test('a legacy identityId command is accepted byte for byte, with no injected field', () => {
        const parsed = parsePrepare({ ...legacyIdentityCommand })
        expect(parsed).toEqual(legacyIdentityCommand)
        expect(Object.keys(parsed).sort()).toEqual(Object.keys(legacyIdentityCommand).sort())
        expect('identityExternalId' in parsed).toBe(false)
    })

    test('a legacy phoneId command is accepted unchanged', () => {
        const command = { ...legacyIdentityCommand, identityId: null, phoneId: 'phone-1' }
        expect(parsePrepare({ ...command })).toEqual(command)
    })

    test('an explicit null selector means "not selected" and stays legacy', () => {
        const command = { ...legacyIdentityCommand, identityExternalId: null }
        expect(parsePrepare({ ...command })).toEqual(command)
    })

    test('both selectors supplied is rejected as ambiguous input', () => {
        expect(() => parsePrepare({
            ...externalIdCommand,
            identityId: 'identity-chatkey',
        })).toThrow(/identityExternalId cannot be combined/)
    })

    test('an external id combined with phoneId is rejected as ambiguous input', () => {
        expect(() => parsePrepare({ ...externalIdCommand, phoneId: 'phone-1' }))
            .toThrow(/identityExternalId cannot be combined/)
    })

    test.each([
        ['empty', ''],
        ['whitespace only', '   '],
        ['padded', ' 902264026154 '],
        ['not a string', 902264026154],
        ['an array', ['902264026154']],
    ])('refuses an external id that is %s', (_label, identityExternalId) => {
        expect(() => parsePrepare({ ...externalIdCommand, identityExternalId })).toThrow()
    })

    test('the selector does not loosen any other axis of the envelope', () => {
        expect(() => parsePrepare({ ...externalIdCommand, purpose: undefined })).toThrow()
        expect(() => parsePrepare({ ...externalIdCommand, channel: 'signal' })).toThrow()
        expect(() => parsePrepare({ ...externalIdCommand, contactId: '' })).toThrow()
        expect(() => parsePrepare({ ...externalIdCommand, senderId: '902264026154' })).toThrow()
        expect(() => parsePrepare({
            ...externalIdCommand,
            contract: 'contacts.PrepareContactConversationIdentityCommand.v2',
        })).toThrow(/unsupported contract version/)
    })
})

describe('prepare handler external-id selector mapping', () => {
    const ready = {
        status: 'ready' as const,
        contact: { id: 'contact-1', displayName: 'User A' },
        identity: {
            id: 'identity-peer',
            channel: 'max' as const,
            externalId: '902264026154',
            providerAccountId: 'max-account-a',
        },
    }

    function fakePort() {
        const calls: unknown[] = []
        return {
            calls,
            port: {
                async resolveChannelContact() { throw new Error('unexpected resolve') },
                async prepareContactConversationIdentity(input: unknown) {
                    calls.push(input)
                    return ready
                },
                async getPreferredActiveContactPhone() { throw new Error('unexpected phone') },
            },
        }
    }

    test('forwards the exact external id to the owner and keeps the result envelope', async () => {
        const { calls, port: fake } = fakePort()
        await expect(createPrepareContactConversationIdentityHandlerV1(fake)({
            contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
            contactId: 'contact-1',
            channel: 'max',
            identityId: null,
            phoneId: null,
            identityExternalId: '902264026154',
            purpose: 'send_in_bound_conversation',
        })).resolves.toEqual({
            contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
            ...ready,
        })
        expect(calls).toEqual([{
            contactId: 'contact-1',
            channel: 'max',
            identityId: null,
            phoneId: null,
            identityExternalId: '902264026154',
            purpose: 'send_in_bound_conversation',
        }])
    })

    test('a legacy command reaches the owner with the selector explicitly unselected', async () => {
        const { calls, port: fake } = fakePort()
        await createPrepareContactConversationIdentityHandlerV1(fake)({
            contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
            contactId: 'contact-1',
            channel: 'max',
            identityId: 'identity-chatkey',
            phoneId: null,
            purpose: 'send_in_bound_conversation',
        })
        expect(calls).toEqual([{
            contactId: 'contact-1',
            channel: 'max',
            identityId: 'identity-chatkey',
            phoneId: null,
            identityExternalId: null,
            purpose: 'send_in_bound_conversation',
        }])
    })

    test('an ambiguous selector is refused before the owner is consulted', async () => {
        const { calls, port: fake } = fakePort()
        await expect(createPrepareContactConversationIdentityHandlerV1(fake)({
            contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
            contactId: 'contact-1',
            channel: 'max',
            identityId: 'identity-chatkey',
            phoneId: null,
            identityExternalId: '902264026154',
            purpose: 'send_in_bound_conversation',
        })).rejects.toThrow(/identityExternalId cannot be combined/)
        expect(calls).toEqual([])
    })
})

describe('Contacts outbound conversation identity preparation by exact external id', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lockRows.mockResolvedValue({})
        mocks.runTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
            throw new Error(`transaction not configured: ${String(work)}`)
        })
    })

    const request = {
        contactId: 'contact-1',
        channel: 'max' as const,
        identityId: null,
        phoneId: null,
        identityExternalId: '902264026154',
        purpose: 'send_in_bound_conversation' as const,
    }

    test('prepares the peer identity while the Chat stays linked to the chat-key identity', async () => {
        const tx = outboundExternalIdTransaction()
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity(request)).resolves.toEqual({
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'User A' },
            identity: {
                id: 'identity-peer',
                channel: 'max',
                externalId: '902264026154',
                providerAliasValues: [],
                providerAccountId: 'max-account-a',
            },
        })
        // The exact row is read with ownership, channel and active in the same predicate.
        expect(tx.contactIdentity.findFirst).toHaveBeenCalledWith({
            where: {
                channel: 'max',
                externalId: '902264026154',
                contactId: 'contact-1',
                isActive: true,
            },
        })
        // The exact row is locked for the read, exactly as the inbound peer query locks it.
        expect(mocks.lockRows).toHaveBeenCalledWith(tx, expect.objectContaining({
            contactIds: ['contact-1'],
            identities: [{ channel: 'max', externalId: '902264026154' }],
        }))
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    })

    test.each([
        ['the exact identity belongs to another Contact', { owner: 'other' as const }],
        ['the exact identity is inactive', { active: false }],
        ['the exact identity sits on another channel', { channel: 'telegram' }],
        ['no identity in the channel carries the external id', { missing: true }],
    ])('fails closed when %s, with no fallback to a sibling identity', async (_label, options) => {
        const tx = outboundExternalIdTransaction(options)
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity(request))
            .resolves.toEqual({ status: 'identity_not_found' })
        // The sibling chat-key identity is active, same-Contact and reachable, so these
        // three assertions are what prove no fallback path was taken.
        expect(tx.contactIdentity.findMany).not.toHaveBeenCalled()
        expect(tx.contactPhone.findFirst).not.toHaveBeenCalled()
        expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    })

    test.each([
        ['the identity carries conflicted evidence', { conflictState: 'conflicted' }],
        ['the Contact holds an open conflict on it', { openConflict: true }],
    ])('returns the existing conflict result when %s', async (_label, options) => {
        const tx = outboundExternalIdTransaction(options)
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity(request))
            .resolves.toEqual({ status: 'identity_conflicted' })
        expect(tx.contactPhone.findFirst).not.toHaveBeenCalled()
    })

    test.each([
        ['unreachable', 'identity_unreachable'],
        ['unknown', 'identity_reachability_unknown'],
    ] as const)('keeps the open_conversation reachability gate for %s', async (
        reachabilityStatus,
        expectedStatus,
    ) => {
        const tx = outboundExternalIdTransaction({ reachabilityStatus })
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            ...request,
            purpose: 'open_conversation',
        })).resolves.toEqual({ status: expectedStatus })
    })

    test.each(['unreachable', 'unknown'] as const)(
        'keeps the bound-conversation reply semantics for %s reachability',
        async reachabilityStatus => {
            const tx = outboundExternalIdTransaction({ reachabilityStatus })
            mocks.runTransaction.mockImplementation(async work => work(tx))

            await expect(port.prepareContactConversationIdentity(request))
                .resolves.toMatchObject({ status: 'ready', identity: { id: 'identity-peer' } })
        },
    )

    test('an archived Contact fails closed before the identity is read', async () => {
        const tx = outboundExternalIdTransaction({ archived: true })
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity(request))
            .resolves.toEqual({ status: 'contact_not_found' })
        expect(tx.contactIdentity.findFirst).not.toHaveBeenCalled()
    })

    test('an unselected external id still takes the unchanged identityId path', async () => {
        const tx = outboundExternalIdTransaction()
        mocks.runTransaction.mockImplementation(async work => work(tx))

        await expect(port.prepareContactConversationIdentity({
            ...request,
            identityId: 'identity-chatkey',
            identityExternalId: null,
        })).resolves.toMatchObject({ status: 'ready', identity: { id: 'identity-chatkey' } })
        expect(tx.contactIdentity.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'identity-chatkey',
                contactId: 'contact-1',
                channel: 'max',
                isActive: true,
            },
        })
        expect(mocks.lockRows).toHaveBeenCalledWith(tx, {
            contactIds: ['contact-1'],
            identityIds: ['identity-chatkey'],
            phoneIds: [],
        })
    })
})
