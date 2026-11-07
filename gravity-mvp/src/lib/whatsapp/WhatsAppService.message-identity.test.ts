import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
    parseCreateChannelMessageCommandV1,
    parsePatchMessageDeliveryCommandV1,
} from '@/contracts/messaging/v1/channel-message-commands'

// W2 binding test: WhatsApp message identity.
//
// The contract under test is what Messaging ends up holding, not the queries
// that produce it. Live ingress, background sync and history import run
// against an in-memory Message/Chat store that behaves like the database:
// Message.externalId is unique (a second writer gets P2002), an update by id
// overwrites, and every write goes through the real Messaging command parsers.
//
//   1. A provider message key identifies a message. Two keys are two messages,
//      whatever their text, type, direction or second.
//   2. The same key processed again, by any path or concurrently, is one row.
//   3. The only content match is the outbound echo: a message the account sent
//      may claim one CRM send in the same conversation that has no provider
//      key yet and was not proven undispatched. It never claims a row that
//      holds a key, a row in another conversation, or a row already claimed.
//   4. A key is never copied or moved to another row.
//   5. Without a provider key nothing is merged on content.

type EventHandler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
    clients: new Map<string, { handlers: Map<string, EventHandler> }>(),
    clientGetChats: vi.fn(),
    pageEvaluate: vi.fn(),
    appendFileSync: vi.fn(),
    rm: vi.fn(),
    chatFindMany: vi.fn(),
    chatFindUnique: vi.fn(),
    messageFindFirst: vi.fn(),
    messageFindUnique: vi.fn(),
    messageFindMany: vi.fn(),
    whatsAppChatUpsert: vi.fn(),
    whatsAppChatUpdate: vi.fn(),
    whatsAppChatFindUnique: vi.fn(),
    whatsAppMessageUpsert: vi.fn(),
    whatsAppConnectionFindFirst: vi.fn(),
    whatsAppConnectionFindMany: vi.fn(),
    whatsAppConnectionFindUnique: vi.fn(),
    whatsAppConnectionUpdate: vi.fn(),
    queryRaw: vi.fn(),
    attachMessageMedia: vi.fn(),
    createChannelMessage: vi.fn(),
    ensureConversationContactLink: vi.fn(),
    patchChannelConversation: vi.fn(),
    patchExternalConversation: vi.fn(),
    patchHistoryImportJob: vi.fn(),
    patchMessageDelivery: vi.fn(),
    upsertChannelConversation: vi.fn(),
    attachPhoneToIdentity: vi.fn(),
    attachProviderIdentityAlias: vi.fn(),
    markChannelIdentityConflict: vi.fn(),
    recordExactProviderReachability: vi.fn(),
    resolveChannelContact: vi.fn(),
    isResolvedChannelContactResult: vi.fn(),
    linkMatchedDriver: vi.fn(),
    outboundWorkflow: vi.fn(),
    inboundWorkflow: vi.fn(),
    emitMessageReceived: vi.fn(),
    broadcastChatMessage: vi.fn(),
    opsLog: vi.fn(),
    clearPendingQr: vi.fn(),
    publishPendingQr: vi.fn(),
    cleanupStaleSessions: vi.fn(),
    registry: {
        ensureEntry: vi.fn(),
        getEntry: vi.fn(),
        beginNewInstance: vi.fn(),
        isCurrentInstance: vi.fn(),
        touch: vi.fn(),
        setReady: vi.fn(),
        setFailed: vi.fn(),
        setReconnecting: vi.fn(),
        setStopped: vi.fn(),
        scheduleReconnect: vi.fn(),
        getAllEntries: vi.fn(),
        getInstanceId: vi.fn(),
        touchLastSeen: vi.fn(),
    },
}))

vi.mock('fs', () => ({
    default: { appendFileSync: mocks.appendFileSync, promises: { rm: mocks.rm } },
    appendFileSync: mocks.appendFileSync,
    promises: { rm: mocks.rm },
}))

vi.mock('whatsapp-web.js', () => {
    class LocalAuth {
        clientId: string
        constructor(options: { clientId: string }) { this.clientId = options.clientId }
    }
    class Client {
        connectionId: string
        handlers = new Map<string, EventHandler>()
        info = { wid: { user: '79990000000' } }
        pupPage = {
            isClosed: () => false,
            mainFrame: () => ({ isDetached: () => false }),
            evaluate: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => mocks.pageEvaluate(fn, ...args),
        }
        constructor(options: { authStrategy: LocalAuth }) {
            this.connectionId = options.authStrategy.clientId
            mocks.clients.set(this.connectionId, this)
        }
        on(event: string, handler: EventHandler) { this.handlers.set(event, handler); return this }
        emit(event: string, ...args: unknown[]) { return this.handlers.get(event)?.(...args) }
        async initialize() {}
        async destroy() {}
        removeAllListeners() { this.handlers.clear() }
        async getChats() { return mocks.clientGetChats(this.connectionId) }
    }
    class MessageMedia {}
    class PrivateChat {}
    class GroupChat {}
    class Channel {}
    return { Client, LocalAuth, MessageMedia, PrivateChat, GroupChat, Channel }
})

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findMany: mocks.chatFindMany, findUnique: mocks.chatFindUnique },
        message: {
            findFirst: mocks.messageFindFirst,
            findUnique: mocks.messageFindUnique,
            findMany: mocks.messageFindMany,
        },
        whatsAppChat: {
            findUnique: mocks.whatsAppChatFindUnique,
            upsert: mocks.whatsAppChatUpsert,
            update: mocks.whatsAppChatUpdate,
        },
        whatsAppMessage: { upsert: mocks.whatsAppMessageUpsert },
        whatsAppConnection: {
            findFirst: mocks.whatsAppConnectionFindFirst,
            findMany: mocks.whatsAppConnectionFindMany,
            findUnique: mocks.whatsAppConnectionFindUnique,
            update: mocks.whatsAppConnectionUpdate,
        },
        $queryRaw: mocks.queryRaw,
    },
}))

