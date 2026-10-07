import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// S2 — the delivery evidence contract, end to end through MessageService.
//
// No status claims more than the evidence proves: a typed send is never
// 'delivered' at send time, a client action is never provider acceptance,
// reachability follows acceptance only, late evidence only strengthens a row,
// and a legacy adapter keeps its legacy behaviour.
//
// The Message store is a stateful stand-in for Prisma with the three unique
// keys (`id`, `clientMessageId`, `externalId`, P2002 with meta.target), an
// `update` that is a compare-and-set when its where clause names `updatedAt`
// (P2025 when the row moved), and `updateMany` as a compare-and-set on its where
// clause. Late evidence goes through the real evidence command and its real
// Prisma adapter against this store. Every adapter counts its physical sends.

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
    // A concurrent writer that lands just before the next updateMany, once.
    beforeNextUpdateMany: null as null | (() => void),
}))

const UNIQUE_KEYS = ['id', 'clientMessageId', 'externalId'] as const

function clone<T>(value: T): T {
    if (value === undefined) return value
    if (value instanceof Date) return new Date(value.getTime()) as T
    return JSON.parse(JSON.stringify(value), (key, v) => (
        (key === 'sentAt' || key === 'updatedAt' || key === 'createdAt') && typeof v === 'string' ? new Date(v) : v
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

function prismaError(code: string, message: string, target?: string): Error {
    return Object.assign(new Error(message), { code, ...(target ? { meta: { modelName: 'Message', target: [target] } } : {}) })
}

function assertUnique(candidate: Row, selfId: string | null) {
    for (const key of UNIQUE_KEYS) {
        const value = candidate[key]
        if (value === null || value === undefined) continue
        const owner = [...mocks.store.values()].find(row => row.id !== selfId && row[key] === value)
        if (owner) throw prismaError('P2002', `Unique constraint failed on the fields: (\`${key}\`)`, key)
    }
}

function time(value: unknown): number {
    return value instanceof Date ? value.getTime() : Number.NaN
}

function fieldMatches(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined
    if (expected instanceof Date) return time(actual) === expected.getTime()
    if (expected && typeof expected === 'object') {
        const condition = expected as Row
        if ('path' in condition) return ((actual as Row | null) ?? {})[condition.path[0]] === condition.equals
        if ('not' in condition) return actual !== condition.not
        if ('in' in condition) return (condition.in as unknown[]).includes(actual)
        return (!('lt' in condition) || time(actual) < condition.lt.getTime())
            && (!('gte' in condition) || time(actual) >= condition.gte.getTime())
            && (!('lte' in condition) || time(actual) <= condition.lte.getTime())
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
            async findMany({ where, select, orderBy, take }: Row) {
                const found = [...mocks.store.values()].filter(row => matches(row, where))
                if (orderBy) found.sort((a, b) => time(a.sentAt) - time(b.sentAt) || String(a.id).localeCompare(String(b.id)))
                return found.slice(0, take ?? found.length).map(row => pick(row, select))
            },
            async create({ data }: Row) {
                const row: Row = { externalId: null, metadata: {}, type: 'text', createdAt: new Date(), ...clone(data) }
                assertUnique(row, null)
                touch(row)
                mocks.store.set(row.id, row)
                return clone(row)
            },
            async update({ where, data }: Row) {
                const row = mocks.store.get(where.id)
                if (!row || (where.updatedAt instanceof Date && time(row.updatedAt) !== where.updatedAt.getTime())) {
                    throw prismaError('P2025', 'Record to update not found.')
                }
                applyData(row, data)
                return clone(row)
            },
            async updateMany({ where, data }: Row) {
                const concurrent = mocks.beforeNextUpdateMany
                mocks.beforeNextUpdateMany = null
                concurrent?.()
                const rows = [...mocks.store.values()].filter(row => matches(row, where))
                for (const row of rows) applyData(row, data)
                return { count: rows.length }
            },
        },
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
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.waSendText }),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.tgSendText }),
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: vi.fn(), sendText: mocks.maxSendText }),
}))

