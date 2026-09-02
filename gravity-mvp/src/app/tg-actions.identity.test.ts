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
        mocks.getEntity.mockImplementation(async target => ({ id: target }))
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

    test('live inbound records and rejects a cross-account Chat before Contact or message writes', async () => {
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
                reason: 'provider_account_mismatch',
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

    test('non-text delivery rejects a mismatched account proof before provider mutation', async () => {
        const connectionId = `telegram-nontext-reject-${connectionSequence}`
        const peerId = '42'
        mocks.telegramConnectionFindUnique.mockResolvedValue(connection(connectionId))
        mocks.chatFindUnique.mockResolvedValue({ id: 'chat-nontext-reject' })
        mocks.prepareOutbound.mockResolvedValue({
            chatId: 'chat-nontext-reject',
            channel: 'telegram',
            providerAccountId: '7060',
            connectionId,
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
            { chatId: 'chat-nontext-reject', providerAccountId: '7061', identityTarget: peerId },
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
})
