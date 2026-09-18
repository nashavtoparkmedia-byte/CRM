import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mobile Text Reply v1, owner side: one send intent is one Message row and at
// most one physical dispatch, whatever repeats it; a retry is that same row;
// and nothing resends a message whose delivery may already have happened.
//
// The Message store below is a small stateful stand-in for Prisma with the two
// properties these guarantees rest on: `clientMessageId` is unique (a second
// create fails with P2002), and updateMany is a compare-and-set on the fields
// in its where clause.

// A loose stand-in for Prisma's untyped row and argument shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdate: vi.fn(),
    maxSendText: vi.fn(),
    maxAssertTransportBinding: vi.fn(),
    onOutboundMessage: vi.fn(),
    prepareIdentity: vi.fn(),
    recordReachability: vi.fn(),
    broadcast: vi.fn(),
    cmidLookupsBlind: { remaining: 0 },
    store: new Map<string, Row>(),
    creates: [] as Row[],
}))

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

function matches(row: Row, where: Row): boolean {
    for (const [key, expected] of Object.entries(where)) {
        if (key === 'metadata') {
            const path = expected.path as string[]
            if ((row.metadata ?? {})[path[0]] !== expected.equals) return false
        } else if (expected instanceof Date) {
            if (!(row[key] instanceof Date) || row[key].getTime() !== expected.getTime()) return false
        } else if (row[key] !== expected) {
            return false
        }
    }
    return true
}

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: mocks.chatFindUnique,
            update: mocks.chatUpdate,
        },
        message: {
            async findUnique({ where, select, include }: Row) {
                if (where.clientMessageId !== undefined) {
                    if (mocks.cmidLookupsBlind.remaining > 0) {
                        mocks.cmidLookupsBlind.remaining -= 1
                        return null
                    }
                    const row = [...mocks.store.values()].find(r => r.clientMessageId === where.clientMessageId)
                    return row ? pick(row, select) : null
                }
                const row = mocks.store.get(where.id)
                if (!row) return null
                const copy = pick(row, select)
                if (include?.chat) copy.chat = await mocks.chatFindUnique({ where: { id: row.chatId } })
                return copy
            },
            async findFirst() { return null },
            async findMany() { return [] },
            async create({ data }: Row) {
                const duplicate = [...mocks.store.values()].some(r => (
                    r.id === data.id || (data.clientMessageId && r.clientMessageId === data.clientMessageId)
                ))
                if (duplicate) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
                const row: Row = { externalId: null, metadata: {}, ...clone(data) }
                touch(row)
                mocks.store.set(row.id, row)
                mocks.creates.push(clone(row))
                return clone(row)
            },
            async update({ where, data }: Row) {
                const row = mocks.store.get(where.id)
                if (!row) throw new Error('Record to update not found')
                for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = clone(value)
                touch(row)
                return clone(row)
            },
            async updateMany({ where, data }: Row) {
                const row = mocks.store.get(where.id)
                if (!row || !matches(row, where)) return { count: 0 }
                for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = clone(value)
                touch(row)
                return { count: 1 }
            },
        },
    },
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: mocks.onOutboundMessage },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: vi.fn() }))
vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({ buildCanonicalContactSummary: vi.fn() }))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: mocks.recordReachability },
}))
vi.mock('@/modules/contacts/public/v1', () => ({ prepareContactConversationIdentityV1: mocks.prepareIdentity }))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: mocks.broadcast }))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({
        assertTransportBinding: mocks.maxAssertTransportBinding,
        sendText: mocks.maxSendText,
    }),
    getTelegramChannelDeliveryV1: () => ({ sendText: vi.fn() }),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: vi.fn() }),
}))

import { MessageService } from '@/lib/MessageService'
import { registerOutboundConversationPreparerV1 } from './outbound-conversation-identity-runtime'
import { prepareOutboundConversationV1 as preparePlatformOutboundConversationV1 } from '@/modules/platform-shell/public/v1/outbound-conversation-identity'
import { retryFailedOutboundMessageV1 } from './operator-delivery-retry'