import { MessageService } from '@/lib/MessageService'
import { PATCH_MESSAGE_DELIVERY_COMMAND_V2 } from '../../../../contracts/messaging/v1'
import { channelDeliveryErrorV1 } from './channel-delivery-runtime'
import { deriveDeliveryStateV1 } from './delivery-state-policy'
import { recoverStuckMessagingDeliveriesV1, retryEligibleMessagingDeliveriesV1 } from './delivery-recovery-operations'
import { legacyPrismaMessageDeliveryEvidencePortV1 } from './legacy-prisma-message-delivery-evidence-adapter'
import { createApplyMessageDeliveryEvidenceHandlerV1 } from './message-delivery-evidence-handler'
import { retryFailedOutboundMessageV1 } from './operator-delivery-retry'
import {
    registerOutboundConversationPreparerV1,
    type OutboundConversationChannelV1,
    type OutboundConversationSnapshotV1,
} from './outbound-conversation-identity-runtime'

type Channel = OutboundConversationChannelV1

const applyEvidence = createApplyMessageDeliveryEvidenceHandlerV1(legacyPrismaMessageDeliveryEvidencePortV1)

const CHATS: Record<Channel, Row> = {
    whatsapp: { id: 'chat-wa', channel: 'whatsapp', externalChatId: '79000000001@c.us', chatType: 'private', contactId: 'contact-wa', contactIdentityId: 'identity-wa', driver: null, metadata: {} },
    telegram: { id: 'chat-tg', channel: 'telegram', externalChatId: 'telegram:4200', chatType: 'private', contactId: 'contact-tg', contactIdentityId: 'identity-tg', driver: null, metadata: {} },
    max: { id: 'chat-max', channel: 'max', externalChatId: 'max:900', chatType: 'private', contactId: 'contact-max', contactIdentityId: 'identity-max', driver: null, metadata: {} },
}
const SEND_MOCKS: Record<Channel, ReturnType<typeof vi.fn>> = {
    whatsapp: mocks.waSendText,
    telegram: mocks.tgSendText,
    max: mocks.maxSendText,
}

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

function persisted(id: string): Row {
    const row = mocks.store.get(id)
    if (!row) throw new Error(`no row ${id}`)
    return row
}

function stateOf(id: string) {
    return deriveDeliveryStateV1(persisted(id))
}

function storedRow(id: string, fields: Row): Row {
    const row: Row = {
        id,
        chatId: CHATS.telegram.id,
        clientMessageId: `cmid-${id}`,
        content: `text ${id}`,
        direction: 'outbound',
        channel: 'telegram',
        type: 'text',
        status: 'sent',
        externalId: null,
        sentAt: new Date(),
        createdAt: new Date(),
        metadata: {},
        ...fields,
    }
    touch(row)
    mocks.store.set(id, row)
    return row
}

function physicalSends(): number {
    return Object.values(SEND_MOCKS).reduce((count, send) => count + send.mock.calls.length, 0)
}

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

function echo(channel: Channel, providerMessageId: string, content: string, evidence = 'provider_echo') {
    return applyEvidence({
        contract: PATCH_MESSAGE_DELIVERY_COMMAND_V2,
        chatId: CHATS[channel].id,
        channel,
        providerMessageId,
        evidence,
        content,
        providerSentAt: new Date(),
    })
}

function onlyRowId(): string {
    const rows = [...mocks.store.values()]
    expect(rows).toHaveLength(1)
    return rows[0].id
}