vi.mock('@/modules/messaging/public/v1', () => ({
    attachMessageMediaV1: mocks.attachMessageMedia,
    createChannelMessageV1: mocks.createChannelMessage,
    ensureConversationContactLinkV1: mocks.ensureConversationContactLink,
    linkMatchedDriverToConversationCapabilityV1: Symbol('link-matched-driver'),
    patchChannelConversationV1: mocks.patchChannelConversation,
    patchExternalConversationV1: mocks.patchExternalConversation,
    patchHistoryImportJobV1: mocks.patchHistoryImportJob,
    patchMessageDeliveryV1: mocks.patchMessageDelivery,
    upsertChannelConversationV1: mocks.upsertChannelConversation,
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    attachPhoneToIdentityV1: mocks.attachPhoneToIdentity,
    attachProviderIdentityAliasV1: mocks.attachProviderIdentityAlias,
    isResolvedChannelContactResultV1: mocks.isResolvedChannelContactResult,
    markChannelIdentityConflictV1: mocks.markChannelIdentityConflict,
    resolveChannelContactOperationV1: mocks.resolveChannelContact,
}))

vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: mocks.recordExactProviderReachability },
}))

vi.mock('@/modules/fleet-operations/public/v1/channel-driver-match', () => ({
    channelDriverMatchV1: { linkChatToDriver: mocks.linkMatchedDriver },
}))

vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
    channelConversationWorkflowV1: {
        onOutboundMessage: mocks.outboundWorkflow,
        onInboundMessage: mocks.inboundWorkflow,
    },
}))

vi.mock('@/modules/messaging/public/v1/persisted-message-ingress', () => ({
    publishPersistedMessageV1: mocks.emitMessageReceived,
}))

vi.mock('@/modules/messaging/public/v1/message-stream', () => ({
    broadcastChatMessageV1: mocks.broadcastChatMessage,
}))

vi.mock('@/modules/messaging/public/v1/transport-registry-lifecycle', () => ({
    transportRegistryLifecycleV1: mocks.registry,
}))

vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.opsLog,
}))

vi.mock('@/lib/whatsapp/WhatsAppCleanup', () => ({
    WWEBJS_AUTH_DIR: '/tmp/wa-test-auth',
    cleanupStaleWhatsAppSessions: mocks.cleanupStaleSessions,
}))

vi.mock('@/lib/whatsapp/enrichChatName', () => ({
    enrichWaChatNameFromSibling: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./whatsapp-qr-ceremony', () => ({
    clearPendingWhatsAppQr: mocks.clearPendingQr,
    publishPendingWhatsAppQr: mocks.publishPendingQr,
}))

import {
    destroyAllClients,
    forceSync,
    importWhatsAppHistory,
    initializeClient,
} from './WhatsAppService'

// ─── In-memory Messaging store ───────────────────────────────────────────

type MessageRow = {
    id: string
    chatId: string
    direction: 'inbound' | 'outbound'
    type: string
    content: string
    externalId: string | null
    clientMessageId: string | null
    status: string
    channel: string | null
    sentAt: Date
    createdAt: Date
    metadata: Record<string, unknown>
}

type ChatRow = {
    id: string
    channel: string
    chatType: string
    externalChatId: string
    name: string | null
    contactId: string | null
    contactIdentityId: string | null
    driverId: string | null
    lastMessageAt: Date | null
    metadata: Record<string, unknown>
}

const store = { messages: [] as MessageRow[], chats: [] as ChatRow[], sequence: 0 }

/** One database round trip: lets concurrent paths interleave between statements. */
const roundTrip = () => new Promise<void>(resolve => setImmediate(resolve))

function uniqueViolation(target: string[]) {
    return Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } })
}

function compare(left: unknown, right: unknown): number {
    const l = left instanceof Date ? left.getTime() : left as number
    const r = right instanceof Date ? right.getTime() : right as number
    return l < r ? -1 : l > r ? 1 : 0
}

/** Prisma `where` semantics for the operators this code may use. */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true
    for (const [key, condition] of Object.entries(where)) {
        // Prisma drops an undefined filter.
        if (condition === undefined) continue
        if (key === 'OR') {
            if (!(condition as Record<string, unknown>[]).some(entry => matchesWhere(row, entry))) return false
            continue
        }
        if (key === 'AND') {
            if (!(condition as Record<string, unknown>[]).every(entry => matchesWhere(row, entry))) return false
            continue
        }
        const value = row[key]
        if (condition === null) {
            if (value !== null && value !== undefined) return false
            continue
        }
        if (condition instanceof Date) {
            if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false
            continue
        }
        if (typeof condition === 'object') {
            for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
                if (operand === undefined) continue
                switch (operator) {
                    case 'equals': if (value !== operand) return false; break
                    case 'gte': if (value == null || compare(value, operand) < 0) return false; break
                    case 'gt': if (value == null || compare(value, operand) <= 0) return false; break
                    case 'lte': if (value == null || compare(value, operand) > 0) return false; break
                    case 'lt': if (value == null || compare(value, operand) >= 0) return false; break
                    case 'in': if (!(operand as unknown[]).includes(value)) return false; break
                    case 'not': if (operand === null ? value == null : value === operand) return false; break
                    default: throw new Error(`test store: unsupported operator ${operator} on ${key}`)
                }
            }
            continue
        }
        if (value !== condition) return false
    }
    return true
}

