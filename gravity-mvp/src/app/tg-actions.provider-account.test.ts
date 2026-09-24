/**
 * M2A2-TG2A runtime and ceremony wiring proof for tg-actions.
 *
 * Telegram availability must never depend on the provider-account foundation,
 * the locator must always come from the transport record, and the admission
 * ceremony must be the only synchronous path.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    clients: [] as Array<{ connected: boolean }>,
    telegramConnectionFindMany: vi.fn(),
    telegramConnectionFindUnique: vi.fn(),
    telegramConnectionUpsert: vi.fn(),
    telegramConnectionCount: vi.fn(),
    beginNewInstance: vi.fn((connectionId: string) => `instance:${connectionId}`),
    recordObserved: vi.fn(),
    admitAccount: vi.fn(),
    describeAccount: vi.fn(),
    requireAdmin: vi.fn(),
    providerAccountId: '7000',
    signIn: vi.fn(),
}))

vi.mock('telegram', () => ({
    TelegramClient: class MockTelegramClient {
        connected = true
        session = { save: () => 'session' }
        constructor() { mocks.clients.push(this) }
        async connect() {}
        async disconnect() {}
        async isUserAuthorized() { return true }
        async getMe() { return { id: BigInt(mocks.providerAccountId) } }
        async signInUserWithQrCode(auth: unknown, callbacks: { qrCode: (code: { token: Buffer; expires: number }) => Promise<void> }) {
            return mocks.signIn(callbacks)
        }
        addEventHandler() {}
        async getDialogs() { return [] }
        async getMessages() { return [] }
    },
    Api: {
        UpdateMessageReactions: class {},
        ReactionEmoji: class {},
        messages: { SendReaction: class {} },
        contacts: { ImportContacts: class {} },
        InputPhoneContact: class {},
    },
}))
vi.mock('telegram/sessions', () => ({ StringSession: class { save() { return 'session' } } }))
vi.mock('telegram/client/uploads', () => ({ CustomFile: class {} }))
vi.mock('telegram/events', () => ({ NewMessage: class {}, Raw: class {} }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') } }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        telegramConnection: {
            findMany: mocks.telegramConnectionFindMany,
            findUnique: mocks.telegramConnectionFindUnique,
            upsert: mocks.telegramConnectionUpsert,
            count: mocks.telegramConnectionCount,
            update: vi.fn(),
        },
        message: { findFirst: vi.fn(), findUnique: vi.fn() },
        messageAttachment: { count: vi.fn(), findFirst: vi.fn() },
        chat: { findUnique: vi.fn() },
        $queryRaw: vi.fn(),
    },
}))

vi.mock('@/modules/messaging/public/v1/transport-registry-lifecycle', () => ({
    transportRegistryLifecycleV1: {
        ensureEntry: vi.fn(),
        beginNewInstance: mocks.beginNewInstance,
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
    appendConversationIdentityCollisionV1: vi.fn(),
    attachBinaryMessageMediaV1: vi.fn(),
    attachMessageMediaV1: vi.fn(),
    createChannelMessageV1: vi.fn(),
    deleteConversationsByIdV1: vi.fn(),
    deleteHistoryImportJobsForChannelV1: vi.fn(),
    deleteHistoryImportJobsForConnectionV1: vi.fn(),
    ensureConversationContactLinkV1: vi.fn(),
    patchChannelConversationV1: vi.fn(),
    patchHistoryImportJobV1: vi.fn(),
    patchMessageDeliveryV1: vi.fn(),
    patchMessageMetadataV1: vi.fn(),
    prepareOutboundConversationV1: vi.fn(),
    upsertChannelConversationV1: vi.fn(),
}))
vi.mock('@/modules/contacts/public/v1', () => ({
    cleanupDanglingContactIdentitiesV1: vi.fn(),
    isResolvedChannelContactResultV1: vi.fn(),
    markChannelIdentityConflictV1: vi.fn(),
    resolveChannelContactOperationV1: vi.fn(),
}))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: vi.fn() },
}))
vi.mock('@/modules/messaging/public/v1/persisted-message-ingress', () => ({ publishPersistedMessageV1: vi.fn() }))
vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
    channelConversationWorkflowV1: { onInboundMessage: vi.fn() },
}))
vi.mock('@/modules/telegram-channel/public/v1/telegram-connection-public-metadata', () => ({
    projectTelegramConnectionMetadata: vi.fn(value => value),
}))
vi.mock('@/modules/telegram-channel/public/v1', () => ({
    getTelegramTransportOptionsV1: () => ({ options: {}, label: null }),
}))
vi.mock('@/modules/identity-access/public/v1', () => ({ requireIntegrationAdminAccess: mocks.requireAdmin }))
vi.mock('@/modules/telegram-channel/internal/provider-account/telegram-account-intake', () => ({
    recordObservedAttestationV1: mocks.recordObserved,
    admitTelegramProviderAccountV1: mocks.admitAccount,
    describeTelegramProviderAccountV1: mocks.describeAccount,
}))

/** The transport record id is deliberately NOT the provider principal. */
const CONNECTION_ID = 'conn-row-1'
const PRINCIPAL = 'identity-access:integration-admin-session'