describe('S2 — delivery evidence contract', () => {
    let unregister: (() => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        for (const send of Object.values(SEND_MOCKS)) send.mockReset()
        mocks.store.clear()
        mocks.beforeNextUpdateMany = null
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

    describe('typed evidence at send', () => {
        it('a Telegram result without a message id is a client action: sent, awaiting proof, no reachability (DT 15, 17)', async () => {
            mocks.tgSendText.mockResolvedValue({ evidence: 'provider_ack', providerMessageId: null })

            const answer = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-tg-1')

            const row = persisted(answer.id)
            expect(row.status).toBe('sent')
            expect(row.externalId).toBeNull()
            expect(row.metadata.delivery).toMatchObject({ v: 1, evidence: 'client_action', source: 'send' })
            expect(answer).toMatchObject({ success: true, status: 'sent', externalId: null, deliveryState: 'send_requested' })
            expect(stateOf(answer.id)).toBe('send_requested')
            expect(mocks.recordReachability).not.toHaveBeenCalled()
        })

        it('a provider acknowledgement is provider acceptance — sent, never delivered — and is reachability evidence', async () => {
            mocks.tgSendText.mockResolvedValue({ evidence: 'provider_ack', providerMessageId: 'tg-501' })

            const answer = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-tg-2')

            const row = persisted(answer.id)
            expect(row).toMatchObject({ status: 'sent', externalId: 'tg-501' })
            expect(row.metadata.delivery).toMatchObject({ evidence: 'provider_ack', source: 'send' })
            expect(answer).toMatchObject({ status: 'sent', externalId: 'tg-501', deliveryState: 'provider_accepted' })
            expect(mocks.recordReachability).toHaveBeenCalledTimes(1)
            expect(mocks.recordReachability).toHaveBeenCalledWith(expect.objectContaining({
                identityId: 'identity-tg', providerTargetId: 'telegram:4200', status: 'confirmed',
            }))
            expect(mocks.onOutboundMessage).toHaveBeenCalledTimes(1)
        })

        it('a MAX id with no correlated proof is never delivered, whatever the legacy outcome says (DT 11)', async () => {
            mocks.maxSendText.mockResolvedValue({
                outcome: 'delivered', externalId: 'd301aa', resolvedChatId: null,
                evidence: 'client_action', providerMessageId: 'd301aa',
            })

            const answer = await MessageService.send(CHATS.max.id, 'Привет', undefined, undefined, 'cmid-max-1')

            const row = persisted(answer.id)
            expect(row.status).toBe('sent')
            expect(row.metadata.maxDelivery).toMatchObject({ status: 'send_requested', deliveryConfirmed: false, maxMessageId: 'd301aa' })
            expect(answer).toMatchObject({ status: 'sent', deliveryConfirmed: false, deliveryState: 'send_requested' })
            expect(mocks.recordReachability).not.toHaveBeenCalled()
        })

        it('a MAX UI submit bound to this send is neither delivered nor provider accepted (DT 12)', async () => {
            mocks.maxSendText.mockResolvedValue({
                outcome: 'pending', externalId: null, resolvedChatId: null,
                evidence: 'client_action', providerMessageId: null,
            })

            const answer = await MessageService.send(CHATS.max.id, 'Привет', undefined, undefined, 'cmid-max-2')

            expect(mocks.maxSendText).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({ clientMessageId: 'cmid-max-2' }),
            }))
            expect(answer.deliveryState).toBe('send_requested')
            expect(persisted(answer.id).status).toBe('sent')
        })

        it('a correlated MAX protocol answer is provider acceptance', async () => {
            mocks.maxSendText.mockResolvedValue({
                outcome: 'pending', externalId: null, resolvedChatId: null,
                evidence: 'provider_ack', providerMessageId: '1149876',
            })

            const answer = await MessageService.send(CHATS.max.id, 'Привет', undefined, undefined, 'cmid-max-3')

            expect(persisted(answer.id)).toMatchObject({ status: 'sent', externalId: '1149876' })
            expect(persisted(answer.id).metadata.maxDelivery).toMatchObject({ status: 'provider_accepted', deliveryConfirmed: false })
            expect(answer.deliveryState).toBe('provider_accepted')
        })

        it('a WhatsApp send with no message object stays awaiting proof, and a later read-back promotes the same row (DT 14)', async () => {
            mocks.waSendText.mockResolvedValue({ evidence: 'client_action', providerMessageId: null })

            const answer = await MessageService.send(CHATS.whatsapp.id, 'Добрый день', undefined, undefined, 'cmid-wa-1')

            expect(persisted(answer.id)).toMatchObject({ status: 'sent', externalId: null })
            expect(answer.deliveryState).toBe('send_requested')

            await expect(echo('whatsapp', 'true_79000000001@c.us_3EB0AA', 'Добрый день', 'history_readback'))
                .resolves.toMatchObject({ outcome: 'applied', messageId: answer.id, matchedBy: 'unresolved_content' })
            expect(onlyRowId()).toBe(answer.id)
            expect(persisted(answer.id).externalId).toBe('true_79000000001@c.us_3EB0AA')
            expect(stateOf(answer.id)).toBe('provider_accepted')
        })

        it('answers a replayed intent with the row\'s derived state', async () => {
            mocks.tgSendText.mockResolvedValue({ evidence: 'provider_ack', providerMessageId: 'tg-777' })
            await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-replay')

            const replay = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-replay')

            expect(replay).toMatchObject({ duplicate: true, status: 'sent', deliveryState: 'provider_accepted' })
            expect(physicalSends()).toBe(1)
        })
    })

    describe('a legacy adapter is unchanged', () => {
        it.each([
            ['whatsapp', { externalId: 'wa-legacy-1' }],
            ['telegram', { externalId: 'tg-legacy-1' }],
            ['max', { outcome: 'delivered', externalId: 'max-legacy-1', resolvedChatId: null }],
        ] as const)('%s: a result without evidence is stored and reported exactly as before', async (channel, result) => {
            SEND_MOCKS[channel].mockResolvedValue(result)

            const answer = await MessageService.send(CHATS[channel].id, 'Привет', undefined, undefined, `cmid-legacy-${channel}`)

            const row = persisted(answer.id)
            expect(row.status).toBe('delivered')
            expect(row.externalId).toBe(result.externalId)
            expect(row.metadata.delivery).toBeUndefined()
            expect(answer).toMatchObject({ success: true, status: 'delivered', deliveryState: 'delivered' })
            expect(mocks.recordReachability).toHaveBeenCalledTimes(1)
        })

        it('a legacy MAX send without proof is awaiting proof, as its own metadata always said', async () => {
            mocks.maxSendText.mockResolvedValue({ outcome: 'pending', externalId: null, resolvedChatId: null })

            const answer = await MessageService.send(CHATS.max.id, 'Привет', undefined, undefined, 'cmid-legacy-max-pending')

            expect(persisted(answer.id).metadata.maxDelivery).toMatchObject({ status: 'send_requested', deliveryConfirmed: false })
            expect(answer).toMatchObject({ status: 'sent', deliveryState: 'send_requested' })
            expect(mocks.recordReachability).not.toHaveBeenCalled()
        })
    })

    describe('typed failures', () => {
        it('a typed not-dispatched failure is safe to retry on the same row, whatever its text says', async () => {
            mocks.tgSendText.mockRejectedValueOnce(channelDeliveryErrorV1('timeout before connect', 'safe_to_redeliver', 'TELEGRAM_NOT_CONNECTED'))

            const answer = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-safe')

            expect(answer).toMatchObject({ success: false, retryable: true, deliveryOutcome: 'safe_to_redeliver', deliveryState: 'failed_safe_to_retry' })
            expect(persisted(answer.id).metadata).toMatchObject({ errorCode: 'TELEGRAM_NOT_CONNECTED', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 })

            mocks.tgSendText.mockResolvedValueOnce({ evidence: 'provider_ack', providerMessageId: 'tg-retry-1' })
            const retried = await retryFailedOutboundMessageV1(answer.id)

            expect(retried).toMatchObject({ ok: true, message: { id: answer.id, status: 'sent', externalId: 'tg-retry-1', deliveryState: 'provider_accepted' } })
            expect(onlyRowId()).toBe(answer.id)
            expect(physicalSends()).toBe(2)
            expect(mocks.recordReachability).toHaveBeenCalledTimes(1)
        })

        it('a typed refusal is terminal and never retried, whatever its text says', async () => {
            mocks.tgSendText.mockRejectedValue(channelDeliveryErrorV1('client not connected', 'terminal', 'TELEGRAM_PEER_UNRESOLVED'))

            const answer = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-terminal')

            expect(answer).toMatchObject({ success: false, retryable: false, deliveryOutcome: 'terminal', deliveryState: 'failed_not_safe_to_retry' })
            await everyRetryPath([answer.id])
            expect(physicalSends()).toBe(1)
        })

        it('an untyped error after dispatch stays unknown, as S1 decided', async () => {
            mocks.waSendText.mockRejectedValue(new Error('Protocol error (Runtime.callFunctionOn): Target closed.'))

            const answer = await MessageService.send(CHATS.whatsapp.id, 'Привет', undefined, undefined, 'cmid-untyped')

            expect(answer).toMatchObject({ success: false, retryable: false, deliveryOutcome: 'unknown', deliveryState: 'indeterminate' })
            expect(mocks.recordReachability).not.toHaveBeenCalled()
        })
    })

    describe('late evidence', () => {
        it('a Telegram timeout whose message did go out: one row, promoted by the late echo, never sent again (DT 6)', async () => {
            mocks.tgSendText.mockRejectedValue(new Error('Telegram delivery failed: Telegram sendMessage timeout (25s)'))

            const answer = await MessageService.send(CHATS.telegram.id, 'Смена в 8', undefined, undefined, 'cmid-tg-timeout')
            expect(stateOf(answer.id)).toBe('indeterminate')
            mocks.onOutboundMessage.mockClear()

            await expect(echo('telegram', 'tg-9001', 'Смена в 8')).resolves.toMatchObject({ outcome: 'applied', messageId: answer.id })

            const row = persisted(answer.id)
            expect(row).toMatchObject({ status: 'sent', externalId: 'tg-9001' })
            expect(row.metadata).not.toHaveProperty('error')
            expect(row.metadata).not.toHaveProperty('deliveryOutcome')
            expect(stateOf(answer.id)).toBe('provider_accepted')
            expect(mocks.onOutboundMessage).toHaveBeenCalledTimes(1)
            expect(mocks.broadcast).toHaveBeenLastCalledWith(CHATS.telegram.id, expect.objectContaining({ id: answer.id, status: 'sent' }))

            await everyRetryPath([answer.id])
            await expect(echo('telegram', 'tg-9001', 'Смена в 8')).resolves.toMatchObject({ outcome: 'unchanged' })
            expect(physicalSends()).toBe(1)
            expect(onlyRowId()).toBe(answer.id)
            expect(mocks.onOutboundMessage).toHaveBeenCalledTimes(1)
        })

        it('restart: an unproven row recovered as indeterminate is promoted by late evidence and never resent', async () => {
            mocks.tgSendText.mockResolvedValue({ evidence: 'client_action', providerMessageId: null })
            const answer = await MessageService.send(CHATS.telegram.id, 'Перезапуск', undefined, undefined, 'cmid-restart')
            persisted(answer.id).sentAt = new Date(Date.now() - 6 * 60_000)

            await recoverStuckMessagingDeliveriesV1()
            expect(stateOf(answer.id)).toBe('indeterminate')

            await expect(echo('telegram', 'tg-restart', 'Перезапуск', 'history_readback')).resolves.toMatchObject({ outcome: 'applied', messageId: answer.id })
            expect(stateOf(answer.id)).toBe('provider_accepted')
            await everyRetryPath([answer.id])
            expect(physicalSends()).toBe(1)
        })

        it('evidence whose row changed between lookup and write resolves again and never overwrites stronger proof', async () => {
            const row = storedRow('cas-1', { content: 'Гонка записи' })
            mocks.beforeNextUpdateMany = () => {
                // A read receipt for the same message lands first, through another path.
                Object.assign(persisted(row.id), {
                    status: 'read',
                    externalId: 'tg-cas',
                    metadata: { delivery: { v: 1, evidence: 'read_receipt', evidenceAt: new Date().toISOString(), source: 'ack' } },
                })
                touch(persisted(row.id))
            }

            await expect(echo('telegram', 'tg-cas', 'Гонка записи')).resolves.toMatchObject({ outcome: 'unchanged', messageId: row.id, matchedBy: 'provider_id' })
            expect(persisted(row.id).status).toBe('read')
            expect(stateOf(row.id)).toBe('read')
        })

        it('a burst of refused copies of the same text never hides the unsettled send from late evidence', async () => {
            const base = Date.now() - 5 * 60_000
            for (let i = 0; i < 25; i++) {
                storedRow(`refused-${i}`, {
                    content: 'Повтор текста',
                    status: 'failed',
                    sentAt: new Date(base + i * 1000),
                    metadata: { error: 'TELEGRAM_REFUSED', retryable: false, deliveryOutcome: 'terminal', errorSchemaVersion: 2 },
                })
            }
            const open = storedRow('unsettled', {
                content: 'Повтор текста',
                status: 'failed',
                sentAt: new Date(base + 60_000),
                metadata: { error: 'timeout', retryable: false, deliveryOutcome: 'unknown', errorSchemaVersion: 2 },
            })

            await expect(echo('telegram', 'tg-burst', 'Повтор текста')).resolves.toMatchObject({ outcome: 'applied', messageId: open.id })
            expect(stateOf(open.id)).toBe('provider_accepted')
            expect(stateOf('refused-0')).toBe('failed_not_safe_to_retry')
        })

        it('a read receipt after acceptance is read; a late device receipt never demotes it (DT 16)', async () => {
            mocks.waSendText.mockResolvedValue({ evidence: 'client_action', providerMessageId: 'wa-cm-1' })
            const answer = await MessageService.send(CHATS.whatsapp.id, 'Привет', undefined, undefined, 'cmid-wa-acks')
            const ack = (evidence: string) => applyEvidence({
                contract: PATCH_MESSAGE_DELIVERY_COMMAND_V2, chatId: CHATS.whatsapp.id, channel: 'whatsapp', providerMessageId: 'wa-cm-1', evidence,
            })

            await ack('provider_ack')
            await ack('read_receipt')
            await expect(ack('device_receipt')).resolves.toMatchObject({ outcome: 'unchanged' })
            expect(persisted(answer.id).status).toBe('read')
            expect(stateOf(answer.id)).toBe('read')
        })
    })

    describe('evidence racing its own send (I5)', () => {
        it('a failure written after the provider echoed the message never overwrites the echo', async () => {
            mocks.tgSendText.mockImplementation(async () => {
                await expect(echo('telegram', 'tg-race-1', 'Гонка')).resolves.toMatchObject({ outcome: 'applied' })
                throw new Error('Telegram delivery failed: Telegram sendMessage timeout (25s)')
            })

            const answer = await MessageService.send(CHATS.telegram.id, 'Гонка', undefined, undefined, 'cmid-race-1')

            const row = persisted(answer.id)
            expect(row).toMatchObject({ status: 'sent', externalId: 'tg-race-1' })
            expect(row.metadata).not.toHaveProperty('error')
            expect(row.metadata.delivery).toMatchObject({ evidence: 'provider_echo' })
            expect(answer).toMatchObject({ success: true, status: 'sent', externalId: 'tg-race-1', error: null, deliveryState: 'provider_accepted' })
            expect(answer).not.toHaveProperty('deliveryOutcome')
            expect(opsEvents('message_settled_by_evidence')).toEqual([expect.objectContaining({ operation: 'send', attemptStatus: 'failed', status: 'sent' })])
            await everyRetryPath([answer.id])
            expect(physicalSends()).toBe(1)
        })

        it('a weaker send answer arriving after the echo never demotes it', async () => {
            mocks.waSendText.mockImplementation(async () => {
                await echo('whatsapp', 'wa-race-2', 'Гонка 2')
                return { evidence: 'client_action', providerMessageId: 'wa-race-2' }
            })

            const answer = await MessageService.send(CHATS.whatsapp.id, 'Гонка 2', undefined, undefined, 'cmid-race-2')

            expect(persisted(answer.id).metadata.delivery).toMatchObject({ evidence: 'provider_echo' })
            expect(answer.deliveryState).toBe('provider_accepted')
            expect(mocks.recordReachability).toHaveBeenCalledTimes(1)
        })

        it('evidence during an operator retry revokes its lease: the proof stands and nothing is sent again', async () => {
            const row = storedRow('safe-1', {
                content: 'Повтор',
                status: 'failed',
                sentAt: new Date(Date.now() - 60_000),
                metadata: { error: 'TELEGRAM_NOT_DISPATCHED', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2, retryAttempt: 0, maxRetries: 3, lastFailedAt: '2020-01-01T00:00:00.000Z' },
            })
            mocks.tgSendText.mockImplementation(async () => {
                await expect(echo('telegram', 'tg-retry-race', 'Повтор')).resolves.toMatchObject({ outcome: 'applied', messageId: row.id })
                return { evidence: 'client_action', providerMessageId: null }
            })

            const retried = await retryFailedOutboundMessageV1(row.id)

            expect(retried).toMatchObject({ ok: true, message: { status: 'sent', externalId: 'tg-retry-race', deliveryState: 'provider_accepted' } })
            expect(persisted(row.id).metadata.delivery).toMatchObject({ evidence: 'provider_echo' })
            expect(persisted(row.id).metadata).not.toHaveProperty('retryLeaseId')
            expect(opsEvents('message_settled_by_evidence')).toEqual([expect.objectContaining({ operation: 'retry' })])
            expect(mocks.onOutboundMessage).toHaveBeenCalledTimes(1)
            await everyRetryPath([row.id])
            expect(physicalSends()).toBe(1)
        })
    })

    describe('retry gate', () => {
        it('refuses any row with recorded evidence, whatever its failure metadata says (DT 10)', async () => {
            const row = storedRow('evidence-safe', {
                status: 'failed',
                metadata: {
                    error: 'x', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2, retryAttempt: 0, maxRetries: 3,
                    lastFailedAt: '2020-01-01T00:00:00.000Z',
                    delivery: { v: 1, evidence: 'client_action', evidenceAt: '2026-10-04T00:00:00.000Z', source: 'send' },
                },
            })

            await expect(MessageService.retrySend(row.id, { operatorInitiated: true })).resolves.toEqual({ success: false, error: 'Not retryable' })
            await everyRetryPath([row.id])
            expect(physicalSends()).toBe(0)
        })
    })

    describe('provider-id write rule with typed evidence', () => {
        it('an acknowledged id another CRM send owns proves nothing here: indeterminate, evidence dropped, no reachability', async () => {
            storedRow('owner', { externalId: 'tg-dup', content: 'другое', status: 'sent' })
            mocks.tgSendText.mockResolvedValue({ evidence: 'provider_ack', providerMessageId: 'tg-dup' })

            const answer = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-conflict')

            const row = persisted(answer.id)
            expect(row).toMatchObject({ status: 'failed', externalId: null })
            expect(row.metadata).not.toHaveProperty('delivery')
            expect(row.metadata).toMatchObject({ errorCode: 'PROVIDER_ID_CONFLICT', deliveryOutcome: 'unknown', retryable: false })
            expect(answer).toMatchObject({ success: false, deliveryState: 'indeterminate' })
            expect(mocks.recordReachability).not.toHaveBeenCalled()
            await everyRetryPath([answer.id])
            expect(physicalSends()).toBe(1)
        })

        it('an acknowledged id a mirror of this very send holds leaves the send accepted', async () => {
            storedRow('mirror', { externalId: 'tg-mirror', content: 'Привет', clientMessageId: null, status: 'delivered' })
            mocks.tgSendText.mockResolvedValue({ evidence: 'provider_ack', providerMessageId: 'tg-mirror' })

            const answer = await MessageService.send(CHATS.telegram.id, 'Привет', undefined, undefined, 'cmid-mirror')

            expect(persisted(answer.id)).toMatchObject({ status: 'sent', externalId: null })
            expect(answer.deliveryState).toBe('provider_accepted')
            expect(persisted('mirror').externalId).toBe('tg-mirror')
            expect(mocks.recordReachability).toHaveBeenCalledTimes(1)
        })
    })
})