const CHAT = {
    id: 'chat-max-reply',
    channel: 'max',
    externalChatId: 'max:acceptance-000000000005',
    chatType: 'private',
    contactId: 'contact-reply',
    contactIdentityId: 'identity-reply',
    driver: null,
    metadata: {
        chatKind: 'private',
        connectionId: 'max_scraper',
        providerAccountId: 'max-provider-reply',
        senderId: 'max-sender-reply',
    },
}

const DELIVERED = { outcome: 'delivered', externalId: null, resolvedChatId: null }

function persisted(id: string): Row {
    const row = mocks.store.get(id)
    if (!row) throw new Error(`no row ${id}`)
    return row
}

function failedRow(id: string, metadata: Row, overrides: Row = {}): Row {
    const row: Row = {
        id,
        chatId: CHAT.id,
        clientMessageId: `cmid-${id}`,
        content: `retry ${id}`,
        direction: 'outbound',
        channel: 'max',
        type: 'text',
        status: 'failed',
        externalId: null,
        sentAt: new Date('2026-09-18T08:00:00.000Z'),
        metadata: { retryAttempt: 0, maxRetries: 3, lastFailedAt: new Date().toISOString(), ...metadata },
        ...overrides,
    }
    touch(row)
    mocks.store.set(id, row)
    return row
}

