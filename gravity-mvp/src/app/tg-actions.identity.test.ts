import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    clients: [] as Array<{ handlers: Array<(event: unknown) => Promise<void>> }>,
    telegramConnectionFindMany: vi.fn(),
    telegramConnectionFindUnique: vi.fn(),
    chatFindUnique: vi.fn(),
    getDialogs: vi.fn(),
    getMessages: vi.fn(),
    getEntity: vi.fn(),
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    invoke: vi.fn(),
    upsertConversation: vi.fn(),
    patchConversation: vi.fn(),
    appendCollision: vi.fn(),
    createMessage: vi.fn(),
    ensureContactLink: vi.fn(),
    resolveContact: vi.fn(),
    isResolvedContact: vi.fn(),
    markIdentityConflict: vi.fn(),
    messageFindFirst: vi.fn(),
    messageFindUnique: vi.fn(),
    patchMessageMetadata: vi.fn(),
    patchImportJob: vi.fn(),
    prepareOutbound: vi.fn(),
    queryRaw: vi.fn(),
    inboundWorkflow: vi.fn(),
    emitMessage: vi.fn(),
    recordReachability: vi.fn(),
    opsLog: vi.fn(),
    telegramConnectionUpdate: vi.fn(),
    admittedChat: null as null | Record<string, unknown>,
    providerAccountId: '7000',
}))

vi.mock('telegram', () => ({
    TelegramClient: class MockTelegramClient {
        connected = true
        handlers: Array<(event: unknown) => Promise<void>> = []
        session = { save: () => 'session' }

        constructor() {
            mocks.clients.push(this)
        }

        async connect() {}
        async disconnect() {}
        async isUserAuthorized() { return true }
        async getMe() { return { id: BigInt(mocks.providerAccountId) } }
        async getDialogs(input: unknown) { return mocks.getDialogs(input) }
        async getMessages(entity: unknown, input: unknown) { return mocks.getMessages(entity, input) }
        async getEntity(target: unknown) { return mocks.getEntity(target) }
        async sendMessage(target: unknown, input: unknown) { return mocks.sendMessage(target, input) }
        async sendFile(target: unknown, input: unknown) { return mocks.sendFile(target, input) }
        async invoke(input: unknown) { return mocks.invoke(input) }
        addEventHandler(handler: (event: unknown) => Promise<void>) { this.handlers.push(handler) }
    },
    Api: {
        UpdateMessageReactions: class {},
        ReactionEmoji: class { constructor(public input: unknown) {} },
        messages: { SendReaction: class { constructor(public input: unknown) {} } },
        contacts: { ImportContacts: class {} },
        InputPhoneContact: class {},
    },
}))

vi.mock('telegram/sessions', () => ({
    StringSession: class {
        save() { return 'session' }
    },
}))

vi.mock('telegram/client/uploads', () => ({ CustomFile: class {} }))
vi.mock('telegram/events', () => ({
    NewMessage: class {},
    Raw: class {},
}))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        telegramConnection: {
            findMany: mocks.telegramConnectionFindMany,
            findUnique: mocks.telegramConnectionFindUnique,
            update: mocks.telegramConnectionUpdate,
        },
        message: {
            findFirst: mocks.messageFindFirst,
            findUnique: mocks.messageFindUnique,
        },
        messageAttachment: {
            count: vi.fn(),
            findFirst: vi.fn(),
        },
        chat: { findUnique: mocks.chatFindUnique },
        $queryRaw: mocks.queryRaw,
    },
}))

vi.mock('@/modules/messaging/public/v1/transport-registry-lifecycle', () => ({
    transportRegistryLifecycleV1: {
        ensureEntry: vi.fn(),
        beginNewInstance: vi.fn((connectionId: string) => `instance:${connectionId}`),
        setReady: vi.fn(),
        touch: vi.fn(),
        getAllEntries: vi.fn(() => []),
        getDegradedDuration: vi.fn(() => null),
        getEntry: vi.fn(() => null),
        setReconnecting: vi.fn(),
        scheduleReconnect: vi.fn(),
    },
}))

vi.mock('@/modules/messaging/public/v1', () => ({
    appendConversationIdentityCollisionV1: mocks.appendCollision,
    attachBinaryMessageMediaV1: vi.fn(),
    attachMessageMediaV1: vi.fn(),
    createChannelMessageV1: mocks.createMessage,
    deleteConversationsByIdV1: vi.fn(),
    deleteHistoryImportJobsForChannelV1: vi.fn(),
    deleteHistoryImportJobsForConnectionV1: vi.fn(),
    ensureConversationContactLinkV1: mocks.ensureContactLink,
    patchChannelConversationV1: mocks.patchConversation,
    patchHistoryImportJobV1: mocks.patchImportJob,
    patchMessageDeliveryV1: vi.fn(),
    patchMessageMetadataV1: mocks.patchMessageMetadata,
    prepareOutboundConversationV1: mocks.prepareOutbound,
    upsertChannelConversationV1: mocks.upsertConversation,
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    cleanupDanglingContactIdentitiesV1: vi.fn(),
    isResolvedChannelContactResultV1: mocks.isResolvedContact,
    markChannelIdentityConflictV1: mocks.markIdentityConflict,
    resolveChannelContactOperationV1: mocks.resolveContact,
}))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: mocks.recordReachability },
}))

vi.mock('@/modules/messaging/public/v1/persisted-message-ingress', () => ({
    publishPersistedMessageV1: mocks.emitMessage,
}))
vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
    channelConversationWorkflowV1: { onInboundMessage: mocks.inboundWorkflow },
}))
vi.mock('@/modules/telegram-channel/public/v1/telegram-connection-public-metadata', () => ({
    projectTelegramConnectionMetadata: vi.fn(value => value),
}))
vi.mock('@/modules/telegram-channel/public/v1', () => ({
    getTelegramTransportOptionsV1: () => ({ options: {}, label: null }),
}))
vi.mock('@/modules/identity-access/public/v1', () => ({
    requireIntegrationAdminAccess: vi.fn(),
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.opsLog,
}))

import {
    checkTelegramReachability,
    importTelegramHistory,
    initTelegramListeners,
    pauseTelegramConnection,
    resumeTelegramConnection,
    sendTelegramMedia,
    sendTelegramMessage,
    sendTelegramReaction,
    stopTelegramHealthCheck,
} from './tg-actions'

let connectionSequence = 0

function connection(id: string) {
    return {
        id,
        apiId: 123,
        apiHash: 'hash',
        sessionString: 'session',
        isActive: true,
        name: id,
    }
}

function exactChat(command: { externalChatId: string; metadata: Record<string, unknown> }) {
    return {
        id: `chat:${command.externalChatId}`,
        channel: 'telegram',
        externalChatId: command.externalChatId,
        chatType: 'private',
        contactId: null,
        contactIdentityId: null,
        driverId: null,
        metadata: command.metadata,
    }
}

function inboundMessage(peerId = '42') {
    return {
        out: false,
        id: 1001,
        peerId: { userId: BigInt(peerId) },
        fromId: { userId: BigInt(peerId) },
        message: 'inbound exact identity',
        date: Math.floor(Date.now() / 1000),
        sender: { firstName: 'Exact', lastName: 'Peer' },
    }
}

function outboundMessage(peerId = '42') {
    return {
        out: true,
        id: 1002,
        peerId: { userId: BigInt(peerId) },
        message: 'mirrored exact identity',
        date: Math.floor(Date.now() / 1000),
        chat: { firstName: 'Exact', lastName: 'Peer' },
    }
}

async function initializeListener(connectionId: string, providerAccountId: string) {
    mocks.providerAccountId = providerAccountId
    mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
    mocks.getDialogs.mockResolvedValue([])
    await initTelegramListeners()
    const client = mocks.clients.at(-1)
    expect(client).toBeDefined()
    const messageHandler = client?.handlers[0]
    expect(messageHandler).toBeTypeOf('function')
    return messageHandler!
}