function ordered<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, 'asc' | 'desc'>[]
    return [...rows].sort((a, b) => {
        for (const entry of keys) {
            const [field, direction] = Object.entries(entry)[0]
            const result = compare(a[field], b[field])
            if (result !== 0) return direction === 'desc' ? -result : result
        }
        return 0
    })
}

function picked(row: Record<string, unknown>, args: { select?: Record<string, boolean>; include?: Record<string, unknown> }) {
    if (args.select) {
        return Object.fromEntries(Object.keys(args.select).filter(key => args.select![key]).map(key => [key, row[key]]))
    }
    return { ...row, ...(args.include?.attachments ? { attachments: [] } : {}) }
}

function seedChat(chat: Partial<ChatRow> & { id: string; externalChatId: string; connectionId: string }): ChatRow {
    const row: ChatRow = {
        id: chat.id,
        channel: 'whatsapp',
        chatType: chat.chatType ?? 'private',
        externalChatId: chat.externalChatId,
        name: chat.name ?? null,
        contactId: null,
        contactIdentityId: null,
        driverId: null,
        lastMessageAt: null,
        metadata: { connectionId: chat.connectionId, providerAccountId: chat.connectionId },
    }
    store.chats.push(row)
    return row
}

function seedCrmSend(input: { id: string; chatId: string; content: string; sentAt: Date; status?: string; metadata?: Record<string, unknown> }) {
    store.messages.push({
        id: input.id,
        chatId: input.chatId,
        direction: 'outbound',
        type: 'text',
        content: input.content,
        externalId: null,
        clientMessageId: `client-${input.id}`,
        status: input.status ?? 'sent',
        channel: 'whatsapp',
        sentAt: input.sentAt,
        createdAt: input.sentAt,
        metadata: input.metadata ?? {},
    })
}

function rowsIn(chatId: string) {
    return ordered(store.messages.filter(row => row.chatId === chatId), [{ sentAt: 'asc' }, { createdAt: 'asc' }])
}

function rowsWithKey(externalId: string) {
    return store.messages.filter(row => row.externalId === externalId)
}

/**
 * Holds the first echo-candidate read until a second path also reads, or until
 * it is clear no second read is coming. Two paths that may both see the same
 * unclaimed CRM send then do, deterministically.
 */
const echoReadBarrier = { arrivals: 0, enabled: false }
async function echoRead() {
    if (!echoReadBarrier.enabled) return
    echoReadBarrier.arrivals += 1
    for (let spin = 0; spin < 50 && echoReadBarrier.arrivals < 2; spin++) await roundTrip()
}

