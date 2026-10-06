import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// S1 — shared retry safety for every messaging channel.
//
// One send intent is one Message row. An outcome that follows a possible
// dispatch without proof that nothing was dispatched is unknown, and nothing
// sends an unknown row again: not the retry job, not stuck-row recovery, not the
// operator's «Повторить». A provider id another row owns is never reassigned.
//
// The Message store below is a stateful stand-in for Prisma with the three
// unique keys these guarantees rest on (`id`, `clientMessageId`, `externalId`:
// a violating write fails with P2002 and Prisma's meta.target), and with
// updateMany as a compare-and-set on its where clause. Every adapter counts its
// physical sends; a test passes only if that count is exactly what one intent
// may cost.

// A loose stand-in for Prisma's untyped row and argument shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdate: vi.fn(),
    waSendText: vi.fn(),
    tgSendText: vi.fn(),
    maxSendText: vi.fn(),
    onOutboundMessage: vi.fn(),
    recordReachability: vi.fn(),
    broadcast: vi.fn(),
    opsLog: vi.fn(),
    store: new Map<string, Row>(),
    creates: [] as Row[],
}))

const UNIQUE_KEYS = ['id', 'clientMessageId', 'externalId'] as const

function clone<T>(value: T): T {
    if (value === undefined) return value
    if (value instanceof Date) return new Date(value.getTime()) as T
    return JSON.parse(JSON.stringify(value), (key, v) => (
        (key === 'sentAt' || key === 'updatedAt') && typeof v === 'string' ? new Date(v) : v
    ))
}

function pick(row: Row, select?: Record<string, boolean>): Row {
    if (!select) return clone(row)
    return Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, clone(row[key])]))
}

function touch(row: Row) {
    const previous = row.updatedAt instanceof Date ? row.updatedAt.getTime() : 0
    row.updatedAt = new Date(Math.max(Date.now(), previous + 1))
}

function uniqueViolation(field: string): Error {
    return Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), {
        code: 'P2002',
        meta: { modelName: 'Message', target: [field] },
    })
}

function assertUnique(candidate: Row, selfId: string | null) {
    for (const key of UNIQUE_KEYS) {
        const value = candidate[key]
        if (value === null || value === undefined) continue
        const owner = [...mocks.store.values()].find(row => row.id !== selfId && row[key] === value)
        if (owner) throw uniqueViolation(key)
    }
}

function fieldMatches(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime()
    if (expected && typeof expected === 'object') {
        const condition = expected as Row
        if ('lt' in condition) return actual instanceof Date && actual.getTime() < condition.lt.getTime()
        if ('not' in condition) return actual !== condition.not
        if ('path' in condition) return ((actual as Row | null) ?? {})[condition.path[0]] === condition.equals
    }
    return actual === expected
}

function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => (
        key === 'OR'
            ? (expected as Row[]).some(arm => matches(row, arm))
            : fieldMatches(row[key], expected)
    ))
}