describe('GramJS private conversation identity admission', () => {
    beforeEach(() => {
        connectionSequence++
        vi.clearAllMocks()
        mocks.clients.length = 0
        mocks.admittedChat = null
        mocks.providerAccountId = '7000'
        mocks.appendCollision.mockResolvedValue(undefined)
        mocks.markIdentityConflict.mockResolvedValue(undefined)
        mocks.messageFindFirst.mockResolvedValue(null)
        mocks.createMessage.mockResolvedValue({ message: { id: 'message-1' } })
        mocks.ensureContactLink.mockResolvedValue({ completed: true })
        mocks.isResolvedContact.mockReturnValue(true)
        mocks.resolveContact.mockImplementation(async (_channel: string, peerId: string) => ({
            status: 'resolved',
            contact: { id: `contact:${peerId}`, displayName: 'Exact Peer' },
            identity: { id: `identity:${peerId}`, channel: 'telegram', externalId: peerId },
            isNew: false,
            warnings: [],
        }))
        mocks.upsertConversation.mockImplementation(async (command: {
            externalChatId: string
            metadata: Record<string, unknown>
        }) => {
            mocks.admittedChat = exactChat(command)
            return { conversation: mocks.admittedChat }
        })
        mocks.patchConversation.mockImplementation(async (command: {
            patch: Record<string, unknown>
        }) => ({
            conversation: { ...mocks.admittedChat, ...command.patch },
        }))
        mocks.queryRaw.mockResolvedValue([{
            msg_count: 0n,
            chat_count: 0n,
            contact_count: 0n,
            min_date: null,
            max_date: null,
        }])
        mocks.patchImportJob.mockResolvedValue({})
        mocks.getEntity.mockImplementation(async target => ({ id: target }))
        mocks.sendMessage.mockResolvedValue({ id: 9001 })
        mocks.sendFile.mockResolvedValue({ id: 9002 })
        mocks.invoke.mockResolvedValue({})
        mocks.inboundWorkflow.mockResolvedValue(undefined)
        mocks.emitMessage.mockResolvedValue(undefined)
        mocks.recordReachability.mockResolvedValue({ outcome: 'updated', status: 'confirmed' })
        mocks.getDialogs.mockResolvedValue([])
        mocks.getMessages.mockResolvedValue([])
        mocks.telegramConnectionUpdate.mockResolvedValue({})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(async () => {
        await stopTelegramHealthCheck()
        vi.restoreAllMocks()
    })

    test('live inbound persists the message before it links exact provider, transport and peer', async () => {
        const connectionId = `telegram-account-live-${connectionSequence}`
        const providerAccountId = '7001'
        const handler = await initializeListener(connectionId, providerAccountId)

        await handler({ message: inboundMessage('42') })

        expect(mocks.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({
            externalChatId: 'telegram:42',
            channel: 'telegram',
            chatType: 'private',
            metadata: {
                chatKind: 'private',
                peerId: '42',
                providerAccountId,
                connectionId,
            },
        }))
        expect(mocks.resolveContact).toHaveBeenCalledWith(
            'telegram',
            '42',
            null,
            'Exact Peer',
            { chatKind: 'private', providerAccountId },
        )
        expect(mocks.createMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.resolveContact.mock.invocationCallOrder[0])
        expect(mocks.createMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.ensureContactLink.mock.invocationCallOrder[0])
        expect(mocks.recordReachability).toHaveBeenCalledWith({
            identityId: 'identity:42',
            contactId: 'contact:42',
            channel: 'telegram',
            providerAccountId,
            providerTargetId: '42',
            status: 'confirmed',
        })
        expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
            externalId: `telegram:${providerAccountId}:42:1001`,
            metadata: {
                providerMessageId: '1001',
                providerAccountId,
                peerId: '42',
            },
        }))
    })

    test('source routes all private ingress modes through exact admission without driver/global fallback', () => {
        const source = readFileSync(`${process.cwd()}/src/app/tg-actions.ts`, 'utf8')
        const importStart = source.indexOf('export async function importTelegramHistory')
        const importEnd = source.indexOf('export async function pauseTelegramConnection', importStart)
        const importSource = source.slice(importStart, importEnd)

        expect(source).toContain("phase: 'inbound'")
        expect(source).toContain("phase: 'mirror'")
        expect(importSource).toContain("phase: 'import'")
        expect(source).not.toMatch(/DriverMatchService|linkMatchedDriverToConversationCapabilityV1/)
        expect(importSource).not.toMatch(/telegramConnection\.findMany|conns\[0\]/)
    })

    // TG design section 14, item 5. A Chat is the peer conversation shared by
    // both Telegram transports, so a stored connection naming another transport
    // (or a replaced personal account) is a transport fact, not a contradiction:
    // the message persists and nothing is ever written onto the person.
    test('a Chat stamped with another transport persists the message and writes no person conflict', async () => {
        const connectionId = `telegram-account-incoming-${connectionSequence}`
        const providerAccountId = '7002'
        const handler = await initializeListener(connectionId, providerAccountId)
        const otherTransportChat = {
            id: 'chat-stamped-by-other-transport',
            channel: 'telegram',
            externalChatId: 'telegram:42',
            chatType: 'private',
            contactId: 'contact-42',
            contactIdentityId: 'identity-42',
            driverId: null,
            metadata: {
                chatKind: 'private',
                peerId: '42',
                providerAccountId: 'telegram-account-other',
                connectionId: 'telegram-account-other',
            },
        }
        mocks.upsertConversation.mockImplementation(async () => {
            mocks.admittedChat = otherTransportChat
            return { conversation: otherTransportChat }
        })

        await handler({ message: inboundMessage('42') })

        expect(mocks.appendCollision).not.toHaveBeenCalled()
        expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
        expect(mocks.createMessage).toHaveBeenCalledOnce()
        expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
            chatId: 'chat-stamped-by-other-transport',
            externalId: `telegram:${providerAccountId}:42:1001`,
        }))
        expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
    })

    test('room messages cannot manufacture a private sender conversation', async () => {
        const connectionId = `telegram-account-room-${connectionSequence}`
        const handler = await initializeListener(connectionId, '7005')

        await handler({
            message: {
                ...inboundMessage('42'),
                peerId: { chatId: 123n },
                fromId: { userId: 42n },
            },
        })

        expect(mocks.upsertConversation).not.toHaveBeenCalled()
        expect(mocks.resolveContact).not.toHaveBeenCalled()
        expect(mocks.createMessage).not.toHaveBeenCalled()
    })

    test('outbound mirror persists first, then re-admits and re-links the existing peer', async () => {
        const connectionId = `telegram-account-mirror-${connectionSequence}`
        const providerAccountId = '7003'
        const handler = await initializeListener(connectionId, providerAccountId)

        await handler({ message: outboundMessage('84') })

        expect(mocks.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({
            externalChatId: 'telegram:84',
            metadata: {
                chatKind: 'private',
                peerId: '84',
                providerAccountId,
                connectionId,
            },
        }))
        expect(mocks.resolveContact).toHaveBeenCalledWith(
            'telegram',
            '84',
            null,
            'Exact Peer',
            { chatKind: 'private', providerAccountId },
        )
        expect(mocks.createMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.ensureContactLink.mock.invocationCallOrder[0])
        expect(mocks.recordReachability).not.toHaveBeenCalled()
        expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
            externalId: `telegram:${providerAccountId}:84:1002`,
        }))
    })

    test('history import requires one exact connection and never falls back globally', async () => {
        await importTelegramHistory('job-unbound', 'available_history')

        expect(mocks.telegramConnectionFindUnique).not.toHaveBeenCalled()
        expect(mocks.telegramConnectionFindMany).not.toHaveBeenCalled()
        expect(mocks.upsertConversation).not.toHaveBeenCalled()
        expect(mocks.patchImportJob).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'job-unbound',
            patch: expect.objectContaining({
                status: 'failed',
                resultType: 'failed',
            }),
        }))
    })

    test('history import admits the exact account, connection and peer, stores messages, then links', async () => {
        const connectionId = `telegram-account-import-${connectionSequence}`
        const providerAccountId = '7004'
        const row = connection(connectionId)
        const dialog = {
            isUser: true,
            entity: { id: 126n, firstName: 'Imported Peer' },
        }
        mocks.telegramConnectionFindUnique.mockResolvedValue(row)
        mocks.providerAccountId = providerAccountId
        mocks.getDialogs
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([dialog])
        mocks.getMessages.mockResolvedValue([{
            out: false,
            id: 2001,
            message: 'imported exact identity',
            date: Math.floor(Date.now() / 1000),
        }])

        await importTelegramHistory('job-exact', 'available_history', undefined, connectionId)

        expect(mocks.telegramConnectionFindUnique).toHaveBeenCalledWith({
            where: { id: connectionId },
        })
        expect(mocks.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({
            externalChatId: 'telegram:126',
            metadata: {
                chatKind: 'private',
                peerId: '126',
                providerAccountId,
                connectionId,
            },
        }))
        expect(mocks.resolveContact).toHaveBeenCalledWith(
            'telegram',
            '126',
            null,
            'Imported Peer',
            { chatKind: 'private', providerAccountId },
        )
        expect(mocks.upsertConversation.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.createMessage.mock.invocationCallOrder[0])
        expect(mocks.createMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.ensureContactLink.mock.invocationCallOrder[0])
        expect(mocks.recordReachability).not.toHaveBeenCalled()
        expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
            externalId: `telegram:${providerAccountId}:126:2001`,
        }))
    })

    test('identity-preflighted delivery preserves a long numeric Telegram peer and re-attests the live account', async () => {
        const connectionId = `telegram-account-send-${connectionSequence}`
        const providerAccountId = '7010'
        const peerId = '12345678901'
        const row = connection(connectionId)
        const chat = {
            ...exactChat({
                externalChatId: `telegram:${peerId}`,
                metadata: {
                    chatKind: 'private',
                    peerId,
                    providerAccountId,
                    connectionId,
                },
            }),
            id: 'chat-long-peer',
            contactId: 'contact-long-peer',
            contactIdentityId: 'identity-long-peer',
        }
        const prepared = {
            chatId: chat.id,
            channel: 'telegram',
            contactId: chat.contactId,
            contactIdentityId: chat.contactIdentityId,
            providerAccountId,
            connectionId,
            identityTarget: peerId,
            target: peerId,
            isMaxPersonal: false,
        }
        mocks.providerAccountId = providerAccountId
        mocks.telegramConnectionFindUnique.mockResolvedValue(row)
        mocks.chatFindUnique.mockResolvedValue(chat)
        mocks.prepareOutbound.mockResolvedValue(prepared)
        mocks.admittedChat = chat

        await expect(sendTelegramMessage(peerId, 'exact peer', connectionId, { chatId: chat.id }))
            .resolves.toMatchObject({ success: true, externalId: `telegram:${providerAccountId}:${peerId}:9001` })

        expect(mocks.prepareOutbound).toHaveBeenCalledWith(chat, connectionId)
        expect(mocks.getEntity).toHaveBeenCalledWith(BigInt(peerId))
        expect(mocks.getEntity).not.toHaveBeenCalledWith(`+${peerId}`)
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: BigInt(peerId) }),
            { message: 'exact peer' },
        )
    })

    test('cached connection fails closed if the authenticated account changes', async () => {
        const connectionId = `telegram-account-rebound-${connectionSequence}`
        await initializeListener(connectionId, '7020')
        mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
        mocks.providerAccountId = '7021'

        await expect(sendTelegramMessage('42', 'must not send', connectionId, { chatId: 'chat-rebound' }))
            .rejects.toThrow('TELEGRAM_PROVIDER_ACCOUNT_ID_CHANGED')
        expect(mocks.getEntity).not.toHaveBeenCalled()
        expect(mocks.sendMessage).not.toHaveBeenCalled()
    })

    test('media and reaction re-read the exact Chat and live account at the transport boundary', async () => {
        const connectionId = `telegram-nontext-${connectionSequence}`
        const providerAccountId = '7050'
        const peerId = '12345678901'
        const row = connection(connectionId)
        const chat = {
            ...exactChat({
                externalChatId: `telegram:${peerId}`,
                metadata: { chatKind: 'private', peerId, providerAccountId, connectionId },
            }),
            id: 'chat-nontext',
            contactId: 'contact-nontext',
            contactIdentityId: 'identity-nontext',
        }
        const prepared = {
            chatId: chat.id,
            channel: 'telegram',
            contactId: chat.contactId,
            contactIdentityId: chat.contactIdentityId,
            providerAccountId,
            connectionId,
            identityTarget: peerId,
            target: peerId,
            isMaxPersonal: false,
        }
        mocks.providerAccountId = providerAccountId
        mocks.telegramConnectionFindUnique.mockResolvedValue(row)
        mocks.chatFindUnique.mockResolvedValue(chat)
        mocks.prepareOutbound.mockResolvedValue(prepared)
        mocks.getEntity.mockResolvedValue({ id: BigInt(peerId) })

        await expect(sendTelegramMedia(
            peerId,
            'ZmFrZQ==',
            'proof.bin',
            'application/octet-stream',
            undefined,
            connectionId,
            { chatId: chat.id, providerAccountId, identityTarget: peerId },
        )).resolves.toEqual({
            success: true,
            externalId: `telegram:${providerAccountId}:${peerId}:9002`,
        })
        expect(mocks.sendFile).toHaveBeenCalledWith(
            expect.objectContaining({ id: BigInt(peerId) }),
            expect.objectContaining({ forceDocument: true }),
        )

        await sendTelegramReaction({
            target: peerId,
            messageId: `telegram:${providerAccountId}:${peerId}:301`,
            emoji: '👍',
            remove: false,
            connectionId,
            proof: { chatId: chat.id, providerAccountId, identityTarget: peerId },
        })
        expect(mocks.invoke).toHaveBeenCalledOnce()
        expect(mocks.prepareOutbound).toHaveBeenCalledWith(chat, connectionId)
    })

    test('non-text delivery rejects a conversation bound to another transport', async () => {
        const connectionId = `telegram-nontext-reject-${connectionSequence}`
        const peerId = '42'
        mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
        mocks.chatFindUnique.mockResolvedValue({ id: 'chat-nontext-reject' })
        // The conversation is bound to a DIFFERENT transport than the one this
        // send would leave through. Account provenance is deferred and no longer
        // compared; a concrete transport disagreement still fails closed.
        mocks.prepareOutbound.mockResolvedValue({
            chatId: 'chat-nontext-reject',
            channel: 'telegram',
            providerAccountId: null,
            connectionId: `${connectionId}-other`,
            identityTarget: peerId,
            target: peerId,
        })
        mocks.providerAccountId = '7060'

        await expect(sendTelegramMedia(
            peerId,
            'ZmFrZQ==',
            'proof.bin',
            'application/octet-stream',
            undefined,
            connectionId,
            { chatId: 'chat-nontext-reject', identityTarget: peerId },
        )).rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        expect(mocks.getEntity).not.toHaveBeenCalled()
        expect(mocks.sendFile).not.toHaveBeenCalled()
    })

    test('reaction updates use account-and-peer namespaced identity and reject a mismatched owning Chat', async () => {
        const connectionId = `telegram-reaction-${connectionSequence}`
        const providerAccountId = '7070'
        const handler = await initializeListener(connectionId, providerAccountId)
        const reactionHandler = mocks.clients.at(-1)?.handlers[1]
        expect(reactionHandler).toBeTypeOf('function')
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-other',
            chatId: 'chat-other',
            metadata: {},
            chat: {
                channel: 'telegram',
                externalChatId: 'telegram:99',
                metadata: { providerAccountId, connectionId, peerId: '99' },
            },
        })

        await reactionHandler!({ msgId: 301, peer: { userId: 42n }, reactions: { results: [] } })

        expect(mocks.messageFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { externalId: `telegram:${providerAccountId}:42:301` },
        }))
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
        expect(handler).toBeTypeOf('function')
    })

    test('reachability resolves a provider account through live attestation, not a connection primary key', async () => {
        const connectionId = `telegram-reachability-${connectionSequence}`
        const providerAccountId = '7030'
        mocks.providerAccountId = providerAccountId
        mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
        mocks.getEntity.mockResolvedValue({ id: BigInt(88) })

        await expect(checkTelegramReachability('+79990000001', providerAccountId)).resolves.toEqual({
            reachable: true,
            telegramId: '88',
            providerAccountId,
        })

        expect(mocks.telegramConnectionFindMany).toHaveBeenCalledWith({
            where: { isActive: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })
        expect(mocks.telegramConnectionFindUnique).not.toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: providerAccountId }),
        }))
    })

    test('reachability will not answer from a live transport authenticated as another account', async () => {
        const connectionId = `telegram-reachability-mismatch-${connectionSequence}`
        mocks.providerAccountId = '7040'
        mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])

        await expect(checkTelegramReachability('+79990000001', '7041')).resolves.toMatchObject({
            reachable: true,
            error: 'Telegram provider account is not live',
        })
        expect(mocks.getEntity).not.toHaveBeenCalled()
    })

    // Legacy compatibility must not become 'accept anything'. A row lacking
    // provenance it could never have recorded is admitted; a row that
    // CONTRADICTS the inbound event still fails closed before any write.
    test('admits a legacy private Chat carrying no transport or peer provenance', async () => {
        const connectionId = `telegram-account-legacy-${connectionSequence}`
        const handler = await initializeListener(connectionId, '7010')
        mocks.upsertConversation.mockResolvedValueOnce({
            conversation: {
                id: 'chat-legacy', channel: 'telegram', externalChatId: 'telegram:42',
                chatType: 'private', contactId: null, contactIdentityId: null, driverId: null,
                metadata: {},
            },
        })

        await handler({ message: inboundMessage('42') })

        expect(mocks.appendCollision).not.toHaveBeenCalled()
        expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
        expect(mocks.resolveContact).toHaveBeenCalled()
    })

    test('still rejects a conversation whose stored peer is somebody else', async () => {
        const connectionId = `telegram-account-peer-${connectionSequence}`
        const handler = await initializeListener(connectionId, '7011')
        mocks.upsertConversation.mockResolvedValueOnce({
            conversation: {
                id: 'chat-other-peer', channel: 'telegram', externalChatId: 'telegram:42',
                chatType: 'private', contactId: 'contact-x', contactIdentityId: 'identity-x',
                driverId: null,
                metadata: { chatKind: 'private', peerId: '999', connectionId },
            },
        })

        await handler({ message: inboundMessage('42') })

        expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
            evidence: expect.objectContaining({ reason: 'peer_identity_mismatch' }),
        }))
        // TG design section 14, item 6: the audit lives on the Chat only.
        expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
        expect(mocks.resolveContact).not.toHaveBeenCalled()
        expect(mocks.createMessage).not.toHaveBeenCalled()
    })


    // Routing compatibility for the production Telegram conversations that carry
    // no transport binding and can never gain one. It answers only which socket
    // carries the send. It resolves ONLY when exactly one active transport
    // exists, so there is no second account to cross into and no choice to make.
    // The legacy rollout invariant. A conversation that carries no transport
    // binding, with exactly one active carrier, must remain usable on every
    // outbound path. Routing is compatibility only and persists nothing.
    describe('legacy unbound Telegram conversation with one active carrier', () => {
        const PEER = '4242'
        const LIVE_ACCOUNT = '9100'
        const CARRIER = 'tg-sole-carrier'
        const REACTION_TARGET = `telegram:${LIVE_ACCOUNT}:${PEER}:301`

        function legacySetup() {
            const chat = {
                ...exactChat({
                    externalChatId: `telegram:${PEER}`,
                    metadata: { chatKind: 'private', peerId: PEER },
                }),
                id: 'chat-legacy',
                contactId: 'contact-legacy',
                contactIdentityId: 'identity-legacy',
            }
            // The account is a LIVE getMe result from the socket the send leaves
            // through, never a stored stamp.
            mocks.providerAccountId = LIVE_ACCOUNT
            mocks.telegramConnectionFindMany.mockResolvedValue([{ id: CARRIER }])
            mocks.telegramConnectionFindUnique.mockResolvedValue(connection(CARRIER))
            mocks.chatFindUnique.mockResolvedValue(chat)
            mocks.getEntity.mockResolvedValue({ id: BigInt(PEER) })
            mocks.prepareOutbound.mockResolvedValue({
                chatId: chat.id,
                channel: 'telegram',
                contactId: chat.contactId,
                contactIdentityId: chat.contactIdentityId,
                providerAccountId: null,
                connectionId: null,
                identityTarget: PEER,
                target: PEER,
                isMaxPersonal: false,
            })
            return chat
        }

        test('text, media and reaction all send through the sole carrier', async () => {
            const chat = legacySetup()

            await sendTelegramMessage(PEER, 'legacy text', undefined, { chatId: chat.id })

            await expect(sendTelegramMedia(
                PEER, 'ZmFrZQ==', 'proof.bin', 'application/octet-stream', undefined, undefined,
                { chatId: chat.id, identityTarget: PEER },
            )).resolves.toMatchObject({ success: true })

            await sendTelegramReaction({
                target: PEER,
                messageId: REACTION_TARGET,
                emoji: '👍',
                remove: false,
                connectionId: undefined,
                proof: { chatId: chat.id, identityTarget: PEER },
            })
            expect(mocks.invoke).toHaveBeenCalled()
            // Every one of the three paths left through the sole active carrier,
            // and none of them consulted a stored provider-account stamp.
            expect(mocks.telegramConnectionFindMany).toHaveBeenCalledTimes(3)
            expect(mocks.telegramConnectionFindUnique).toHaveBeenCalledTimes(3)
            for (const call of mocks.telegramConnectionFindUnique.mock.calls) {
                expect(call[0]).toMatchObject({ where: { id: CARRIER } })
            }
        })

        test.each([
            ['no active carrier', []],
            ['several active carriers', [{ id: 'a' }, { id: 'b' }]],
        ])('every path fails closed with %s', async (_label, carriers) => {
            const chat = legacySetup()
            mocks.telegramConnectionFindMany.mockResolvedValue(carriers)

            await expect(sendTelegramMessage(PEER, 'legacy', undefined, { chatId: chat.id }))
                .rejects.toThrow()
            await expect(sendTelegramMedia(
                PEER, 'ZmFrZQ==', 'proof.bin', 'application/octet-stream', undefined, undefined,
                { chatId: chat.id, identityTarget: PEER },
            )).rejects.toThrow()
            await expect(sendTelegramReaction({
                target: PEER,
                messageId: REACTION_TARGET,
                emoji: '👍',
                remove: false,
                connectionId: undefined,
                proof: { chatId: chat.id, identityTarget: PEER },
            })).rejects.toThrow()
        })
    })
    // ── TG-1: persist first, then enrich ─────────────────────────────────
    // A valid provider message is stored before any Contact or Driver work, and
    // no enrichment outcome, duplicate, race, restart or catch-up failure can
    // make it disappear or store it twice.
    const RUNTIME_SLOT = Symbol.for('yoko.telegram.mtproto-runtime.v1')

    type StoredRow = {
        id: string
        chatId: string
        externalId: string
        direction: string
        content: string
        sentAt: Date
    }

    // Does one Prisma where-arm match a stored row? Equality per field, plus the
    // gte/lte range a content window uses, so any dedupe arm is evaluated as
    // the database would evaluate it.
    function storedArmMatches(row: StoredRow, arm: Record<string, any>): boolean {
        return Object.entries(arm).every(([field, expected]) => {
            if (field === 'sentAt') {
                const at = row.sentAt.getTime()
                return (expected.gte === undefined || at >= expected.gte.getTime())
                    && (expected.lte === undefined || at <= expected.lte.getTime())
            }
            return (row as Record<string, unknown>)[field] === expected
        })
    }

    // An in-memory Message table with the real unique key on externalId.
    function useMessageStore() {
        const rows = new Map<string, StoredRow>()
        mocks.createMessage.mockImplementation(async (command: StoredRow) => {
            if (rows.has(command.externalId)) {
                throw Object.assign(new Error('Unique constraint failed on the fields: (`externalId`)'), { code: 'P2002' })
            }
            const row = {
                id: `stored-${rows.size + 1}`,
                chatId: command.chatId,
                externalId: command.externalId,
                direction: command.direction,
                content: command.content,
                sentAt: command.sentAt,
            }
            rows.set(command.externalId, row)
            return { message: row }
        })
        mocks.messageFindFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
            const arms: Array<Record<string, any>> = where.OR ?? [where]
            return [...rows.values()].find(row => arms.some(arm => storedArmMatches(row, arm))) ?? null
        })
        return rows
    }

    function enrichmentBlockedLogs() {
        return mocks.opsLog.mock.calls.filter(call => call[1] === 'telegram_mtproto_enrichment_blocked')
    }

    function catchUpSummaries(connectionId: string) {
        return mocks.opsLog.mock.calls
            .filter(call => call[1] === 'telegram_mtproto_catchup_summary' && call[2]?.connectionId === connectionId)
            .map(call => call[2])
    }

    async function waitForCatchUp(connectionId: string, count = 1) {
        await vi.waitFor(() => expect(catchUpSummaries(connectionId).length).toBeGreaterThanOrEqual(count))
        return catchUpSummaries(connectionId)[count - 1]
    }

    function listenerErrors() {
        return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
            .filter(call => String(call[0]).startsWith('[TG-LISTENER] Error'))
    }

    function catchUpMessage(peerId: string, id: number, out = false) {
        return {
            out,
            id,
            peerId: { userId: BigInt(peerId) },
            message: `catch-up ${peerId}/${id}`,
            date: Math.floor(Date.now() / 1000) - 600 + id,
        }
    }

    describe('TG-1 persist-first MTProto ingress', () => {
        describe('enrichment failure after the provider event', () => {
            test('inbound persists when the link throws DRIVER_MISMATCH; no person write, side effects still run', async () => {
                const connectionId = `tg1-driver-mismatch-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7101')
                mocks.ensureContactLink.mockRejectedValueOnce(new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH'))

                await handler({ message: inboundMessage('42') })

                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
                    chatId: 'chat:telegram:42',
                    direction: 'inbound',
                    externalId: 'telegram:7101:42:1001',
                    status: 'delivered',
                }))
                expect(mocks.recordReachability).not.toHaveBeenCalled()
                expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
                expect(enrichmentBlockedLogs()).toEqual([[
                    'warn',
                    'telegram_mtproto_enrichment_blocked',
                    expect.objectContaining({
                        channel: 'telegram',
                        phase: 'inbound',
                        connectionId,
                        chatId: 'chat:telegram:42',
                        messageId: 'message-1',
                        error: 'CONTACT_CONVERSATION_DRIVER_MISMATCH',
                    }),
                ]])
                expect(mocks.inboundWorkflow).toHaveBeenCalledWith('chat:telegram:42', expect.any(Date))
                expect(mocks.emitMessage).toHaveBeenCalledWith({ id: 'message-1' })
                expect(listenerErrors()).toEqual([])
            })

            test.each([
                ['error', 'a Contact lock timeout'],
                ['ambiguous', 'identity ambiguity'],
                ['conflicted', 'an open identity conflict'],
            ])('inbound persists when the resolver answers %s (%s), with no link and no conflict write', async (status) => {
                const connectionId = `tg1-resolver-${status}-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7102')
                mocks.isResolvedContact.mockReturnValue(false)
                mocks.resolveContact.mockResolvedValue({ status, warnings: [] })

                await handler({ message: inboundMessage('42') })

                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(mocks.ensureContactLink).not.toHaveBeenCalled()
                expect(mocks.recordReachability).not.toHaveBeenCalled()
                expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
                expect(enrichmentBlockedLogs()[0]?.[2]).toMatchObject({
                    phase: 'inbound',
                    error: `CONTACT_RESOLUTION_BLOCKED:${status}`,
                })
                expect(mocks.emitMessage).toHaveBeenCalledOnce()
            })

            test('inbound persists when the resolver itself throws', async () => {
                const connectionId = `tg1-resolver-throws-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7103')
                mocks.resolveContact.mockRejectedValueOnce(new Error('CONTACT_OWNERSHIP_LOCK_TIMEOUT'))

                await handler({ message: inboundMessage('42') })

                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(enrichmentBlockedLogs()[0]?.[2]).toMatchObject({ error: 'CONTACT_OWNERSHIP_LOCK_TIMEOUT' })
                expect(listenerErrors()).toEqual([])
            })

            test('the outbound mirror persists for a driver-bound chat', async () => {
                const connectionId = `tg1-mirror-driver-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7104')
                mocks.ensureContactLink.mockRejectedValueOnce(new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH'))

                await handler({ message: outboundMessage('84') })

                expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
                    direction: 'outbound',
                    externalId: 'telegram:7104:84:1002',
                }))
                expect(enrichmentBlockedLogs()[0]?.[2]).toMatchObject({ phase: 'mirror', messageId: 'message-1' })
                expect(mocks.emitMessage).toHaveBeenCalledWith({ id: 'message-1' })
                expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
            })

            test('history import persists every message of a driver-bound dialog and reports the dialog as enrichment-blocked', async () => {
                const connectionId = `tg1-import-driver-${connectionSequence}`
                const providerAccountId = '7105'
                mocks.providerAccountId = providerAccountId
                mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
                mocks.getDialogs
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([{ isUser: true, entity: { id: 126n, firstName: 'Driver' } }])
                mocks.getMessages.mockResolvedValue([catchUpMessage('126', 2), catchUpMessage('126', 1)])
                mocks.ensureContactLink.mockRejectedValue(new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH'))

                await importTelegramHistory('job-driver-bound', 'available_history', undefined, connectionId)

                expect(mocks.createMessage).toHaveBeenCalledTimes(2)
                expect(enrichmentBlockedLogs()[0]?.[2]).toMatchObject({ phase: 'import', chatId: 'chat:telegram:126' })
                expect(mocks.patchImportJob).toHaveBeenLastCalledWith(expect.objectContaining({
                    jobId: 'job-driver-bound',
                    patch: expect.objectContaining({
                        status: 'completed',
                        contactsFound: 0,
                        detailsJson: expect.objectContaining({
                            newMessages: 2,
                            failedMessages: 0,
                            enrichmentBlockedChats: 1,
                        }),
                    }),
                }))
            })
        })

        test('history import stores the rest of a dialog when one message cannot be stored', async () => {
            const rows = useMessageStore()
            const connectionId = `tg1-import-isolation-${connectionSequence}`
            const providerAccountId = '7106'
            mocks.providerAccountId = providerAccountId
            mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
            mocks.getDialogs
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ isUser: true, entity: { id: 127n, firstName: 'Peer' } }])
            mocks.getMessages.mockResolvedValue([
                catchUpMessage('127', 3),
                catchUpMessage('127', 2),
                catchUpMessage('127', 1),
            ])
            const store = mocks.createMessage.getMockImplementation()!
            mocks.createMessage.mockImplementation(async (command: { externalId: string }) => {
                if (command.externalId === `telegram:${providerAccountId}:127:2`) throw new Error('database unavailable')
                return store(command)
            })

            await importTelegramHistory('job-isolation', 'available_history', undefined, connectionId)

            expect([...rows.keys()].sort()).toEqual([
                `telegram:${providerAccountId}:127:1`,
                `telegram:${providerAccountId}:127:3`,
            ])
            expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
            expect(mocks.patchImportJob).toHaveBeenLastCalledWith(expect.objectContaining({
                patch: expect.objectContaining({
                    status: 'completed',
                    contactsFound: 1,
                    detailsJson: expect.objectContaining({ newMessages: 2, failedMessages: 1, enrichmentBlockedChats: 0 }),
                }),
            }))
        })

        describe('duplicate provider events and the insert race', () => {
            test('the same event delivered twice is stored and enriched once', async () => {
                const rows = useMessageStore()
                const connectionId = `tg1-duplicate-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7110')

                await handler({ message: inboundMessage('42') })
                await handler({ message: inboundMessage('42') })

                expect(rows.size).toBe(1)
                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(mocks.resolveContact).toHaveBeenCalledOnce()
                expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
                expect(mocks.emitMessage).toHaveBeenCalledOnce()
            })

            test('a unique violation on the exact provider key is a benign duplicate', async () => {
                const rows = useMessageStore()
                const connectionId = `tg1-p2002-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7111')
                // Another path stored the event inside the dedupe window.
                rows.set('telegram:7111:42:1001', {
                    id: 'stored-by-catch-up',
                    chatId: 'chat:telegram:42',
                    externalId: 'telegram:7111:42:1001',
                    direction: 'inbound',
                    content: 'inbound exact identity',
                    sentAt: new Date(),
                })
                mocks.messageFindFirst.mockResolvedValueOnce(null)

                await handler({ message: inboundMessage('42') })

                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(rows.size).toBe(1)
                expect(listenerErrors()).toEqual([])
                expect(mocks.resolveContact).not.toHaveBeenCalled()
                expect(mocks.emitMessage).not.toHaveBeenCalled()
                expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
            })

            test('two concurrent deliveries of one event store one row and never fail', async () => {
                const rows = useMessageStore()
                const connectionId = `tg1-concurrent-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7112')

                await Promise.all([
                    handler({ message: inboundMessage('42') }),
                    handler({ message: inboundMessage('42') }),
                ])

                expect(rows.size).toBe(1)
                expect(listenerErrors()).toEqual([])
                expect(mocks.emitMessage).toHaveBeenCalledOnce()
            })

            test('a unique violation the exact key does not explain is a real failure', async () => {
                const connectionId = `tg1-p2002-unexplained-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7113')
                mocks.createMessage.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' }))

                await handler({ message: inboundMessage('42') })

                expect(listenerErrors()).toHaveLength(1)
                expect(mocks.resolveContact).not.toHaveBeenCalled()
                expect(mocks.emitMessage).not.toHaveBeenCalled()
            })
        })

        test('a persistence failure enriches nothing, publishes nothing and surfaces as a failure', async () => {
            const connectionId = `tg1-persist-failure-${connectionSequence}`
            const handler = await initializeListener(connectionId, '7120')
            mocks.createMessage.mockRejectedValueOnce(new Error('database unavailable'))

            await handler({ message: inboundMessage('42') })

            expect(listenerErrors()).toHaveLength(1)
            expect(mocks.resolveContact).not.toHaveBeenCalled()
            expect(mocks.ensureContactLink).not.toHaveBeenCalled()
            expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
            expect(mocks.emitMessage).not.toHaveBeenCalled()
            expect(enrichmentBlockedLogs()).toEqual([])
        })

        test('a message lost to a persistence failure is recovered once by catch-up after a restart, and a second restart adds nothing', async () => {
            const rows = useMessageStore()
            const connectionId = `tg1-restart-${connectionSequence}`
            const providerAccountId = '7121'
            const host = globalThis as Record<symbol, unknown>
            const original = host[RUNTIME_SLOT]
            const restarted: Array<{ stopTelegramHealthCheck: () => Promise<void> }> = []
            try {
                const handler = await initializeListener(connectionId, providerAccountId)
                await waitForCatchUp(connectionId)
                mocks.createMessage.mockRejectedValueOnce(new Error('database unavailable'))
                await handler({ message: inboundMessage('42') })
                expect(rows.size).toBe(0)

                mocks.getDialogs.mockResolvedValue([{ isUser: true, entity: { id: 42n }, unreadCount: 1 }])
                mocks.getMessages.mockResolvedValue([inboundMessage('42')])
                for (let restart = 1; restart <= 2; restart++) {
                    // A new process: fresh module and fresh per-process runtime.
                    delete host[RUNTIME_SLOT]
                    vi.resetModules()
                    const fresh = await import('./tg-actions')
                    restarted.push(fresh)
                    await fresh.initTelegramListeners()
                    const summary = await waitForCatchUp(connectionId, restart + 1)
                    expect(summary).toMatchObject({
                        mode: 'startup',
                        saved: restart === 1 ? 1 : 0,
                        duplicates: restart === 1 ? 0 : 1,
                        failed: 0,
                        error: undefined,
                    })
                }

                expect(rows.size).toBe(1)
                expect([...rows.keys()]).toEqual([`telegram:${providerAccountId}:42:1001`])
            } finally {
                for (const module of restarted) await module.stopTelegramHealthCheck()
                host[RUNTIME_SLOT] = original
            }
        })

        test('catch-up replays oldest first and persists each message before its enrichment', async () => {
            useMessageStore()
            const connectionId = `tg1-ordering-${connectionSequence}`
            mocks.providerAccountId = '7130'
            mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
            mocks.getDialogs.mockResolvedValue([{ isUser: true, entity: { id: 55n }, unreadCount: 3 }])
            // GramJS returns the newest message first.
            mocks.getMessages.mockResolvedValue([catchUpMessage('55', 3), catchUpMessage('55', 2), catchUpMessage('55', 1)])

            await initTelegramListeners()
            await waitForCatchUp(connectionId)

            expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual([
                'telegram:7130:55:1',
                'telegram:7130:55:2',
                'telegram:7130:55:3',
            ])
            const created = mocks.createMessage.mock.invocationCallOrder
            const enriched = mocks.resolveContact.mock.invocationCallOrder
            expect(enriched).toHaveLength(3)
            for (let index = 0; index < 3; index++) {
                expect(created[index]).toBeLessThan(enriched[index])
                if (index < 2) expect(enriched[index]).toBeLessThan(created[index + 1])
            }
        })

        describe('catch-up', () => {
            test('one failing message or dialog never aborts the run, non-person dialogs are skipped, and one summary is logged', async () => {
                useMessageStore()
                const connectionId = `tg1-catchup-isolation-${connectionSequence}`
                const providerAccountId = '7140'
                mocks.providerAccountId = providerAccountId
                mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
                mocks.getDialogs.mockResolvedValue([
                    { isUser: true, entity: { id: 501n }, unreadCount: 0 },
                    { isUser: true, entity: { id: 502n }, unreadCount: 0 },
                    { isUser: true, entity: { id: BigInt(providerAccountId) }, unreadCount: 0 },
                    { isUser: true, entity: { id: 777000n }, unreadCount: 1 },
                    { isUser: true, entity: { id: 504n, bot: true }, unreadCount: 1 },
                    { isUser: true, entity: { id: 503n }, unreadCount: 0 },
                ])
                mocks.getMessages.mockImplementation(async (entity: { id: bigint }) => {
                    const peer = entity.id.toString()
                    if (peer === '502') throw new Error('FLOOD_WAIT_3')
                    if (peer === '501') return [catchUpMessage('501', 2), catchUpMessage('501', 1)]
                    if (peer === '503') return [catchUpMessage('503', 1)]
                    throw new Error(`unexpected dialog ${peer}`)
                })
                const store = mocks.createMessage.getMockImplementation()!
                mocks.createMessage.mockImplementation(async (command: { externalId: string }) => {
                    if (command.externalId === `telegram:${providerAccountId}:501:1`) throw new Error('database unavailable')
                    return store(command)
                })
                mocks.ensureContactLink.mockImplementation(async (command: { chatId: string }) => {
                    if (command.chatId === 'chat:telegram:503') throw new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH')
                    return { completed: true }
                })

                await initTelegramListeners()
                const summary = await waitForCatchUp(connectionId)

                expect(summary).toMatchObject({
                    mode: 'startup',
                    dialogs: 3,
                    skippedDialogs: 3,
                    failedDialogs: 1,
                    messages: 3,
                    saved: 2,
                    duplicates: 0,
                    enrichmentBlocked: 1,
                    failed: 1,
                    error: undefined,
                })
                expect(catchUpSummaries(connectionId)).toHaveLength(1)
                expect(mocks.getDialogs).toHaveBeenCalledWith({ limit: 100 })
                const fetchedPeers = mocks.getMessages.mock.calls.map(call => (call[0] as { id: bigint }).id.toString())
                expect(fetchedPeers).toEqual(['501', '502', '503'])
            })

            test('concurrent catch-up requests for one connection make one getDialogs', async () => {
                const connectionId = `tg1-single-flight-${connectionSequence}`
                mocks.providerAccountId = '7141'
                mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
                mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
                let releaseDialogs!: (dialogs: unknown[]) => void
                mocks.getDialogs.mockImplementationOnce(() => new Promise(resolve => { releaseDialogs = resolve }))

                await initTelegramListeners()
                await vi.waitFor(() => expect(mocks.getDialogs).toHaveBeenCalledOnce())
                const resumed = resumeTelegramConnection(connectionId, true)
                await vi.waitFor(() => expect(mocks.telegramConnectionFindUnique).toHaveBeenCalled())
                releaseDialogs([])
                await resumed

                expect(mocks.getDialogs).toHaveBeenCalledOnce()
                expect(catchUpSummaries(connectionId)).toHaveLength(1)
            })

            test('a send never starts a catch-up run', async () => {
                const connectionId = `tg1-send-no-catchup-${connectionSequence}`
                const providerAccountId = '7142'
                const peerId = '4242'
                const chat = {
                    ...exactChat({
                        externalChatId: `telegram:${peerId}`,
                        metadata: { chatKind: 'private', peerId, providerAccountId, connectionId },
                    }),
                    id: 'chat-send-no-catchup',
                    contactId: 'contact-send',
                    contactIdentityId: 'identity-send',
                }
                await initializeListener(connectionId, providerAccountId)
                await waitForCatchUp(connectionId)
                mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
                mocks.chatFindUnique.mockResolvedValue(chat)
                mocks.prepareOutbound.mockResolvedValue({
                    chatId: chat.id,
                    channel: 'telegram',
                    providerAccountId,
                    connectionId,
                    identityTarget: peerId,
                    target: peerId,
                })

                await sendTelegramMessage(peerId, 'first', connectionId, { chatId: chat.id })
                await sendTelegramMessage(peerId, 'second', connectionId, { chatId: chat.id })

                expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
                expect(mocks.getDialogs).toHaveBeenCalledOnce()
            })

            test('the health tick replays the recent 30 dialogs every 10 minutes while connected', async () => {
                vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
                try {
                    const connectionId = `tg1-periodic-${connectionSequence}`
                    await initializeListener(connectionId, '7143')
                    await waitForCatchUp(connectionId)
                    expect(mocks.getDialogs.mock.calls.map(call => call[0])).toEqual([{ limit: 100 }])

                    await vi.advanceTimersByTimeAsync(9 * 60_000)
                    expect(mocks.getDialogs).toHaveBeenCalledOnce()

                    await vi.advanceTimersByTimeAsync(60_000)
                    await waitForCatchUp(connectionId, 2)
                    expect(mocks.getDialogs.mock.calls.map(call => call[0])).toEqual([{ limit: 100 }, { limit: 30 }])
                    expect(catchUpSummaries(connectionId)[1]).toMatchObject({ mode: 'periodic' })

                    await vi.advanceTimersByTimeAsync(60_000)
                    expect(mocks.getDialogs).toHaveBeenCalledTimes(2)
                } finally {
                    await stopTelegramHealthCheck()
                    vi.useRealTimers()
                }
            })
        })

        test('two module copies in one process resolve to one GramJS client', async () => {
            const connectionId = `tg1-one-client-${connectionSequence}`
            mocks.providerAccountId = '7150'
            mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
            mocks.getEntity.mockResolvedValue({ id: 88n })
            vi.resetModules()
            const startupCopy = await import('./tg-actions')
            vi.resetModules()
            const routeCopy = await import('./tg-actions')
            expect(startupCopy).not.toBe(routeCopy)

            await Promise.all([
                startupCopy.initTelegramListeners(),
                routeCopy.checkTelegramReachability('+79990000001'),
                routeCopy.initTelegramListeners(),
            ])
            await waitForCatchUp(connectionId)

            expect(mocks.clients).toHaveLength(1)
            expect(mocks.clients[0].handlers).toHaveLength(2)
            expect(mocks.getDialogs).toHaveBeenCalledOnce()
        })

        describe('non-person peers', () => {
            test.each([
                ['Telegram service account 777000', '777000', {}, false],
                ['the account itself (Saved Messages)', '7160', {}, false],
                ['a bot', '93', { sender: { bot: true, firstName: 'Bot' } }, false],
                ['a mirror to the account itself', '7160', {}, true],
                ['a mirror to a bot', '93', { chat: { bot: true, firstName: 'Bot' } }, true],
            ])('%s produces zero writes', async (_label, peerId, extra, out) => {
                const connectionId = `tg1-non-person-${peerId}-${out}-${connectionSequence}`
                const handler = await initializeListener(connectionId, '7160')

                await handler({ message: { ...(out ? outboundMessage(peerId) : inboundMessage(peerId)), ...extra } })

                expect(mocks.upsertConversation).not.toHaveBeenCalled()
                expect(mocks.messageFindFirst).not.toHaveBeenCalled()
                expect(mocks.createMessage).not.toHaveBeenCalled()
                expect(mocks.resolveContact).not.toHaveBeenCalled()
                expect(mocks.ensureContactLink).not.toHaveBeenCalled()
                expect(mocks.emitMessage).not.toHaveBeenCalled()
            })

            test('history import skips self, service and bot dialogs', async () => {
                const connectionId = `tg1-import-non-person-${connectionSequence}`
                const providerAccountId = '7161'
                mocks.providerAccountId = providerAccountId
                mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
                mocks.getDialogs
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([
                        { isUser: true, entity: { id: BigInt(providerAccountId) } },
                        { isUser: true, entity: { id: 777000n } },
                        { isUser: true, entity: { id: 93n, bot: true } },
                    ])

                await importTelegramHistory('job-non-person', 'available_history', undefined, connectionId)

                expect(mocks.getMessages).not.toHaveBeenCalled()
                expect(mocks.upsertConversation).not.toHaveBeenCalled()
                expect(mocks.createMessage).not.toHaveBeenCalled()
            })
        })

        describe('reply semantic', () => {
            const PEER = '12345678901'
            const ACCOUNT = '7170'

            function replySetup() {
                const connectionId = `tg1-reply-${connectionSequence}`
                const chat = {
                    ...exactChat({
                        externalChatId: `telegram:${PEER}`,
                        metadata: { chatKind: 'private', peerId: PEER, providerAccountId: ACCOUNT, connectionId },
                    }),
                    id: 'chat-reply',
                    contactId: 'contact-reply',
                    contactIdentityId: 'identity-reply',
                }
                mocks.providerAccountId = ACCOUNT
                mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
                mocks.chatFindUnique.mockResolvedValue(chat)
                mocks.prepareOutbound.mockResolvedValue({
                    chatId: chat.id,
                    channel: 'telegram',
                    providerAccountId: ACCOUNT,
                    connectionId,
                    identityTarget: PEER,
                    target: PEER,
                })
                return { connectionId, chat }
            }

            test('a quote in the exact current form for this live account and peer is sent as a reply', async () => {
                const { connectionId, chat } = replySetup()
                mocks.getMessages.mockResolvedValue([{ id: 5021, date: 1_700_000_000 }])

                await expect(sendTelegramMessage(PEER, 'answer', connectionId, {
                    chatId: chat.id,
                    quotedMsgId: `telegram:${ACCOUNT}:${PEER}:5021`,
                })).resolves.toMatchObject({ success: true })

                expect(mocks.sendMessage).toHaveBeenCalledWith(
                    expect.objectContaining({ id: BigInt(PEER) }),
                    { message: 'answer', replyTo: 5021 },
                )
            })

            test.each([
                ['another account', `telegram:9999:${PEER}:5021`],
                ['another peer', `telegram:${ACCOUNT}:42:5021`],
                ['a Bot-lane event key', `telegram:${ACCOUNT}:${PEER}:update%3A77`],
                ['an old Bot-lane id', `telegram:${PEER}:5021`],
                ['a zero id', `telegram:${ACCOUNT}:${PEER}:0`],
                ['an unsafe integer', `telegram:${ACCOUNT}:${PEER}:99999999999999999999`],
                ['garbage', 'not-a-message'],
            ])('a quote that is %s refuses the send instead of downgrading it to plain text', async (_label, quotedMsgId) => {
                const { connectionId, chat } = replySetup()

                await expect(sendTelegramMessage(PEER, 'answer', connectionId, { chatId: chat.id, quotedMsgId }))
                    .rejects.toThrow('REPLY_TARGET_NOT_ADDRESSABLE')

                expect(mocks.sendMessage).not.toHaveBeenCalled()
                expect(mocks.getEntity).not.toHaveBeenCalled()
            })
        })
    })
    // ── TG-2: MTProto reliability completion ─────────────────────────────
    // F4 key-only inbound dedupe, F5 peer resolution with one sweep, F6 the
    // channel's own quote parser with a live addressability proof.
    describe('TG-2 MTProto reliability completion', () => {
        // The published S1 adapter outcome token (MessageService, S1 contract).
        const S1_OUTCOME_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(SEND_OUTCOME_UNKNOWN|NOT_DISPATCHED|REFUSED)\b/g
        const s1Outcomes = (error: unknown) => [...String((error as Error)?.message ?? error).matchAll(S1_OUTCOME_CODE)].map(match => match[1])

        async function rejection(promise: Promise<unknown>): Promise<Error> {
            try {
                await promise
            } catch (error) {
                return error as Error
            }
            throw new Error('expected a rejection')
        }

        function sweepCalls() {
            return mocks.getDialogs.mock.calls.filter(call => (call[0] as { limit?: number })?.limit === 200)
        }

        function sendSetup(peerId: string, providerAccountId = '7200') {
            const connectionId = `tg2-send-${peerId}-${connectionSequence}`
            const chat = {
                ...exactChat({
                    externalChatId: `telegram:${peerId}`,
                    metadata: { chatKind: 'private', peerId, providerAccountId, connectionId },
                }),
                id: `chat-tg2-${peerId}`,
                contactId: `contact-tg2-${peerId}`,
                contactIdentityId: `identity-tg2-${peerId}`,
            }
            mocks.providerAccountId = providerAccountId
            mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
            mocks.chatFindUnique.mockResolvedValue(chat)
            mocks.prepareOutbound.mockResolvedValue({
                chatId: chat.id,
                channel: 'telegram',
                providerAccountId,
                connectionId,
                identityTarget: peerId,
                target: peerId,
            })
            return { connectionId, chat }
        }

        describe('F4 key-only inbound dedupe', () => {
            test('two identical texts with distinct provider ids within seconds are two rows', async () => {
                const rows = useMessageStore()
                const handler = await initializeListener(`tg2-repeat-${connectionSequence}`, '7201')
                const first = { ...inboundMessage('42'), id: 3001, message: 'да' }
                const second = { ...first, id: 3002, date: first.date + 1 }

                await handler({ message: first })
                await handler({ message: second })

                expect([...rows.keys()]).toEqual(['telegram:7201:42:3001', 'telegram:7201:42:3002'])
            })

            test('the same word twice within 5 s, then 1..6, arrives as 8 rows in order (catch-up replay)', async () => {
                const rows = useMessageStore()
                const connectionId = `tg2-burst-${connectionSequence}`
                mocks.providerAccountId = '7202'
                mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
                const base = Math.floor(Date.now() / 1000) - 120
                const sent = ['ок', 'ок', '1', '2', '3', '4', '5', '6'].map((text, index) => ({
                    out: false,
                    id: 4001 + index,
                    peerId: { userId: 77n },
                    message: text,
                    date: base + (index < 2 ? 0 : index),
                }))
                mocks.getDialogs.mockResolvedValue([{ isUser: true, entity: { id: 77n }, unreadCount: 8 }])
                mocks.getMessages.mockResolvedValue([...sent].reverse())

                await initTelegramListeners()
                await waitForCatchUp(connectionId)

                expect([...rows.values()].map(row => row.content)).toEqual(['ок', 'ок', '1', '2', '3', '4', '5', '6'])
                expect(rows.size).toBe(8)
            })

            test('a replayed event is matched exactly to its legacy bare row in the same chat, and only there', async () => {
                const rows = useMessageStore()
                const handler = await initializeListener(`tg2-legacy-${connectionSequence}`, '7203')
                const stamp = new Date()
                rows.set('5501', { id: 'legacy-in-42', chatId: 'chat:telegram:42', externalId: '5501', direction: 'inbound', content: 'старый текст', sentAt: stamp })
                rows.set('5502', { id: 'legacy-in-99', chatId: 'chat:telegram:99', externalId: '5502', direction: 'inbound', content: 'другой чат', sentAt: stamp })

                await handler({ message: { ...inboundMessage('42'), id: 5501, message: 'старый текст' } })
                await handler({ message: { ...inboundMessage('42'), id: 5502, message: 'другой чат' } })

                expect(rows.has('telegram:7203:42:5501')).toBe(false)
                expect(rows.has('telegram:7203:42:5502')).toBe(true)
                expect(rows.size).toBe(3)
            })

            test('a reworded event with an already stored provider id stays one row', async () => {
                const rows = useMessageStore()
                const handler = await initializeListener(`tg2-reworded-${connectionSequence}`, '7204')

                await handler({ message: { ...inboundMessage('42'), id: 6001, message: 'исходный' } })
                await handler({ message: { ...inboundMessage('42'), id: 6001, message: 'отредактированный', date: Math.floor(Date.now() / 1000) + 30 } })

                expect(rows.size).toBe(1)
                expect(mocks.createMessage).toHaveBeenCalledOnce()
            })

            test('history import stores identical inbound texts by key and matches legacy bare rows exactly', async () => {
                const rows = useMessageStore()
                const connectionId = `tg2-import-${connectionSequence}`
                const providerAccountId = '7205'
                mocks.providerAccountId = providerAccountId
                mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
                const date = Math.floor(Date.now() / 1000) - 60
                rows.set('7001', { id: 'legacy-7001', chatId: 'chat:telegram:128', externalId: '7001', direction: 'inbound', content: 'привет', sentAt: new Date(date * 1000) })
                mocks.getDialogs
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([{ isUser: true, entity: { id: 128n, firstName: 'Peer' } }])
                mocks.getMessages.mockResolvedValue([
                    { out: false, id: 7003, message: 'да', date: date + 2 },
                    { out: false, id: 7002, message: 'да', date: date + 1 },
                    { out: false, id: 7001, message: 'привет', date },
                ])

                await importTelegramHistory('job-tg2-keys', 'available_history', undefined, connectionId)

                expect([...rows.keys()].sort()).toEqual(['7001', `telegram:${providerAccountId}:128:7002`, `telegram:${providerAccountId}:128:7003`])
                expect(mocks.patchImportJob).toHaveBeenLastCalledWith(expect.objectContaining({
                    patch: expect.objectContaining({
                        detailsJson: expect.objectContaining({ newMessages: 2, failedMessages: 0 }),
                    }),
                }))
            })
        })

        describe('F5 peer resolution', () => {
            test('a peer missing from the entity cache resolves after one sweep and is sent once', async () => {
                const peerId = '880001'
                const { connectionId, chat } = sendSetup(peerId)
                mocks.getEntity
                    .mockRejectedValueOnce(new Error(`Could not find the input entity for {"userId":"${peerId}"}`))
                    .mockImplementation(async target => ({ id: target }))

                await expect(sendTelegramMessage(peerId, 'после рестарта', connectionId, { chatId: chat.id }))
                    .resolves.toMatchObject({ success: true, externalId: `telegram:7200:${peerId}:9001` })

                expect(sweepCalls()).toHaveLength(1)
                expect(mocks.getEntity).toHaveBeenCalledTimes(2)
                expect(mocks.sendMessage).toHaveBeenCalledOnce()
                expect(mocks.opsLog).toHaveBeenCalledWith('info', 'telegram_mtproto_peer_sweep', expect.objectContaining({
                    connectionId,
                    ok: true,
                }))
            })

            test('a peer still unresolved after a sweep that answered is refused, terminal, never sent', async () => {
                const peerId = '880002'
                const { connectionId, chat } = sendSetup(peerId)
                mocks.getEntity.mockRejectedValue(new Error('Could not find the input entity'))

                const error = await rejection(sendTelegramMessage(peerId, 'бот-чат', connectionId, { chatId: chat.id }))

                expect(error.message).toContain('TELEGRAM_PEER_UNRESOLVED')
                expect(s1Outcomes(error)).toEqual(['REFUSED'])
                expect(error.message.length).toBeLessThanOrEqual(120)
                expect(sweepCalls()).toHaveLength(1)
                expect(mocks.sendMessage).not.toHaveBeenCalled()
                expect(mocks.recordReachability).not.toHaveBeenCalled()
            })

            test('a sweep that does not answer leaves the send safe to redeliver and unsent', async () => {
                const peerId = '880003'
                const { connectionId, chat } = sendSetup(peerId)
                mocks.getEntity.mockRejectedValue(new Error('Could not find the input entity'))
                mocks.getDialogs.mockImplementation(async (input: { limit?: number }) => {
                    if (input?.limit === 200) throw new Error('FLOOD_WAIT_30')
                    return []
                })

                const error = await rejection(sendTelegramMessage(peerId, 'текст', connectionId, { chatId: chat.id }))

                expect(error.message).toContain('TELEGRAM_PEER_UNRESOLVED')
                expect(s1Outcomes(error)).toEqual(['NOT_DISPATCHED'])
                expect(error.message.length).toBeLessThanOrEqual(120)
                expect(mocks.sendMessage).not.toHaveBeenCalled()
                expect(mocks.opsLog).toHaveBeenCalledWith('warn', 'telegram_mtproto_peer_sweep', expect.objectContaining({ ok: false, error: 'FLOOD_WAIT_30' }))
            })

            test('concurrent misses share one sweep, and a second sweep waits 10 minutes', async () => {
                vi.useFakeTimers({ toFake: ['Date'] })
                try {
                    const peerId = '880004'
                    const { connectionId, chat } = sendSetup(peerId)
                    mocks.getEntity.mockRejectedValue(new Error('Could not find the input entity'))

                    const [first, second] = await Promise.all([
                        rejection(sendTelegramMessage(peerId, 'один', connectionId, { chatId: chat.id })),
                        rejection(sendTelegramMessage(peerId, 'два', connectionId, { chatId: chat.id })),
                    ])
                    expect(s1Outcomes(first)).toEqual(['REFUSED'])
                    expect(s1Outcomes(second)).toEqual(['REFUSED'])
                    expect(sweepCalls()).toHaveLength(1)

                    vi.setSystemTime(Date.now() + 9 * 60_000)
                    await rejection(sendTelegramMessage(peerId, 'три', connectionId, { chatId: chat.id }))
                    expect(sweepCalls()).toHaveLength(1)

                    vi.setSystemTime(Date.now() + 2 * 60_000)
                    await rejection(sendTelegramMessage(peerId, 'четыре', connectionId, { chatId: chat.id }))
                    expect(sweepCalls()).toHaveLength(2)
                    expect(mocks.sendMessage).not.toHaveBeenCalled()
                } finally {
                    vi.useRealTimers()
                }
            })

            test('a replaced client never inherits the previous client\'s sweep window', async () => {
                const peerId = '880007'
                const { connectionId, chat } = sendSetup(peerId)
                mocks.getEntity.mockRejectedValue(new Error('Could not find the input entity'))

                await rejection(sendTelegramMessage(peerId, 'до замены', connectionId, { chatId: chat.id }))
                expect(sweepCalls()).toHaveLength(1)

                // Pause and resume replace the GramJS client; its entity cache is cold.
                await pauseTelegramConnection(connectionId)
                await resumeTelegramConnection(connectionId)
                const clientsBefore = mocks.clients.length
                mocks.getEntity
                    .mockRejectedValueOnce(new Error('Could not find the input entity'))
                    .mockImplementation(async target => ({ id: target }))

                await expect(sendTelegramMessage(peerId, 'после замены', connectionId, { chatId: chat.id }))
                    .resolves.toMatchObject({ success: true })
                expect(mocks.clients.length).toBe(clientsBefore)
                expect(sweepCalls()).toHaveLength(2)
                expect(mocks.sendMessage).toHaveBeenCalledOnce()
            })

            test('media and reaction resolve through the same sweep and refuse the same way', async () => {
                const peerId = '880005'
                const { connectionId, chat } = sendSetup(peerId)
                mocks.getEntity.mockRejectedValue(new Error('Could not find the input entity'))
                const proof = { chatId: chat.id, providerAccountId: '7200', identityTarget: peerId }

                const media = await rejection(sendTelegramMedia(peerId, 'ZmFrZQ==', 'a.bin', 'application/octet-stream', undefined, connectionId, proof))
                const reaction = await rejection(sendTelegramReaction({
                    target: peerId,
                    messageId: `telegram:7200:${peerId}:301`,
                    emoji: '👍',
                    remove: false,
                    connectionId,
                    proof,
                }))

                expect(s1Outcomes(media)).toEqual(['REFUSED'])
                expect(s1Outcomes(reaction)).toEqual(['REFUSED'])
                expect(sweepCalls()).toHaveLength(1)
                expect(mocks.sendFile).not.toHaveBeenCalled()
                expect(mocks.invoke).not.toHaveBeenCalled()
            })

            test('an entity that resolves to another peer is a binding mismatch and never triggers a sweep', async () => {
                const peerId = '880006'
                const { connectionId, chat } = sendSetup(peerId)
                mocks.getEntity.mockResolvedValue({ id: 123n })

                await expect(sendTelegramMessage(peerId, 'текст', connectionId, { chatId: chat.id }))
                    .rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
                expect(sweepCalls()).toHaveLength(0)
                expect(mocks.sendMessage).not.toHaveBeenCalled()
            })
        })

        describe('F6 reply parsed by the channel and proven before dispatch', () => {
            const PEER = '12345678901'
            const ACCOUNT = '7210'
            const PROVIDER_DATE = 1_700_000_000

            function replySend(quotedMsgId: string) {
                const { connectionId, chat } = sendSetup(PEER, ACCOUNT)
                return () => sendTelegramMessage(PEER, 'ответ', connectionId, { chatId: chat.id, quotedMsgId })
            }

            test('a current-form quote of a live message in this dialog is sent as a reply', async () => {
                const send = replySend(`telegram:${ACCOUNT}:${PEER}:5021`)
                mocks.getMessages.mockResolvedValue([{ id: 5021, date: PROVIDER_DATE }])

                await expect(send()).resolves.toMatchObject({ success: true })

                expect(mocks.getMessages).toHaveBeenCalledWith(expect.objectContaining({ id: BigInt(PEER) }), { ids: [5021] })
                expect(mocks.sendMessage).toHaveBeenCalledWith(expect.anything(), { message: 'ответ', replyTo: 5021 })
            })

            test('a legacy bare quote stored in this chat at the provider timestamp is sent as a reply', async () => {
                const rows = useMessageStore()
                const send = replySend('5021')
                rows.set('5021', { id: 'legacy', chatId: `chat-tg2-${PEER}`, externalId: '5021', direction: 'inbound', content: 'старое', sentAt: new Date(PROVIDER_DATE * 1000) })
                mocks.getMessages.mockResolvedValue([{ id: 5021, date: PROVIDER_DATE }])

                await expect(send()).resolves.toMatchObject({ success: true })

                expect(mocks.sendMessage).toHaveBeenCalledWith(expect.anything(), { message: 'ответ', replyTo: 5021 })
            })

            test.each([
                ['a deleted or foreign-dialog current id (GramJS answers nothing)', `telegram:${ACCOUNT}:${PEER}:5021`, [undefined], null],
                ['a legacy bare id this chat never stored', '5021', [{ id: 5021, date: PROVIDER_DATE }], null],
                ['a legacy bare id stored in another chat', '5021', [{ id: 5021, date: PROVIDER_DATE }], 'chat-other'],
                ['a legacy bare id numbered by another account (timestamp differs)', '5021', [{ id: 5021, date: PROVIDER_DATE + 3600 }], 'same-chat'],
            ])('%s is refused, terminal, never sent', async (_label, quotedMsgId, providerAnswer, storedIn) => {
                const rows = useMessageStore()
                const send = replySend(quotedMsgId)
                if (storedIn) {
                    rows.set('5021', {
                        id: 'legacy',
                        chatId: storedIn === 'same-chat' ? `chat-tg2-${PEER}` : storedIn,
                        externalId: '5021',
                        direction: 'inbound',
                        content: 'старое',
                        sentAt: new Date(PROVIDER_DATE * 1000),
                    })
                }
                mocks.getMessages.mockResolvedValue(providerAnswer)

                const error = await rejection(send())

                expect(error.message).toContain('REPLY_TARGET_NOT_ADDRESSABLE')
                expect(s1Outcomes(error)).toEqual(['REFUSED'])
                expect(error.message.length).toBeLessThanOrEqual(120)
                expect(mocks.sendMessage).not.toHaveBeenCalled()
            })

            test('a quote the provider cannot be asked about leaves the send unsent and safe to redeliver', async () => {
                const send = replySend(`telegram:${ACCOUNT}:${PEER}:5021`)
                mocks.getMessages.mockRejectedValue(new Error('Request was unsuccessful 3 time(s)'))

                const error = await rejection(send())

                expect(error.message).toContain('REPLY_TARGET_UNVERIFIED')
                expect(s1Outcomes(error)).toEqual(['NOT_DISPATCHED'])
                expect(error.message.length).toBeLessThanOrEqual(120)
                expect(mocks.sendMessage).not.toHaveBeenCalled()
            })

            test('a malformed quote is refused before any provider call', async () => {
                const send = replySend('telegram:other:shape')

                const error = await rejection(send())

                expect(s1Outcomes(error)).toEqual(['REFUSED'])
                expect(mocks.getEntity).not.toHaveBeenCalled()
                expect(mocks.getMessages).not.toHaveBeenCalled()
                expect(mocks.sendMessage).not.toHaveBeenCalled()
            })

        })
    })
})
