import { beforeEach, describe, expect, it, vi } from 'vitest'

// messaging.ContactConversationsQuery.v1 — contract tests.
//
// The handler is driven through its port with an in-memory Chat table that
// applies exactly the adapter's filter (exact `contactId` link, private only),
// and the canonical Contact comes from Contacts' own merge-lineage handler over
// an in-memory Contact table, so Messaging is proven to consume that algorithm,
// not to carry a second one. The adapter tests at the end pin the one read the
// Prisma adapter makes and prove it touches nothing else and never writes.

const mocks = vi.hoisted(() => ({
    chatFindMany: vi.fn(),
    lineage: vi.fn(),
    write: vi.fn(() => { throw new Error('a read-only query must never write') }),
    forbiddenRead: vi.fn(() => { throw new Error('a contact conversations query must never read this model') }),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findMany: mocks.chatFindMany,
            findUnique: mocks.forbiddenRead,
            findFirst: mocks.forbiddenRead,
            update: mocks.write,
            updateMany: mocks.write,
            create: mocks.write,
            upsert: mocks.write,
            delete: mocks.write,
            deleteMany: mocks.write,
        },
        contact: { findMany: mocks.forbiddenRead, findUnique: mocks.forbiddenRead, findFirst: mocks.forbiddenRead, update: mocks.write },
        contactPhone: { findMany: mocks.forbiddenRead, findFirst: mocks.forbiddenRead, findUnique: mocks.forbiddenRead },
        contactIdentity: { findMany: mocks.forbiddenRead, findFirst: mocks.forbiddenRead, findUnique: mocks.forbiddenRead },
        driver: { findMany: mocks.forbiddenRead, findFirst: mocks.forbiddenRead, findUnique: mocks.forbiddenRead },
        message: { findMany: mocks.forbiddenRead, findFirst: mocks.forbiddenRead },
        $queryRaw: mocks.forbiddenRead,
        $queryRawUnsafe: mocks.forbiddenRead,
        $executeRaw: mocks.write,
        $executeRawUnsafe: mocks.write,
        $transaction: mocks.write,
    },
}))
vi.mock('@/modules/contacts/public/v1', () => ({ resolveContactLineageV1: mocks.lineage }))

import {
    CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1,
    CONTACT_CONVERSATIONS_QUERY_V1,
    CONTACT_CONVERSATIONS_RESULT_V1,
    ContactConversationsQueryValidationError,
    compareContactConversationsV1,
    contactChannelConversationsV1,
    type ContactConversationsEntryV1,
    type ContactConversationsFoundV1,
} from '../../../../contracts/messaging/v1'
import { createResolveContactLineageHandlerV1 } from '../../../contacts/public/v1/contact-lineage-handler'
import {
    createContactConversationsQueryHandlerV1,
    type ContactConversationsPortV1,
} from './contact-conversations-query-handler'
import { legacyPrismaContactConversationsQueryPortV1 } from './legacy-prisma-contact-conversations-query-adapter'

type ChatRow = {
    id: string
    contactId: string | null
    channel: string
    chatType: string
    status: string
    lastMessageAt: Date | null
    createdAt: Date
    // Fields that exist on a Chat and must never cross the contract.
    externalChatId: string
    metadata: unknown
    contactIdentityId: string | null
    driverId: string | null
    name: string | null
}
type ContactRow = { id: string; mergedIntoContactId: string | null }

let chats: ChatRow[]
let contacts: ContactRow[]
let merges: Array<{ survivorId: string; mergedId: string }>
let reads: string[]

const lineage = createResolveContactLineageHandlerV1({
    async findRedirect(contactId) {
        const contact = contacts.find(row => row.id === contactId)
        return contact ? { id: contact.id, mergedIntoContactId: contact.mergedIntoContactId } : null
    },
    async findMergedContactIds(survivorId) {
        return merges.filter(merge => merge.survivorId === survivorId).map(merge => merge.mergedId)
    },
})