function applyData(row: Row, data: Row) {
    const next = { ...row }
    for (const [key, value] of Object.entries(data)) if (value !== undefined) next[key] = clone(value)
    assertUnique(next, row.id)
    Object.assign(row, next)
    touch(row)
}

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: mocks.chatFindUnique,
            update: mocks.chatUpdate,
        },
        message: {
            async findUnique({ where, select, include }: Row) {
                const [key, value] = Object.entries(where)[0]
                const row = [...mocks.store.values()].find(r => r[key] === value)
                if (!row) return null
                const copy = pick(row, select)
                if (include?.chat) copy.chat = await mocks.chatFindUnique({ where: { id: row.chatId } })
                return copy
            },
            async findFirst() { return null },
            async findMany({ where, select }: Row) {
                return [...mocks.store.values()].filter(row => matches(row, where)).map(row => pick(row, select))
            },
            async create({ data }: Row) {
                const row: Row = { externalId: null, metadata: {}, type: 'text', ...clone(data) }
                assertUnique(row, null)
                touch(row)
                mocks.store.set(row.id, row)
                mocks.creates.push(clone(row))
                return clone(row)
            },
            async update({ where, data }: Row) {
                const row = mocks.store.get(where.id)
                if (!row) throw new Error('Record to update not found')
                applyData(row, data)
                return clone(row)
            },
            async updateMany({ where, data }: Row) {
                const rows = [...mocks.store.values()].filter(row => matches(row, where))
                for (const row of rows) applyData(row, data)
                return { count: rows.length }
            },
        },
        // The unattended job's candidate SQL, made as permissive as possible:
        // every failed outbound row. What the real SQL selects is proven against
        // PostgreSQL in delivery-recovery-operations.postgres.test.ts; here the
        // owner's own gate must hold even if a selection let a row through.
        async $queryRaw() {
            return [...mocks.store.values()]
                .filter(row => row.status === 'failed' && row.direction === 'outbound')
                .map(row => ({ id: row.id }))
        },
    },
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: mocks.onOutboundMessage },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.opsLog }))
vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({ buildCanonicalContactSummary: vi.fn() }))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: mocks.recordReachability },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: mocks.broadcast }))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.waSendText }),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.tgSendText }),
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: vi.fn(), sendText: mocks.maxSendText }),
}))

import { MessageService, isSafeToRedeliver } from '@/lib/MessageService'
import {
    registerOutboundConversationPreparerV1,
    type OutboundConversationChannelV1,
    type OutboundConversationSnapshotV1,
} from './outbound-conversation-identity-runtime'
import { recoverStuckMessagingDeliveriesV1, retryEligibleMessagingDeliveriesV1 } from './delivery-recovery-operations'
import { retryFailedOutboundMessageV1 } from './operator-delivery-retry'

type Channel = OutboundConversationChannelV1

const CHATS: Record<Channel, Row> = {
    whatsapp: { id: 'chat-wa', channel: 'whatsapp', externalChatId: '79000000001@c.us', chatType: 'private', contactId: 'contact-wa', contactIdentityId: 'identity-wa', driver: null, metadata: {} },
    telegram: { id: 'chat-tg', channel: 'telegram', externalChatId: 'telegram:4200', chatType: 'private', contactId: 'contact-tg', contactIdentityId: 'identity-tg', driver: null, metadata: {} },
    max: { id: 'chat-max', channel: 'max', externalChatId: 'max:900', chatType: 'private', contactId: 'contact-max', contactIdentityId: 'identity-max', driver: null, metadata: {} },
}
const CHANNELS = Object.keys(CHATS) as Channel[]
const SEND_MOCKS: Record<Channel, ReturnType<typeof vi.fn>> = {
    whatsapp: mocks.waSendText,
    telegram: mocks.tgSendText,
    max: mocks.maxSendText,
}

// What each adapter answers when the provider took the message.
function accepted(channel: Channel, externalId: string | null) {
    if (channel === 'max') return { outcome: 'delivered', externalId, resolvedChatId: null }
    return { externalId }
}

// The binding the Platform Shell preparer proves; here the conversation's own fields.
async function preparedBinding(chat: OutboundConversationSnapshotV1) {
    const row = chat as Row
    return {
        chatId: row.id,
        channel: row.channel as Channel,
        contactId: row.contactId,
        contactIdentityId: row.contactIdentityId,
        providerAccountId: `${row.channel}-account`,
        connectionId: `${row.channel}-connection`,
        identityTarget: row.externalChatId,
        target: row.externalChatId,
        isMaxPersonal: row.channel === 'max',
    }
}

const SAFE_V2 = { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 }

function persisted(id: string): Row {
    const row = mocks.store.get(id)
    if (!row) throw new Error(`no row ${id}`)
    return row
}

