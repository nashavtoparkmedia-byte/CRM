import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type EventHandler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
    clients: new Map<string, { handlers: Map<string, EventHandler> }>(),
    clientGetChats: vi.fn(),
    clientIsRegisteredUser: vi.fn(),
    clientSendMessage: vi.fn(),
    appendFileSync: vi.fn(),
    rm: vi.fn(),
    chatFindMany: vi.fn(),
    chatFindUnique: vi.fn(),
    messageFindFirst: vi.fn(),
    messageFindUnique: vi.fn(),
    whatsAppChatFindUnique: vi.fn(),
    whatsAppChatUpsert: vi.fn(),
    whatsAppChatUpdate: vi.fn(),
    whatsAppMessageFindUnique: vi.fn(),
    whatsAppMessageUpsert: vi.fn(),
    whatsAppConnectionFindFirst: vi.fn(),
    whatsAppConnectionFindMany: vi.fn(),
    whatsAppConnectionFindUnique: vi.fn(),
    whatsAppConnectionUpdate: vi.fn(),
    queryRaw: vi.fn(),
    attachMessageMedia: vi.fn(),
    createChannelMessage: vi.fn(),
    ensureConversationContactLink: vi.fn(),
    linkMatchedDriver: vi.fn(),
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
    outboundWorkflow: vi.fn(),
    inboundWorkflow: vi.fn(),
    emitMessageReceived: vi.fn(),
    broadcastChatMessage: vi.fn(),
    opsLog: vi.fn(),
    clearPendingQr: vi.fn(),
    publishPendingQr: vi.fn(),
    cleanupStaleSessions: vi.fn(),
    registryEnsureEntry: vi.fn(),
    registryGetEntry: vi.fn(),
    registryBeginNewInstance: vi.fn(),
    registryIsCurrentInstance: vi.fn(),
    registryTouch: vi.fn(),
    registrySetReady: vi.fn(),
    registrySetFailed: vi.fn(),
    registrySetReconnecting: vi.fn(),
    registrySetStopped: vi.fn(),
    registryScheduleReconnect: vi.fn(),
    registryGetAllEntries: vi.fn(),
    registryGetInstanceId: vi.fn(),
    registryTouchLastSeen: vi.fn(),
}))

vi.mock('fs', () => ({
    default: {
        appendFileSync: mocks.appendFileSync,
        promises: { rm: mocks.rm },
    },
    appendFileSync: mocks.appendFileSync,
    promises: { rm: mocks.rm },
}))

vi.mock('whatsapp-web.js', () => {
    class LocalAuth {
        clientId: string

        constructor(options: { clientId: string }) {
            this.clientId = options.clientId
        }
    }

    class Client {
        connectionId: string
        handlers = new Map<string, EventHandler>()
        info = { wid: { user: '79990000000' } }
        pupPage = {
            isClosed: () => false,
            mainFrame: () => ({ isDetached: () => false }),
            evaluate: vi.fn().mockResolvedValue('{}'),
        }

        constructor(options: { authStrategy: LocalAuth }) {
            this.connectionId = options.authStrategy.clientId
            mocks.clients.set(this.connectionId, this)
        }

        on(event: string, handler: EventHandler) {
            this.handlers.set(event, handler)
            return this
        }

        async initialize() {}
        async destroy() {}
        removeAllListeners() { this.handlers.clear() }
        async getChats() { return mocks.clientGetChats(this.connectionId) }
        async isRegisteredUser(providerTargetId: string) {
            return mocks.clientIsRegisteredUser(this.connectionId, providerTargetId)
        }
        async sendMessage(providerTargetId: string, text: string, options: unknown) {
            return mocks.clientSendMessage(this.connectionId, providerTargetId, text, options)
        }
    }

    class MessageMedia {}
    class PrivateChat {}
    class GroupChat {}
    class Channel {}

    return { Client, LocalAuth, MessageMedia, PrivateChat, GroupChat, Channel }
})

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findMany: mocks.chatFindMany,
            findUnique: mocks.chatFindUnique,
        },
        message: {
            findFirst: mocks.messageFindFirst,
            findUnique: mocks.messageFindUnique,
        },
        whatsAppChat: {
            findUnique: mocks.whatsAppChatFindUnique,
            upsert: mocks.whatsAppChatUpsert,
            update: mocks.whatsAppChatUpdate,
        },
        whatsAppMessage: {
            findUnique: mocks.whatsAppMessageFindUnique,
            upsert: mocks.whatsAppMessageUpsert,
        },
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
    contactReachabilityV1: {
        recordExactProviderReachability: mocks.recordExactProviderReachability,
    },
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
    transportRegistryLifecycleV1: {
        ensureEntry: mocks.registryEnsureEntry,
        getEntry: mocks.registryGetEntry,
        beginNewInstance: mocks.registryBeginNewInstance,
        isCurrentInstance: mocks.registryIsCurrentInstance,
        touch: mocks.registryTouch,
        setReady: mocks.registrySetReady,
        setFailed: mocks.registrySetFailed,
        setReconnecting: mocks.registrySetReconnecting,
        setStopped: mocks.registrySetStopped,
        scheduleReconnect: mocks.registryScheduleReconnect,
        getAllEntries: mocks.registryGetAllEntries,
        getInstanceId: mocks.registryGetInstanceId,
        touchLastSeen: mocks.registryTouchLastSeen,
    },
}))

vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.opsLog,
}))

vi.mock('@/lib/whatsapp/WhatsAppCleanup', () => ({
    WWEBJS_AUTH_DIR: '/tmp/wa-test-auth',
    cleanupStaleWhatsAppSessions: mocks.cleanupStaleSessions,
}))

vi.mock('./whatsapp-qr-ceremony', () => ({
    clearPendingWhatsAppQr: mocks.clearPendingQr,
    publishPendingWhatsAppQr: mocks.publishPendingQr,
}))

import {
    checkReachability,
    destroyAllClients,
    forceSync,
    importWhatsAppHistory,
    initializeClient,
    sendMessage,
} from './WhatsAppService'
import { canonicalWhatsAppIdentityExternalIdV1 } from '@/modules/whatsapp-channel/public/v1/identity-canonicalization'

const STORED_CONNECTION_ID = 'wa-connection-a'
const INCOMING_CONNECTION_ID = 'wa-connection-b'
const PRIVATE_JID = '79990001122@c.us'
const CANONICAL_EXTERNAL_ID = 'whatsapp:79990001122'

function crossAccountConversation() {
    return {
        id: 'chat-owned-by-connection-a',
        channel: 'whatsapp',
        chatType: 'private',
        externalChatId: CANONICAL_EXTERNAL_ID,
        contactId: 'contact-a',
        contactIdentityId: 'identity-a',
        metadata: { connectionId: STORED_CONNECTION_ID },
    }
}

function historyChat() {
    return {
        id: { _serialized: PRIVATE_JID },
        name: 'Existing private chat',
        isGroup: false,
        fetchMessages: vi.fn().mockResolvedValue([{
            id: { _serialized: 'history-message-1' },
            body: 'do not cross accounts',
            timestamp: Math.floor(Date.now() / 1000),
            fromMe: false,
            type: 'chat',
            hasMedia: false,
        }]),
    }
}

function expectNoConversationWrites() {
    expect(mocks.whatsAppChatUpsert).not.toHaveBeenCalled()
    expect(mocks.whatsAppChatUpdate).not.toHaveBeenCalled()
    expect(mocks.whatsAppMessageUpsert).not.toHaveBeenCalled()
    expect(mocks.upsertChannelConversation).not.toHaveBeenCalled()
    expect(mocks.patchChannelConversation).not.toHaveBeenCalled()
    expect(mocks.ensureConversationContactLink).not.toHaveBeenCalled()
    expect(mocks.createChannelMessage).not.toHaveBeenCalled()
    expect(mocks.patchMessageDelivery).not.toHaveBeenCalled()
    expect(mocks.recordExactProviderReachability).not.toHaveBeenCalled()
}