function byContractOrder(left: ChatRow, right: ChatRow): number {
    const a = left.lastMessageAt?.getTime() ?? null
    const b = right.lastMessageAt?.getTime() ?? null
    if (a !== b) {
        if (a === null) return 1
        if (b === null) return -1
        return b - a
    }
    if (left.createdAt.getTime() !== right.createdAt.getTime()) return right.createdAt.getTime() - left.createdAt.getTime()
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

const port: ContactConversationsPortV1 = {
    async canonicalContactId(contactId) {
        reads.push(`lineage:${contactId}`)
        const resolved = await lineage(contactId)
        return resolved ? resolved.canonicalContactId : null
    },
    async findPrivateConversations(contactIds, limit) {
        reads.push(`chats:${[...contactIds].join(',')}:${limit}`)
        return chats
            .filter(chat => chat.contactId !== null && contactIds.includes(chat.contactId) && chat.chatType === 'private')
            .sort(byContractOrder)
            .slice(0, limit)
            .map(chat => ({ conversationId: chat.id, channel: chat.channel, lastActivityAt: chat.lastMessageAt, createdAt: chat.createdAt }))
    },
}

const contactConversations = createContactConversationsQueryHandlerV1(port)
const query = (contactIds: string[]) => ({ contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds })
const at = (iso: string) => new Date(iso)

function chat(id: string, contactId: string | null, overrides: Partial<ChatRow> = {}): ChatRow {
    return {
        id,
        contactId,
        channel: 'whatsapp',
        chatType: 'private',
        status: 'open',
        lastMessageAt: at('2026-10-01T10:00:00.000Z'),
        createdAt: at('2026-09-01T10:00:00.000Z'),
        externalChatId: `provider-chat-${id}`,
        metadata: { providerAccountId: 'account-1', connectionId: 'connection-1', route: 'route-1' },
        contactIdentityId: `identity-${id}`,
        driverId: `driver-${id}`,
        name: `Name ${id}`,
        ...overrides,
    }
}

async function only(contactId: string): Promise<ContactConversationsFoundV1> {
    const result = await contactConversations(query([contactId]))
    const entry = result.contacts[0]
    if (entry.status !== 'found') throw new Error(`expected found, got ${entry.status}`)
    return entry
}

beforeEach(() => {
    vi.clearAllMocks()
    contacts = [
        { id: 'contact-a', mergedIntoContactId: null },
        { id: 'contact-b', mergedIntoContactId: null },
        { id: 'contact-empty', mergedIntoContactId: null },
    ]
    merges = []
    chats = []
    reads = []
})

describe('answers', () => {
    it('answers a found Contact with zero conversations with an empty, complete answer', async () => {
        const result = await contactConversations(query(['contact-empty']))
        expect(result).toEqual({
            contract: CONTACT_CONVERSATIONS_RESULT_V1,
            contacts: [{
                contactId: 'contact-empty',
                status: 'found',
                canonicalContactId: 'contact-empty',
                channels: [],
                latestConversationId: null,
                truncated: false,
            }],
        })
    })

    it('answers not_found for an unknown id while the other ids answer normally, in request order', async () => {
        chats = [chat('chat-b1', 'contact-b', { channel: 'telegram' })]
        const result = await contactConversations(query(['missing', 'contact-b', 'contact-empty']))
        expect(result.contacts.map(entry => [entry.contactId, entry.status])).toEqual([
            ['missing', 'not_found'],
            ['contact-b', 'found'],
            ['contact-empty', 'found'],
        ])
        expect(result.contacts[0]).toEqual({ contactId: 'missing', status: 'not_found' })
        expect((result.contacts[1] as ContactConversationsFoundV1).latestConversationId).toBe('chat-b1')
    })

    it('lists every conversation of a channel, the most recent first and primary, and the latest over all channels', async () => {
        chats = [
            chat('wa-old', 'contact-a', { channel: 'whatsapp', lastMessageAt: at('2026-10-01T08:00:00.000Z') }),
            chat('tg-1', 'contact-a', { channel: 'telegram', lastMessageAt: at('2026-10-01T09:00:00.000Z') }),
            chat('wa-new', 'contact-a', { channel: 'whatsapp', lastMessageAt: at('2026-10-02T08:00:00.000Z') }),
            chat('other-person', 'contact-b', { channel: 'whatsapp', lastMessageAt: at('2026-10-03T08:00:00.000Z') }),
        ]
        expect(await only('contact-a')).toEqual({
            contactId: 'contact-a',
            status: 'found',
            canonicalContactId: 'contact-a',
            channels: [
                {
                    channel: 'whatsapp',
                    primaryConversationId: 'wa-new',
                    conversations: [
                        { conversationId: 'wa-new', lastActivityAt: '2026-10-02T08:00:00.000Z' },
                        { conversationId: 'wa-old', lastActivityAt: '2026-10-01T08:00:00.000Z' },
                    ],
                },
                {
                    channel: 'telegram',
                    primaryConversationId: 'tg-1',
                    conversations: [{ conversationId: 'tg-1', lastActivityAt: '2026-10-01T09:00:00.000Z' }],
                },
            ],
            latestConversationId: 'wa-new',
            truncated: false,
        })
    })

    it('puts a never-active conversation last and breaks equal activity by creation, newest first', async () => {
        chats = [
            chat('never', 'contact-a', { lastMessageAt: null, createdAt: at('2026-10-05T00:00:00.000Z') }),
            chat('older-created', 'contact-a', { lastMessageAt: at('2026-10-01T10:00:00.000Z'), createdAt: at('2026-09-01T00:00:00.000Z') }),
            chat('newer-created', 'contact-a', { lastMessageAt: at('2026-10-01T10:00:00.000Z'), createdAt: at('2026-09-02T00:00:00.000Z') }),
        ]
        const entry = await only('contact-a')
        expect(entry.channels[0].conversations.map(ref => ref.conversationId)).toEqual(['newer-created', 'older-created', 'never'])
        expect(entry.channels[0].conversations[2]).toEqual({ conversationId: 'never', lastActivityAt: null })
        expect(entry.latestConversationId).toBe('newer-created')
    })

    it('breaks identical activity and creation by conversation id, the same whatever order rows arrive in', async () => {
        const same = { lastMessageAt: at('2026-10-01T10:00:00.000Z'), createdAt: at('2026-09-01T10:00:00.000Z') }
        const rows = [chat('chat-b', 'contact-a', same), chat('chat-a', 'contact-a', same), chat('chat-c', 'contact-a', { ...same, channel: 'telegram' })]
        chats = rows
        const first = await only('contact-a')
        chats = [...rows].reverse()
        const reversed = await only('contact-a')
        expect(first).toEqual(reversed)
        expect(first.channels.map(context => context.channel)).toEqual(['whatsapp', 'telegram'])
        expect(first.channels[0].conversations.map(ref => ref.conversationId)).toEqual(['chat-a', 'chat-b'])
        expect(first.latestConversationId).toBe('chat-a')
    })

    it('imposes the whole contract order itself, whatever order the port answers in', async () => {
        const rows = [
            { conversationId: 'never-old', channel: 'whatsapp', lastActivityAt: null, createdAt: at('2026-01-01T00:00:00.000Z') },
            { conversationId: 'tie-b', channel: 'telegram', lastActivityAt: at('2026-10-01T10:00:00.000Z'), createdAt: at('2026-09-01T00:00:00.000Z') },
            { conversationId: 'never-new', channel: 'max', lastActivityAt: null, createdAt: at('2026-02-01T00:00:00.000Z') },
            { conversationId: 'created-later', channel: 'whatsapp', lastActivityAt: at('2026-10-01T10:00:00.000Z'), createdAt: at('2026-09-05T00:00:00.000Z') },
            { conversationId: 'tie-a', channel: 'whatsapp', lastActivityAt: at('2026-10-01T10:00:00.000Z'), createdAt: at('2026-09-01T00:00:00.000Z') },
            { conversationId: 'newest', channel: 'max', lastActivityAt: at('2026-10-03T00:00:00.000Z'), createdAt: at('2026-01-01T00:00:00.000Z') },
        ]
        const expected = ['newest', 'created-later', 'tie-a', 'tie-b', 'never-new', 'never-old']
        for (const scrambled of [rows, [...rows].reverse(), [rows[4], rows[2], rows[0], rows[5], rows[1], rows[3]]]) {
            const handler = createContactConversationsQueryHandlerV1({
                canonicalContactId: async id => id,
                findPrivateConversations: async () => scrambled,
            })
            const result = await handler(query(['contact-a']))
            const entry = result.contacts[0] as ContactConversationsFoundV1
            const answered = entry.channels.flatMap(context => context.conversations.map(ref => ref.conversationId))
            expect([...answered].sort()).toEqual([...expected].sort())
            expect(entry.channels.map(context => [context.channel, context.primaryConversationId])).toEqual([
                ['max', 'newest'],
                ['whatsapp', 'created-later'],
                ['telegram', 'tie-b'],
            ])
            expect(entry.channels[1].conversations.map(ref => ref.conversationId)).toEqual(['created-later', 'tie-a', 'never-old'])
            expect(entry.channels[0].conversations.map(ref => ref.conversationId)).toEqual(['newest', 'never-new'])
            expect(entry.latestConversationId).toBe('newest')
        }
    })

    it('orders by the one comparator: activity DESC, never-active last, then creation DESC, then id ASC', () => {
        const ref = (conversationId: string, lastActivityAt: string | null, createdAt: string) => ({ conversationId, lastActivityAt, createdAt })
        const list = [
            ref('z', null, '2026-09-03T00:00:00.000Z'),
            ref('b', '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
            ref('a', '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
            ref('c', '2026-10-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
            ref('y', null, '2026-09-04T00:00:00.000Z'),
            ref('d', '2026-10-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ]
        expect([...list].sort(compareContactConversationsV1).map(item => item.conversationId)).toEqual(['d', 'c', 'a', 'b', 'y', 'z'])
        expect([...list].reverse().sort(compareContactConversationsV1).map(item => item.conversationId)).toEqual(['d', 'c', 'a', 'b', 'y', 'z'])
        expect(compareContactConversationsV1(list[2], list[2])).toBe(0)
    })

    it('never answers with a group conversation, even one linked to the Contact', async () => {
        chats = [chat('group-1', 'contact-a', { chatType: 'group', lastMessageAt: at('2026-10-09T00:00:00.000Z') })]
        expect(await only('contact-a')).toMatchObject({ channels: [], latestConversationId: null, truncated: false })
        chats.push(chat('private-1', 'contact-a'))
        expect((await only('contact-a')).latestConversationId).toBe('private-1')
    })

    it('includes a conversation whatever its workflow status', async () => {
        chats = ['new', 'open', 'waiting_customer', 'waiting_internal', 'resolved'].map((status, index) =>
            chat(`chat-${status}`, 'contact-a', { status, lastMessageAt: at(`2026-10-0${index + 1}T00:00:00.000Z`) }))
        expect((await only('contact-a')).channels[0].conversations).toHaveLength(5)
    })

    it('counts only the exact Messaging link: a conversation of another person or with no link never appears', async () => {
        chats = [
            chat('linked', 'contact-a'),
            chat('unlinked-same-phone', null, { driverId: 'driver-linked' }),
            chat('other-person', 'contact-b'),
        ]
        const entry = await only('contact-a')
        expect(entry.channels.flatMap(context => context.conversations.map(ref => ref.conversationId))).toEqual(['linked'])
        expect(reads).toEqual(['lineage:contact-a', `chats:contact-a:${CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1 + 1}`])
    })
})

describe('merge lineage (D3, bounded)', () => {
    beforeEach(() => {
        contacts = [
            { id: 'survivor', mergedIntoContactId: null },
            { id: 'merged-requested', mergedIntoContactId: 'survivor' },
            { id: 'merged-sibling', mergedIntoContactId: 'survivor' },
        ]
        merges = [
            { survivorId: 'survivor', mergedId: 'merged-requested' },
            { survivorId: 'survivor', mergedId: 'merged-sibling' },
        ]
        chats = [
            chat('on-survivor', 'survivor', { lastMessageAt: at('2026-10-02T00:00:00.000Z') }),
            chat('residual-on-requested', 'merged-requested', { channel: 'telegram', lastMessageAt: at('2026-10-01T00:00:00.000Z') }),
            chat('residual-on-sibling', 'merged-sibling', { channel: 'max', lastMessageAt: at('2026-10-03T00:00:00.000Z') }),
        ]
    })

    it('answers a merged-away id for its survivor with the exact requested-id and survivor conversations', async () => {
        const entry = await only('merged-requested')
        expect(entry.canonicalContactId).toBe('survivor')
        expect(entry.channels.map(context => [context.channel, context.primaryConversationId])).toEqual([
            ['whatsapp', 'on-survivor'],
            ['telegram', 'residual-on-requested'],
        ])
        expect(reads).toEqual(['lineage:merged-requested', `chats:merged-requested,survivor:${CONTACT_CONVERSATIONS_MAX_PER_CONTACT_V1 + 1}`])
    })

    it('does not discover a conversation of another merged-away alias that was not the requested id', async () => {
        for (const requested of ['merged-requested', 'survivor']) {
            reads = []
            const entry = await only(requested)
            const ids = entry.channels.flatMap(context => context.conversations.map(ref => ref.conversationId))
            expect(ids).not.toContain('residual-on-sibling')
            expect(reads.some(read => read.includes('merged-sibling'))).toBe(false)
        }
    })

    it('fails closed on a broken merge lineage instead of inventing an answer', async () => {
        contacts = [
            { id: 'loop-a', mergedIntoContactId: 'loop-b' },
            { id: 'loop-b', mergedIntoContactId: 'loop-a' },
        ]
        await expect(contactConversations(query(['loop-a']))).rejects.toThrow('CONTACT_MERGE_REDIRECT_CYCLE')
    })
})

describe('the bound (D4): truncated means partial, never "no more"', () => {
    function many(count: number, channel = 'whatsapp'): ChatRow[] {
        return Array.from({ length: count }, (_, index) => chat(
            `${channel}-${String(index).padStart(3, '0')}`,
            'contact-a',
            { channel, lastMessageAt: at(new Date(Date.UTC(2026, 9, 1, 0, 0, count - index)).toISOString()) },
        ))
    }

    it('returns exactly 50 complete conversations without truncation', async () => {
        chats = many(50)
        const entry = await only('contact-a')
        expect(entry.channels[0].conversations).toHaveLength(50)
        expect(entry.truncated).toBe(false)
    })

    it('returns the first 50 in the contract order and marks the answer truncated past them', async () => {
        chats = many(51)
        const entry = await only('contact-a')
        expect(entry.truncated).toBe(true)
        expect(entry.channels[0].conversations).toHaveLength(50)
        expect(entry.channels[0].conversations.map(ref => ref.conversationId)).toEqual(chats.slice(0, 50).map(row => row.id))
        expect(entry.channels[0].conversations.map(ref => ref.conversationId)).not.toContain('whatsapp-050')
    })

    it('exposes no false completeness: a channel missing from a truncated answer is unknown, not absent', async () => {
        chats = [...many(51, 'whatsapp'), chat('telegram-old', 'contact-a', { channel: 'telegram', lastMessageAt: at('2026-01-01T00:00:00.000Z') })]
        const truncated = await only('contact-a')
        expect(truncated.truncated).toBe(true)
        expect(truncated.channels.map(context => context.channel)).toEqual(['whatsapp'])
        expect(contactChannelConversationsV1(truncated, 'telegram')).toEqual({ kind: 'unknown' })
        expect(contactChannelConversationsV1(truncated, 'whatsapp')).toMatchObject({ kind: 'present', primaryConversationId: 'whatsapp-000' })

        chats = many(2)
        const complete = await only('contact-a')
        expect(contactChannelConversationsV1(complete, 'telegram')).toEqual({ kind: 'absent' })
        expect(contactChannelConversationsV1({ contactId: 'x', status: 'not_found' }, 'telegram')).toEqual({ kind: 'not_found' })
    })

    it('asks the port for one more than the bound, so that more than 50 is known and nothing else is read', async () => {
        chats = many(3)
        await only('contact-a')
        expect(reads).toEqual(['lineage:contact-a', 'chats:contact-a:51'])
    })
})

describe('fail closed on what the contract cannot name', () => {
    it('fails the query on a conversation on a channel the contract does not know', async () => {
        chats = [chat('strange', 'contact-a', { channel: 'pigeon' })]
        await expect(contactConversations(query(['contact-a']))).rejects.toThrow('CONTACT_CONVERSATIONS_UNKNOWN_CHANNEL: pigeon')
    })

    it('fails the query when the port answers the same conversation twice', async () => {
        const duplicated: ContactConversationsPortV1 = {
            canonicalContactId: async id => id,
            findPrivateConversations: async () => [
                { conversationId: 'same', channel: 'whatsapp', lastActivityAt: null, createdAt: at('2026-09-01T00:00:00.000Z') },
                { conversationId: 'same', channel: 'whatsapp', lastActivityAt: null, createdAt: at('2026-09-01T00:00:00.000Z') },
            ],
        }
        await expect(createContactConversationsQueryHandlerV1(duplicated)(query(['contact-a'])))
            .rejects.toThrow('CONTACT_CONVERSATIONS_DUPLICATE_CONVERSATION')
    })
})

describe('the contract', () => {
    it.each([
        ['a non-object', 'not a query', /query must be an object/],
        ['no contactIds', { contract: CONTACT_CONVERSATIONS_QUERY_V1 }, /contactIds must be an array/],
        ['an empty list', query([]), /at least one Contact/],
        ['26 ids', query(Array.from({ length: 26 }, (_, index) => `contact-${index}`)), /at most 25 Contacts/],
        ['a non-string id', { contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: [42] }, /non-empty string/],
        ['an empty id', query(['']), /non-empty string/],
        ['a blank id', query(['   ']), /non-empty string/],
        ['a duplicate id', query(['contact-a', 'contact-a']), /duplicate contactId: contact-a/],
    ])('rejects %s', async (_label, input, message) => {
        const error = await contactConversations(input).catch(caught => caught)
        expect(error).toBeInstanceOf(ContactConversationsQueryValidationError)
        expect(error.code).toBe('INVALID_CONTRACT')
        expect(error.message).toMatch(message)
        expect(reads).toEqual([])
    })

    it('accepts 25 ids', async () => {
        const ids = Array.from({ length: 25 }, (_, index) => `missing-${index}`)
        const result = await contactConversations(query(ids))
        expect(result.contacts.map(entry => entry.contactId)).toEqual(ids)
    })

    it('rejects an unknown field, so no phone, identity, provider or routing input can be smuggled in', async () => {
        for (const field of ['phone', 'contactIdentityId', 'providerAccountId', 'channel', 'limit']) {
            const error = await contactConversations({ ...query(['contact-a']), [field]: 'x' }).catch(caught => caught)
            expect(error).toBeInstanceOf(ContactConversationsQueryValidationError)
            expect(error.message).toBe(`unsupported field(s): ${field}`)
        }
    })

    it('rejects another version as unsupported and another contract as invalid', async () => {
        const version = await contactConversations({ contract: 'messaging.ContactConversationsQuery.v2', contactIds: ['contact-a'] }).catch(caught => caught)
        expect(version.code).toBe('UNSUPPORTED_CONTRACT_VERSION')
        const other = await contactConversations({ contract: 'messaging.ResolveConversationContactQuery.v1', contactIds: ['contact-a'] }).catch(caught => caught)
        expect(other.code).toBe('INVALID_CONTRACT')
    })

    it('serializes to exactly this shape: an ordered array of channel contexts and explicit nulls', async () => {
        chats = [
            chat('wa-1', 'contact-a', { lastMessageAt: at('2026-10-02T08:00:00.000Z') }),
            chat('tg-never', 'contact-a', { channel: 'telegram', lastMessageAt: null }),
        ]
        const result = await contactConversations(query(['contact-a', 'contact-empty', 'missing']))
        expect(JSON.stringify(result)).toBe(JSON.stringify({
            contract: 'messaging.ContactConversationsResult.v1',
            contacts: [
                {
                    contactId: 'contact-a',
                    status: 'found',
                    canonicalContactId: 'contact-a',
                    channels: [
                        { channel: 'whatsapp', primaryConversationId: 'wa-1', conversations: [{ conversationId: 'wa-1', lastActivityAt: '2026-10-02T08:00:00.000Z' }] },
                        { channel: 'telegram', primaryConversationId: 'tg-never', conversations: [{ conversationId: 'tg-never', lastActivityAt: null }] },
                    ],
                    latestConversationId: 'wa-1',
                    truncated: false,
                },
                { contactId: 'contact-empty', status: 'found', canonicalContactId: 'contact-empty', channels: [], latestConversationId: null, truncated: false },
                { contactId: 'missing', status: 'not_found' },
            ],
        }))
        expect(Array.isArray((result.contacts[0] as ContactConversationsFoundV1).channels)).toBe(true)
    })

    it('answers with no provider, account, route, transport, identity, driver, name or workflow field', async () => {
        chats = [chat('wa-1', 'contact-a'), chat('tg-1', 'contact-a', { channel: 'telegram' })]
        const result = await contactConversations(query(['contact-a', 'missing']))
        const keys = new Set<string>()
        const walk = (value: unknown) => {
            if (Array.isArray(value)) return value.forEach(walk)
            if (value && typeof value === 'object') {
                for (const [key, item] of Object.entries(value)) { keys.add(key); walk(item) }
            }
        }
        walk(result)
        expect([...keys].sort()).toEqual([
            'canonicalContactId', 'channel', 'channels', 'contactId', 'contacts', 'contract', 'conversationId',
            'conversations', 'lastActivityAt', 'latestConversationId', 'primaryConversationId', 'status', 'truncated',
        ])
        const serialized = JSON.stringify(result)
        for (const leaked of ['provider-chat-', 'account-1', 'connection-1', 'route-1', 'identity-', 'driver-', 'Name ', '"open"']) {
            expect(serialized).not.toContain(leaked)
        }
    })

    it('answers a repeated query identically, and reads the same things each time', async () => {
        chats = [chat('wa-1', 'contact-a'), chat('wa-2', 'contact-a', { lastMessageAt: null })]
        const first = await contactConversations(query(['contact-a', 'missing']))
        const firstReads = [...reads]
        reads = []
        const second = await contactConversations(query(['contact-a', 'missing']))
        expect(JSON.stringify(second)).toBe(JSON.stringify(first))
        expect(reads).toEqual(firstReads)
    })

    it('keeps every primary and latest id consistent with the ordered lists', async () => {
        chats = [
            chat('a', 'contact-a', { channel: 'max', lastMessageAt: at('2026-10-04T00:00:00.000Z') }),
            chat('b', 'contact-a', { channel: 'whatsapp', lastMessageAt: at('2026-10-03T00:00:00.000Z') }),
            chat('c', 'contact-a', { channel: 'max', lastMessageAt: null }),
            chat('d', 'contact-a', { channel: 'phone', lastMessageAt: at('2026-10-05T00:00:00.000Z') }),
        ]
        const entry: ContactConversationsEntryV1 = await only('contact-a')
        if (entry.status !== 'found') throw new Error('found expected')
        for (const context of entry.channels) expect(context.primaryConversationId).toBe(context.conversations[0].conversationId)
        expect(entry.latestConversationId).toBe(entry.channels[0].primaryConversationId)
        expect(entry.channels.map(context => context.channel)).toEqual(['phone', 'max', 'whatsapp'])
        expect(new Set(entry.channels.map(context => context.channel)).size).toBe(entry.channels.length)
    })
})

describe('the Prisma adapter', () => {
    it('reads exactly the private conversations of the exact ids, in the full contract order, and nothing else', async () => {
        mocks.chatFindMany.mockResolvedValue([
            { id: 'chat-1', channel: 'telegram', lastMessageAt: at('2026-10-01T00:00:00.000Z'), createdAt: at('2026-09-01T00:00:00.000Z') },
        ])
        await expect(legacyPrismaContactConversationsQueryPortV1.findPrivateConversations(['merged', 'survivor'], 51)).resolves.toEqual([
            { conversationId: 'chat-1', channel: 'telegram', lastActivityAt: at('2026-10-01T00:00:00.000Z'), createdAt: at('2026-09-01T00:00:00.000Z') },
        ])
        expect(mocks.chatFindMany).toHaveBeenCalledOnce()
        expect(mocks.chatFindMany).toHaveBeenCalledWith({
            where: { contactId: { in: ['merged', 'survivor'] }, chatType: 'private' },
            select: { id: true, channel: true, lastMessageAt: true, createdAt: true },
            orderBy: [
                { lastMessageAt: { sort: 'desc', nulls: 'last' } },
                { createdAt: 'desc' },
                { id: 'asc' },
            ],
            take: 51,
        })
        expect(mocks.forbiddenRead).not.toHaveBeenCalled()
    })

    it('takes the canonical Contact only from Contacts public lineage', async () => {
        mocks.lineage.mockResolvedValueOnce({ requestedContactId: 'merged', canonicalContactId: 'survivor', contactIds: ['merged', 'sibling', 'survivor'] })
        await expect(legacyPrismaContactConversationsQueryPortV1.canonicalContactId('merged')).resolves.toBe('survivor')
        mocks.lineage.mockResolvedValueOnce(null)
        await expect(legacyPrismaContactConversationsQueryPortV1.canonicalContactId('missing')).resolves.toBeNull()
        expect(mocks.lineage.mock.calls).toEqual([['merged'], ['missing']])
    })

    it('reads only through the lineage and the one chat read: no phone, ChannelIdentity, provider or raw lookup, and no write', async () => {
        mocks.lineage.mockImplementation(async (id: string) => (id === 'merged'
            ? { requestedContactId: 'merged', canonicalContactId: 'survivor', contactIds: ['merged', 'sibling', 'survivor'] }
            : null))
        mocks.chatFindMany.mockResolvedValue([
            { id: 'chat-1', channel: 'whatsapp', lastMessageAt: null, createdAt: at('2026-09-01T00:00:00.000Z') },
        ])
        const handler = createContactConversationsQueryHandlerV1(legacyPrismaContactConversationsQueryPortV1)
        const result = await handler(query(['merged', 'missing']))
        expect(result.contacts).toEqual([
            {
                contactId: 'merged',
                status: 'found',
                canonicalContactId: 'survivor',
                channels: [{ channel: 'whatsapp', primaryConversationId: 'chat-1', conversations: [{ conversationId: 'chat-1', lastActivityAt: null }] }],
                latestConversationId: 'chat-1',
                truncated: false,
            },
            { contactId: 'missing', status: 'not_found' },
        ])
        // The lineage's own alias list is not consumed: only the requested id and the survivor are read.
        expect(mocks.chatFindMany.mock.calls.map(([args]) => args.where)).toEqual([
            { contactId: { in: ['merged', 'survivor'] }, chatType: 'private' },
        ])
        expect(mocks.forbiddenRead).not.toHaveBeenCalled()
        expect(mocks.write).not.toHaveBeenCalled()
    })
})