function storedRow(id: string, fields: Row): Row {
    const row: Row = {
        id,
        chatId: CHATS.max.id,
        clientMessageId: `cmid-${id}`,
        content: `text ${id}`,
        direction: 'outbound',
        channel: 'max',
        type: 'text',
        status: 'delivered',
        externalId: null,
        sentAt: new Date(Date.now() - 60 * 60_000),
        metadata: {},
        ...fields,
    }
    touch(row)
    mocks.store.set(id, row)
    return row
}

function failedRow(id: string, metadata: Row, fields: Row = {}): Row {
    return storedRow(id, {
        status: 'failed',
        // Old enough that the job's pacing backoff has elapsed.
        metadata: { retryAttempt: 0, maxRetries: 3, lastFailedAt: '2020-01-01T00:00:00.000Z', ...metadata },
        ...fields,
    })
}

/** As if the clock moved past the stuck-row window for this row. */
function age(id: string, minutes = 10) {
    persisted(id).sentAt = new Date(Date.now() - minutes * 60_000)
}

function physicalSends(): number {
    return CHANNELS.reduce((count, channel) => count + SEND_MOCKS[channel].mock.calls.length, 0)
}

/** Everything that could resend a row on its own or on an operator's request. */
async function everyRetryPath(ids: string[]) {
    await retryEligibleMessagingDeliveriesV1()
    await recoverStuckMessagingDeliveriesV1()
    await retryEligibleMessagingDeliveriesV1()
    for (const id of ids) {
        await MessageService.retrySend(id)
        await MessageService.retrySend(id, { operatorInitiated: true })
        await retryFailedOutboundMessageV1(id)
    }
}

function opsEvents(name: string): Row[] {
    return mocks.opsLog.mock.calls.filter(([, event]) => event === name).map(([, , fields]) => fields)
}