function expectTransportCollisionPersisted(
    phase: 'live' | 'sync' | 'import',
    incomingConnectionId: string,
    existingConnectionId: string | null = STORED_CONNECTION_ID,
) {
    expect(mocks.patchExternalConversation).toHaveBeenCalledOnce()
    expect(mocks.patchExternalConversation).toHaveBeenCalledWith({
        contract: 'messaging.PatchExternalConversationCommand.v1',
        chatId: 'chat-owned-by-connection-a',
        patch: {
            metadata: expect.objectContaining({
                ...(existingConnectionId ? { connectionId: existingConnectionId } : {}),
                channelIdentityCollisionAudit: [expect.objectContaining({
                    channel: 'whatsapp',
                    reason: existingConnectionId ? 'transport_mismatch' : 'transport_unbound',
                    phase,
                    incomingConnectionId,
                    existingConnectionId,
                    externalChatId: CANONICAL_EXTERNAL_ID,
                    observedAt: expect.any(String),
                })],
            }),
        },
    })
    expect(mocks.markChannelIdentityConflict).toHaveBeenCalledOnce()
    expect(mocks.markChannelIdentityConflict).toHaveBeenCalledWith({
        contactId: 'contact-a',
        identityId: 'identity-a',
        channel: 'whatsapp',
        reason: existingConnectionId ? 'transport_mismatch' : 'transport_unbound',
        evidenceRoot: expect.stringMatching(
            new RegExp(`^channel-collision:whatsapp:chat-owned-by-connection-a:${existingConnectionId ? 'transport_mismatch' : 'transport_unbound'}:[a-f0-9]{64}$`),
        ),
        details: {
            phase,
            externalChatId: CANONICAL_EXTERNAL_ID,
            incomingConnectionId,
            existingConnectionId,
        },
    })
}

