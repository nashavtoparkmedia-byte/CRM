import { beforeEach, describe, expect, it, vi } from 'vitest'

// messaging.ResolveConversationContactQuery.v1 — contract tests.
//
// The handler is driven through its port with an in-memory Chat table, and the
// canonical Contact comes from Contacts' own merge-lineage handler over an
// in-memory Contact table, so Messaging is proven to consume that algorithm,
// not to carry a second one. The adapter tests at the end pin the one read the
// Prisma adapter makes and prove it never writes.

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    lineage: vi.fn(),
    write: vi.fn(() => { throw new Error('a read-only query must never write') }),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: mocks.chatFindUnique,
            update: mocks.write,
            updateMany: mocks.write,
            create: mocks.write,
            upsert: mocks.write,
            delete: mocks.write,
            deleteMany: mocks.write,
        },
        $executeRaw: mocks.write,
        $executeRawUnsafe: mocks.write,
        $transaction: mocks.write,
    },
}))
vi.mock('@/modules/contacts/public/v1', () => ({ resolveContactLineageV1: mocks.lineage }))

import {
    RESOLVE_CONVERSATION_CONTACT_QUERY_V1,
    RESOLVE_CONVERSATION_CONTACT_RESULT_V1,
    ResolveConversationContactQueryValidationError,
} from '../../../../contracts/messaging/v1'
import { createResolveContactLineageHandlerV1 } from '../../../contacts/public/v1/contact-lineage-handler'
import { legacyPrismaResolveConversationContactPortV1 } from './legacy-prisma-resolve-conversation-contact-adapter'
import {
    createResolveConversationContactHandlerV1,
    type ResolveConversationContactPortV1,
} from './resolve-conversation-contact-handler'

type ChatRow = { id: string; contactId: string | null; metadata: unknown; channel: string; externalChatId: string }
type ContactRow = { id: string; mergedIntoContactId: string | null }

let chats: ChatRow[]
let contacts: ContactRow[]
let reads: string[]

const lineage = createResolveContactLineageHandlerV1({
    async findRedirect(contactId) {
        const contact = contacts.find(row => row.id === contactId)
        return contact ? { id: contact.id, mergedIntoContactId: contact.mergedIntoContactId } : null
    },
    async findMergedContactIds(survivorId) {
        return contacts.filter(row => row.mergedIntoContactId === survivorId).map(row => row.id)
    },
})

const port: ResolveConversationContactPortV1 = {
    async findConversationContact(chatId) {
        reads.push(`chat:${chatId}`)
        const chat = chats.find(row => row.id === chatId)
        if (!chat) return null
        const metadata = (chat.metadata ?? {}) as { contactResolution?: { status?: unknown } }
        const status = metadata.contactResolution?.status
        return { contactId: chat.contactId, contactResolutionStatus: typeof status === 'string' ? status : null }
    },
    async canonicalContactId(contactId) {
        reads.push(`contact:${contactId}`)
        return (await lineage(contactId))?.canonicalContactId ?? null
    },
}

const resolve = createResolveConversationContactHandlerV1(port)
const query = (chatId: unknown) => ({ contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId })

function chat(id: string, fields: Partial<ChatRow> = {}): ChatRow {
    const row: ChatRow = { id, contactId: null, metadata: {}, channel: 'telegram', externalChatId: `telegram:${id}`, ...fields }
    chats.push(row)
    return row
}

function contact(id: string, mergedIntoContactId: string | null = null) {
    contacts.push({ id, mergedIntoContactId })
}

const resolved = (contactId: string) => ({ contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status: 'resolved', contactId })
const bare = (status: 'unresolved' | 'ambiguous' | 'not_found') => ({ contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status })

beforeEach(() => {
    chats = []
    contacts = []
    reads = []
    vi.clearAllMocks()
})

