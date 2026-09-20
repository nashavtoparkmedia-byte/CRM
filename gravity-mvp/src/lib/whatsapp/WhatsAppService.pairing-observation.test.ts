import { beforeEach, describe, expect, test, vi } from 'vitest'

type EventHandler = (...args: unknown[]) => unknown

const CONNECTION_ID = 'cpairingobservationslot01'

const mocks = vi.hoisted(() => {
    // The history sync that ready starts is outside this test; mark it as already done
    // before WhatsAppService creates its process-wide guard.
    ;(globalThis as unknown as { _waSyncDone?: Set<string> })._waSyncDone = new Set(['cpairingobservationslot01'])
    const order: string[] = []
    return {
        order,
        clients: new Map<string, { handlers: Map<string, EventHandler> }>(),
        observe: vi.fn((request: { event: string }) => { order.push(`observe:${request.event}`) }),
        connectionUpdate: vi.fn(async (args: { data: Record<string, unknown> }) => {
            order.push(`db:${Object.keys(args.data).sort().join('+')}`)
            return {}
        }),
        opsLog: vi.fn((_level: string, event: string) => { order.push(`log:${event}`) }),
        registryIsCurrentInstance: vi.fn(() => true),
        registrySetReady: vi.fn(() => { order.push('registry:setReady') }),
        registrySetFailed: vi.fn(() => { order.push('registry:setFailed') }),
        registrySetReconnecting: vi.fn(() => { order.push('registry:setReconnecting') }),
        registryScheduleReconnect: vi.fn(() => { order.push('registry:scheduleReconnect') }),
        publishPendingQr: vi.fn(() => { order.push('qr:publish') }),
        clearPendingQr: vi.fn(),
        recordAttestation: vi.fn(() => { order.push('account:record') }),
    }
})

vi.mock('whatsapp-web.js', () => {
    class LocalAuth {
        clientId: string
        constructor(options: { clientId: string }) {
            this.clientId = options.clientId
        }
    }
    class Client {
        handlers = new Map<string, EventHandler>()
        info = { wid: { server: 'c.us', user: '70000000001' } }
        pupPage = { isClosed: () => false, evaluate: vi.fn().mockResolvedValue('{"session":"stub"}') }
        constructor(options: { authStrategy: LocalAuth }) {
            mocks.clients.set(options.authStrategy.clientId, this)
        }
        on(event: string, handler: EventHandler) {
            this.handlers.set(event, handler)
            return this
        }
        async initialize() {}
        async destroy() {}
        removeAllListeners() { this.handlers.clear() }
    }
    class MessageMedia {}
    return { Client, LocalAuth, MessageMedia }
})

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') } }))

vi.mock('@/lib/prisma', () => ({
    prisma: { whatsAppConnection: { update: mocks.connectionUpdate } },
}))

vi.mock('@/modules/whatsapp-channel/internal/company-account/whatsapp-account-intake', () => ({
    recordObservedAttestationV1: mocks.recordAttestation,
}))

vi.mock('@/modules/messaging/public/v1', () => ({
    attachMessageMediaV1: vi.fn(),
    createChannelMessageV1: vi.fn(),
    ensureConversationContactLinkV1: vi.fn(),
    linkMatchedDriverToConversationCapabilityV1: Symbol('link-matched-driver'),
    patchChannelConversationV1: vi.fn(),
    appendConversationIdentityCollisionV1: vi.fn(),
    patchHistoryImportJobV1: vi.fn(),
    patchMessageDeliveryV1: vi.fn(),
    upsertChannelConversationV1: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    attachPhoneToIdentityV1: vi.fn(),
    attachProviderIdentityAliasV1: vi.fn(),
    isResolvedChannelContactResultV1: vi.fn(),
    resolveChannelContactOperationV1: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: vi.fn() },
}))

vi.mock('@/modules/fleet-operations/public/v1/channel-driver-match', () => ({
    channelDriverMatchV1: { linkChatToDriver: vi.fn() },
}))

vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
    channelConversationWorkflowV1: { onOutboundMessage: vi.fn(), onInboundMessage: vi.fn() },
}))

vi.mock('@/modules/messaging/public/v1/persisted-message-ingress', () => ({
    publishPersistedMessageV1: vi.fn(),
}))

vi.mock('@/modules/messaging/public/v1/message-stream', () => ({
    broadcastChatMessageV1: vi.fn(),
}))

vi.mock('@/modules/messaging/public/v1/transport-registry-lifecycle', () => ({
    transportRegistryLifecycleV1: {
        ensureEntry: vi.fn(),
        getEntry: vi.fn(() => undefined),
        beginNewInstance: vi.fn(() => 'instance-under-test'),
        isCurrentInstance: mocks.registryIsCurrentInstance,
        touch: vi.fn(),
        setReady: mocks.registrySetReady,
        setFailed: mocks.registrySetFailed,
        setReconnecting: mocks.registrySetReconnecting,
        setStopped: vi.fn(),
        scheduleReconnect: mocks.registryScheduleReconnect,
        getAllEntries: vi.fn(() => []),
        getInstanceId: vi.fn(),
        touchLastSeen: vi.fn(),
    },
}))

vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.opsLog,
}))

vi.mock('@/lib/whatsapp/WhatsAppCleanup', () => ({
    WWEBJS_AUTH_DIR: '/tmp/wa-pairing-observation-test-auth',
    cleanupStaleWhatsAppSessions: vi.fn(),
}))

vi.mock('./whatsapp-qr-ceremony', () => ({
    clearPendingWhatsAppQr: mocks.clearPendingQr,
    publishPendingWhatsAppQr: mocks.publishPendingQr,
}))

vi.mock('@/modules/whatsapp-channel/internal/pairing-observation/whatsapp-pairing-observer', () => ({
    observeWhatsAppPairingV1: mocks.observe,
}))

import { initializeClient } from './WhatsAppService'

type ObservationRequest = { event: string; connectionId: string; instanceId: string; client: unknown; isCurrentInstance: () => boolean; disconnectReason?: unknown; recordAttestation?: (observed: unknown) => void }

async function startedClient() {
    await initializeClient(CONNECTION_ID)
    const client = mocks.clients.get(CONNECTION_ID)
    if (!client) throw new Error('client was not created')
    return client
}

function lastRequest(): ObservationRequest {
    return mocks.observe.mock.calls.at(-1)![0] as unknown as ObservationRequest
}

describe('WhatsApp pairing observation hooks', () => {
    beforeEach(() => {
        mocks.order.length = 0
        mocks.observe.mockClear()
        mocks.registryIsCurrentInstance.mockReturnValue(true)
    })

    test('ready calls the observer once, after every existing ready transition, with a live instance check', async () => {
        const client = await startedClient()
        mocks.order.length = 0
        await client.handlers.get('ready')!()
        expect(mocks.order).toEqual([
            'registry:setReady',
            'log:wa_ready',
            'db:phoneNumber+status',
            'db:sessionData',
            'log:wa_sync_skipped_already_done',
            'observe:ready',
        ])
        expect(mocks.observe).toHaveBeenCalledTimes(1)
        const request = lastRequest()
        expect(request).toMatchObject({ event: 'ready', connectionId: CONNECTION_ID, instanceId: 'instance-under-test' })
        expect(request.client).toBe(client)
        expect(request.isCurrentInstance()).toBe(true)
    })

    test('qr calls the observer after the QR is published and the status written', async () => {
        const client = await startedClient()
        mocks.order.length = 0
        await client.handlers.get('qr')!('qr-payload')
        expect(mocks.order).toEqual(['log:wa_qr_received', 'qr:publish', 'db:sessionData+status', 'observe:qr'])
        expect(lastRequest()).toMatchObject({ event: 'qr', connectionId: CONNECTION_ID })
    })

    test('disconnected calls the observer after the reconnect decision, and the instance is then stale', async () => {
        const client = await startedClient()
        mocks.order.length = 0
        await client.handlers.get('disconnected')!('NAVIGATION')
        expect(mocks.order).toEqual([
            'db:status',
            'registry:setReconnecting',
            'registry:scheduleReconnect',
            'observe:disconnected',
        ])
        const request = lastRequest()
        expect(request).toMatchObject({ event: 'disconnected', disconnectReason: 'NAVIGATION' })
        expect(request.isCurrentInstance()).toBe(false)

        const logoutClient = await startedClient()
        mocks.order.length = 0
        await logoutClient.handlers.get('disconnected')!('LOGOUT')
        expect(mocks.order).toEqual(['db:status', 'registry:setFailed', 'observe:disconnected'])
    })

    test('a superseded instance never reaches the observer', async () => {
        const client = await startedClient()
        mocks.registryIsCurrentInstance.mockReturnValue(false)
        await client.handlers.get('qr')!('qr-payload')
        await client.handlers.get('ready')!()
        await client.handlers.get('disconnected')!('LOGOUT')
        expect(mocks.observe).not.toHaveBeenCalled()
    })

    test('the runtime hands the company-account sink to the observer, and never calls it itself', async () => {
        const client = await startedClient()
        mocks.order.length = 0
        await client.handlers.get('ready')!()
        const request = lastRequest()
        // The runtime supplies the sink; only the observer decides when a complete
        // observation exists, so the runtime must never invoke it directly.
        expect(request.recordAttestation).toBe(mocks.recordAttestation)
        expect(mocks.recordAttestation).not.toHaveBeenCalled()
        expect(mocks.order).not.toContain('account:record')
    })

    test('the handlers do not wait for the observer', async () => {
        const client = await startedClient()
        mocks.observe.mockImplementationOnce(() => new Promise(() => undefined) as unknown as undefined)
        const settled = await Promise.race([
            Promise.resolve(client.handlers.get('ready')!()).then(() => 'handler-returned'),
            new Promise((resolve) => setTimeout(() => resolve('handler-blocked'), 200)),
        ])
        expect(settled).toBe('handler-returned')
        expect(mocks.observe).toHaveBeenCalledTimes(1)
    })
})