function connectionRecord(id = CONNECTION_ID) {
    return { id, apiId: 123, apiHash: 'hash', sessionString: 'session', isActive: true, name: id }
}

async function freshActions() {
    vi.resetModules()
    return await import('./tg-actions')
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.recordObserved.mockImplementation(() => undefined)
    mocks.clients.length = 0
    mocks.providerAccountId = '7000'
    mocks.requireAdmin.mockResolvedValue({ id: PRINCIPAL, kind: 'integration_admin_session' })
    mocks.telegramConnectionFindMany.mockResolvedValue([connectionRecord()])
    mocks.telegramConnectionFindUnique.mockResolvedValue(connectionRecord())
    mocks.telegramConnectionCount.mockResolvedValue(0)
    mocks.telegramConnectionUpsert.mockResolvedValue({ id: '7000' })
    mocks.admitAccount.mockResolvedValue({ status: 'admitted', reason: 'admitted' })
    mocks.describeAccount.mockResolvedValue({
        available: true, providerAccountId: 'account-1', accountKind: 'mtproto_user',
        lifecycle: 'pending_approval', readiness: 'not_admitted',
    })
    mocks.beginNewInstance.mockImplementation((connectionId: string) => `instance:${connectionId}`)
    mocks.signIn.mockImplementation(async (callbacks: { qrCode: (code: { token: Buffer; expires: number }) => Promise<void> }) => {
        await callbacks.qrCode({ token: Buffer.from('qr'), expires: 60 })
        return { id: BigInt(mocks.providerAccountId) }
    })
})

afterEach(async () => {
    const actions = await import('./tg-actions')
    await actions.stopTelegramHealthCheck()
})

describe('runtime observation', () => {
    test('records one attestation with the locator taken from the transport record', async () => {
        const actions = await freshActions()
        await actions.initTelegramListeners()

        expect(mocks.recordObserved).toHaveBeenCalledTimes(1)
        const observed = mocks.recordObserved.mock.calls[0][0]
        expect(observed).toEqual({
            transportKind: 'mtproto_session',
            transportRef: CONNECTION_ID,
            accountKind: 'mtproto_user',
            providerUserId: '7000',
            attestingInstanceId: `instance:${CONNECTION_ID}`,
        })
        expect(observed.transportRef).not.toBe(observed.providerUserId)
    })

    test('a foundation failure cannot reach the Telegram runtime', async () => {
        // A throwing intake must not escape the attestation boundary. The probe
        // is a path that does NOT swallow a client failure of its own, so the
        // assertion fails if the throw reaches getTelegramClient.
        mocks.recordObserved.mockImplementation(() => { throw new Error('foundation down') })
        const actions = await freshActions()

        await expect(actions.initTelegramListeners()).resolves.toBeUndefined()
        const admission = await actions.admitTelegramProviderAccount(CONNECTION_ID)

        expect(mocks.recordObserved).toHaveBeenCalled()
        expect(admission).toEqual({ status: 'admitted', reason: 'admitted' })
        expect(mocks.admitAccount).toHaveBeenCalledTimes(1)
    })

    test('the same principal after a reconnect keeps attesting without an error', async () => {
        const actions = await freshActions()
        await actions.initTelegramListeners()
        await actions.resumeTelegramConnection(CONNECTION_ID, false)

        expect(mocks.recordObserved.mock.calls.length).toBeGreaterThanOrEqual(2)
        const principals = new Set(mocks.recordObserved.mock.calls.map(call => call[0].providerUserId))
        expect([...principals]).toEqual(['7000'])
    })

    test('the same principal after a process restart attests again from a fresh instance', async () => {
        const first = await freshActions()
        await first.initTelegramListeners()
        const firstInstance = mocks.recordObserved.mock.calls[0][0].attestingInstanceId

        mocks.recordObserved.mockClear()
        const second = await freshActions()
        await second.initTelegramListeners()

        expect(mocks.recordObserved).toHaveBeenCalledTimes(1)
        const observed = mocks.recordObserved.mock.calls[0][0]
        expect(observed.providerUserId).toBe('7000')
        expect(observed.transportRef).toBe(CONNECTION_ID)
        expect(firstInstance).toBe(`instance:${CONNECTION_ID}`)
    })

    test('a changed principal fails closed and is never attested', async () => {
        const actions = await freshActions()
        await actions.initTelegramListeners()
        mocks.recordObserved.mockClear()

        mocks.providerAccountId = '9999'
        await actions.resumeTelegramConnection(CONNECTION_ID, false)

        expect(mocks.recordObserved).not.toHaveBeenCalled()
    })

    test('an unknown runtime instance falls back to a process identity, never to a placeholder', async () => {
        mocks.beginNewInstance.mockImplementation(() => undefined as unknown as string)
        const actions = await freshActions()
        await actions.initTelegramListeners()

        const observed = mocks.recordObserved.mock.calls[0][0]
        expect(observed.attestingInstanceId).toMatch(/^process:[0-9a-f-]{36}$/)
    })

    test('concurrent observations on different transports are all recorded', async () => {
        mocks.telegramConnectionFindMany.mockResolvedValue([connectionRecord('conn-a'), connectionRecord('conn-b')])
        mocks.telegramConnectionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => connectionRecord(where.id))
        const actions = await freshActions()
        await Promise.all([
            actions.resumeTelegramConnection('conn-a', false),
            actions.resumeTelegramConnection('conn-b', false),
        ])

        const refs = mocks.recordObserved.mock.calls.map(call => call[0].transportRef).sort()
        expect(refs).toEqual(['conn-a', 'conn-b'])
    })
})