describe('resolution', () => {
    it('resolves a linked conversation to its Contact', async () => {
        contact('contact-1')
        chat('chat-1', { contactId: 'contact-1', metadata: { contactResolution: { status: 'resolved', candidateCount: 1 } } })

        await expect(resolve(query('chat-1'))).resolves.toEqual(resolved('contact-1'))
    })

    it('answers a merged-away Contact with its canonical survivor, through Contacts lineage', async () => {
        contact('survivor')
        contact('loser-b', 'survivor')
        contact('loser-a', 'loser-b')
        chat('chat-stale', { contactId: 'loser-a' })

        await expect(resolve(query('chat-stale'))).resolves.toEqual(resolved('survivor'))
    })

    it('is unresolved when the conversation carries no Contact', async () => {
        chat('chat-1')
        await expect(resolve(query('chat-1'))).resolves.toEqual(bare('unresolved'))
    })

    it.each(['not_attempted', 'group_skipped', 'unknown_kind_limited', 'identity_phone_conflict', 'error'])(
        'is unresolved for an unlinked conversation whose recorded resolution was %s',
        async status => {
            chat('chat-1', { metadata: { contactResolution: { status, candidateCount: 0 } } })
            await expect(resolve(query('chat-1'))).resolves.toEqual(bare('unresolved'))
        },
    )

    it('is unresolved when the linked Contact no longer exists', async () => {
        chat('chat-dangling', { contactId: 'contact-gone' })
        await expect(resolve(query('chat-dangling'))).resolves.toEqual(bare('unresolved'))
    })

    it('is ambiguous when the recorded resolution matched more than one person', async () => {
        chat('chat-1', { metadata: { contactResolution: { status: 'ambiguous', candidateCount: 3 } } })
        await expect(resolve(query('chat-1'))).resolves.toEqual(bare('ambiguous'))
    })

    it('stays ambiguous even when the conversation carries an older link', async () => {
        contact('contact-1')
        chat('chat-1', { contactId: 'contact-1', metadata: { contactResolution: { status: 'ambiguous', candidateCount: 2 } } })

        await expect(resolve(query('chat-1'))).resolves.toEqual(bare('ambiguous'))
        expect(reads).toEqual(['chat:chat-1'])
    })

    it('is not_found for an id no conversation has', async () => {
        chat('chat-1')
        await expect(resolve(query('chat-404'))).resolves.toEqual(bare('not_found'))
    })

    it('reads only the exact conversation, never another conversation of the same person', async () => {
        contact('contact-1')
        chat('chat-whatsapp', { contactId: 'contact-1', channel: 'whatsapp' })
        chat('chat-telegram')

        await expect(resolve(query('chat-telegram'))).resolves.toEqual(bare('unresolved'))
        expect(reads).toEqual(['chat:chat-telegram'])
    })

    it('fails closed on a broken merge lineage instead of inventing a status', async () => {
        contact('a', 'b')
        contact('b', 'a')
        chat('chat-1', { contactId: 'a' })

        await expect(resolve(query('chat-1'))).rejects.toThrow('CONTACT_MERGE_REDIRECT_CYCLE')
    })
})

describe('the contract', () => {
    it.each([
        ['a non-object', 'chat-1'],
        ['null', null],
        ['an array', ['chat-1']],
    ])('rejects %s', async (_label, input) => {
        await expect(resolve(input)).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
        expect(reads).toEqual([])
    })

    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['blank', '   '],
        ['a number', 42],
        ['an object', { id: 'chat-1' }],
    ])('rejects a %s chatId before any read', async (_label, chatId) => {
        const error = await resolve(query(chatId)).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(ResolveConversationContactQueryValidationError)
        expect(error).toMatchObject({ code: 'INVALID_CONTRACT', message: 'chatId is required' })
        expect(reads).toEqual([])
    })

    it('rejects an unknown field, so no provider or routing input can be smuggled in', async () => {
        await expect(resolve({ ...query('chat-1'), channel: 'max' })).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
        await expect(resolve({ ...query('chat-1'), allChatIds: ['chat-2'] })).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
        expect(reads).toEqual([])
    })

    it('rejects another version as unsupported and another contract as invalid', async () => {
        await expect(resolve({ contract: 'messaging.ResolveConversationContactQuery.v2', chatId: 'chat-1' }))
            .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
        await expect(resolve({ contract: 'messaging.EnsureConversationContactLinkCommand.v1', chatId: 'chat-1' }))
            .rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
        expect(reads).toEqual([])
    })

    it('answers with no provider, account, transport, route or runtime field', async () => {
        contact('contact-1')
        chat('chat-resolved', {
            contactId: 'contact-1',
            channel: 'max',
            externalChatId: 'max:900',
            metadata: { providerAccountId: 'max-account', transportConnectionId: 'conn-1', contactResolution: { status: 'resolved' } },
        })
        chat('chat-ambiguous', { metadata: { providerAccountId: 'x', contactResolution: { status: 'ambiguous', candidateCount: 2 } } })
        chat('chat-unresolved', { metadata: { providerAccountId: 'x' } })

        for (const [id, keys] of [
            ['chat-resolved', ['contactId', 'contract', 'status']],
            ['chat-ambiguous', ['contract', 'status']],
            ['chat-unresolved', ['contract', 'status']],
            ['chat-missing', ['contract', 'status']],
        ] as const) {
            const result = await resolve(query(id))
            expect(Object.keys(result).sort()).toEqual(keys)
            expect(JSON.stringify(result)).not.toMatch(/max|provider|transport|telegram|whatsapp|route|candidate/i)
        }
    })

    it('answers a repeated query identically, and reads the same things each time', async () => {
        contact('survivor')
        contact('loser', 'survivor')
        chat('chat-1', { contactId: 'loser' })

        const first = await resolve(query('chat-1'))
        const firstReads = [...reads]
        reads = []
        const second = await resolve(query('chat-1'))

        expect(second).toEqual(first)
        expect(reads).toEqual(firstReads)
    })
})