describe('S1 — shared retry safety', () => {
    let unregister: (() => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        for (const send of Object.values(SEND_MOCKS)) send.mockReset()
        mocks.store.clear()
        mocks.creates.length = 0
        mocks.chatFindUnique.mockImplementation(async ({ where, select }: Row = {}) => {
            const chat = Object.values(CHATS).find(candidate => candidate.id === where?.id)
            if (!chat) return null
            return select ? pick(chat, select) : clone(chat)
        })
        mocks.chatUpdate.mockResolvedValue({})
        mocks.onOutboundMessage.mockResolvedValue(undefined)
        mocks.recordReachability.mockResolvedValue({ outcome: 'updated' })
        unregister = registerOutboundConversationPreparerV1(preparedBinding)
    })

    afterEach(() => {
        unregister?.()
        vi.restoreAllMocks()
    })

    describe('timeout after dispatch started', () => {
        it.each([
            ['telegram', 'Telegram delivery failed: Telegram sendMessage timeout (25s)', 'TIMEOUT'],
            ['whatsapp', 'Protocol error (Runtime.callFunctionOn): Target closed.', 'TRANSPORT_CRASH'],
            ['max', 'Timeout: opcode 64 seq 17', 'TIMEOUT'],
            ['max', 'Failed to send message via Scraper', 'NETWORK_ERROR'],
        ] as const)('%s: %s is unknown and is never sent again', async (channel, error, errorCode) => {
            SEND_MOCKS[channel].mockRejectedValue(new Error(error))

            const result = await MessageService.send(CHATS[channel].id, 'Timed out', channel, undefined, `cmid-timeout-${channel}-${errorCode}`)

            expect(result).toMatchObject({ success: false, status: 'failed', retryable: false, deliveryOutcome: 'unknown', errorSchemaVersion: 2 })
            const row = persisted(result.id)
            expect(row).toMatchObject({ status: 'failed', metadata: { errorCode, retryable: false, deliveryOutcome: 'unknown' } })
            expect(isSafeToRedeliver(row.metadata)).toBe(false)

            await everyRetryPath([result.id])

            expect(physicalSends()).toBe(1)
            expect(mocks.creates).toHaveLength(1)
            expect(persisted(result.id)).toMatchObject({ status: 'failed', metadata: { deliveryOutcome: 'unknown', retryAttempt: 0 } })
        })

        it('an untyped error after dispatch is unknown, not a final failure', async () => {
            // whatsapp-web.js 1.34.6 throws this after WhatsApp already took the message.
            mocks.waSendText.mockRejectedValue(new Error("Cannot read properties of undefined (reading 'timestamp')"))

            const result = await MessageService.send(CHATS.whatsapp.id, 'Untyped', 'whatsapp', undefined, 'cmid-untyped')

            expect(result).toMatchObject({ success: false, deliveryOutcome: 'unknown', retryable: false })
            await everyRetryPath([result.id])
            expect(mocks.waSendText).toHaveBeenCalledTimes(1)
        })
    })

    describe('the adapter outcome-code contract', () => {
        it.each([
            ['MAX_NOT_DISPATCHED: socket not authenticated', 'safe_to_redeliver', true],
            ['WHATSAPP_NOT_DISPATCHED: invalid session', 'safe_to_redeliver', true],
            ['MAX_SEND_REFUSED: MAX_ROUTE_UNRESOLVED', 'terminal', false],
            ['TELEGRAM_PEER_UNRESOLVED_REFUSED', 'terminal', false],
            ['TELEGRAM_MTPROTO_SEND_OUTCOME_UNKNOWN: ECONNREFUSED after the request was written', 'unknown', false],
            ['MAX_NOT_DISPATCHED then MAX_SEND_OUTCOME_UNKNOWN', 'unknown', false],
            ['MAX_NOT_DISPATCHED then MAX_SEND_REFUSED', 'terminal', false],
            ['NOT_DISPATCHED', 'unknown', false],
            ['max_not_dispatched', 'unknown', false],
            ['MAX_NOT_DISPATCHEDX', 'unknown', false],
        ] as const)('%s → %s', async (error, deliveryOutcome, retryable) => {
            mocks.maxSendText.mockRejectedValue(new Error(error))

            const result = await MessageService.send(CHATS.max.id, 'Coded', 'max', undefined, `cmid-code-${error}`)

            expect(result).toMatchObject({ success: false, deliveryOutcome, retryable })
            expect(persisted(result.id).metadata).toMatchObject({ deliveryOutcome, retryable, errorSchemaVersion: 2 })
            expect(isSafeToRedeliver(persisted(result.id).metadata)).toBe(retryable)
        })

        it('a coded NOT_DISPATCHED failure is redelivered on its own row only', async () => {
            mocks.maxSendText.mockRejectedValueOnce(new Error('MAX_NOT_DISPATCHED: socket not authenticated'))
            const first = await MessageService.send(CHATS.max.id, 'Not dispatched', 'max', undefined, 'cmid-not-dispatched')
            persisted(first.id).metadata.lastFailedAt = '2020-01-01T00:00:00.000Z'
            mocks.maxSendText.mockResolvedValue(accepted('max', 'd301-redelivered'))

            await retryEligibleMessagingDeliveriesV1()
            await everyRetryPath([first.id])

            expect(mocks.maxSendText).toHaveBeenCalledTimes(2)
            expect(mocks.creates).toHaveLength(1)
            expect(mocks.maxSendText.mock.calls[1][0].options.clientMessageId).toBe('cmid-not-dispatched')
            expect(persisted(first.id)).toMatchObject({ status: 'delivered', externalId: 'd301-redelivered' })
        })
    })

    describe('adapter returned no trustworthy provider proof', () => {
        it('a MAX send with no correlated id stays send_requested, then becomes unknown, and is never resent', async () => {
            mocks.maxSendText.mockResolvedValue({ outcome: 'pending', externalId: null, resolvedChatId: null })

            const result = await MessageService.send(CHATS.max.id, 'No proof', 'max', undefined, 'cmid-no-proof')

            expect(result).toMatchObject({ success: true, status: 'sent', externalId: null })
            expect(persisted(result.id)).toMatchObject({ status: 'sent', externalId: null, metadata: { maxDelivery: { status: 'send_requested', deliveryConfirmed: false } } })
            expect(mocks.recordReachability).not.toHaveBeenCalled()

            await retryEligibleMessagingDeliveriesV1()
            age(result.id)
            await everyRetryPath([result.id])

            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(persisted(result.id)).toMatchObject({
                status: 'failed',
                metadata: { retryable: false, deliveryOutcome: 'unknown', maxDelivery: { status: 'send_requested' } },
            })
        })

        it('a success whose provider-account proof does not bind is unknown', async () => {
            mocks.maxSendText.mockRejectedValue(new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH'))

            const result = await MessageService.send(CHATS.max.id, 'Unbound proof', 'max', undefined, 'cmid-unbound')

            expect(result).toMatchObject({ deliveryOutcome: 'unknown', retryable: false })
            await everyRetryPath([result.id])
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        })
    })

    describe('process restart after an ambiguous send', () => {
        it('a row the dead process left in flight is recovered as unknown and never resent', async () => {
            // The dispatch starts and the process dies before any answer.
            mocks.maxSendText.mockImplementation(() => new Promise(() => {}))
            void MessageService.send(CHATS.max.id, 'Crashed mid-send', 'max', undefined, 'cmid-crash')
            await vi.waitFor(() => expect(mocks.maxSendText).toHaveBeenCalledTimes(1))
            const [orphan] = mocks.creates
            expect(persisted(orphan.id)).toMatchObject({ status: 'sent', externalId: null })

            // A new process: startup recovery, then the periodic jobs.
            mocks.maxSendText.mockReset()
            mocks.maxSendText.mockResolvedValue(accepted('max', 'd301-second-copy'))
            age(orphan.id)
            await recoverStuckMessagingDeliveriesV1()
            await everyRetryPath([orphan.id])
            // The browser whose answer was lost repeats the same intent.
            const replay = await MessageService.send(CHATS.max.id, 'Crashed mid-send', 'max', undefined, 'cmid-crash')

            expect(replay).toMatchObject({ duplicate: true, id: orphan.id, status: 'failed', deliveryOutcome: 'unknown', retryable: false })
            expect(mocks.maxSendText).not.toHaveBeenCalled()
            expect(mocks.creates).toHaveLength(1)
            expect(persisted(orphan.id)).toMatchObject({ status: 'failed', externalId: null, metadata: { deliveryOutcome: 'unknown', retryable: false } })
        })
    })

    describe('stuck-message recovery', () => {
        it('turns a stuck row of every channel into unknown, never retryable', async () => {
            for (const channel of CHANNELS) {
                storedRow(`stuck-${channel}`, { channel, chatId: CHATS[channel].id, status: 'sent', sentAt: new Date(Date.now() - 10 * 60_000) })
            }
            // Not stuck: provider id present, a call record, a fresh row.
            storedRow('has-id', { status: 'sent', externalId: 'd301-has-id', sentAt: new Date(Date.now() - 10 * 60_000) })
            storedRow('call', { status: 'sent', type: 'call', sentAt: new Date(Date.now() - 10 * 60_000), metadata: { callId: 'c1' } })
            storedRow('fresh', { status: 'sent', sentAt: new Date() })
            // A MAX row stuck mid-retry still carries the safe outcome of the failure before it.
            storedRow('stuck-retry', { status: 'sent', sentAt: new Date(Date.now() - 10 * 60_000), metadata: { ...SAFE_V2, retryAttempt: 1, retryLeaseId: 'lease-1' } })

            await expect(recoverStuckMessagingDeliveriesV1()).resolves.toBe(4)

            for (const id of [...CHANNELS.map(channel => `stuck-${channel}`), 'stuck-retry']) {
                const row = persisted(id)
                expect(row).toMatchObject({ status: 'failed', metadata: { deliveryOutcome: 'unknown' } })
                expect(row.metadata.retryable).not.toBe(true)
                expect(isSafeToRedeliver(row.metadata)).toBe(false)
            }
            expect(persisted('has-id').status).toBe('sent')
            expect(persisted('call')).toMatchObject({ status: 'sent', metadata: { callId: 'c1' } })
            expect(persisted('fresh').status).toBe('sent')

            await everyRetryPath([...CHANNELS.map(channel => `stuck-${channel}`), 'stuck-retry'])
            expect(physicalSends()).toBe(0)
        })
    })

    describe('same row observed by recovery more than once', () => {
        it('the first pass settles it; later passes change nothing and send nothing', async () => {
            storedRow('observed', { status: 'sent', sentAt: new Date(Date.now() - 10 * 60_000), metadata: { maxDelivery: { status: 'send_requested' } } })

            const counts = [
                await recoverStuckMessagingDeliveriesV1(),
                await recoverStuckMessagingDeliveriesV1(),
                await recoverStuckMessagingDeliveriesV1(),
            ]
            const settled = clone(persisted('observed'))
            await recoverStuckMessagingDeliveriesV1()
            await everyRetryPath(['observed'])

            expect(counts).toEqual([1, 0, 0])
            expect(persisted('observed').metadata).toEqual(settled.metadata)
            expect(physicalSends()).toBe(0)
        })

        it('recovery that overtakes a send still in flight never causes a second dispatch', async () => {
            let release!: (value: unknown) => void
            mocks.maxSendText.mockImplementation(() => new Promise(resolve => { release = resolve }))
            const pending = MessageService.send(CHATS.max.id, 'Slow provider', 'max', undefined, 'cmid-slow')
            await vi.waitFor(() => expect(mocks.maxSendText).toHaveBeenCalledTimes(1))
            const [row] = mocks.creates

            age(row.id)
            await recoverStuckMessagingDeliveriesV1()
            expect(persisted(row.id)).toMatchObject({ status: 'failed', metadata: { deliveryOutcome: 'unknown' } })
            await everyRetryPath([row.id])
            await recoverStuckMessagingDeliveriesV1()

            release(accepted('max', 'd301-slow'))
            await pending

            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.creates).toHaveLength(1)
            expect(persisted(row.id)).toMatchObject({ status: 'delivered', externalId: 'd301-slow' })
        })
    })

    describe('manual retry path', () => {
        it.each([
            ['unknown', { retryable: false, deliveryOutcome: 'unknown', errorSchemaVersion: 2, error: 'Timeout' }],
            ['terminal', { retryable: false, deliveryOutcome: 'terminal', errorSchemaVersion: 2, error: 'Invalid target' }],
            ['v1 retryable', { retryable: true, errorCode: 'TIMEOUT', error: 'Timeout' }],
            ['unknown marked retryable', { retryable: true, deliveryOutcome: 'unknown', errorSchemaVersion: 2 }],
        ])('«Повторить» on a %s row is refused without any dispatch', async (_label, metadata) => {
            failedRow('manual', metadata)
            const before = clone(persisted('manual'))

            const result = await retryFailedOutboundMessageV1('manual')

            expect(result).toMatchObject({ ok: false, error: 'Not retryable', message: { id: 'manual', status: 'failed', retryable: false } })
            expect(physicalSends()).toBe(0)
            expect(mocks.creates).toHaveLength(0)
            expect(persisted('manual')).toEqual(before)
        })

        it.each([
            ['a provider id', { externalId: 'd301-already-there' }, {}],
            ['a confirmed MAX delivery', {}, { maxDelivery: { status: 'delivered', deliveryConfirmed: true } }],
        ])('a row carrying %s is never redelivered, whatever its failure metadata says', async (_label, fields, metadata) => {
            failedRow('evidenced', { ...SAFE_V2, ...metadata }, fields)

            await expect(MessageService.retrySend('evidenced', { operatorInitiated: true })).resolves.toEqual({ success: false, error: 'Not retryable' })
            await everyRetryPath(['evidenced'])

            expect(physicalSends()).toBe(0)
        })

        it('a safe row is retried as that row, once, and then never again', async () => {
            failedRow('safe', { ...SAFE_V2, error: 'ECONNREFUSED' })
            mocks.maxSendText.mockResolvedValue(accepted('max', 'd301-safe'))

            const first = await retryFailedOutboundMessageV1('safe')
            await everyRetryPath(['safe'])

            expect(first).toMatchObject({ ok: true, message: { id: 'safe', status: 'delivered', externalId: 'd301-safe' } })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.maxSendText.mock.calls[0][0].options.clientMessageId).toBe('cmid-safe')
            expect(mocks.creates).toHaveLength(0)
        })
    })

    describe('duplicate provider id', () => {
        it('replays the D-01 sequence: the previous message\'s id is refused, the row becomes unknown, nothing resends it', async () => {
            // "6" was sent and confirmed with its own id.
            mocks.maxSendText.mockResolvedValueOnce(accepted('max', 'd301-six'))
            const six = await MessageService.send(CHATS.max.id, '6', 'max', undefined, 'cmid-six')
            // "7" comes back with "6"'s id: an uncorrelated echo.
            mocks.maxSendText.mockResolvedValue(accepted('max', 'd301-six'))
            mocks.recordReachability.mockClear()
            mocks.onOutboundMessage.mockClear()

            const seven = await MessageService.send(CHATS.max.id, '7', 'max', undefined, 'cmid-seven')

            expect(seven).toMatchObject({ success: false, status: 'failed', externalId: null, deliveryOutcome: 'unknown', retryable: false })
            expect(persisted(six.id)).toMatchObject({ status: 'delivered', externalId: 'd301-six', content: '6' })
            expect(persisted(seven.id)).toMatchObject({
                status: 'failed',
                externalId: null,
                metadata: {
                    errorCode: 'PROVIDER_ID_CONFLICT',
                    retryable: false,
                    deliveryOutcome: 'unknown',
                    providerIdConflict: { externalId: 'd301-six', ownerMessageId: six.id },
                    maxDelivery: { status: 'send_requested', deliveryConfirmed: false, maxMessageId: null, externalId: null },
                },
            })
            expect(mocks.recordReachability).not.toHaveBeenCalled()
            expect(mocks.onOutboundMessage).not.toHaveBeenCalled()
            expect(opsEvents('message_provider_id_conflict')).toEqual([
                expect.objectContaining({ operation: 'send', messageId: seven.id, externalId: 'd301-six', ownerMessageId: six.id }),
            ])

            // 19:26:01 → 19:32:16: recovery and the retry job run, again and again.
            age(seven.id)
            await everyRetryPath([seven.id])
            await everyRetryPath([seven.id])

            expect(mocks.maxSendText).toHaveBeenCalledTimes(2)
            expect(mocks.creates).toHaveLength(2)
        })

        it.each([
            ['another CRM send of the same text', { clientMessageId: 'cmid-earlier-5', content: '5' }],
            ['the peer\'s inbound message', { clientMessageId: null, direction: 'inbound', content: '5' }],
            ['a mirror in another conversation', { clientMessageId: null, chatId: 'chat-elsewhere', content: '5' }],
        ])('an id owned by %s is a conflict', async (_label, owner) => {
            storedRow('owner', { externalId: 'd301-owned', ...owner })
            mocks.maxSendText.mockResolvedValue(accepted('max', 'd301-owned'))

            const result = await MessageService.send(CHATS.max.id, '5', 'max', undefined, 'cmid-five')

            expect(result).toMatchObject({ status: 'failed', deliveryOutcome: 'unknown' })
            expect(persisted('owner').externalId).toBe('d301-owned')
            await everyRetryPath([result.id])
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        })

        it('a provider mirror of this very send keeps the id and the send stands (WhatsApp sync twin)', async () => {
            storedRow('wa-mirror', {
                chatId: CHATS.whatsapp.id,
                channel: 'whatsapp',
                clientMessageId: null,
                content: 'Twin',
                externalId: 'true_79000000001@c.us_3EB0TWIN',
            })
            mocks.waSendText.mockResolvedValue(accepted('whatsapp', 'true_79000000001@c.us_3EB0TWIN'))

            const result = await MessageService.send(CHATS.whatsapp.id, 'Twin', 'whatsapp', undefined, 'cmid-twin')

            expect(result).toMatchObject({ success: true, status: 'delivered', externalId: null })
            expect(persisted(result.id)).toMatchObject({ status: 'delivered', externalId: null })
            expect(persisted('wa-mirror').externalId).toBe('true_79000000001@c.us_3EB0TWIN')
            expect(opsEvents('message_provider_id_mirror')).toHaveLength(1)
            expect(opsEvents('message_provider_id_conflict')).toHaveLength(0)
            await everyRetryPath([result.id])
            expect(mocks.waSendText).toHaveBeenCalledTimes(1)
        })

        it('a retry whose answer names another row\'s id ends unknown under its lease', async () => {
            storedRow('owner', { externalId: 'd301-owned' })
            failedRow('retried', { ...SAFE_V2, error: 'ECONNREFUSED' })
            mocks.maxSendText.mockResolvedValue(accepted('max', 'd301-owned'))

            await expect(MessageService.retrySend('retried', { operatorInitiated: true })).resolves.toEqual({
                success: false,
                error: 'MESSAGING_SEND_OUTCOME_UNKNOWN: provider id belongs to another message',
            })
            expect(persisted('retried')).toMatchObject({
                status: 'failed',
                externalId: null,
                metadata: { errorCode: 'PROVIDER_ID_CONFLICT', deliveryOutcome: 'unknown', retryable: false, retryAttempt: 1 },
            })
            expect(persisted('owner').externalId).toBe('d301-owned')
            expect(mocks.recordReachability).not.toHaveBeenCalled()

            await everyRetryPath(['retried'])
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        })

        it.each(CHANNELS)('%s: the id the adapter returns is stored, and an empty one stores nothing', async channel => {
            SEND_MOCKS[channel].mockResolvedValueOnce(accepted(channel, `${channel}-provider-id`))
            const withId = await MessageService.send(CHATS[channel].id, 'With id', channel, undefined, `cmid-id-${channel}`)
            SEND_MOCKS[channel].mockResolvedValueOnce(accepted(channel, channel === 'max' ? null : ''))
            const withoutId = await MessageService.send(CHATS[channel].id, 'Without id', channel, undefined, `cmid-noid-${channel}`)

            expect(persisted(withId.id).externalId).toBe(`${channel}-provider-id`)
            expect(persisted(withoutId.id).externalId).toBeNull()
        })
    })

    describe('one intent, one row', () => {
        it('two different sends in the same millisecond are two rows, each dispatched once', async () => {
            vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T19:26:01.000Z'))
            mocks.maxSendText.mockResolvedValue({ outcome: 'pending', externalId: null, resolvedChatId: null })

            const [first, second] = await Promise.all([
                MessageService.send(CHATS.max.id, 'Same ms A', 'max', undefined, 'cmid-ms-a'),
                MessageService.send(CHATS.max.id, 'Same ms B', 'max', undefined, 'cmid-ms-b'),
            ])

            expect(first.id).not.toBe(second.id)
            expect(first.id).toMatch(/^msg_1790969161000_/)
            expect(mocks.creates).toHaveLength(2)
            expect(mocks.maxSendText).toHaveBeenCalledTimes(2)
        })
    })
})