describe('login admission ceremony', () => {
    async function completeLogin(actions: Awaited<ReturnType<typeof freshActions>>) {
        const { loginId } = await actions.getTelegramAuthQR(123, 'hash')
        await new Promise(resolve => setTimeout(resolve, 10))
        return await actions.checkTelegramAuthStatus(loginId)
    }

    test('admits synchronously with the persisted record id and both live observations', async () => {
        mocks.telegramConnectionUpsert.mockResolvedValue({ id: 'persisted-row' })
        const actions = await freshActions()
        const result = await completeLogin(actions)

        expect(result).toMatchObject({ status: 'success', accountAdmission: 'admitted' })
        expect(mocks.admitAccount).toHaveBeenCalledTimes(1)
        const [input, principalId] = mocks.admitAccount.mock.calls[0]
        expect(input).toMatchObject({
            transportKind: 'mtproto_session',
            transportRef: 'persisted-row',
            accountKind: 'mtproto_user',
            providerUserId: '7000',
            previouslyObservedProviderUserId: '7000',
        })
        expect(principalId).toBe(PRINCIPAL)
    })

    test('the login still succeeds when the attestation cannot commit', async () => {
        mocks.admitAccount.mockResolvedValue({ status: 'unavailable', reason: 'attestation_unavailable' })
        const actions = await freshActions()
        const result = await completeLogin(actions)

        expect(result).toMatchObject({ status: 'success', accountAdmission: 'unavailable' })
    })

    test('a proven pending account is reported as pending, never as admitted', async () => {
        mocks.admitAccount.mockResolvedValue({ status: 'pending_approval', reason: 'admission_unavailable' })
        const actions = await freshActions()
        const result = await completeLogin(actions)

        expect(result).toMatchObject({ status: 'success', accountAdmission: 'pending_approval' })
    })

    test('skips admission when the persisted record carries no id, never falling back to the principal', async () => {
        mocks.telegramConnectionUpsert.mockResolvedValue({})
        const actions = await freshActions()
        const result = await completeLogin(actions)

        expect(result).toMatchObject({ status: 'success', accountAdmission: 'unavailable', accountAdmissionReason: 'transport_unavailable' })
        expect(mocks.admitAccount).not.toHaveBeenCalled()
    })

    test('a thrown ceremony never breaks the login', async () => {
        mocks.admitAccount.mockRejectedValue(new Error('foundation down'))
        const actions = await freshActions()
        const result = await completeLogin(actions)

        expect(result).toMatchObject({ status: 'success', accountAdmission: 'unavailable' })
    })
})

describe('explicit admission for an existing session', () => {
    test('takes a fresh live principal and admits through the ceremony', async () => {
        const actions = await freshActions()
        const result = await actions.admitTelegramProviderAccount(CONNECTION_ID)

        expect(result).toEqual({ status: 'admitted', reason: 'admitted' })
        expect(mocks.admitAccount).toHaveBeenCalledTimes(1)
        const [input] = mocks.admitAccount.mock.calls[0]
        expect(input).toMatchObject({
            transportRef: CONNECTION_ID,
            providerUserId: '7000',
            previouslyObservedProviderUserId: null,
        })
        expect(mocks.clients.length).toBeGreaterThan(0)
    })

    test('never admits from a stored projection alone', async () => {
        const actions = await freshActions()
        await actions.getTelegramProviderAccountState(CONNECTION_ID)

        expect(mocks.describeAccount).toHaveBeenCalledWith('mtproto_session', CONNECTION_ID)
        expect(mocks.admitAccount).not.toHaveBeenCalled()
    })

    test('refuses a transport that is not active', async () => {
        mocks.telegramConnectionFindUnique.mockResolvedValue({ ...connectionRecord(), isActive: false })
        const actions = await freshActions()
        const result = await actions.admitTelegramProviderAccount(CONNECTION_ID)

        expect(result).toEqual({ status: 'unavailable', reason: 'transport_unavailable' })
        expect(mocks.admitAccount).not.toHaveBeenCalled()
    })

    test('rejects an unauthenticated caller before touching the foundation', async () => {
        mocks.requireAdmin.mockRejectedValue(new Error('integration_admin_auth_required'))
        const actions = await freshActions()

        await expect(actions.admitTelegramProviderAccount(CONNECTION_ID)).rejects.toThrow('integration_admin_auth_required')
        await expect(actions.getTelegramProviderAccountState(CONNECTION_ID)).rejects.toThrow('integration_admin_auth_required')
        expect(mocks.admitAccount).not.toHaveBeenCalled()
        expect(mocks.describeAccount).not.toHaveBeenCalled()
    })
})