describe('the Prisma adapter', () => {
    it('reads exactly the conversation link and its recorded resolution status, and nothing else', async () => {
        mocks.chatFindUnique.mockResolvedValueOnce({ contactId: 'contact-1', metadata: { contactResolution: { status: 'ambiguous', candidateCount: 2 }, providerAccountId: 'p' } })

        await expect(legacyPrismaResolveConversationContactPortV1.findConversationContact('chat-1'))
            .resolves.toEqual({ contactId: 'contact-1', contactResolutionStatus: 'ambiguous' })
        expect(mocks.chatFindUnique).toHaveBeenCalledWith({ where: { id: 'chat-1' }, select: { contactId: true, metadata: true } })
    })

    it.each([
        ['no metadata', null],
        ['array metadata', []],
        ['no recorded resolution', {}],
        ['a non-object resolution', { contactResolution: 'ambiguous' }],
        ['a non-string status', { contactResolution: { status: 2 } }],
    ])('records no status for %s', async (_label, metadata) => {
        mocks.chatFindUnique.mockResolvedValueOnce({ contactId: null, metadata })
        await expect(legacyPrismaResolveConversationContactPortV1.findConversationContact('chat-1'))
            .resolves.toEqual({ contactId: null, contactResolutionStatus: null })
    })

    it('answers null for a conversation that does not exist', async () => {
        mocks.chatFindUnique.mockResolvedValueOnce(null)
        await expect(legacyPrismaResolveConversationContactPortV1.findConversationContact('chat-404')).resolves.toBeNull()
    })

    it('takes the canonical Contact from Contacts public lineage', async () => {
        mocks.lineage.mockResolvedValueOnce({ requestedContactId: 'loser', canonicalContactId: 'survivor', contactIds: ['loser', 'survivor'] })
        await expect(legacyPrismaResolveConversationContactPortV1.canonicalContactId('loser')).resolves.toBe('survivor')
        mocks.lineage.mockResolvedValueOnce(null)
        await expect(legacyPrismaResolveConversationContactPortV1.canonicalContactId('gone')).resolves.toBeNull()
        expect(mocks.lineage).toHaveBeenCalledWith('loser')
    })

    it('writes nothing through a whole resolution', async () => {
        mocks.chatFindUnique.mockResolvedValueOnce({ contactId: 'loser', metadata: { contactResolution: { status: 'resolved' } } })
        mocks.lineage.mockResolvedValueOnce({ requestedContactId: 'loser', canonicalContactId: 'survivor', contactIds: ['loser', 'survivor'] })
        const adapterResolve = createResolveConversationContactHandlerV1(legacyPrismaResolveConversationContactPortV1)

        await expect(adapterResolve(query('chat-1'))).resolves.toEqual(resolved('survivor'))
        expect(mocks.write).not.toHaveBeenCalled()
    })
})
