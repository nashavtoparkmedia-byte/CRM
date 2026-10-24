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
    patchMessageDelivery: vi.fn(),
    attachMessageMedia: vi.fn(),
    attachBinaryMedia: vi.fn(),
    downloadMedia: vi.fn(),
    attachmentCount: vi.fn(),
    attachmentFindFirst: vi.fn(),
    admittedChat: null as null | Record<string, unknown>,
    providerAccountId: '7000',
    getMeFailure: null as null | Error,
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
        async getMe() {
            if (mocks.getMeFailure) throw mocks.getMeFailure
            return { id: BigInt(mocks.providerAccountId) }
        }
        async getDialogs(input: unknown) { return mocks.getDialogs(input, this) }
        async getMessages(entity: unknown, input: unknown) { return mocks.getMessages(entity, input, this) }
        async getEntity(target: unknown) { return mocks.getEntity(target, this) }
        async sendMessage(target: unknown, input: unknown) { return mocks.sendMessage(target, input, this) }
        async sendFile(target: unknown, input: unknown) { return mocks.sendFile(target, input) }
        async invoke(input: unknown) { return mocks.invoke(input) }
        async downloadMedia(message: unknown, input: unknown) { return mocks.downloadMedia(message, input) }
        addEventHandler(handler: (event: unknown) => Promise<void>) { this.handlers.push(handler) }
    },
    Api: {
        User: class { constructor(input: Record<string, unknown>) { Object.assign(this, input) } },
        Chat: class { constructor(input: Record<string, unknown>) { Object.assign(this, input) } },
        Channel: class { constructor(input: Record<string, unknown>) { Object.assign(this, input) } },
        Message: class { constructor(input: Record<string, unknown>) { Object.assign(this, input) } },
        MessageService: class { constructor(input: Record<string, unknown>) { Object.assign(this, input) } },
        PeerUser: class { constructor(input: Record<string, unknown>) { Object.assign(this, input) } },
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
        },
        message: {
            findFirst: mocks.messageFindFirst,
            findUnique: mocks.messageFindUnique,
        },
        messageAttachment: {
            count: mocks.attachmentCount,
            findFirst: mocks.attachmentFindFirst,
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
    attachBinaryMessageMediaV1: mocks.attachBinaryMedia,
    attachMessageMediaV1: mocks.attachMessageMedia,
    createChannelMessageV1: mocks.createMessage,
    deleteConversationsByIdV1: vi.fn(),
    deleteHistoryImportJobsForChannelV1: vi.fn(),
    deleteHistoryImportJobsForConnectionV1: vi.fn(),
    ensureConversationContactLinkV1: mocks.ensureContactLink,
    patchChannelConversationV1: mocks.patchConversation,
    patchHistoryImportJobV1: mocks.patchImportJob,
    patchMessageDeliveryV1: mocks.patchMessageDelivery,
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

import { Api } from 'telegram'
// The mocked GramJS classes take plain values; the real constructors' typings do not.
const tl = Api as unknown as Record<
    'User' | 'Chat' | 'Channel' | 'Message' | 'MessageService' | 'PeerUser',
    new (input: Record<string, unknown>) => object
>
import {
    checkTelegramReachability,
    importTelegramHistory,
    initTelegramListeners,
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
        mocks.getMeFailure = null
        mocks.getEntity.mockImplementation(async target => new tl.User({ id: target }))
        mocks.sendMessage.mockResolvedValue({ id: 9001 })
        mocks.sendFile.mockResolvedValue({ id: 9002 })
        mocks.invoke.mockResolvedValue({})
        mocks.inboundWorkflow.mockResolvedValue(undefined)
        mocks.emitMessage.mockResolvedValue(undefined)
        mocks.recordReachability.mockResolvedValue({ outcome: 'updated', status: 'confirmed' })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(async () => {
        await stopTelegramHealthCheck()
        vi.restoreAllMocks()
    })

    test('live inbound persists and links exact provider, transport and peer before the message', async () => {
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
        expect(mocks.ensureContactLink.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.createMessage.mock.invocationCallOrder[0])
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

    test('live inbound records and rejects a cross-transport Chat before Contact or message writes', async () => {
        const connectionId = `telegram-account-incoming-${connectionSequence}`
        const providerAccountId = '7002'
        const handler = await initializeListener(connectionId, providerAccountId)
        mocks.upsertConversation.mockResolvedValueOnce({
            conversation: {
                id: 'chat-owned-by-other-account',
                channel: 'telegram',
                externalChatId: 'telegram:42',
                chatType: 'private',
                contactId: 'contact-other',
                contactIdentityId: 'identity-other',
                driverId: null,
                metadata: {
                    chatKind: 'private',
                    peerId: '42',
                    providerAccountId: 'telegram-account-other',
                    connectionId: 'telegram-account-other',
                },
            },
        })

        await handler({ message: inboundMessage('42') })

        expect(mocks.appendCollision).toHaveBeenCalledWith({
            chatId: 'chat-owned-by-other-account',
            evidence: expect.objectContaining({
                channel: 'telegram',
                reason: 'transport_connection_mismatch',
                phase: 'inbound',
                incomingPeerId: '42',
                incomingProviderAccountId: providerAccountId,
                incomingConnectionId: connectionId,
            }),
        })
        expect(mocks.markIdentityConflict).toHaveBeenCalledOnce()
        expect(mocks.resolveContact).not.toHaveBeenCalled()
        expect(mocks.ensureContactLink).not.toHaveBeenCalled()
        expect(mocks.createMessage).not.toHaveBeenCalled()
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

    test('outbound mirror re-admits and re-links an existing peer before mirroring', async () => {
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
        expect(mocks.ensureContactLink.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.createMessage.mock.invocationCallOrder[0])
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

    test('history import admits exact account, connection and peer before importing messages', async () => {
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
        expect(mocks.ensureContactLink.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.createMessage.mock.invocationCallOrder[0])
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
        expect(mocks.getEntity).toHaveBeenCalledWith(BigInt(peerId), expect.anything())
        expect(mocks.getEntity).not.toHaveBeenCalledWith(`+${peerId}`, expect.anything())
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: BigInt(peerId) }),
            { message: 'exact peer' },
            expect.anything(),
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
        mocks.getEntity.mockResolvedValue(new tl.User({ id: BigInt(peerId) }))

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
            mocks.getEntity.mockResolvedValue(new tl.User({ id: BigInt(PEER) }))
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

    // D1′ safe MTProto ingress: F9, HOLD, exact-key-first dedupe, isolation,
    // bounded error codes and B3-a strict import reporting.
    describe('D1′ safe MTProto ingress', () => {
        const OTP_TEXT = 'Код входа в Telegram: 51734. Никому не сообщайте этот код.'
        const nowSeconds = () => Math.floor(Date.now() / 1000)

        beforeEach(() => {
            for (const mock of [
                mocks.messageFindUnique,
                mocks.messageFindFirst,
                mocks.patchMessageDelivery,
                mocks.attachMessageMedia,
                mocks.attachBinaryMedia,
                mocks.downloadMedia,
                mocks.attachmentCount,
                mocks.attachmentFindFirst,
                mocks.getMessages,
                mocks.getDialogs,
                mocks.patchMessageMetadata,
            ]) mock.mockReset()
            mocks.messageFindUnique.mockResolvedValue(null)
            mocks.messageFindFirst.mockResolvedValue(null)
            mocks.patchMessageDelivery.mockResolvedValue({})
            mocks.attachMessageMedia.mockResolvedValue({})
            mocks.attachBinaryMedia.mockResolvedValue({})
            mocks.downloadMedia.mockResolvedValue(Buffer.from('media'))
            mocks.attachmentCount.mockResolvedValue(0)
            mocks.attachmentFindFirst.mockResolvedValue(null)
            mocks.getMessages.mockResolvedValue([])
            mocks.getDialogs.mockResolvedValue([])
            mocks.patchMessageMetadata.mockResolvedValue({})
            mocks.createMessage.mockImplementation(async (command: { externalId: string }) => ({
                message: { ...command, id: `message:${command.externalId}` },
            }))
        })

        function logs(): string {
            return [console.log, console.warn, console.error]
                .flatMap(spy => vi.mocked(spy).mock.calls)
                .map(call => call.map(String).join(' '))
                .join('\n')
        }

        function privateMessage(input: {
            peer: string
            id?: number
            text?: string
            out?: boolean
            date?: number
            extra?: Record<string, unknown>
        }) {
            return {
                out: input.out ?? false,
                ...(input.id === undefined ? {} : { id: input.id }),
                peerId: { userId: BigInt(input.peer) },
                message: input.text ?? 'exact identity text',
                date: input.date ?? nowSeconds(),
                sender: { firstName: 'Exact', lastName: 'Peer' },
                chat: { firstName: 'Exact', lastName: 'Peer' },
                ...input.extra,
            }
        }

        function userDialog(peer: string, extra: Record<string, unknown> = {}) {
            return { isUser: true, unreadCount: 0, date: nowSeconds(), entity: { id: BigInt(peer), firstName: `Peer ${peer}` }, ...extra }
        }

        function messagesByPeer(map: Record<string, unknown[]>) {
            mocks.getMessages.mockImplementation(async (entity: { id: bigint }) => map[entity.id.toString()] ?? [])
        }

        async function runCatchUp(dialogs: unknown[], providerAccountId = '7500') {
            const connectionId = `telegram-d1-catchup-${connectionSequence}`
            mocks.providerAccountId = providerAccountId
            mocks.telegramConnectionFindMany.mockResolvedValue([connection(connectionId)])
            mocks.getDialogs.mockResolvedValue(dialogs)
            await initTelegramListeners()
            const marker = `[TG-CATCHUP] summary conn=${connectionId} `
            await vi.waitFor(() => expect(logs()).toContain(marker))
            return logs().split('\n').find(line => line.includes(marker))!
        }

        async function runImport(dialogs: unknown[], providerAccountId = '7600', mode = 'available_history') {
            const connectionId = `telegram-d1-import-${connectionSequence}`
            mocks.providerAccountId = providerAccountId
            mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
            mocks.getDialogs.mockResolvedValueOnce([]).mockResolvedValueOnce(dialogs)
            await importTelegramHistory(`job-d1-${connectionSequence}`, mode, undefined, connectionId)
            const final = mocks.patchImportJob.mock.calls
                .map(call => call[0] as { patch: Record<string, any> })
                .filter(command => command.patch.status === 'completed' || command.patch.status === 'failed')
                .at(-1)
            return final!.patch
        }

        function expectNothingPersistedOrPublished() {
            expect(mocks.createMessage).not.toHaveBeenCalled()
            expect(mocks.patchMessageDelivery).not.toHaveBeenCalled()
            expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
            expect(mocks.emitMessage).not.toHaveBeenCalled()
        }

        describe('F9 exact Telegram service peer 777000', () => {
            test('live inbound and outbound for 777000 write, publish and log nothing of the message', async () => {
                const handler = await initializeListener(`telegram-f9-live-${connectionSequence}`, '7100')

                await handler({ message: privateMessage({ peer: '777000', id: 1, text: OTP_TEXT }) })
                await handler({ message: privateMessage({ peer: '777000', id: 2, text: OTP_TEXT, out: true }) })

                expect(mocks.upsertConversation).not.toHaveBeenCalled()
                expect(mocks.resolveContact).not.toHaveBeenCalled()
                expect(mocks.ensureContactLink).not.toHaveBeenCalled()
                expect(mocks.messageFindUnique).not.toHaveBeenCalled()
                expect(mocks.messageFindFirst).not.toHaveBeenCalled()
                expectNothingPersistedOrPublished()
                expect(logs()).toContain('telegram_mtproto_service_peer_skipped phase=live')
                expect(logs()).not.toContain('51734')
                expect(logs()).not.toContain('Код входа')
            })

            test('catch-up never fetches the 777000 dialog', async () => {
                const summary = await runCatchUp([userDialog('777000', { unreadCount: 3 })])

                expect(mocks.getMessages).not.toHaveBeenCalled()
                expect(mocks.upsertConversation).not.toHaveBeenCalled()
                expect(summary).toContain('serviceSkipped=1')
                expect(logs()).toContain('telegram_mtproto_service_peer_skipped phase=catch-up')
            })

            test('a processor reached directly still drops 777000 before any write', async () => {
                messagesByPeer({ '42': [
                    privateMessage({ peer: '777000', id: 6, text: OTP_TEXT, out: true }),
                    privateMessage({ peer: '777000', id: 3, text: OTP_TEXT }),
                ] })

                const summary = await runCatchUp([userDialog('42')])

                expect(mocks.upsertConversation).not.toHaveBeenCalled()
                expectNothingPersistedOrPublished()
                expect(summary).toContain('serviceSkipped=2')
                expect(logs()).toContain('telegram_mtproto_service_peer_skipped phase=import')
                expect(logs()).toContain('telegram_mtproto_service_peer_skipped phase=mirror')
                expect(logs()).not.toContain('51734')
            })

            test('history import neither admits nor fetches the 777000 dialog', async () => {
                messagesByPeer({ '777000': [privateMessage({ peer: '777000', id: 4, text: OTP_TEXT })] })

                const patch = await runImport([userDialog('777000')])

                expect(mocks.getMessages).not.toHaveBeenCalled()
                expect(mocks.upsertConversation).not.toHaveBeenCalled()
                expect(patch.detailsJson.completeness.serviceSkipped).toBe(1)
                expect(logs()).toContain('telegram_mtproto_service_peer_skipped phase=import')
                expect(logs()).not.toContain('51734')
            })

            test.each(['77700', '7770000', '1777000'])('peer %s is an ordinary peer and is processed', async peer => {
                const handler = await initializeListener(`telegram-f9-negative-${peer}-${connectionSequence}`, '7101')

                await handler({ message: privateMessage({ peer, id: 5 }) })

                expect(mocks.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({ externalChatId: `telegram:${peer}` }))
                expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({ externalId: `telegram:7101:${peer}:5` }))
            })
        })

        describe('HOLD: attribution not proven in this event', () => {
            test.each([
                ['CONTACT_CONVERSATION_DRIVER_MISMATCH', 'held'],
                ['CONTACT_CONVERSATION_OWNERSHIP_MISMATCH', 'held'],
                ['CONTACT_IDENTITY_LINK_MISMATCH', 'held'],
                ['CONTACT_IDENTITY_LINK_STALE', 'held_transient'],
                ['CONTACT_CONVERSATION_LINK_STALE', 'held_transient'],
            ])('%s holds a live message without persistence, publication or workflow', async (code, outcome) => {
                const handler = await initializeListener(`telegram-hold-${code}-${connectionSequence}`, '7110')
                mocks.ensureContactLink.mockRejectedValueOnce(new Error(code))

                await handler({ message: privateMessage({ peer: '42', id: 10, text: 'private text that must not leak' }) })

                expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
                expect(mocks.recordReachability).not.toHaveBeenCalled()
                expect(mocks.patchConversation).not.toHaveBeenCalled()
                expect(mocks.messageFindUnique).not.toHaveBeenCalled()
                expectNothingPersistedOrPublished()
                expect(logs()).toContain(`${outcome} code=${code}`)
                expect(logs()).not.toContain('private text')
            })

            test.each([
                [{ code: 'P2010', meta: { code: '55P03', message: 'canceling statement due to lock timeout' } }, 'PG_LOCK_TIMEOUT'],
                [{ code: 'P2028', meta: { error: 'Transaction already closed' } }, 'P2028'],
            ])('a database lock or transaction failure in the link is a transient hold (%#)', async (shape, expected) => {
                const handler = await initializeListener(`telegram-hold-db-${expected}-${connectionSequence}`, '7111')
                mocks.ensureContactLink.mockRejectedValueOnce(Object.assign(new Error('Raw query failed for text "private body"'), shape))

                await handler({ message: privateMessage({ peer: '42', id: 11, text: 'private body' }) })

                expectNothingPersistedOrPublished()
                expect(logs()).toContain(`held_transient code=${expected}`)
                expect(logs()).not.toContain('private body')
            })

            test('blocked contact resolution holds before any link', async () => {
                const handler = await initializeListener(`telegram-hold-resolution-${connectionSequence}`, '7112')
                mocks.isResolvedContact.mockReturnValueOnce(false)
                mocks.resolveContact.mockResolvedValueOnce({ status: 'ambiguous', candidateContactIds: ['a', 'b'], warnings: [] })

                await handler({ message: privateMessage({ peer: '42', id: 12 }) })

                expect(mocks.ensureContactLink).not.toHaveBeenCalled()
                expectNothingPersistedOrPublished()
                expect(logs()).toContain('held code=CONTACT_RESOLUTION_BLOCKED:ambiguous')
            })

            test('catch-up stops a held dialog after its first message and still finishes the others', async () => {
                mocks.ensureContactLink.mockImplementation(async (command: { chatId: string }) => {
                    if (command.chatId === 'chat:telegram:42') throw new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH')
                    return { completed: true }
                })
                messagesByPeer({
                    '42': [13, 12, 11].map(id => privateMessage({ peer: '42', id })),
                    '43': [22, 21].map(id => privateMessage({ peer: '43', id })),
                })

                const summary = await runCatchUp([userDialog('42'), userDialog('43'), { isUser: false, entity: { id: 5n } }])

                expect(mocks.ensureContactLink.mock.calls.filter(call => call[0].chatId === 'chat:telegram:42')).toHaveLength(1)
                expect(mocks.createMessage).toHaveBeenCalledTimes(2)
                expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual([
                    'telegram:7500:43:21',
                    'telegram:7500:43:22',
                ])
                expect(summary).toContain('dialogs=2 fetched=5 saved=2 duplicates=0')
                expect(summary).toContain('held=3 heldTransient=0 rejected=0 failed=0 skipped=0 serviceSkipped=0 failedDialogs=0')
                expect(logs()).toContain('[TG-CATCHUP] Finished. Processed 5 messages.')
            })

            test('a failing message does not abort the catch-up run', async () => {
                mocks.createMessage
                    .mockRejectedValueOnce(Object.assign(new Error('Invalid `prisma.message.create()` invocation: content "secret"'), { name: 'PrismaClientValidationError' }))
                messagesByPeer({ '43': [32, 31].map(id => privateMessage({ peer: '43', id })) })

                const summary = await runCatchUp([userDialog('43')])

                expect(mocks.createMessage).toHaveBeenCalledTimes(2)
                expect(summary).toContain('fetched=2 saved=1')
                expect(summary).toContain('failed=1')
                expect(logs()).toContain('message failed conn=')
                expect(logs()).toContain('code=PRISMA_VALIDATION')
                expect(logs()).not.toContain('secret')
            })

            test('history import holds a dialog without fetching it, finishes the rest and reports partial', async () => {
                mocks.ensureContactLink.mockImplementation(async (command: { chatId: string }) => {
                    if (command.chatId === 'chat:telegram:126') throw new Error('CONTACT_CONVERSATION_DRIVER_MISMATCH')
                    return { completed: true }
                })
                messagesByPeer({
                    '126': [privateMessage({ peer: '126', id: 41 })],
                    '127': [privateMessage({ peer: '127', id: 42 })],
                })

                const patch = await runImport([userDialog('126'), userDialog('127')])

                expect(mocks.getMessages.mock.calls.map(call => call[0].id.toString())).toEqual(['127'])
                expect(mocks.createMessage).toHaveBeenCalledTimes(1)
                expect(patch.resultType).toBe('partial')
                expect(patch.detailsJson.completeness.heldDialogs).toBe(1)
                expect(logs()).toContain('Dialog held job=')
            })
        })

        describe('exact-key-first deduplication', () => {
            test('two provider messages with identical text one second apart are both persisted live', async () => {
                const handler = await initializeListener(`telegram-dedupe-live-${connectionSequence}`, '7200')
                const date = nowSeconds()

                await handler({ message: privateMessage({ peer: '42', id: 5001, text: 'ok', date }) })
                await handler({ message: privateMessage({ peer: '42', id: 5002, text: 'ok', date: date + 1 }) })

                expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual([
                    'telegram:7200:42:5001',
                    'telegram:7200:42:5002',
                ])
                expect(mocks.messageFindFirst).not.toHaveBeenCalled()
                expect(mocks.inboundWorkflow).toHaveBeenCalledTimes(2)
            })

            test('identical repeated messages are both persisted by catch-up and by import', async () => {
                const date = nowSeconds()
                messagesByPeer({ '43': [6002, 6001].map(id => privateMessage({ peer: '43', id, text: 'ok', date })) })
                await runCatchUp([userDialog('43')], '7201')
                expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual([
                    'telegram:7201:43:6001',
                    'telegram:7201:43:6002',
                ])

                mocks.createMessage.mockClear()
                messagesByPeer({ '44': [7002, 7001].map(id => privateMessage({ peer: '44', id, text: 'ok', date })) })
                const patch = await runImport([userDialog('44')], '7202')
                expect(mocks.createMessage.mock.calls.map(call => call[0].externalId).sort()).toEqual([
                    'telegram:7202:44:7001',
                    'telegram:7202:44:7002',
                ])
                expect(patch.detailsJson.newMessages).toBe(2)
            })

            test('the same provider message twice is one row', async () => {
                const stored = new Map<string, Record<string, unknown>>()
                mocks.createMessage.mockImplementation(async (command: { externalId: string }) => {
                    stored.set(command.externalId, { ...command, id: `message:${command.externalId}` })
                    return { message: { ...command, id: `message:${command.externalId}` } }
                })
                mocks.messageFindUnique.mockImplementation(async (query: { where: { externalId: string } }) => stored.get(query.where.externalId) ?? null)
                const handler = await initializeListener(`telegram-dedupe-same-${connectionSequence}`, '7203')

                await handler({ message: privateMessage({ peer: '42', id: 5003 }) })
                await handler({ message: privateMessage({ peer: '42', id: 5003 }) })

                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
                expect(logs()).toContain('DB-DEDUP: skipped existing=message:telegram:7203:42:5003')
            })

            test('a concurrent writer of the same key is a benign duplicate only when its row is found', async () => {
                const handler = await initializeListener(`telegram-dedupe-race-${connectionSequence}`, '7204')
                const unique = () => Object.assign(new Error('Unique constraint failed on the fields: (`externalId`)'), { code: 'P2002' })
                mocks.createMessage.mockRejectedValueOnce(unique())
                mocks.messageFindUnique
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce({ id: 'winner', chatId: 'chat:telegram:42', direction: 'inbound', channel: 'telegram', content: 'exact identity text' })

                await handler({ message: privateMessage({ peer: '42', id: 5004 }) })

                expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
                expect(mocks.emitMessage).not.toHaveBeenCalled()
                expect(logs()).toContain('DB-DEDUP: concurrent writer existing=winner')
                expect(logs()).not.toContain('Error (conn=')

                mocks.createMessage.mockRejectedValueOnce(unique())
                await handler({ message: privateMessage({ peer: '42', id: 5005 }) })
                expect(logs()).toContain('failed code=P2002')
            })

            test('a legacy bare-id row is never a duplicate of another provider account\'s message', async () => {
                const handler = await initializeListener(`telegram-dedupe-legacy-${connectionSequence}`, '7205')
                const legacy = (overrides: Record<string, unknown> = {}) => ({
                    chatId: 'chat:telegram:42', direction: 'inbound', channel: 'telegram', content: 'same text', ...overrides,
                })
                const byKey = (rows: Record<string, unknown>) => async (query: { where: { externalId: string } }) => rows[query.where.externalId] ?? null

                // Same chat, direction and content: provenance unproven -> held, never a duplicate.
                mocks.messageFindUnique.mockImplementation(byKey({ '1001': legacy() }))
                await handler({ message: privateMessage({ peer: '42', id: 1001, text: 'same text' }) })
                expect(mocks.createMessage).not.toHaveBeenCalled()
                expect(logs()).toContain('LEGACY-HOLD chat=chat:telegram:42')
                expect(logs()).not.toContain('DB-DEDUP')

                // Different content proves a different message.
                mocks.messageFindUnique.mockImplementation(byKey({ '1002': legacy({ content: 'other text' }) }))
                await handler({ message: privateMessage({ peer: '42', id: 1002, text: 'same text' }) })
                // Another chat is not this conversation.
                mocks.messageFindUnique.mockImplementation(byKey({ '1003': legacy({ chatId: 'chat:telegram:99' }) }))
                await handler({ message: privateMessage({ peer: '42', id: 1003, text: 'same text' }) })
                // Another account's exact key for the same peer and message id.
                mocks.messageFindUnique.mockImplementation(byKey({ 'telegram:7999:42:1004': { id: 'other-account' } }))
                await handler({ message: privateMessage({ peer: '42', id: 1004, text: 'same text' }) })

                expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual([
                    'telegram:7205:42:1002',
                    'telegram:7205:42:1003',
                    'telegram:7205:42:1004',
                ])
            })

            test('a cross-account legacy collision is counted as held, not as a duplicate, by catch-up', async () => {
                mocks.messageFindUnique.mockImplementation(async (query: { where: { externalId: string } }) => (
                    query.where.externalId === '1101'
                        ? { chatId: 'chat:telegram:43', direction: 'inbound', channel: 'telegram', content: 'same text' }
                        : null
                ))
                messagesByPeer({ '43': [privateMessage({ peer: '43', id: 1101, text: 'same text' })] })

                const summary = await runCatchUp([userDialog('43')], '7206')

                expect(mocks.createMessage).not.toHaveBeenCalled()
                expect(summary).toContain('duplicates=0 reconciledSend=0 heldLegacy=1')
            })

            test('an MTProto event with a valid id never consults a content window', async () => {
                const handler = await initializeListener(`telegram-dedupe-window-${connectionSequence}`, '7207')
                mocks.messageFindFirst.mockResolvedValue({ id: 'bot-event-row' })

                await handler({ message: privateMessage({ peer: '42', id: 1201, text: 'same text' }) })

                expect(mocks.messageFindFirst).not.toHaveBeenCalled()
                expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'telegram:7207:42:1201' }))
            })

            test('an event without a provider id keeps the content window against this account\'s local keys only', async () => {
                const handler = await initializeListener(`telegram-dedupe-noid-${connectionSequence}`, '7208')
                mocks.messageFindFirst.mockResolvedValueOnce({ id: 'local-row' })

                await handler({ message: privateMessage({ peer: '42', text: 'no id text' }) })

                expect(mocks.messageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
                    where: expect.objectContaining({
                        direction: 'inbound',
                        OR: [{ externalId: { startsWith: 'telegram:7208:42:local-' } }],
                    }),
                }))
                expect(mocks.createMessage).not.toHaveBeenCalled()
            })

            test('mirror reconciles one CRM send row without a provider id, then mirrors a second identical phone message', async () => {
                const handler = await initializeListener(`telegram-dedupe-mirror-${connectionSequence}`, '7209')
                mocks.messageFindFirst.mockResolvedValueOnce({ id: 'crm-send-row' }).mockResolvedValueOnce(null)

                await handler({ message: privateMessage({ peer: '84', id: 8001, text: 'ok', out: true }) })
                await handler({ message: privateMessage({ peer: '84', id: 8002, text: 'ok', out: true }) })

                expect(mocks.messageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
                    where: expect.objectContaining({ direction: 'outbound', content: 'ok', externalId: null }),
                }))
                expect(mocks.patchMessageDelivery).toHaveBeenCalledWith(expect.objectContaining({
                    messageId: 'crm-send-row',
                    externalId: 'telegram:7209:84:8001',
                    status: 'delivered',
                }))
                expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual(['telegram:7209:84:8002'])
            })

            test('import stamps a CRM send row instead of duplicating it', async () => {
                mocks.messageFindFirst.mockResolvedValueOnce({ id: 'crm-send-row' })
                messagesByPeer({ '126': [privateMessage({ peer: '126', id: 9101, text: 'ok', out: true })] })

                const patch = await runImport([userDialog('126')], '7210')

                expect(mocks.patchMessageDelivery).toHaveBeenCalledWith(expect.objectContaining({
                    messageId: 'crm-send-row',
                    externalId: 'telegram:7210:126:9101',
                }))
                expect(mocks.createMessage).not.toHaveBeenCalled()
                expect(patch.detailsJson.completeness.reconciledSendMessages).toBe(1)
            })

            describe('F1/F2: a row found by its external key must be this event\'s own', () => {
                const pdf = () => ({
                    media: { className: 'MessageMediaDocument', document: { mimeType: 'application/pdf', attributes: [{ fileName: 'scan.pdf' }] } },
                    downloadMedia: vi.fn(async () => Buffer.from('pdf')),
                })
                const row = (overrides: Record<string, unknown> = {}) => ({
                    id: 'stored-row', chatId: 'chat:telegram:42', direction: 'inbound', channel: 'telegram', content: 'same text', ...overrides,
                })
                const byKey = (rows: Record<string, unknown>) => async (query: { where: { externalId: string } }) => rows[query.where.externalId] ?? null
                const uniqueViolation = () => Object.assign(new Error('Unique constraint failed on the fields: (`externalId`)'), { code: 'P2002' })

                // A real unique index: a second insert of a stored key fails with P2002.
                function uniqueKeyStore() {
                    const rows = new Map<string, Record<string, unknown>>()
                    mocks.createMessage.mockImplementation(async (command: { externalId: string }) => {
                        if (rows.has(command.externalId)) throw uniqueViolation()
                        const created = { ...command, id: `message:${rows.size + 1}` }
                        rows.set(command.externalId, created)
                        return { message: created }
                    })
                    mocks.messageFindUnique.mockImplementation(async (query: { where: { externalId: string } }) => rows.get(query.where.externalId) ?? null)
                    return rows
                }

                function expectStoredRowUntouched() {
                    expect(mocks.attachmentCount).not.toHaveBeenCalled()
                    expect(mocks.downloadMedia).not.toHaveBeenCalled()
                    expect(mocks.attachMessageMedia).not.toHaveBeenCalled()
                    expect(mocks.attachBinaryMedia).not.toHaveBeenCalled()
                    expect(mocks.patchMessageDelivery).not.toHaveBeenCalled()
                    expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
                    expect(mocks.emitMessage).not.toHaveBeenCalled()
                }

                test.each([
                    ['another chat', { chatId: 'chat:telegram:99' }],
                    ['the other direction', { direction: 'outbound' }],
                    ['another channel', { channel: 'max' }],
                ])('live inbound: its exact key stored in %s is a key conflict; no media attach, stamp, publication or workflow', async (_where, overrides) => {
                    const handler = await initializeListener(`telegram-key-conflict-in-${connectionSequence}`, '7220')
                    mocks.messageFindUnique.mockImplementation(byKey({ 'telegram:7220:42:9401': row(overrides) }))

                    await handler({ message: privateMessage({ peer: '42', id: 9401, text: '', extra: pdf() }) })

                    expect(mocks.createMessage).not.toHaveBeenCalled()
                    expectStoredRowUntouched()
                    expect(logs()).toContain('[TG-LISTENER] KEY-CONFLICT chat=chat:telegram:42 code=TELEGRAM_MESSAGE_KEY_CONFLICT')
                    expect(logs()).not.toContain('DB-DEDUP')
                    expect(logs()).not.toContain('stored-row')
                })

                test('mirror: its exact key stored in another chat is a key conflict; no delivery stamp or attachment', async () => {
                    const handler = await initializeListener(`telegram-key-conflict-out-${connectionSequence}`, '7221')
                    mocks.messageFindUnique.mockImplementation(byKey({ 'telegram:7221:84:9402': row({ chatId: 'chat:telegram:99', direction: 'outbound' }) }))

                    await handler({ message: privateMessage({ peer: '84', id: 9402, text: '', out: true, extra: pdf() }) })

                    expect(mocks.createMessage).not.toHaveBeenCalled()
                    expect(mocks.messageFindFirst).not.toHaveBeenCalled()
                    expectStoredRowUntouched()
                    expect(logs()).toContain('[TG-MIRROR] KEY-CONFLICT chat=chat:telegram:84 code=TELEGRAM_MESSAGE_KEY_CONFLICT')
                    expect(logs()).not.toContain('DEDUP')
                })

                test('a P2002 winner in another chat is a key conflict, not a concurrent duplicate', async () => {
                    const handler = await initializeListener(`telegram-key-conflict-race-${connectionSequence}`, '7222')
                    mocks.createMessage.mockRejectedValueOnce(uniqueViolation())
                    mocks.messageFindUnique
                        .mockResolvedValueOnce(null)
                        .mockResolvedValueOnce(null)
                        .mockResolvedValueOnce(row({ chatId: 'chat:telegram:99' }))

                    await handler({ message: privateMessage({ peer: '42', id: 9403, text: '', extra: pdf() }) })

                    expect(mocks.createMessage).toHaveBeenCalledOnce()
                    expectStoredRowUntouched()
                    expect(logs()).toContain('[TG-LISTENER] KEY-CONFLICT chat=chat:telegram:42 code=TELEGRAM_MESSAGE_KEY_CONFLICT')
                    expect(logs()).not.toContain('concurrent writer')
                    expect(logs()).not.toContain('Error (conn=')
                })

                test('catch-up and import count a key conflict and still process the rest of the dialog', async () => {
                    mocks.messageFindUnique.mockImplementation(byKey({ 'telegram:7223:43:9501': row({ chatId: 'chat:telegram:99' }) }))
                    messagesByPeer({ '43': [9502, 9501].map(id => privateMessage({ peer: '43', id })) })
                    const summary = await runCatchUp([userDialog('43')], '7223')
                    expect(summary).toContain('saved=1 duplicates=0 reconciledSend=0 heldLegacy=0 keyConflicts=1 held=0')
                    expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual(['telegram:7223:43:9502'])

                    mocks.createMessage.mockClear()
                    mocks.messageFindUnique.mockImplementation(byKey({ 'telegram:7224:44:9601': row({ chatId: 'chat:telegram:99' }) }))
                    messagesByPeer({ '44': [9602, 9601].map(id => privateMessage({ peer: '44', id })) })
                    const patch = await runImport([userDialog('44')], '7224')
                    expect(patch.resultType).toBe('partial')
                    expect(patch.detailsJson.newMessages).toBe(1)
                    expect(patch.detailsJson.existingMessages).toBe(0)
                    expect(patch.detailsJson.completeness.keyConflictMessages).toBe(1)
                    expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual(['telegram:7224:44:9602'])
                })

                test('two different id-less messages with the same timestamp: the second is a key conflict, never a false duplicate or an overwrite', async () => {
                    const rows = uniqueKeyStore()
                    const handler = await initializeListener(`telegram-local-key-${connectionSequence}`, '7230')
                    const date = nowSeconds()
                    const key = `telegram:7230:42:local-${date * 1000}`

                    await handler({ message: privateMessage({ peer: '42', text: 'first message', date }) })
                    await handler({ message: privateMessage({ peer: '42', text: 'second message', date }) })

                    expect(mocks.createMessage.mock.calls.map(call => call[0].externalId)).toEqual([key, key])
                    expect([...rows.values()]).toEqual([expect.objectContaining({ externalId: key, content: 'first message' })])
                    expect(logs()).toContain('[TG-LISTENER] KEY-CONFLICT chat=chat:telegram:42 code=TELEGRAM_MESSAGE_KEY_CONFLICT')
                    expect(logs()).not.toContain('concurrent writer')
                    expect(logs()).not.toContain('second message')
                    expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
                    expect(mocks.emitMessage).toHaveBeenCalledOnce()

                    // The same id-less message racing itself is still a benign duplicate.
                    await handler({ message: privateMessage({ peer: '42', text: 'first message', date }) })
                    expect(logs()).toContain('DB-DEDUP: concurrent writer existing=message:1')
                    expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
                    expect(rows.size).toBe(1)
                })

                test('mirror and import report a same-second id-less collision as a key conflict', async () => {
                    const rows = uniqueKeyStore()
                    const handler = await initializeListener(`telegram-local-key-out-${connectionSequence}`, '7231')
                    const date = nowSeconds()

                    await handler({ message: privateMessage({ peer: '84', text: 'first sent', date, out: true }) })
                    await handler({ message: privateMessage({ peer: '84', text: 'second sent', date, out: true }) })
                    expect(logs()).toContain('[TG-MIRROR] KEY-CONFLICT chat=chat:telegram:84 code=TELEGRAM_MESSAGE_KEY_CONFLICT')
                    expect(logs()).not.toContain('concurrent writer')
                    expect(mocks.emitMessage).toHaveBeenCalledOnce()

                    messagesByPeer({ '45': ['first imported', 'second imported'].map(text => privateMessage({ peer: '45', text, date })) })
                    const patch = await runImport([userDialog('45')], '7232')
                    expect(patch.detailsJson.newMessages).toBe(1)
                    expect(patch.detailsJson.existingMessages).toBe(0)
                    expect(patch.detailsJson.completeness.keyConflictMessages).toBe(1)
                    expect([...rows.values()].map(stored => stored.content)).toEqual(['first sent', 'first imported'])
                })
            })
        })

        describe('B3-a strict import completeness', () => {
            test('an import that saved messages is partial, never full, with its own counts', async () => {
                mocks.queryRaw.mockResolvedValue([{ msg_count: 500n, chat_count: 9n, contact_count: 7n, min_date: null, max_date: null }])
                messagesByPeer({ '126': [privateMessage({ peer: '126', id: 3001 })] })

                const patch = await runImport([userDialog('126')])

                expect(patch.resultType).toBe('partial')
                expect(patch.messagesImported).toBe(1)
                expect(patch.chatsScanned).toBe(1)
                expect(patch.detailsJson.completeness).toMatchObject({ basis: 'bounded-fetch', proof: 'none', dialogsCapHit: false })
                expect(patch.detailsJson.databaseContext.telegramMessagesSinceCutoff).toBe(500)
            })

            test('an empty run is live_only and never borrows database totals', async () => {
                mocks.queryRaw.mockResolvedValue([{ msg_count: 50n, chat_count: 3n, contact_count: 2n, min_date: new Date(), max_date: new Date() }])

                const patch = await runImport([])

                expect(patch.resultType).toBe('live_only')
                expect(patch.messagesImported).toBe(0)
                expect(patch.chatsScanned).toBe(0)
                expect(patch.contactsFound).toBe(0)
                expect(patch.coveredPeriodFrom).toBeNull()
            })

            test('dialog and message caps are reported as incomplete', async () => {
                const rooms = Array.from({ length: 99 }, (_, index) => ({ isUser: false, date: nowSeconds(), entity: { id: BigInt(index + 1000) } }))
                messagesByPeer({ '126': Array.from({ length: 200 }, (_, index) => privateMessage({ peer: '126', id: 4000 + index })) })

                const patch = await runImport([...rooms, userDialog('126')])

                expect(patch.resultType).toBe('partial')
                expect(patch.detailsJson.completeness).toMatchObject({
                    dialogsReturned: 100,
                    dialogsCapHit: true,
                    messagesCap: 200,
                    dialogsWithMessageCapHit: 1,
                })
            })

            test('a dialog list that ends before the window is not a dialog cap', async () => {
                const old = nowSeconds() - 200 * 24 * 60 * 60
                const rooms = Array.from({ length: 99 }, (_, index) => ({ isUser: false, date: nowSeconds(), entity: { id: BigInt(index + 2000) } }))

                const patch = await runImport([...rooms, { isUser: false, date: old, entity: { id: 3000n } }])

                expect(patch.detailsJson.completeness.dialogsCapHit).toBe(false)
            })

            test('a failing message is isolated and makes the run partial', async () => {
                messagesByPeer({ '126': [privateMessage({ peer: '126', id: 0 }), privateMessage({ peer: '126', id: 3002 })] })

                const patch = await runImport([userDialog('126')])

                expect(mocks.createMessage).toHaveBeenCalledOnce()
                expect(patch.detailsJson.completeness.failedMessages).toBe(1)
                expect(patch.resultType).toBe('partial')
                expect(logs()).toContain('code=TELEGRAM_MESSAGE_IDENTITY_UNPROVEN')
            })
        })

        describe('bounded ingress error codes', () => {
            test('media persistence errors never log data URLs, file names or Prisma text', async () => {
                const prismaText = () => Object.assign(
                    new Error('Invalid `prisma.messageAttachment.create()` invocation: { url: "data:application/pdf;base64,SUVEU0VDUkVU", fileName: "Иванов_паспорт.pdf" }'),
                    { name: 'PrismaClientValidationError' },
                )
                mocks.attachMessageMedia.mockRejectedValue(prismaText())
                mocks.attachBinaryMedia.mockRejectedValue(prismaText())
                const media = {
                    media: { className: 'MessageMediaDocument', document: { mimeType: 'application/pdf', attributes: [{ fileName: 'Иванов_паспорт.pdf' }] } },
                    downloadMedia: vi.fn(async () => Buffer.from('pdf')),
                }
                const handler = await initializeListener(`telegram-log-media-${connectionSequence}`, '7300')

                await handler({ message: privateMessage({ peer: '42', id: 9201, text: '', extra: media }) })
                await handler({ message: privateMessage({ peer: '42', id: 9202, text: '', out: true, extra: media }) })
                mocks.messageFindUnique.mockResolvedValueOnce({ id: 'existing-media-row', chatId: 'chat:telegram:42', direction: 'inbound', channel: 'telegram' })
                await handler({ message: privateMessage({ peer: '42', id: 9201, text: '', extra: media }) })

                expect(logs()).toContain('Media download failed for msg=')
                expect(logs()).toContain('Media download failed: code=PRISMA_VALIDATION')
                expect(logs()).toContain('MEDIA retry failed for existing msg=existing-media-row: code=PRISMA_VALIDATION')
                for (const leaked of ['base64', 'SUVEU0VDUkVU', 'Иванов', 'Invalid `prisma', 'application/pdf']) {
                    expect(logs()).not.toContain(leaked)
                }
            })

            test.each([
                ['UNCLASSIFIED', new Error('79991234567')],
                ['UNCLASSIFIED', Object.assign(new Error('provider said 79991234567'), { code: '79991234567' })],
                ['UNCLASSIFIED', { errorMessage: 'PHONE_NUMBER_INVALID_79991234567', message: 'PHONE_NUMBER_INVALID 79991234567' }],
                ['TG_FLOOD_WAIT', { errorMessage: 'FLOOD_WAIT_30', message: 'A wait of 30 seconds is required for Ivan' }],
                ['PG_LOCK_TIMEOUT', Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '55P03', message: 'lock timeout for Ivan' } })],
                ['CONTACT_RESOLUTION_BLOCKED', new Error('CONTACT_RESOLUTION_BLOCKED:ivan_petrov_79991234567')],
                ['UNCLASSIFIED', new Error('TELEGRAM_PEER_ID_UNPROVEN79991234567')],
                ['UNCLASSIFIED', new Error('SOME_PROVIDER_SECRET_TOKEN for Ivan')],
                ['UNCLASSIFIED', 'plain string error with Ivan 79991234567'],
                ['JS_TYPE_ERROR', new TypeError("Cannot read properties of undefined (reading 'Ivan')")],
            ])('a provider-controlled error is logged only as %s (case %#)', async (expected, error) => {
                const handler = await initializeListener(`telegram-log-code-${expected}-${connectionSequence}`, '7301')
                mocks.upsertConversation.mockRejectedValueOnce(error)

                await handler({ message: privateMessage({ peer: '42', id: 9301 }) })

                expect(logs()).toMatch(new RegExp(`code=${expected}(?![A-Z_:])`))
                for (const leaked of ['79991234567', 'Ivan', 'ivan', '30 seconds', 'SECRET', 'lock timeout for']) {
                    expect(logs()).not.toContain(leaked)
                }
            })

            test('workflow and publication failures log codes only', async () => {
                mocks.inboundWorkflow.mockRejectedValueOnce(new Error('update failed for "secret body"'))
                mocks.emitMessage.mockRejectedValueOnce(new Error('broadcast failed for "secret body"'))
                const handler = await initializeListener(`telegram-log-workflow-${connectionSequence}`, '7302')

                await handler({ message: privateMessage({ peer: '42', id: 9401, text: 'secret body' }) })

                await vi.waitFor(() => expect(logs()).toContain('emitMessageReceived error: code=UNCLASSIFIED'))
                expect(logs()).toContain('onInboundMessage error: code=UNCLASSIFIED')
                expect(logs()).not.toContain('secret body')
            })

            test('reaction and import-job update failures log codes only', async () => {
                const connectionId = `telegram-log-reaction-${connectionSequence}`
                await initializeListener(connectionId, '7303')
                const reactionHandler = mocks.clients.at(-1)!.handlers[1]
                mocks.messageFindUnique.mockResolvedValueOnce({
                    id: 'reacted-message',
                    chatId: 'chat-reacted',
                    metadata: {},
                    chat: { channel: 'telegram', externalChatId: 'telegram:4242', metadata: { providerAccountId: '7303', connectionId, peerId: '4242' } },
                })
                mocks.patchMessageMetadata.mockRejectedValueOnce(new Error('metadata write failed for peer 4242 "Ivan"'))

                await reactionHandler({ msgId: 301, peer: { userId: 4242n }, reactions: { results: [{ reaction: { emoticon: '👍' }, count: 1 }] } })
                expect(logs()).toContain('[TG-REACTION] Error: code=UNCLASSIFIED')

                mocks.patchImportJob.mockRejectedValue(new Error('patch failed: detailsJson {"secret":"Ivan"}'))
                await runImport([])
                expect(logs()).toContain('[TG-IMPORT] updateTgImportJob error: code=UNCLASSIFIED')
                expect(logs()).not.toContain('Ivan')
                expect(logs()).not.toContain('detailsJson')
            })

            test('no ingress log statement can reference message text, names, provider ids or raw error text', () => {
                const source = readFileSync(`${process.cwd()}/src/app/tg-actions.ts`, 'utf8')
                const ingressFunctions = [
                    'logTelegramServicePeerSkipped',
                    'logTelegramMessageKeyConflict',
                    'rejectTelegramConversationCollision',
                    'admitTelegramPrivateConversation',
                    'processInboundTelegramMessage',
                    'processOutboundMirrorMessage',
                    'ensureOutboundTelegramAttachment',
                    'catchUpMissedMessages',
                    'processReactionUpdate',
                    'attachInboundListener',
                    'importTelegramHistory',
                    'updateTgImportJob',
                ]
                const forbidden = /\.message\b|\.stack\b|JSON\.stringify|\b(?:text|content|msgText|fileName|mimeType|senderName|recipientName|senderId|recipientId|peerId|externalMsgId|rawExternalMsgId|username|firstName|lastName)\b|,\s*(?:err|error|e|retryErr|mediaErr|chatErr|messageError|dialogError)\s*\)/
                let checked = 0
                for (const name of ingressFunctions) {
                    const start = source.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`))
                    expect(start, name).toBeGreaterThan(-1)
                    const rest = source.slice(start + 1)
                    const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*|\ntype |\nconst /)
                    const body = end === -1 ? rest : rest.slice(0, end)
                    const statements = body.split('\n').filter(line => /console\.(?:log|warn|error)\(|opsLog\(/.test(line))
                    for (const statement of statements) {
                        expect(statement.trim(), name).not.toMatch(forbidden)
                        checked++
                    }
                }
                expect(checked).toBeGreaterThan(30)
            })
        })
    })
})

// TG2R: the exact outbound person, a proven reply target and the S1 outcome of
// every pre-dispatch failure. Each client keeps its own entity cache here, as
// GramJS does: a person resolves only on the client that learned them.
describe('TG2R exact peer, reply proof and pre-dispatch outcome', () => {
    const ACCOUNT = '7300'
    const PEER = '5550001'
    const OTHER_PEER = '5550002'
    const DATE = 1_760_000_000
    let sequence = 0
    let caches: Map<unknown, Set<string>>
    let sweepDialogs: (client: unknown) => Promise<unknown>

    const miss = (target: unknown) => new Error(`Could not find the input entity for {"userId":"${String(target)}"}`)
    const cacheOf = (client: unknown) => {
        let set = caches.get(client)
        if (!set) caches.set(client, set = new Set())
        return set
    }
    const sweeps = () => mocks.getDialogs.mock.calls.filter(([input]) => (input as { limit?: number })?.limit === 200)
    const quote = (id: number | string, account = ACCOUNT, peer = PEER) => `telegram:${account}:${peer}:${id}`
    const liveMessage = (id: number, date = DATE, peer = PEER) => new tl.Message({
        id, date, peerId: new tl.PeerUser({ userId: BigInt(peer) }),
    })
    const tokens = (message: string) => message.match(/TELEGRAM_MTPROTO_(?:REFUSED|NOT_DISPATCHED|SEND_OUTCOME_UNKNOWN)/g) ?? []
    // The published S1 adapter grammar (MessageService): every code in the text.
    const s1Codes = (message: string) =>
        [...message.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(SEND_OUTCOME_UNKNOWN|NOT_DISPATCHED|REFUSED)\b/g)].map(match => match[1])
    const rpcError = (code: number, errorMessage: string) => Object.assign(new Error(`${code}: ${errorMessage}`), { code, errorMessage })
    const settle = async () => {
        for (let round = 0; round < 20; round++) await new Promise(resolve => setImmediate(resolve))
    }
    async function failure(promise: Promise<unknown>): Promise<Error> {
        const error = await promise.then(() => null, (reason: unknown) => reason)
        expect(error).toBeInstanceOf(Error)
        return error as Error
    }
    function expectOutcome(error: Error, token: 'TELEGRAM_MTPROTO_REFUSED' | 'TELEGRAM_MTPROTO_NOT_DISPATCHED', code?: string) {
        expect(error.message).toMatch(/^Telegram delivery failed: /)
        expect(tokens(error.message)).toEqual([token])
        expect(s1Codes(error.message)).toEqual([token === 'TELEGRAM_MTPROTO_REFUSED' ? 'REFUSED' : 'NOT_DISPATCHED'])
        if (code) expect(error.message).toContain(code)
    }

    function setup(options: { legacy?: boolean } = {}) {
        const connectionId = `tg2r-${options.legacy ? 'carrier' : 'bound'}-${sequence}`
        const chat = {
            ...exactChat({
                externalChatId: `telegram:${PEER}`,
                metadata: options.legacy
                    ? { chatKind: 'private', peerId: PEER }
                    : { chatKind: 'private', peerId: PEER, providerAccountId: ACCOUNT, connectionId },
            }),
            id: `chat-tg2r-${sequence}`,
            contactId: 'contact-tg2r',
            contactIdentityId: 'identity-tg2r',
        }
        mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
        mocks.telegramConnectionFindMany.mockResolvedValue([{ id: connectionId }])
        mocks.chatFindUnique.mockResolvedValue(chat)
        mocks.prepareOutbound.mockResolvedValue({
            chatId: chat.id,
            channel: 'telegram',
            contactId: chat.contactId,
            contactIdentityId: chat.contactIdentityId,
            providerAccountId: options.legacy ? null : ACCOUNT,
            connectionId: options.legacy ? null : connectionId,
            identityTarget: PEER,
            target: PEER,
            isMaxPersonal: false,
        })
        const send = (quotedMsgId?: string, text = 'tg2r text') => sendTelegramMessage(
            PEER,
            text,
            options.legacy ? undefined : connectionId,
            { chatId: chat.id, ...(quotedMsgId === undefined ? {} : { quotedMsgId }) },
        )
        return { connectionId, chat, send }
    }

    /** Creates and caches this connection's client before the scenario starts. */
    async function warm(connectionId: string) {
        mocks.telegramConnectionFindMany.mockResolvedValueOnce([connection(connectionId)])
        await initTelegramListeners()
        const client = mocks.clients.at(-1) as unknown as { connected: boolean, connect: () => Promise<void> }
        expect(client).toBeDefined()
        return client
    }

    function knowPeerEverywhere() {
        mocks.getEntity.mockImplementation(async (target: unknown) => new tl.User({ id: BigInt(String(target)) }))
    }

    beforeEach(() => {
        sequence++
        vi.clearAllMocks()
        mocks.clients.length = 0
        mocks.providerAccountId = ACCOUNT
        mocks.getMeFailure = null
        caches = new Map()
        sweepDialogs = async client => {
            cacheOf(client).add(PEER)
            return []
        }
        mocks.getDialogs.mockImplementation(async (input: { limit?: number }, client: unknown) =>
            input?.limit === 200 ? sweepDialogs(client) : [])
        mocks.getEntity.mockImplementation(async (target: unknown, client: unknown) => {
            if (cacheOf(client).has(String(target))) return new tl.User({ id: BigInt(String(target)) })
            throw miss(target)
        })
        mocks.getMessages.mockResolvedValue([])
        mocks.sendMessage.mockResolvedValue({ id: 9101 })
        mocks.sendFile.mockResolvedValue({ id: 9102 })
        mocks.invoke.mockResolvedValue({})
        mocks.messageFindUnique.mockResolvedValue(null)
        mocks.createMessage.mockResolvedValue({ message: { id: 'never' } })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(async () => {
        vi.useRealTimers()
        await stopTelegramHealthCheck()
        vi.restoreAllMocks()
    })

    describe('exact person', () => {
        test('a cold cache sweeps 200 dialogs once, looks the exact id up once more and sends once to that user', async () => {
            const { send } = setup()

            await expect(send()).resolves.toEqual({ success: true, externalId: quote(9101) })

            expect(sweeps()).toHaveLength(1)
            expect(sweeps()[0][0]).toEqual({ limit: 200 })
            expect(mocks.getEntity).toHaveBeenCalledTimes(2)
            expect(mocks.sendMessage).toHaveBeenCalledOnce()
            const [entity, options] = mocks.sendMessage.mock.calls[0]
            expect(entity).toBeInstanceOf(Api.User)
            expect(String((entity as { id: bigint }).id)).toBe(PEER)
            expect(options).toEqual({ message: 'tg2r text' })
        })

        test('a person the client already knows is sent to without a sweep', async () => {
            const { send } = setup()
            await send()
            await send()

            expect(sweeps()).toHaveLength(1)
            expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
        })

        test('a fresh sweep that does not find the person refuses, and nothing is sent', async () => {
            const { send } = setup()
            sweepDialogs = async () => []

            const error = await failure(send())

            expectOutcome(error, 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_PEER_UNRESOLVED')
            expect(mocks.getEntity).toHaveBeenCalledTimes(2)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('concurrent misses share one sweep and each send goes out exactly once', async () => {
            const { connectionId, send } = setup()
            await warm(connectionId)
            let release!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            sweepDialogs = async client => {
                await gate
                cacheOf(client).add(PEER)
                return []
            }

            const first = send(undefined, 'first')
            const second = send(undefined, 'second')
            await settle()
            expect(sweeps()).toHaveLength(1)
            release()

            await expect(first).resolves.toMatchObject({ success: true })
            await expect(second).resolves.toMatchObject({ success: true })
            expect(sweeps()).toHaveLength(1)
            expect(mocks.sendMessage.mock.calls.map(call => (call[1] as { message: string }).message).sort())
                .toEqual(['first', 'second'])
        })

        test('only the call that started a sweep may refuse; a call that joined it is not dispatched', async () => {
            const { connectionId, send } = setup()
            await warm(connectionId)
            let release!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            sweepDialogs = async () => {
                await gate
                return []
            }

            const starter = failure(send())
            const joiner = failure(send())
            await settle()
            release()

            expectOutcome(await starter, 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_PEER_UNRESOLVED')
            expectOutcome(await joiner, 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')
            expect(sweeps()).toHaveLength(1)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a miss inside the rate window starts no sweep and is not dispatched; after it a fresh sweep runs', async () => {
            const { send } = setup()
            vi.useFakeTimers({ toFake: ['Date'] })
            sweepDialogs = async () => []
            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_PEER_UNRESOLVED')

            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')
            expect(sweeps()).toHaveLength(1)

            vi.setSystemTime(Date.now() + 61_000)
            sweepDialogs = async client => {
                cacheOf(client).add(PEER)
                return []
            }
            await expect(send()).resolves.toMatchObject({ success: true })
            expect(sweeps()).toHaveLength(2)
        })

        test('a failed sweep is not dispatched, and FLOOD_WAIT holds the next sweep back for its whole wait', async () => {
            const { send } = setup()
            vi.useFakeTimers({ toFake: ['Date'] })
            const start = Date.now()
            sweepDialogs = async () => {
                throw Object.assign(rpcError(420, 'FLOOD_WAIT'), { seconds: 120 })
            }
            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')

            vi.setSystemTime(start + 61_000)
            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_NOT_DISPATCHED')
            expect(sweeps()).toHaveLength(1)

            vi.setSystemTime(start + 121_000)
            sweepDialogs = async client => {
                cacheOf(client).add(PEER)
                return []
            }
            await expect(send()).resolves.toMatchObject({ success: true })
            expect(sweeps()).toHaveLength(2)
        })

        test('a sweep that never answers is waited 15 s, is joined until 60 s old, and is then released', async () => {
            const { connectionId, send } = setup()
            await warm(connectionId)
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
            const start = Date.now()
            sweepDialogs = () => new Promise(() => {})

            const first = failure(send())
            await vi.advanceTimersByTimeAsync(15_000)
            expectOutcome(await first, 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')

            const joined = failure(send())
            await vi.advanceTimersByTimeAsync(15_000)
            expectOutcome(await joined, 'TELEGRAM_MTPROTO_NOT_DISPATCHED')
            expect(sweeps()).toHaveLength(1)

            vi.setSystemTime(start + 61_000)
            sweepDialogs = async client => {
                cacheOf(client).add(PEER)
                return []
            }
            const released = send()
            await vi.advanceTimersByTimeAsync(0)
            await expect(released).resolves.toMatchObject({ success: true })
            expect(sweeps()).toHaveLength(2)
            expect(mocks.sendMessage).toHaveBeenCalledOnce()
        })

        test('a client evicted while its sweep runs proves nothing and sends nothing', async () => {
            const { connectionId, send } = setup()
            const client = await warm(connectionId)
            let release!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            sweepDialogs = async swept => {
                await gate
                cacheOf(swept).add(PEER)
                return []
            }

            const pending = failure(send())
            await settle()
            client.connected = false
            release()

            expectOutcome(await pending, 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_SEND_CLIENT_REPLACED')
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('media on a client evicted while its sweep runs is refused that client and sends nothing', async () => {
            const { chat, connectionId } = setup()
            const client = await warm(connectionId)
            let release!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            sweepDialogs = async swept => {
                await gate
                cacheOf(swept).add(PEER)
                return []
            }

            const pending = sendTelegramMedia(
                PEER, 'ZmFrZQ==', 'proof.bin', 'application/octet-stream', undefined, connectionId,
                { chatId: chat.id, identityTarget: PEER },
            ).then(() => null, (reason: unknown) => reason as Error)
            await settle()
            client.connected = false
            release()

            expect((await pending)?.message).toContain('TELEGRAM_SEND_CLIENT_REPLACED')
            expect(mocks.sendFile).not.toHaveBeenCalled()
        })

        test('a replacement client never joins the old client\'s sweep, and the flood window stays with the connection', async () => {
            const { connectionId, send } = setup()
            const old = await warm(connectionId)
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
            const start = Date.now()
            sweepDialogs = () => new Promise(() => {})
            const stuck = failure(send())
            await vi.advanceTimersByTimeAsync(15_000)
            expectOutcome(await stuck, 'TELEGRAM_MTPROTO_NOT_DISPATCHED')

            old.connected = false
            old.connect = async () => { throw new Error('socket down') }
            sweepDialogs = async client => {
                cacheOf(client).add(PEER)
                return []
            }
            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_NOT_DISPATCHED')
            expect(sweeps()).toHaveLength(1)

            vi.setSystemTime(start + 61_000)
            await expect(send()).resolves.toMatchObject({ success: true })
            expect(sweeps()).toHaveLength(2)
            const replacement = mocks.sendMessage.mock.calls[0][2]
            expect(replacement).not.toBe(old)
            expect(sweeps()[1][1]).toBe(replacement)
        })

        test('the legacy carrier route resolves through the same exact sweep', async () => {
            const { send } = setup({ legacy: true })

            await expect(send()).resolves.toMatchObject({ success: true, externalId: quote(9101) })
            expect(sweeps()).toHaveLength(1)
            expect(mocks.sendMessage).toHaveBeenCalledOnce()
        })

        test.each([
            ['a basic group', (id: bigint) => new tl.Chat({ id })],
            ['a channel', (id: bigint) => new tl.Channel({ id })],
        ])('%s that shares the number is never addressed', async (_label, collide) => {
            const { send } = setup()
            mocks.getEntity.mockImplementation(async (target: unknown, client: unknown) =>
                cacheOf(client).has(String(target))
                    ? new tl.User({ id: BigInt(String(target)) })
                    : collide(BigInt(String(target))))

            await expect(send()).resolves.toMatchObject({ success: true })
            expect(mocks.sendMessage.mock.calls[0][0]).toBeInstanceOf(Api.User)

            sequence++
            const unresolved = setup()
            sweepDialogs = async () => []
            expectOutcome(await failure(unresolved.send()), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_PEER_UNRESOLVED')
            expect(mocks.sendMessage).toHaveBeenCalledOnce()
        })

        test.each([
            ['another user', () => new tl.User({ id: BigInt(OTHER_PEER) })],
            ['no entity at all', () => undefined],
        ])('%s is never resolved as the person', async (_label, answer) => {
            const { send } = setup()
            mocks.getEntity.mockImplementation(async () => answer())

            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_PEER_UNRESOLVED')
            expect(mocks.getEntity).toHaveBeenCalledTimes(2)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test.each([
            ['a network error', rpcError(500, 'RPC_CALL_FAIL'), 'TELEGRAM_MTPROTO_NOT_DISPATCHED'],
            ['a dead session', rpcError(401, 'AUTH_KEY_UNREGISTERED'), 'TELEGRAM_MTPROTO_REFUSED'],
        ] as const)('%s on the lookup is answered without a sweep', async (_label, error, token) => {
            const { send } = setup()
            mocks.getEntity.mockRejectedValue(error)

            expectOutcome(await failure(send()), token)
            expect(sweeps()).toHaveLength(0)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a network error on the lookup after the sweep is not dispatched', async () => {
            const { send } = setup()
            mocks.getEntity
                .mockRejectedValueOnce(miss(PEER))
                .mockRejectedValueOnce(rpcError(500, 'RPC_CALL_FAIL'))

            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')
            expect(sweeps()).toHaveLength(1)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('text, media and reactions resolve only by the exact numeric id: no phone, username or contact import', async () => {
            const { chat, connectionId, send } = setup()
            sweepDialogs = async () => []
            await failure(send())
            sequence++
            const media = setup()
            await expect(sendTelegramMedia(
                PEER, 'ZmFrZQ==', 'proof.bin', 'application/octet-stream', undefined, media.connectionId,
                { chatId: media.chat.id, identityTarget: PEER },
            )).rejects.toThrow('TELEGRAM_PEER_UNRESOLVED')

            for (const [target] of mocks.getEntity.mock.calls) expect(typeof target).toBe('bigint')
            expect(mocks.invoke).not.toHaveBeenCalled()
            expect(mocks.sendMessage).not.toHaveBeenCalled()
            expect(mocks.sendFile).not.toHaveBeenCalled()
            expect(chat.id).not.toBe(media.chat.id)
            expect(connectionId).not.toBe(media.connectionId)
        })

        test('media and reactions on a cold cache resolve through the same sweep', async () => {
            const { chat, connectionId } = setup()

            await expect(sendTelegramMedia(
                PEER, 'ZmFrZQ==', 'proof.bin', 'application/octet-stream', undefined, connectionId,
                { chatId: chat.id, identityTarget: PEER },
            )).resolves.toEqual({ success: true, externalId: quote(9102) })
            await sendTelegramReaction({
                target: PEER,
                messageId: quote(301),
                emoji: '👍',
                remove: false,
                connectionId,
                proof: { chatId: chat.id, identityTarget: PEER },
            })

            expect(sweeps()).toHaveLength(1)
            expect(mocks.sendFile.mock.calls[0][0]).toBeInstanceOf(Api.User)
            expect(mocks.invoke).toHaveBeenCalledOnce()
        })
    })

    describe('account and transport', () => {
        test('a connected client whose account changed is refused before any lookup', async () => {
            const { connectionId, send } = setup()
            await warm(connectionId)
            mocks.providerAccountId = '7399'

            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_PROVIDER_ACCOUNT_ID_CHANGED')
            expect(mocks.getEntity).not.toHaveBeenCalled()
            expect(sweeps()).toHaveLength(0)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('an account change while the proof runs leaves nothing on the old client', async () => {
            const { connectionId, send } = setup()
            const old = await warm(connectionId)
            let release!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            sweepDialogs = async client => {
                await gate
                cacheOf(client).add(PEER)
                return []
            }
            const pending = failure(send())
            await settle()

            old.connected = false
            old.connect = async () => { throw new Error('socket down') }
            mocks.providerAccountId = '7398'
            const replacement = await failure(send())
            release()

            expectOutcome(await pending, 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_SEND_CLIENT_REPLACED')
            expectOutcome(replacement, 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a conversation bound to another transport is refused before any lookup', async () => {
            const { connectionId, send } = setup()
            mocks.prepareOutbound.mockResolvedValue({
                chatId: `chat-tg2r-${sequence}`,
                channel: 'telegram',
                providerAccountId: ACCOUNT,
                connectionId: `${connectionId}-other`,
                identityTarget: PEER,
                target: PEER,
            })

            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_REFUSED', 'CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
            expect(mocks.getEntity).not.toHaveBeenCalled()
        })

        test('a reconnected client proves the person again instead of reusing another client\'s proof', async () => {
            const { connectionId, send } = setup()
            const old = await warm(connectionId)
            vi.useFakeTimers({ toFake: ['Date'] })
            const start = Date.now()
            await expect(send()).resolves.toMatchObject({ success: true })

            old.connected = false
            old.connect = async () => { throw new Error('socket down') }
            expectOutcome(await failure(send()), 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_PEER_RESOLUTION_UNAVAILABLE')

            vi.setSystemTime(start + 61_000)
            await expect(send()).resolves.toMatchObject({ success: true })
            const [firstClient, lastClient] = [mocks.sendMessage.mock.calls[0][2], mocks.sendMessage.mock.calls[1][2]]
            expect(firstClient).toBe(old)
            expect(lastClient).not.toBe(old)
            expect(sweeps().map(call => call[1])).toEqual([old, lastClient])
        })
    })

    describe('reply target', () => {
        test('a current-form quote of a live message in this dialog is sent as that exact quote', async () => {
            const { send } = setup()
            knowPeerEverywhere()
            mocks.getMessages.mockResolvedValue([liveMessage(4242)])

            await expect(send(quote(4242))).resolves.toMatchObject({ success: true })

            expect(mocks.getMessages).toHaveBeenCalledWith(expect.any(Api.User), { ids: [4242] }, expect.anything())
            expect(mocks.sendMessage).toHaveBeenCalledWith(
                expect.any(Api.User),
                { message: 'tg2r text', replyTo: 4242 },
                expect.anything(),
            )
        })

        test.each([
            ['another Telegram account', quote(4242, '7301')],
            ['another chat', quote(4242, ACCOUNT, OTHER_PEER)],
            ['the synthetic local key', quote('local-1760000000000')],
            ['an id beyond 32 bits', quote(2147483648)],
            ['a bare id beyond 32 bits', '2147483648'],
            ['id zero', quote(0)],
            ['a non-numeric id', 'not-a-message'],
            ['a MAX id', 'max:-71234567890:5678'],
            ['a WhatsApp id', 'false_79991234567@c.us_3EB0C0FFEE'],
        ])('a quote of %s is not addressable and nothing is sent', async (_label, quoted) => {
            const { send } = setup()
            knowPeerEverywhere()

            expectOutcome(await failure(send(quoted)), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_REPLY_TARGET_NOT_ADDRESSABLE')
            expect(mocks.getMessages).not.toHaveBeenCalled()
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test.each([
            ['a deleted message', [undefined]],
            ['a service message', [new tl.MessageService({ id: 4242, date: DATE, peerId: new tl.PeerUser({ userId: BigInt(PEER) }) })]],
            ['another dialog\'s message', [liveMessage(4242, DATE, OTHER_PEER)]],
            ['another message id', [liveMessage(4243)]],
        ])('a quote of %s is unproven and nothing is sent', async (_label, answer) => {
            const { send } = setup()
            knowPeerEverywhere()
            mocks.getMessages.mockResolvedValue(answer)

            expectOutcome(await failure(send(quote(4242))), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_REPLY_TARGET_UNPROVEN')
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a legacy bare quote is sent only for the row this chat stored with the provider\'s own time', async () => {
            const { chat, send } = setup()
            knowPeerEverywhere()
            mocks.getMessages.mockResolvedValue([liveMessage(4242)])
            mocks.messageFindUnique.mockResolvedValue({ chatId: chat.id, sentAt: new Date(DATE * 1000 + 999) })

            await expect(send('4242')).resolves.toMatchObject({ success: true })

            expect(mocks.messageFindUnique).toHaveBeenCalledWith({
                where: { externalId: '4242' },
                select: { chatId: true, sentAt: true },
            })
            expect(mocks.sendMessage.mock.calls[0][1]).toEqual({ message: 'tg2r text', replyTo: 4242 })
        })

        test.each([
            ['no stored row', () => null],
            ['a row of another chat', () => ({ chatId: 'chat-elsewhere', sentAt: new Date(DATE * 1000) })],
            ['a different provider second', (chatId: string) => ({ chatId, sentAt: new Date((DATE + 1) * 1000) })],
            ['a CRM send time instead of the provider time', (chatId: string) => ({ chatId, sentAt: new Date((DATE - 3) * 1000) })],
        ])('a legacy bare quote with %s is unproven', async (_label, row) => {
            const { chat, send } = setup()
            knowPeerEverywhere()
            mocks.getMessages.mockResolvedValue([liveMessage(4242)])
            mocks.messageFindUnique.mockResolvedValue(row(chat.id))

            expectOutcome(await failure(send('4242')), 'TELEGRAM_MTPROTO_REFUSED', 'TELEGRAM_REPLY_TARGET_UNPROVEN')
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test.each([
            ['a network error', rpcError(500, 'RPC_CALL_FAIL'), 'TELEGRAM_MTPROTO_NOT_DISPATCHED'],
            ['a dead session', rpcError(401, 'SESSION_REVOKED'), 'TELEGRAM_MTPROTO_REFUSED'],
        ] as const)('%s while proving the quote never becomes an unquoted send', async (_label, error, token) => {
            const { send } = setup()
            knowPeerEverywhere()
            mocks.getMessages.mockRejectedValue(error)

            expectOutcome(await failure(send(quote(4242))), token, 'TELEGRAM_REPLY_TARGET_PROOF_UNAVAILABLE')
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a client evicted while the quote is proven sends nothing', async () => {
            const { connectionId, send } = setup()
            const client = await warm(connectionId)
            knowPeerEverywhere()
            mocks.getMessages.mockImplementation(async () => {
                client.connected = false
                return [liveMessage(4242)]
            })

            expectOutcome(await failure(send(quote(4242))), 'TELEGRAM_MTPROTO_NOT_DISPATCHED', 'TELEGRAM_SEND_CLIENT_REPLACED')
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a redelivered reply keeps its exact quote (DEP-Q forwards it on retry)', async () => {
            const { send } = setup()
            knowPeerEverywhere()
            mocks.getMessages
                .mockRejectedValueOnce(rpcError(500, 'RPC_CALL_FAIL'))
                .mockResolvedValue([liveMessage(4242)])

            expectOutcome(await failure(send(quote(4242))), 'TELEGRAM_MTPROTO_NOT_DISPATCHED')
            await expect(send(quote(4242))).resolves.toMatchObject({ success: true })

            expect(mocks.sendMessage).toHaveBeenCalledOnce()
            expect(mocks.sendMessage.mock.calls[0][1]).toEqual({ message: 'tg2r text', replyTo: 4242 })
            const service = readFileSync(`${process.cwd()}/src/lib/MessageService.ts`, 'utf8')
            const retryLeg = service.slice(service.lastIndexOf("case 'telegram': {"))
            expect(retryLeg.slice(0, 900)).toContain('quotedMsgId: nonEmptyString(meta.quotedMsgId)')
        })
    })

    describe('pre-dispatch outcome, side effects and idempotency', () => {
        test.each([
            ['a send with no conversation', 'REFUSED', 'CONTACT_CONVERSATION_IDENTITY_REQUIRED',
                () => { mocks.chatFindUnique.mockResolvedValue(null) }],
            ['no active legacy carrier', 'REFUSED', 'CONTACT_CONVERSATION_TRANSPORT_UNBOUND',
                () => { mocks.telegramConnectionFindMany.mockResolvedValue([]) }, true],
            ['several legacy carriers', 'REFUSED', 'CONTACT_CONVERSATION_TRANSPORT_AMBIGUOUS',
                () => { mocks.telegramConnectionFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]) }, true],
            ['an inactive connection', 'NOT_DISPATCHED', 'Telegram is not connected',
                () => { mocks.telegramConnectionFindUnique.mockResolvedValue(null) }],
            ['a dead session at attestation', 'REFUSED', 'AUTH_KEY_UNREGISTERED',
                () => { mocks.getMeFailure = rpcError(401, 'AUTH_KEY_UNREGISTERED') }],
            ['a dropped socket at attestation', 'NOT_DISPATCHED', 'Connection dropped',
                () => { mocks.getMeFailure = new Error('Connection dropped') }],
            ['a conversation gate refusal', 'REFUSED', 'CONTACT_CONVERSATION_NOT_PRIVATE',
                () => { mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_CONVERSATION_NOT_PRIVATE')) }],
            ['a busy contact owner', 'NOT_DISPATCHED', 'CONTACT_OWNERSHIP_BUSY',
                () => { mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_OWNERSHIP_BUSY')) }],
        ] as Array<[string, 'REFUSED' | 'NOT_DISPATCHED', string, () => void, boolean?]>)('%s is %s before dispatch', async (_label, outcome, code, arrange, legacy = false) => {
            const { send } = setup({ legacy })
            arrange()

            expectOutcome(await failure(send()), `TELEGRAM_MTPROTO_${outcome}`, code)
            expect(mocks.sendMessage).not.toHaveBeenCalled()
        })

        test('a send without a conversation id is refused before any lookup', async () => {
            setup()
            expectOutcome(
                await failure(sendTelegramMessage(PEER, 'tg2r text', 'tg2r-none', {})),
                'TELEGRAM_MTPROTO_REFUSED',
                'CONTACT_CONVERSATION_IDENTITY_REQUIRED',
            )
            expect(mocks.telegramConnectionFindUnique).not.toHaveBeenCalled()
        })

        test('an outcome another owner already stated passes through unchanged', async () => {
            const { send } = setup()
            mocks.prepareOutbound.mockRejectedValue(new Error('MESSAGING_SEND_OUTCOME_UNKNOWN: gate state lost'))

            const error = await failure(send())
            expect(error.message).toBe('Telegram delivery failed: MESSAGING_SEND_OUTCOME_UNKNOWN: gate state lost')
            expect(tokens(error.message)).toEqual([])
        })

        test('a failed credential read keeps its untyped error', async () => {
            const { send } = setup()
            mocks.telegramConnectionFindUnique.mockRejectedValue(new Error('Invalid `prisma.telegramConnection.findUnique()` invocation'))

            const error = await failure(send())
            expect(tokens(error.message)).toEqual([])
            expect(s1Codes(error.message)).toEqual([])
        })

        test.each([
            ['a provider refusal', rpcError(400, 'PEER_ID_INVALID')],
            ['a dead session', rpcError(401, 'AUTH_KEY_UNREGISTERED')],
            ['FLOOD_WAIT', rpcError(420, 'FLOOD_WAIT_30')],
            ['a dropped socket', new Error('Not connected')],
        ])('after dispatch, %s keeps main\'s untyped outcome', async (_label, error) => {
            const { send } = setup()
            knowPeerEverywhere()
            mocks.sendMessage.mockRejectedValue(error)

            const thrown = await failure(send())
            expect(thrown.message).toBe(`Telegram delivery failed: ${error.message}`)
            expect(tokens(thrown.message)).toEqual([])
            expect(mocks.sendMessage).toHaveBeenCalledOnce()
        })

        test('a send that never answers within 25 s keeps main\'s untyped timeout', async () => {
            const { send } = setup()
            knowPeerEverywhere()
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
            mocks.sendMessage.mockReturnValue(new Promise(() => {}))

            const pending = failure(send())
            await vi.advanceTimersByTimeAsync(25_000)
            const error = await pending
            expect(error.message).toBe('Telegram delivery failed: Telegram sendMessage timeout (25s)')
            expect(tokens(error.message)).toEqual([])
        })

        test('the sweep fetches no history, admits nothing, writes nothing and logs no dialog content', async () => {
            const { send } = setup()
            sweepDialogs = async client => {
                cacheOf(client).add(PEER)
                return [
                    { isUser: true, entity: { id: BigInt(PEER) }, message: { message: 'private dialog text' } },
                    { isUser: true, entity: { id: 777000n }, message: { message: 'Login code 51734' } },
                ]
            }

            await expect(send()).resolves.toMatchObject({ success: true })

            expect(mocks.getMessages).not.toHaveBeenCalled()
            for (const writer of [
                mocks.createMessage, mocks.upsertConversation, mocks.patchConversation,
                mocks.emitMessage, mocks.inboundWorkflow, mocks.ensureContactLink, mocks.resolveContact,
            ]) expect(writer).not.toHaveBeenCalled()
            const logged = [console.log, console.warn, console.error]
                .flatMap(spy => (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls)
                .map(call => call.map(String).join(' '))
                .join('\n')
            expect(logged).not.toContain('private dialog text')
            expect(logged).not.toContain('51734')
        })
    })
})