describe('Mobile Text Reply v1 — owner-side send and retry semantics', () => {
    let unregister: (() => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.store.clear()
        mocks.creates.length = 0
        mocks.cmidLookupsBlind.remaining = 0
        // Honour `select`: a send must load every field the outbound preparer
        // checks, or a private conversation is refused as non-private.
        mocks.chatFindUnique.mockImplementation(async ({ select }: Row = {}) => (
            select ? pick(CHAT, select) : clone(CHAT)
        ))
        mocks.chatUpdate.mockResolvedValue({ id: CHAT.id })
        mocks.onOutboundMessage.mockResolvedValue(undefined)
        mocks.recordReachability.mockResolvedValue({ outcome: 'updated' })
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: CHAT.contactId, displayName: 'Reply' },
            identity: {
                id: CHAT.contactIdentityId,
                channel: 'max',
                externalId: CHAT.metadata.senderId,
                providerAccountId: CHAT.metadata.providerAccountId,
            },
        })
        unregister = registerOutboundConversationPreparerV1(preparePlatformOutboundConversationV1)
    })

    afterEach(() => {
        unregister?.()
        vi.useRealTimers()
    })

    describe('one intent, one row, one dispatch', () => {
        it('sends once and answers with the settled canonical state', async () => {
            mocks.maxSendText.mockResolvedValue(DELIVERED)

            const result = await MessageService.send(CHAT.id, 'Hello', 'max', undefined, 'cmid-normal')

            expect(result).toMatchObject({
                success: true,
                clientMessageId: 'cmid-normal',
                status: 'delivered',
            })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.maxSendText.mock.calls[0][0].options.clientMessageId).toBe('cmid-normal')
            expect(mocks.creates).toHaveLength(1)
            expect(persisted(result.id)).toMatchObject({ clientMessageId: 'cmid-normal', status: 'delivered' })
        })

        it('pushes the created row and then the settled row to open views', async () => {
            mocks.maxSendText.mockResolvedValue(DELIVERED)

            const result = await MessageService.send(CHAT.id, 'Pushed', 'max', undefined, 'cmid-pushed')

            const pushed = mocks.broadcast.mock.calls.map(([chatId, row]) => ({ chatId, id: row.id, status: row.status }))
            expect(pushed).toEqual([
                { chatId: CHAT.id, id: result.id, status: 'sent' },
                { chatId: CHAT.id, id: result.id, status: 'delivered' },
            ])
        })

        it('a repeated intent after a lost answer returns the existing row and never dispatches again', async () => {
            mocks.maxSendText.mockResolvedValue(DELIVERED)
            const first = await MessageService.send(CHAT.id, 'Lost answer', 'max', undefined, 'cmid-lost')

            const repeat = await MessageService.send(CHAT.id, 'Lost answer', 'max', undefined, 'cmid-lost')

            expect(repeat).toMatchObject({
                success: true,
                duplicate: true,
                id: first.id,
                chatId: CHAT.id,
                clientMessageId: 'cmid-lost',
                status: 'delivered',
                error: null,
            })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.creates).toHaveLength(1)
        })

        it('a repeated intent of a failed send reports the failure with its classification', async () => {
            mocks.maxSendText.mockRejectedValue(new Error('ECONNREFUSED MAX scraper'))
            const first = await MessageService.send(CHAT.id, 'Refused', 'max', undefined, 'cmid-refused')

            const repeat = await MessageService.send(CHAT.id, 'Refused', 'max', undefined, 'cmid-refused')

            expect(repeat).toMatchObject({
                success: false,
                duplicate: true,
                id: first.id,
                status: 'failed',
                error: 'ECONNREFUSED MAX scraper',
                retryable: true,
                deliveryOutcome: 'safe_to_redeliver',
            })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        })

        it('two requests for one intent racing past the lookup create one row and dispatch once', async () => {
            // Both requests read "no row yet" before either creates one.
            mocks.cmidLookupsBlind.remaining = 2
            let release!: () => void
            const released = new Promise<void>(resolve => { release = resolve })
            mocks.maxSendText.mockImplementation(async () => {
                await released
                return DELIVERED
            })

            const first = MessageService.send(CHAT.id, 'Double tap', 'max', undefined, 'cmid-race')
            const second = MessageService.send(CHAT.id, 'Double tap', 'max', undefined, 'cmid-race')
            const loser = await Promise.race([first, second])
            release()
            const results = await Promise.all([first, second])

            expect(loser).toMatchObject({ duplicate: true, clientMessageId: 'cmid-race' })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.creates).toHaveLength(1)
            expect(new Set(results.map(result => result.id)).size).toBe(1)
            expect(results.filter(result => (result as Row).duplicate === true)).toHaveLength(1)
        })

        it('a unique violation that is not this intent is not mistaken for a duplicate', async () => {
            // msg_${Date.now()} collides with an unrelated row's primary key.
            const now = vi.spyOn(Date, 'now').mockReturnValue(0)
            mocks.store.set('msg_0', { id: 'msg_0', clientMessageId: 'cmid-unrelated', chatId: CHAT.id, status: 'delivered' })

            await expect(MessageService.send(CHAT.id, 'Collision', 'max', undefined, 'cmid-collision'))
                .rejects.toThrow('Unique constraint failed')
            now.mockRestore()
            expect(mocks.maxSendText).not.toHaveBeenCalled()
        })
    })

    describe('delivery outcome decides what may happen next', () => {
        it.each([
            ['ECONNREFUSED MAX scraper', 'safe_to_redeliver', true, 'NETWORK_ERROR'],
            ['MAX client not connected', 'safe_to_redeliver', true, 'TRANSPORT_UNAVAILABLE'],
            ['Timeout: MAX Web reply', 'unknown', false, 'TIMEOUT'],
            ['socket ECONNRESET', 'unknown', false, 'NETWORK_ERROR'],
            ['Failed to send message via Scraper', 'unknown', false, 'NETWORK_ERROR'],
            ['MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH', 'unknown', false, 'UNKNOWN'],
            ['Контакт не найден в MAX. Дождитесь первого входящего сообщения', 'terminal', false, 'RECIPIENT_NOT_FOUND'],
            ['Invalid target', 'terminal', false, 'VALIDATION_ERROR'],
            ['MAX delivery failed', 'terminal', false, 'UNKNOWN'],
        ])('%s → %s', async (error, deliveryOutcome, retryable, errorCode) => {
            mocks.maxSendText.mockRejectedValue(new Error(error))

            const result = await MessageService.send(CHAT.id, 'Classified', 'max', undefined, `cmid-${deliveryOutcome}-${errorCode}`)

            expect(result).toMatchObject({ success: false, status: 'failed', error, retryable, deliveryOutcome })
            expect(persisted(result.id).metadata).toMatchObject({
                error,
                errorCode,
                retryable,
                deliveryOutcome,
                errorSchemaVersion: 2,
            })
        })
    })

    describe('operator retry of a persisted failure', () => {
        it('retries the same row and clientMessageId at once, while the unattended job still waits', async () => {
            failedRow('msg-safe', { retryable: true, deliveryOutcome: 'safe_to_redeliver', error: 'ECONNREFUSED' })
            mocks.maxSendText.mockResolvedValue(DELIVERED)

            await expect(MessageService.retrySend('msg-safe')).resolves.toEqual({
                success: false,
                error: 'Backoff not elapsed',
            })
            expect(mocks.maxSendText).not.toHaveBeenCalled()

            const result = await retryFailedOutboundMessageV1('msg-safe')

            expect(result).toEqual({
                ok: true,
                error: null,
                message: {
                    id: 'msg-safe',
                    chatId: CHAT.id,
                    clientMessageId: 'cmid-msg-safe',
                    status: 'delivered',
                    externalId: null,
                    error: null,
                    retryable: false,
                    deliveryOutcome: null,
                },
            })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.maxSendText.mock.calls[0][0]).toMatchObject({
                content: 'retry msg-safe',
                options: expect.objectContaining({ clientMessageId: 'cmid-msg-safe' }),
            })
            expect(mocks.creates).toHaveLength(0)
            expect(persisted('msg-safe')).toMatchObject({ status: 'delivered', metadata: { retryAttempt: 1 } })
            expect(mocks.broadcast).toHaveBeenLastCalledWith(CHAT.id, expect.objectContaining({ id: 'msg-safe', status: 'delivered' }))
        })

        it('lets exactly one of two concurrent retries dispatch', async () => {
            failedRow('msg-concurrent', { retryable: true, deliveryOutcome: 'safe_to_redeliver' })
            let release!: () => void
            const released = new Promise<void>(resolve => { release = resolve })
            mocks.maxSendText.mockImplementation(async () => {
                await released
                return DELIVERED
            })

            const first = retryFailedOutboundMessageV1('msg-concurrent')
            const second = retryFailedOutboundMessageV1('msg-concurrent')
            const refused = await Promise.race([first, second])
            release()
            const results = await Promise.all([first, second])

            expect(refused).toMatchObject({ ok: false, error: 'Retry already claimed' })
            expect(results.filter(result => result.ok)).toHaveLength(1)
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
            expect(mocks.creates).toHaveLength(0)
            expect(persisted('msg-concurrent')).toMatchObject({ status: 'delivered', metadata: { retryAttempt: 1 } })
        })

        it('reports a retry that fails again with the new classification', async () => {
            failedRow('msg-again', { retryable: true, deliveryOutcome: 'safe_to_redeliver' })
            mocks.maxSendText.mockRejectedValue(new Error('Timeout: MAX Web reply'))

            const result = await retryFailedOutboundMessageV1('msg-again')

            expect(result).toMatchObject({
                ok: false,
                error: 'Timeout: MAX Web reply',
                message: { id: 'msg-again', status: 'failed', retryable: false, deliveryOutcome: 'unknown' },
            })
            expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        })

        it.each([
            ['an unknown delivery outcome', { retryable: false, deliveryOutcome: 'unknown' }, {}, 'Not retryable'],
            ['a terminal failure', { retryable: false, deliveryOutcome: 'terminal' }, {}, 'Not retryable'],
            ['a message that is not failed', { retryable: true }, { status: 'delivered' }, 'Status is delivered, not failed'],
            ['an exhausted attempt limit', { retryable: true, retryAttempt: 3 }, {}, 'Max retries exceeded'],
        ])('refuses %s without dispatching', async (_name, metadata, overrides, error) => {
            failedRow('msg-refused', metadata, overrides)

            const result = await retryFailedOutboundMessageV1('msg-refused')

            expect(result).toMatchObject({ ok: false, error, message: { id: 'msg-refused' } })
            expect(mocks.maxSendText).not.toHaveBeenCalled()
            expect(mocks.creates).toHaveLength(0)
        })

        it.each([[''], ['  msg-safe'], [42], [null]])('refuses a malformed message id %j', async (messageId) => {
            await expect(retryFailedOutboundMessageV1(messageId)).resolves.toEqual({
                ok: false,
                error: 'MESSAGE_ID_REQUIRED',
                message: null,
            })
            expect(mocks.maxSendText).not.toHaveBeenCalled()
        })

        it('refuses a message that does not exist', async () => {
            await expect(retryFailedOutboundMessageV1('msg-missing')).resolves.toEqual({
                ok: false,
                error: 'Message not found',
                message: null,
            })
        })
    })
})