describe('WhatsApp private conversation connection ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clients.clear()
        mocks.clientGetChats.mockResolvedValue([])
        mocks.clientIsRegisteredUser.mockResolvedValue(true)
        mocks.clientSendMessage.mockResolvedValue({
            id: { _serialized: 'wa-outbound-1' },
            timestamp: Math.floor(Date.now() / 1000),
        })
        mocks.chatFindMany.mockResolvedValue([])
        mocks.chatFindUnique.mockResolvedValue(null)
        mocks.queryRaw.mockResolvedValue([{
            msg_count: 0n,
            chat_count: 0n,
            contact_count: 0n,
            min_date: null,
            max_date: null,
        }])
        mocks.whatsAppConnectionUpdate.mockResolvedValue({})
        mocks.registryGetEntry.mockReturnValue(null)
        mocks.registryBeginNewInstance.mockImplementation((connectionId: string) => `instance:${connectionId}`)
        mocks.registryIsCurrentInstance.mockReturnValue(true)
        mocks.registryGetAllEntries.mockReturnValue([])
        mocks.patchHistoryImportJob.mockResolvedValue({})
        mocks.isResolvedChannelContactResult.mockImplementation((value: unknown) => (
            Boolean(value && typeof value === 'object' && ['resolved', 'created', 'identity_reused'].includes(
                String((value as { status?: unknown }).status),
            ))
        ))
        mocks.resolveChannelContact.mockResolvedValue({
            status: 'resolved',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: { id: 'identity-1', externalId: PRIVATE_JID },
            isNew: false,
            warnings: [],
        })
        mocks.upsertChannelConversation.mockImplementation(async (command: {
            externalChatId: string
            metadata?: Record<string, unknown>
        }) => ({
            conversation: {
                id: 'chat-1',
                channel: 'whatsapp',
                chatType: 'private',
                externalChatId: command.externalChatId,
                contactId: null,
                contactIdentityId: null,
                metadata: command.metadata ?? {},
            },
        }))
        mocks.patchChannelConversation.mockImplementation(async (command: {
            selector: { chatId: string }
            patch: Record<string, unknown>
        }) => ({
            conversation: {
                id: command.selector.chatId,
                channel: 'whatsapp',
                chatType: 'private',
                externalChatId: CANONICAL_EXTERNAL_ID,
                contactId: null,
                contactIdentityId: null,
                metadata: { connectionId: INCOMING_CONNECTION_ID },
                ...command.patch,
            },
        }))
        mocks.ensureConversationContactLink.mockResolvedValue({ linked: true })
        mocks.markChannelIdentityConflict.mockResolvedValue(undefined)
        mocks.recordExactProviderReachability.mockResolvedValue({
            outcome: 'updated',
            identityId: 'identity-1',
            status: 'confirmed',
        })
        mocks.attachPhoneToIdentity.mockResolvedValue({ kind: 'exists_same_contact' })
        mocks.createChannelMessage.mockResolvedValue({ message: { id: 'message-1' } })
        mocks.emitMessageReceived.mockResolvedValue(undefined)
        mocks.whatsAppChatUpsert.mockResolvedValue({})
        mocks.whatsAppMessageUpsert.mockResolvedValue({})
        mocks.messageFindUnique.mockResolvedValue(null)
        mocks.messageFindFirst.mockResolvedValue(null)
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

    test('live ingress does not patch, link, or write through a private Chat owned by another connection', async () => {
        mocks.chatFindMany.mockResolvedValue([crossAccountConversation()])
        await initializeClient(INCOMING_CONNECTION_ID)

        const client = mocks.clients.get(INCOMING_CONNECTION_ID)
        const messageHandler = client?.handlers.get('message')
        expect(messageHandler).toBeTypeOf('function')

        await messageHandler?.({
            id: { _serialized: 'live-message-1' },
            from: PRIVATE_JID,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'do not cross accounts',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
        })

        expect(mocks.chatFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ channel: 'whatsapp' }),
        }))
        expect(mocks.opsLog).toHaveBeenCalledWith('warn', 'wa_conversation_transport_mismatch', expect.objectContaining({
            phase: 'live',
            conversationId: 'chat-owned-by-connection-a',
            storedConnectionId: STORED_CONNECTION_ID,
            incomingConnectionId: INCOMING_CONNECTION_ID,
        }))
        expectTransportCollisionPersisted('live', INCOMING_CONNECTION_ID)
        expectNoConversationWrites()
    })

    test('live ingress does not claim a private legacy Chat without concrete connection ownership', async () => {
        mocks.chatFindMany.mockResolvedValue([{
            ...crossAccountConversation(),
            metadata: {},
        }])
        await initializeClient(INCOMING_CONNECTION_ID)

        const client = mocks.clients.get(INCOMING_CONNECTION_ID)
        const messageHandler = client?.handlers.get('message')
        await messageHandler?.({
            id: { _serialized: 'live-message-unbound' },
            from: PRIVATE_JID,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'do not claim legacy history',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
        })

        expect(mocks.opsLog).toHaveBeenCalledWith(
            'warn',
            'wa_conversation_transport_mismatch',
            expect.objectContaining({
                phase: 'live',
                storedConnectionId: null,
                incomingConnectionId: INCOMING_CONNECTION_ID,
            }),
        )
        expectTransportCollisionPersisted('live', INCOMING_CONNECTION_ID, null)
        expectNoConversationWrites()
    })

    test('background sync skips a private Chat owned by another connection before any write', async () => {
        const chat = historyChat()
        mocks.clientGetChats.mockResolvedValue([chat])
        mocks.chatFindUnique.mockResolvedValue(crossAccountConversation())
        await initializeClient(`${INCOMING_CONNECTION_ID}-sync`)

        await forceSync(`${INCOMING_CONNECTION_ID}-sync`)

        expect(chat.fetchMessages).toHaveBeenCalledOnce()
        expect(mocks.chatFindUnique).toHaveBeenCalledWith({
            where: { externalChatId: CANONICAL_EXTERNAL_ID },
        })
        expect(mocks.opsLog).toHaveBeenCalledWith('warn', 'wa_conversation_transport_mismatch', expect.objectContaining({
            phase: 'sync',
            storedConnectionId: STORED_CONNECTION_ID,
            incomingConnectionId: `${INCOMING_CONNECTION_ID}-sync`,
        }))
        expectTransportCollisionPersisted('sync', `${INCOMING_CONNECTION_ID}-sync`)
        expectNoConversationWrites()
    })

    test('history import skips a private Chat owned by another connection before link or message writes', async () => {
        const importConnectionId = `${INCOMING_CONNECTION_ID}-import`
        const chat = historyChat()
        mocks.clientGetChats.mockResolvedValue([chat])
        mocks.chatFindUnique.mockResolvedValue(crossAccountConversation())
        await initializeClient(importConnectionId)

        await importWhatsAppHistory('history-job-1', 'available_history', undefined, importConnectionId)

        expect(chat.fetchMessages).toHaveBeenCalledOnce()
        expect(mocks.chatFindUnique).toHaveBeenCalledWith({
            where: { externalChatId: CANONICAL_EXTERNAL_ID },
        })
        expect(mocks.opsLog).toHaveBeenCalledWith('warn', 'wa_conversation_transport_mismatch', expect.objectContaining({
            phase: 'import',
            storedConnectionId: STORED_CONNECTION_ID,
            incomingConnectionId: importConnectionId,
        }))
        expectTransportCollisionPersisted('import', importConnectionId)
        expectNoConversationWrites()
    })

    test('normalizes the same phone JID to one ContactIdentity key', () => {
        expect(canonicalWhatsAppIdentityExternalIdV1('79990001122@c.us')).toBe(PRIVATE_JID)
        expect(canonicalWhatsAppIdentityExternalIdV1('89990001122@c.us')).toBe(PRIVATE_JID)
        expect(canonicalWhatsAppIdentityExternalIdV1('165313509372005@lid')).toBe('165313509372005@lid')
    })

    test('live ingress supplies canonical trusted phone-JID evidence to Contacts', async () => {
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'live-message-trusted-phone' },
            from: PRIVATE_JID,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'trusted phone jid',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
            notifyName: 'Contact',
        })

        expect(mocks.resolveChannelContact).toHaveBeenCalledWith(
            'whatsapp',
            PRIVATE_JID,
            '79990001122',
            'Contact',
            expect.objectContaining({
                providerAccountId: INCOMING_CONNECTION_ID,
                phoneEvidence: {
                    source: 'whatsapp_phone_jid',
                    trustedForAutomaticResolution: true,
                },
            }),
        )
        expect(mocks.ensureConversationContactLink).toHaveBeenCalledWith(expect.objectContaining({
            chatId: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
        }))
        expect(mocks.recordExactProviderReachability).toHaveBeenCalledWith({
            identityId: 'identity-1',
            contactId: 'contact-1',
            channel: 'whatsapp',
            providerAccountId: INCOMING_CONNECTION_ID,
            providerTargetId: PRIVATE_JID,
            status: 'confirmed',
        })
    })

    test('retains an observed LID and attaches the provider-proven phone JID as its exact alias', async () => {
        const lid = '165313509372005@lid'
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'live-message-resolved-lid' },
            from: lid,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'resolved lid',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
            notifyName: 'Contact',
            getContact: vi.fn().mockResolvedValue({ number: '79990001122' }),
        })

        expect(mocks.resolveChannelContact).toHaveBeenCalledWith(
            'whatsapp',
            lid,
            '79990001122',
            'Contact',
            expect.objectContaining({
                providerAccountId: INCOMING_CONNECTION_ID,
                phoneEvidence: {
                    source: 'whatsapp_phone_jid',
                    trustedForAutomaticResolution: true,
                },
            }),
        )
        expect(mocks.attachProviderIdentityAlias).toHaveBeenCalledWith({
            identityId: 'identity-1',
            channel: 'whatsapp',
            providerAccountId: INCOMING_CONNECTION_ID,
            aliasType: 'wa_phone_jid',
            aliasValue: PRIVATE_JID,
            provenance: 'whatsapp-web.js',
            evidenceRoot: `wa:${INCOMING_CONNECTION_ID}:${lid}:${PRIVATE_JID}`,
        })
        expect(mocks.upsertChannelConversation).toHaveBeenCalledWith(expect.objectContaining({
            externalChatId: CANONICAL_EXTERNAL_ID,
        }))
    })

    test('phone-first then resolved-LID reuses the phone identity and records only the LID alias', async () => {
        const lid = '165313509372005@lid'
        const phoneChat = {
            id: 'chat-phone-first',
            channel: 'whatsapp',
            chatType: 'private',
            externalChatId: CANONICAL_EXTERNAL_ID,
            contactId: 'contact-1',
            contactIdentityId: 'identity-phone',
            driverId: null,
            name: 'Contact',
            metadata: { connectionId: INCOMING_CONNECTION_ID },
        }
        mocks.chatFindMany.mockResolvedValue([phoneChat])
        mocks.patchChannelConversation.mockResolvedValue({ conversation: phoneChat })
        mocks.resolveChannelContact.mockResolvedValue({
            status: 'identity_reused',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: { id: 'identity-phone', externalId: PRIVATE_JID },
            isNew: false,
            warnings: [],
        })
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'lid-after-phone' },
            from: lid,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'same person',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
            getContact: vi.fn().mockResolvedValue({ number: '79990001122' }),
        })

        expect(mocks.resolveChannelContact).toHaveBeenCalledWith(
            'whatsapp',
            PRIVATE_JID,
            '79990001122',
            'Contact',
            expect.objectContaining({ providerAccountId: INCOMING_CONNECTION_ID }),
        )
        expect(mocks.attachProviderIdentityAlias).toHaveBeenCalledWith(expect.objectContaining({
            identityId: 'identity-phone',
            aliasType: 'wa_lid',
            aliasValue: lid,
        }))
        expect(mocks.upsertChannelConversation).not.toHaveBeenCalled()
    })

    test('resolved-LID first then phone-JID converges on one Chat and one LID primary', async () => {
        const lid = '165313509372005@lid'
        const canonicalChat = {
            id: 'chat-lid-first',
            channel: 'whatsapp',
            chatType: 'private',
            externalChatId: CANONICAL_EXTERNAL_ID,
            contactId: 'contact-1',
            contactIdentityId: 'identity-lid',
            driverId: null,
            name: 'Contact',
            metadata: { connectionId: INCOMING_CONNECTION_ID },
        }
        mocks.chatFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([canonicalChat])
        mocks.upsertChannelConversation.mockResolvedValue({ conversation: canonicalChat })
        mocks.patchChannelConversation.mockResolvedValue({ conversation: canonicalChat })
        mocks.resolveChannelContact.mockResolvedValue({
            status: 'identity_reused',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: { id: 'identity-lid', externalId: lid },
            isNew: false,
            warnings: [],
        })
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'lid-first' },
            from: lid,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'lid first',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
            getContact: vi.fn().mockResolvedValue({ number: '79990001122' }),
        })
        await handler?.({
            id: { _serialized: 'phone-second' },
            from: PRIVATE_JID,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'phone second',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
        })

        expect(mocks.upsertChannelConversation).toHaveBeenCalledTimes(1)
        expect(mocks.resolveChannelContact.mock.calls.map(call => call[1])).toEqual([
            lid,
            PRIVATE_JID,
        ])
        expect(mocks.ensureConversationContactLink).toHaveBeenCalledTimes(2)
        expect(mocks.ensureConversationContactLink).toHaveBeenNthCalledWith(2, expect.objectContaining({
            chatId: 'chat-lid-first',
            contactId: 'contact-1',
            contactIdentityId: 'identity-lid',
        }))
    })

    test('keeps a phone-like title display-only when an unresolved LID has no provider phone evidence', async () => {
        const lid = '165313509372005@lid'
        mocks.chatFindUnique.mockResolvedValue({
            id: 'chat-1',
            name: '+7 (922) 123-45-67',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
        })
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'live-message-unresolved-lid' },
            from: lid,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'unresolved lid',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
            notifyName: '+7 (922) 123-45-67',
            getContact: vi.fn().mockResolvedValue({ number: null }),
        })

        expect(mocks.resolveChannelContact).toHaveBeenCalledWith(
            'whatsapp',
            lid,
            null,
            '+7 (922) 123-45-67',
            expect.objectContaining({
                providerAccountId: INCOMING_CONNECTION_ID,
                phoneEvidence: null,
            }),
        )
        expect(mocks.attachPhoneToIdentity).not.toHaveBeenCalled()
        expect(mocks.attachProviderIdentityAlias).not.toHaveBeenCalled()
        expect(mocks.recordExactProviderReachability).toHaveBeenCalledWith(expect.objectContaining({
            providerTargetId: lid,
            status: 'confirmed',
        }))
    })

    test('outbound LID delivery never suffix-resolves or mutates a colliding phone Chat', async () => {
        const lid = '165313509372005@lid'
        await initializeClient(INCOMING_CONNECTION_ID)
        vi.clearAllMocks()
        mocks.clientSendMessage.mockResolvedValue({
            id: { _serialized: 'wa-outbound-lid' },
            timestamp: Math.floor(Date.now() / 1000),
        })
        mocks.whatsAppChatUpsert.mockResolvedValue({})
        mocks.whatsAppMessageUpsert.mockResolvedValue({})

        await expect(sendMessage(INCOMING_CONNECTION_ID, lid, 'exact opaque peer'))
            .resolves.toEqual({ externalId: 'wa-outbound-lid' })

        expect(mocks.clientSendMessage).toHaveBeenCalledWith(
            INCOMING_CONNECTION_ID,
            lid,
            'exact opaque peer',
            {},
        )
        expect(mocks.chatFindMany).not.toHaveBeenCalled()
        expect(mocks.chatFindUnique).not.toHaveBeenCalled()
        expect(mocks.patchChannelConversation).not.toHaveBeenCalled()
        expect(mocks.patchMessageDelivery).not.toHaveBeenCalled()
        expect(mocks.createChannelMessage).not.toHaveBeenCalled()
    })

    test('does not record live reachability from an outbound echo', async () => {
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'live-message-outbound' },
            from: '79990009999@c.us',
            to: PRIVATE_JID,
            fromMe: true,
            body: 'manager outbound echo',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
        })

        expect(mocks.ensureConversationContactLink).toHaveBeenCalledOnce()
        expect(mocks.recordExactProviderReachability).not.toHaveBeenCalled()
    })

    test('does not record live reachability from a group-room message', async () => {
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'live-message-group' },
            from: '120363000000000000@g.us',
            to: '79990009999@c.us',
            author: PRIVATE_JID,
            fromMe: false,
            body: 'group inbound',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
            getChat: vi.fn().mockResolvedValue({ name: 'Dispatch group' }),
        })

        expect(mocks.resolveChannelContact).not.toHaveBeenCalled()
        expect(mocks.ensureConversationContactLink).not.toHaveBeenCalled()
        expect(mocks.recordExactProviderReachability).not.toHaveBeenCalled()
    })

    test('does not record live reachability when persisted Chat candidates are ambiguous', async () => {
        mocks.chatFindMany.mockResolvedValue([
            {
                id: 'chat-phone',
                externalChatId: CANONICAL_EXTERNAL_ID,
                metadata: { connectionId: INCOMING_CONNECTION_ID },
            },
            {
                id: 'chat-legacy',
                externalChatId: PRIVATE_JID,
                metadata: { connectionId: INCOMING_CONNECTION_ID },
            },
        ])
        await initializeClient(INCOMING_CONNECTION_ID)
        const handler = mocks.clients.get(INCOMING_CONNECTION_ID)?.handlers.get('message')

        await handler?.({
            id: { _serialized: 'live-message-ambiguous' },
            from: PRIVATE_JID,
            to: '79990009999@c.us',
            fromMe: false,
            body: 'ambiguous chat mapping',
            timestamp: Math.floor(Date.now() / 1000),
            type: 'chat',
            hasMedia: false,
        })

        expect(mocks.resolveChannelContact).not.toHaveBeenCalled()
        expect(mocks.ensureConversationContactLink).not.toHaveBeenCalled()
        expect(mocks.recordExactProviderReachability).not.toHaveBeenCalled()
    })

    test('sync and import use the same canonical phone-JID identity key and trusted evidence', async () => {
        const syncConnectionId = `${INCOMING_CONNECTION_ID}-sync-canonical`
        const importConnectionId = `${INCOMING_CONNECTION_ID}-import-canonical`
        const chat = historyChat()
        mocks.clientGetChats.mockResolvedValue([chat])
        await initializeClient(syncConnectionId)
        await forceSync(syncConnectionId)
        await initializeClient(importConnectionId)
        await importWhatsAppHistory('history-job-canonical', 'available_history', undefined, importConnectionId)

        const calls = mocks.resolveChannelContact.mock.calls.filter(call => call[0] === 'whatsapp')
        expect(calls).toEqual(expect.arrayContaining([
            expect.arrayContaining([
                'whatsapp',
                PRIVATE_JID,
                '79990001122',
                'Existing private chat',
                expect.objectContaining({
                    providerAccountId: syncConnectionId,
                    phoneEvidence: {
                        source: 'whatsapp_phone_jid',
                        trustedForAutomaticResolution: true,
                    },
                }),
            ]),
            expect.arrayContaining([
                'whatsapp',
                PRIVATE_JID,
                '79990001122',
                'Existing private chat',
                expect.objectContaining({
                    providerAccountId: importConnectionId,
                    phoneEvidence: {
                        source: 'whatsapp_phone_jid',
                        trustedForAutomaticResolution: true,
                    },
                }),
            ]),
        ]))
        expect(mocks.recordExactProviderReachability).not.toHaveBeenCalled()
    })

    test.each([
        { reachable: true, confirmed: true },
        { reachable: false, confirmed: false },
    ])('returns exact provider evidence for a definitive reachability result %#', async ({ reachable, confirmed }) => {
        const connectionId = `${INCOMING_CONNECTION_ID}-reachability-${String(reachable)}`
        mocks.clientIsRegisteredUser.mockResolvedValueOnce(reachable)
        await initializeClient(connectionId)

        await expect(checkReachability('8 (999) 000-11-22', connectionId)).resolves.toMatchObject({
            reachable,
            confirmed,
            providerAccountId: connectionId,
            providerTargetId: PRIVATE_JID,
        })
        expect(mocks.clientIsRegisteredUser).toHaveBeenCalledWith(connectionId, PRIVATE_JID)
    })
})