function installStore() {
    store.messages = []
    store.chats = []
    store.sequence = 0
    echoReadBarrier.arrivals = 0
    echoReadBarrier.enabled = false

    mocks.messageFindUnique.mockImplementation(async (args: { where: Record<string, unknown>; select?: Record<string, boolean>; include?: Record<string, unknown> }) => {
        await roundTrip()
        const row = store.messages.find(candidate => matchesWhere(candidate, args.where))
        return row ? picked(row, args) : null
    })
    mocks.messageFindFirst.mockImplementation(async (args: { where?: Record<string, unknown>; orderBy?: unknown; select?: Record<string, boolean> }) => {
        await roundTrip()
        const row = ordered(store.messages.filter(candidate => matchesWhere(candidate, args.where)), args.orderBy)[0]
        return row ? picked(row, args) : null
    })
    mocks.messageFindMany.mockImplementation(async (args: { where?: Record<string, unknown>; orderBy?: unknown; take?: number; select?: Record<string, boolean> }) => {
        if (args.where?.externalId === null) await echoRead()
        await roundTrip()
        const rows = ordered(store.messages.filter(candidate => matchesWhere(candidate, args.where)), args.orderBy)
        return rows.slice(0, args.take ?? rows.length).map(row => picked(row, args))
    })
    mocks.createChannelMessage.mockImplementation(async (command: unknown) => {
        const parsed = parseCreateChannelMessageCommandV1(command)
        await roundTrip()
        if (store.messages.some(row => row.externalId === parsed.externalId)) throw uniqueViolation(['externalId'])
        const now = new Date()
        const row: MessageRow = {
            id: `message-${++store.sequence}`,
            chatId: parsed.chatId,
            direction: parsed.direction,
            type: parsed.type,
            content: parsed.content,
            externalId: parsed.externalId,
            clientMessageId: null,
            status: parsed.status ?? 'sent',
            channel: parsed.channel ?? 'whatsapp',
            sentAt: parsed.sentAt,
            createdAt: now,
            metadata: (parsed.metadata as Record<string, unknown> | undefined) ?? {},
        }
        store.messages.push(row)
        return { message: { ...row } }
    })
    mocks.patchMessageDelivery.mockImplementation(async (command: unknown) => {
        const parsed = parsePatchMessageDeliveryCommandV1(command)
        await roundTrip()
        const row = store.messages.find(candidate => candidate.id === parsed.messageId)
        if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' })
        if (store.messages.some(other => other !== row && other.externalId === parsed.externalId)) {
            throw uniqueViolation(['externalId'])
        }
        // An update by id overwrites, exactly like prisma.message.update.
        row.externalId = parsed.externalId
        if (parsed.status) row.status = parsed.status
        if (parsed.sentAt) row.sentAt = parsed.sentAt
        return { updated: true }
    })

    mocks.chatFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => (
        store.chats.filter(chat => matchesWhere(chat, args.where)).map(chat => ({ ...chat }))
    ))
    mocks.chatFindUnique.mockImplementation(async (args: { where: Record<string, unknown> }) => {
        const chat = store.chats.find(candidate => matchesWhere(candidate, args.where))
        return chat ? { ...chat } : null
    })
    mocks.upsertChannelConversation.mockImplementation(async (command: {
        externalChatId: string
        name?: string | null
        chatType?: string
        metadata?: Record<string, unknown>
    }) => {
        let chat = store.chats.find(candidate => candidate.externalChatId === command.externalChatId)
        if (!chat) {
            chat = {
                id: `chat-${++store.sequence}`,
                channel: 'whatsapp',
                chatType: command.chatType ?? 'private',
                externalChatId: command.externalChatId,
                name: command.name ?? null,
                contactId: null,
                contactIdentityId: null,
                driverId: null,
                lastMessageAt: null,
                metadata: command.metadata ?? {},
            }
            store.chats.push(chat)
        }
        return { conversation: { ...chat } }
    })
    mocks.patchChannelConversation.mockImplementation(async (command: {
        selector: { chatId?: string; externalChatId?: string }
        patch: Partial<ChatRow>
    }) => {
        const chat = store.chats.find(candidate => (
            command.selector.chatId ? candidate.id === command.selector.chatId : candidate.externalChatId === command.selector.externalChatId
        ))
        if (!chat) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' })
        if (command.patch.externalChatId && store.chats.some(other => other !== chat && other.externalChatId === command.patch.externalChatId)) {
            throw uniqueViolation(['externalChatId'])
        }
        Object.assign(chat, command.patch)
        return { conversation: { ...chat } }
    })
}

// ─── Provider fixtures ───────────────────────────────────────────────────

const ACCOUNT_A = 'wa-account-a'
const ACCOUNT_B = 'wa-account-b'
const PARTNER_A_JID = '79990001122@c.us'
const PARTNER_A_CHAT = 'whatsapp:79990001122'
const PARTNER_B_JID = '79990003344@c.us'
const PARTNER_B_CHAT = 'whatsapp:79990003344'
const NOW_SECONDS = Math.floor(Date.now() / 1000) - 600

type ProviderMessage = {
    id: unknown
    body: string
    type?: string
    fromMe?: boolean
    hasMedia?: boolean
    timestamp?: number
}

function liveMessage(partnerJid: string, message: ProviderMessage) {
    const fromMe = Boolean(message.fromMe)
    return {
        id: message.id,
        from: fromMe ? '79990000000@c.us' : partnerJid,
        to: fromMe ? partnerJid : '79990000000@c.us',
        fromMe,
        body: message.body,
        timestamp: message.timestamp ?? NOW_SECONDS,
        type: message.type ?? 'chat',
        hasMedia: Boolean(message.hasMedia),
        downloadMedia: async () => null,
        getChat: async () => ({ name: null, getContact: async () => null }),
        getContact: async () => null,
    }
}

function historyChat(partnerJid: string, messages: ProviderMessage[]) {
    return {
        id: { _serialized: partnerJid },
        name: 'Водитель',
        isGroup: false,
        fetchMessages: vi.fn(async () => messages.map(message => ({
            id: message.id,
            body: message.body,
            timestamp: message.timestamp ?? NOW_SECONDS,
            fromMe: Boolean(message.fromMe),
            type: message.type ?? 'chat',
            hasMedia: Boolean(message.hasMedia),
            downloadMedia: async () => null,
        }))),
    }
}

function key(fromMe: boolean, partnerJid: string, localId: string) {
    return `${fromMe ? 'true' : 'false'}_${partnerJid}_${localId}`
}

async function connect(connectionId: string) {
    await initializeClient(connectionId)
    const client = mocks.clients.get(connectionId)
    const handler = client?.handlers.get('message')
    if (!handler) throw new Error('live message handler was not registered')
    return {
        live: async (partnerJid: string, message: ProviderMessage) => { await handler(liveMessage(partnerJid, message)) },
    }
}

/** Every chat each account exposes to sync and import. */
const providerChats = new Map<string, unknown[]>()

function errorLogs(): string[] {
    return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call => call.map(String).join(' '))
}

describe('W2 — WhatsApp message identity', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clients.clear()
        providerChats.clear()
        installStore()
        mocks.clientGetChats.mockImplementation(async (connectionId: string) => providerChats.get(connectionId) ?? [])
        mocks.pageEvaluate.mockResolvedValue('{}')
        mocks.queryRaw.mockResolvedValue([{ msg_count: 0n, chat_count: 0n, contact_count: 0n, min_date: null, max_date: null }])
        mocks.whatsAppConnectionUpdate.mockResolvedValue({})
        mocks.registry.getEntry.mockReturnValue(null)
        mocks.registry.beginNewInstance.mockImplementation((connectionId: string) => `instance:${connectionId}`)
        mocks.registry.isCurrentInstance.mockReturnValue(true)
        mocks.registry.getAllEntries.mockReturnValue([])
        mocks.patchHistoryImportJob.mockResolvedValue({})
        mocks.isResolvedChannelContactResult.mockReturnValue(true)
        mocks.resolveChannelContact.mockResolvedValue({
            status: 'resolved',
            contact: { id: 'contact-1', displayName: 'Водитель' },
            identity: { id: 'identity-1' },
            isNew: false,
            warnings: [],
        })
        mocks.ensureConversationContactLink.mockResolvedValue({ linked: true })
        mocks.recordExactProviderReachability.mockResolvedValue({ outcome: 'updated' })
        mocks.attachPhoneToIdentity.mockResolvedValue({ kind: 'exists_same_contact' })
        mocks.linkMatchedDriver.mockResolvedValue(false)
        mocks.emitMessageReceived.mockResolvedValue(undefined)
        mocks.whatsAppChatUpsert.mockResolvedValue({})
        mocks.whatsAppChatUpdate.mockResolvedValue({})
        mocks.whatsAppMessageUpsert.mockResolvedValue({})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await destroyAllClients()
    })

    describe('different provider keys are different messages', () => {
        test('live: two inbound messages with the same text in the same second are both stored', async () => {
            const { live } = await connect(ACCOUNT_A)

            await live(PARTNER_A_JID, { id: { _serialized: key(false, PARTNER_A_JID, 'A1') }, body: 'Добрый день' })
            await live(PARTNER_A_JID, { id: { _serialized: key(false, PARTNER_A_JID, 'A2') }, body: 'Добрый день' })

            const chat = store.chats.find(candidate => candidate.externalChatId === PARTNER_A_CHAT)!
            expect(rowsIn(chat.id).map(row => [row.direction, row.content, row.externalId])).toEqual([
                ['inbound', 'Добрый день', key(false, PARTNER_A_JID, 'A1')],
                ['inbound', 'Добрый день', key(false, PARTNER_A_JID, 'A2')],
            ])
            expect(mocks.emitMessageReceived).toHaveBeenCalledTimes(2)
        })

        test('live: two photos without a caption are two image messages', async () => {
            const { live } = await connect(ACCOUNT_A)

            await live(PARTNER_A_JID, { id: { _serialized: key(false, PARTNER_A_JID, 'P1') }, body: '', type: 'image', hasMedia: true })
            await live(PARTNER_A_JID, { id: { _serialized: key(false, PARTNER_A_JID, 'P2') }, body: '', type: 'image', hasMedia: true })

            const chat = store.chats.find(candidate => candidate.externalChatId === PARTNER_A_CHAT)!
            expect(rowsIn(chat.id).map(row => [row.type, row.content, row.externalId])).toEqual([
                ['image', '[Фото]', key(false, PARTNER_A_JID, 'P1')],
                ['image', '[Фото]', key(false, PARTNER_A_JID, 'P2')],
            ])
        })

        test.each(['sync', 'import'] as const)('%s: same-text messages and captionless photos keep one row per provider key', async (path) => {
            await connect(ACCOUNT_A)
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [
                { id: { _serialized: key(false, PARTNER_A_JID, 'H1') }, body: 'Да' },
                { id: { _serialized: key(false, PARTNER_A_JID, 'H2') }, body: 'Да' },
                { id: { _serialized: key(false, PARTNER_A_JID, 'H3') }, body: '', type: 'image', hasMedia: true },
                { id: { _serialized: key(false, PARTNER_A_JID, 'H4') }, body: '', type: 'image', hasMedia: true },
                { id: { _serialized: key(true, PARTNER_A_JID, 'H5') }, body: 'Принято', fromMe: true },
                { id: { _serialized: key(true, PARTNER_A_JID, 'H6') }, body: 'Принято', fromMe: true },
            ])])
            const run = () => path === 'sync'
                ? forceSync(ACCOUNT_A)
                : importWhatsAppHistory(`job-${path}`, 'available_history', undefined, ACCOUNT_A)

            await run()
            await run()

            const chat = store.chats.find(candidate => candidate.externalChatId === PARTNER_A_CHAT)!
            expect(rowsIn(chat.id).map(row => [row.direction, row.content, row.externalId])).toEqual([
                ['inbound', 'Да', key(false, PARTNER_A_JID, 'H1')],
                ['inbound', 'Да', key(false, PARTNER_A_JID, 'H2')],
                ['inbound', '[Фото]', key(false, PARTNER_A_JID, 'H3')],
                ['inbound', '[Фото]', key(false, PARTNER_A_JID, 'H4')],
                ['outbound', 'Принято', key(true, PARTNER_A_JID, 'H5')],
                ['outbound', 'Принято', key(true, PARTNER_A_JID, 'H6')],
            ])
        })

        test('history without any provider key keeps two same-text messages apart and stays idempotent', async () => {
            await connect(ACCOUNT_A)
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [
                { id: {}, body: 'Ок' },
                { id: {}, body: 'Ок' },
            ])])

            await forceSync(ACCOUNT_A)
            await forceSync(ACCOUNT_A)

            const chat = store.chats.find(candidate => candidate.externalChatId === PARTNER_A_CHAT)!
            const rows = rowsIn(chat.id)
            expect(rows.map(row => row.content)).toEqual(['Ок', 'Ок'])
            expect(new Set(rows.map(row => row.externalId)).size).toBe(2)
        })
    })

    describe('the same provider key is one message', () => {
        test('live: a redelivered event stores nothing twice', async () => {
            const { live } = await connect(ACCOUNT_A)
            const message = { id: { _serialized: key(false, PARTNER_A_JID, 'R1') }, body: 'Где машина?' }

            await live(PARTNER_A_JID, message)
            await live(PARTNER_A_JID, message)

            expect(rowsWithKey(key(false, PARTNER_A_JID, 'R1'))).toHaveLength(1)
            expect(mocks.emitMessageReceived).toHaveBeenCalledOnce()
            expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
        })

        test('a message stored live is not stored again by sync or import', async () => {
            const { live } = await connect(ACCOUNT_A)
            const id = key(false, PARTNER_A_JID, 'L1')
            await live(PARTNER_A_JID, { id: { _serialized: id }, body: 'Еду' })
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [{ id: { _serialized: id }, body: 'Еду' }])])

            await forceSync(ACCOUNT_A)
            await importWhatsAppHistory('job-after-live', 'available_history', undefined, ACCOUNT_A)

            expect(rowsWithKey(id)).toHaveLength(1)
        })

        test('concurrent live ingress and history sync of one message store one row without errors', async () => {
            const { live } = await connect(ACCOUNT_A)
            const id = key(false, PARTNER_A_JID, 'C1')
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [{ id: { _serialized: id }, body: 'Одновременно' }])])

            await Promise.all([
                live(PARTNER_A_JID, { id: { _serialized: id }, body: 'Одновременно' }),
                forceSync(ACCOUNT_A),
                importWhatsAppHistory('job-concurrent', 'available_history', undefined, ACCOUNT_A),
            ])

            expect(rowsWithKey(id)).toHaveLength(1)
            expect(errorLogs().filter(line => /Failed to save message|Message event error|Msg error/.test(line))).toEqual([])
        })

        test('the WhatsApp Web 2026-07 `$1` key, live and from the Store fallback, is the same identity', async () => {
            const { live } = await connect(ACCOUNT_A)
            const first = key(false, PARTNER_A_JID, 'S1')
            const second = key(false, PARTNER_A_JID, 'S2')
            await live(PARTNER_A_JID, { id: { $1: first }, body: 'Да' })

            // fetchMessages fails for this chat, so sync reads WhatsApp Web's Store.
            const chat = historyChat(PARTNER_A_JID, [])
            chat.fetchMessages.mockRejectedValue(new Error('fetchMessages failed'))
            providerChats.set(ACCOUNT_A, [chat])
            const storeModels = [
                { id: { $1: first, fromMe: false }, body: 'Да', t: NOW_SECONDS, type: 'chat' },
                { id: { $1: second, fromMe: false }, body: 'Да', t: NOW_SECONDS, type: 'chat' },
            ]
            mocks.pageEvaluate.mockImplementation(async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
                const globalWindow = globalThis as unknown as { window?: unknown }
                const previous = globalWindow.window
                globalWindow.window = {
                    localStorage: {},
                    Store: { Chat: { get: () => ({ msgs: { getModelsArray: () => storeModels } }) } },
                }
                try { return await fn(...args) } finally { globalWindow.window = previous }
            })

            await forceSync(ACCOUNT_A)

            expect(rowsWithKey(first)).toHaveLength(1)
            expect(rowsWithKey(second)).toHaveLength(1)
            expect(store.messages).toHaveLength(2)
        })
    })

    describe('outbound echo reconciliation', () => {
        test('the echo of a CRM send takes the provider key; a second same-text message from the phone stays its own', async () => {
            await connect(ACCOUNT_A)
            const chat = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({ id: 'crm-send-1', chatId: chat.id, content: 'Ок', sentAt: new Date(NOW_SECONDS * 1000 + 400) })
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [
                { id: { _serialized: key(true, PARTNER_A_JID, 'E1') }, body: 'Ок', fromMe: true },
                { id: { _serialized: key(true, PARTNER_A_JID, 'E2') }, body: 'Ок', fromMe: true, timestamp: NOW_SECONDS + 1 },
            ])])

            await forceSync(ACCOUNT_A)
            await importWhatsAppHistory('job-echo', 'available_history', undefined, ACCOUNT_A)

            expect(rowsIn(chat.id).map(row => [row.id, row.externalId])).toEqual([
                ['crm-send-1', key(true, PARTNER_A_JID, 'E1')],
                ['message-1', key(true, PARTNER_A_JID, 'E2')],
            ])
        })

        test('import reconciles the echo too, so a later same-text message is not hidden behind the CRM send', async () => {
            await connect(ACCOUNT_A)
            const chat = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({ id: 'crm-send-1', chatId: chat.id, content: 'Ок', sentAt: new Date(NOW_SECONDS * 1000) })
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [
                { id: { _serialized: key(true, PARTNER_A_JID, 'I1') }, body: 'Ок', fromMe: true },
                { id: { _serialized: key(true, PARTNER_A_JID, 'I2') }, body: 'Ок', fromMe: true },
            ])])

            await importWhatsAppHistory('job-import-echo', 'available_history', undefined, ACCOUNT_A)

            expect(store.messages.find(row => row.id === 'crm-send-1')?.externalId).toBe(key(true, PARTNER_A_JID, 'I1'))
            expect(rowsWithKey(key(true, PARTNER_A_JID, 'I2'))).toHaveLength(1)
        })

        test('live: the echo reconciles the CRM send once; the replayed echo changes nothing', async () => {
            const { live } = await connect(ACCOUNT_A)
            const chat = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({ id: 'crm-send-1', chatId: chat.id, content: 'Выезжаю', sentAt: new Date(NOW_SECONDS * 1000) })
            const echo = { id: { _serialized: key(true, PARTNER_A_JID, 'LE1') }, body: 'Выезжаю', fromMe: true }

            await live(PARTNER_A_JID, echo)
            await live(PARTNER_A_JID, echo)

            expect(rowsIn(chat.id).map(row => [row.id, row.externalId, row.status])).toEqual([
                ['crm-send-1', key(true, PARTNER_A_JID, 'LE1'), 'delivered'],
            ])
            expect(mocks.patchMessageDelivery).toHaveBeenCalledOnce()
        })

        test('a CRM send proven undispatched is never claimed by a phone message with the same text', async () => {
            await connect(ACCOUNT_A)
            const chat = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({
                id: 'crm-send-failed',
                chatId: chat.id,
                content: 'Ок',
                sentAt: new Date(NOW_SECONDS * 1000),
                status: 'failed',
                metadata: { deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 },
            })
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [
                { id: { _serialized: key(true, PARTNER_A_JID, 'U1') }, body: 'Ок', fromMe: true },
            ])])

            await forceSync(ACCOUNT_A)

            // The undispatched send keeps no provider key, so S1 may still redeliver it.
            expect(store.messages.find(row => row.id === 'crm-send-failed')?.externalId).toBeNull()
            expect(rowsWithKey(key(true, PARTNER_A_JID, 'U1'))).toHaveLength(1)
        })

        test('two different echoes racing for one CRM send: one claims it, the other is its own message', async () => {
            const { live } = await connect(ACCOUNT_A)
            const chat = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({ id: 'crm-send-1', chatId: chat.id, content: 'Ок', sentAt: new Date(NOW_SECONDS * 1000) })
            const liveKey = key(true, PARTNER_A_JID, 'X1')
            const syncKey = key(true, PARTNER_A_JID, 'X2')
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [{ id: { _serialized: syncKey }, body: 'Ок', fromMe: true }])])
            echoReadBarrier.enabled = true

            await Promise.all([
                live(PARTNER_A_JID, { id: { _serialized: liveKey }, body: 'Ок', fromMe: true }),
                forceSync(ACCOUNT_A),
            ])

            const rows = rowsIn(chat.id)
            expect(rows).toHaveLength(2)
            expect(rowsWithKey(liveKey)).toHaveLength(1)
            expect(rowsWithKey(syncKey)).toHaveLength(1)
            expect([liveKey, syncKey]).toContain(store.messages.find(row => row.id === 'crm-send-1')?.externalId)
        })
    })

    describe('provider accounts and conversations', () => {
        test('two accounts receiving the same text in the same second keep each message in its own conversation', async () => {
            const a = await connect(ACCOUNT_A)
            const b = await connect(ACCOUNT_B)

            await Promise.all([
                a.live(PARTNER_A_JID, { id: { _serialized: key(false, PARTNER_A_JID, 'M1') }, body: 'Добрый день' }),
                b.live(PARTNER_B_JID, { id: { _serialized: key(false, PARTNER_B_JID, 'M1') }, body: 'Добрый день' }),
            ])

            const chatA = store.chats.find(chat => chat.externalChatId === PARTNER_A_CHAT)!
            const chatB = store.chats.find(chat => chat.externalChatId === PARTNER_B_CHAT)!
            expect(chatA.metadata.connectionId).toBe(ACCOUNT_A)
            expect(chatB.metadata.connectionId).toBe(ACCOUNT_B)
            expect(rowsIn(chatA.id).map(row => row.externalId)).toEqual([key(false, PARTNER_A_JID, 'M1')])
            expect(rowsIn(chatB.id).map(row => row.externalId)).toEqual([key(false, PARTNER_B_JID, 'M1')])
        })

        test("an echo in one account's conversation never claims a CRM send in another account's conversation", async () => {
            await connect(ACCOUNT_B)
            const chatA = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({ id: 'crm-send-a', chatId: chatA.id, content: 'Ок', sentAt: new Date(NOW_SECONDS * 1000) })
            providerChats.set(ACCOUNT_B, [historyChat(PARTNER_B_JID, [
                { id: { _serialized: key(true, PARTNER_B_JID, 'B1') }, body: 'Ок', fromMe: true },
            ])])

            await forceSync(ACCOUNT_B)

            expect(store.messages.find(row => row.id === 'crm-send-a')?.externalId).toBeNull()
            const chatB = store.chats.find(chat => chat.externalChatId === PARTNER_B_CHAT)!
            expect(rowsIn(chatB.id).map(row => row.externalId)).toEqual([key(true, PARTNER_B_JID, 'B1')])
        })

        test('a provider key already held in another conversation is neither copied nor moved', async () => {
            const { live } = await connect(ACCOUNT_A)
            const sibling = seedChat({ id: 'chat-sibling', externalChatId: '165313509372005@lid', connectionId: ACCOUNT_A })
            const id = key(false, PARTNER_A_JID, 'K1')
            store.messages.push({
                id: 'owner-row', chatId: sibling.id, direction: 'inbound', type: 'text', content: 'Привет',
                externalId: id, clientMessageId: null, status: 'sent', channel: 'whatsapp',
                sentAt: new Date(NOW_SECONDS * 1000), createdAt: new Date(), metadata: {},
            })

            await live(PARTNER_A_JID, { id: { _serialized: id }, body: 'Привет' })

            expect(rowsWithKey(id)).toEqual([expect.objectContaining({ id: 'owner-row', chatId: sibling.id })])
            expect(mocks.opsLog).toHaveBeenCalledWith('warn', 'wa_message_provider_id_owned_elsewhere', expect.objectContaining({
                phase: 'live',
                ownerMessageId: 'owner-row',
                ownerConversationId: sibling.id,
            }))
        })
    })

    describe('missing or malformed provider keys', () => {
        test('live: a key exposed only as `$1` or only as its parts is still the provider identity', async () => {
            const { live } = await connect(ACCOUNT_A)

            await live(PARTNER_A_JID, { id: { $1: key(false, PARTNER_A_JID, 'D1') }, body: 'Да' })
            await live(PARTNER_A_JID, { id: { fromMe: false, remote: PARTNER_A_JID, id: 'D2' }, body: 'Да' })
            await live(PARTNER_A_JID, { id: { fromMe: false, remote: { _serialized: PARTNER_A_JID }, id: 'D2' }, body: 'Да' })

            expect(store.messages.map(row => row.externalId)).toEqual([
                key(false, PARTNER_A_JID, 'D1'),
                key(false, PARTNER_A_JID, 'D2'),
            ])
        })

        test('live: a message without any provider key is reported and never folded into another message', async () => {
            const { live } = await connect(ACCOUNT_A)
            await live(PARTNER_A_JID, { id: { _serialized: key(false, PARTNER_A_JID, 'N1') }, body: 'Да' })

            await live(PARTNER_A_JID, { id: {}, body: 'Да' })
            await live(PARTNER_A_JID, { id: undefined, body: 'Нет' })

            expect(store.messages.map(row => [row.content, row.externalId])).toEqual([
                ['Да', key(false, PARTNER_A_JID, 'N1')],
            ])
            expect(mocks.patchMessageDelivery).not.toHaveBeenCalled()
            expect(mocks.opsLog).toHaveBeenCalledWith('error', 'wa_message_provider_id_missing', expect.objectContaining({
                connectionId: ACCOUNT_A,
                phase: 'live',
            }))
        })
    })

    describe('partial failures', () => {
        test('a failed write loses nothing: the rest of the history is stored and a rerun stores the failed message once', async () => {
            await connect(ACCOUNT_A)
            const failing = key(false, PARTNER_A_JID, 'F1')
            const next = key(false, PARTNER_A_JID, 'F2')
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [
                { id: { _serialized: failing }, body: 'Ок' },
                { id: { _serialized: next }, body: 'Ок' },
            ])])
            const create = mocks.createChannelMessage.getMockImplementation()!
            let failedOnce = false
            mocks.createChannelMessage.mockImplementation(async (command: { externalId: string }) => {
                if (command.externalId === failing && !failedOnce) {
                    failedOnce = true
                    throw new Error('connection reset')
                }
                return create(command)
            })

            await forceSync(ACCOUNT_A)
            expect(rowsWithKey(failing)).toHaveLength(0)
            expect(rowsWithKey(next)).toHaveLength(1)

            await forceSync(ACCOUNT_A)
            expect(rowsWithKey(failing)).toHaveLength(1)
            expect(rowsWithKey(next)).toHaveLength(1)
        })

        test('a failed echo claim leaves the CRM send claimable by the next pass', async () => {
            await connect(ACCOUNT_A)
            const chat = seedChat({ id: 'chat-a', externalChatId: PARTNER_A_CHAT, connectionId: ACCOUNT_A })
            seedCrmSend({ id: 'crm-send-1', chatId: chat.id, content: 'Ок', sentAt: new Date(NOW_SECONDS * 1000) })
            const echo = key(true, PARTNER_A_JID, 'FE1')
            providerChats.set(ACCOUNT_A, [historyChat(PARTNER_A_JID, [{ id: { _serialized: echo }, body: 'Ок', fromMe: true }])])
            const patch = mocks.patchMessageDelivery.getMockImplementation()!
            mocks.patchMessageDelivery.mockImplementationOnce(async () => { throw new Error('connection reset') })
            mocks.patchMessageDelivery.mockImplementation(patch)

            await forceSync(ACCOUNT_A)
            expect(store.messages.find(row => row.id === 'crm-send-1')?.externalId).toBeNull()
            expect(rowsWithKey(echo)).toHaveLength(0)

            await forceSync(ACCOUNT_A)
            expect(rowsIn(chat.id).map(row => [row.id, row.externalId])).toEqual([['crm-send-1', echo]])
        })
    })
})
