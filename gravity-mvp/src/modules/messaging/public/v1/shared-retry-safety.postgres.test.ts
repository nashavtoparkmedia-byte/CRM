import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// S1 shared retry safety against real PostgreSQL: the real unique indexes
// (Message.id, clientMessageId, externalId), the real P2002 that Prisma raises
// for them, the real stuck-row recovery and the retry job's real candidate SQL.
// Only the provider adapters are stand-ins, and each counts its physical sends.
//
// Runs only against a disposable database named by
// MESSAGING_RETRY_TEST_DATABASE_URL (the Prisma client must point at the same
// database through DATABASE_URL); skipped otherwise. The retry job selects
// across the whole Message table, so the database must hold no other failed
// outbound rows: run this file on its own.

const TEST_DATABASE_URL = process.env.MESSAGING_RETRY_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

const mocks = vi.hoisted(() => ({
    waSendText: vi.fn(),
    tgSendText: vi.fn(),
    maxSendText: vi.fn(),
    opsLog: vi.fn(),
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: vi.fn(async () => undefined) },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.opsLog }))
vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({ buildCanonicalContactSummary: vi.fn() }))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: vi.fn(async () => ({ outcome: 'updated' })) },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: vi.fn() }))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.waSendText }),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.tgSendText }),
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: vi.fn(), sendText: mocks.maxSendText }),
}))

import { prisma } from '@/lib/prisma'
import { MessageService, isSafeToRedeliver } from '@/lib/MessageService'
import { registerOutboundConversationPreparerV1, type OutboundConversationSnapshotV1 } from './outbound-conversation-identity-runtime'
import { recoverStuckMessagingDeliveriesV1, retryEligibleMessagingDeliveriesV1 } from './delivery-recovery-operations'
import { retryFailedOutboundMessageV1 } from './operator-delivery-retry'

const RUN = `s1rs${Date.now().toString(36)}`
const CHAT = {
    whatsapp: `${RUN}_wa`,
    telegram: `${RUN}_tg`,
    max: `${RUN}_max`,
} as const
type Channel = keyof typeof CHAT

async function preparedBinding(chat: OutboundConversationSnapshotV1) {
    const row = chat as { id: string; channel: Channel; externalChatId: string }
    return {
        chatId: row.id,
        channel: row.channel,
        contactId: `${row.id}_contact`,
        contactIdentityId: `${row.id}_identity`,
        providerAccountId: `${row.channel}-account`,
        connectionId: `${row.channel}-connection`,
        identityTarget: row.externalChatId,
        target: row.externalChatId,
        isMaxPersonal: row.channel === 'max',
    }
}

function sends(): number {
    return mocks.waSendText.mock.calls.length + mocks.tgSendText.mock.calls.length + mocks.maxSendText.mock.calls.length
}

async function row(id: string) {
    return prisma.message.findUniqueOrThrow({ where: { id } })
}

function meta(value: unknown): Record<string, any> {
    return (value ?? {}) as Record<string, any>
}

async function age(id: string, minutes = 10) {
    await prisma.message.update({ where: { id }, data: { sentAt: new Date(Date.now() - minutes * 60_000) } })
}

async function everyRetryPath(ids: string[]) {
    await retryEligibleMessagingDeliveriesV1()
    await recoverStuckMessagingDeliveriesV1()
    await retryEligibleMessagingDeliveriesV1()
    for (const id of ids) {
        await MessageService.retrySend(id)
        await retryFailedOutboundMessageV1(id)
    }
}

describeWithDatabase('S1 shared retry safety (PostgreSQL)', () => {
    let unregister: (() => void) | undefined

    beforeAll(async () => {
        if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
            throw new Error('DATABASE_URL must equal MESSAGING_RETRY_TEST_DATABASE_URL for this suite')
        }
        const foreign = await prisma.message.count({ where: { status: 'failed', direction: 'outbound', NOT: { chatId: { startsWith: RUN } } } })
        if (foreign !== 0) throw new Error('the disposable database already holds failed outbound rows')
        for (const [channel, id] of Object.entries(CHAT)) {
            await prisma.chat.create({ data: { id, channel: channel as Channel, externalChatId: `${channel}:${id}` } })
        }
    })

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.waSendText.mockReset()
        mocks.tgSendText.mockReset()
        mocks.maxSendText.mockReset()
        unregister = registerOutboundConversationPreparerV1(preparedBinding)
    })

    afterEach(async () => {
        unregister?.()
        vi.restoreAllMocks()
        await prisma.message.deleteMany({ where: { chatId: { startsWith: RUN } } })
    })

    afterAll(async () => {
        await prisma.message.deleteMany({ where: { chatId: { startsWith: RUN } } })
        await prisma.chat.deleteMany({ where: { id: { startsWith: RUN } } })
        await prisma.$disconnect()
    })

    it('a provider id another row owns raises the real P2002 on externalId', async () => {
        await prisma.message.create({ data: { id: `${RUN}_owner`, chatId: CHAT.max, direction: 'outbound', channel: 'max', content: 'owner', externalId: `${RUN}-dup` } })
        await prisma.message.create({ data: { id: `${RUN}_other`, chatId: CHAT.max, direction: 'outbound', channel: 'max', content: 'other' } })

        const error = await prisma.message.update({ where: { id: `${RUN}_other` }, data: { externalId: `${RUN}-dup` } }).catch((caught: unknown) => caught)

        expect(error).toMatchObject({ code: 'P2002' })
        expect(JSON.stringify((error as { meta?: unknown }).meta)).toContain('externalId')
    })

    it('replays D-01: the previous message\'s id is refused, the row is unknown, recovery and the job never resend it', async () => {
        mocks.maxSendText.mockResolvedValueOnce({ outcome: 'delivered', externalId: `${RUN}-d301-six`, resolvedChatId: null })
        const six = await MessageService.send(CHAT.max, '6', 'max', undefined, `${RUN}-cmid-six`)
        mocks.maxSendText.mockResolvedValue({ outcome: 'delivered', externalId: `${RUN}-d301-six`, resolvedChatId: null })

        const seven = await MessageService.send(CHAT.max, '7', 'max', undefined, `${RUN}-cmid-seven`)

        expect(seven).toMatchObject({ success: false, status: 'failed', deliveryOutcome: 'unknown', retryable: false, externalId: null })
        expect(await row(six.id)).toMatchObject({ status: 'delivered', externalId: `${RUN}-d301-six` })
        const stored = await row(seven.id)
        expect(stored).toMatchObject({ status: 'failed', externalId: null })
        expect(meta(stored.metadata)).toMatchObject({
            errorCode: 'PROVIDER_ID_CONFLICT',
            deliveryOutcome: 'unknown',
            retryable: false,
            providerIdConflict: { externalId: `${RUN}-d301-six`, ownerMessageId: six.id },
            maxDelivery: { deliveryConfirmed: false, status: 'send_requested' },
        })

        await age(seven.id)
        await everyRetryPath([seven.id])
        await everyRetryPath([seven.id])

        expect(mocks.maxSendText).toHaveBeenCalledTimes(2)
        expect(await prisma.message.count({ where: { chatId: CHAT.max } })).toBe(2)
    })

    it('real recovery turns stuck rows of every channel unknown, and the real job selects none of them', async () => {
        const stuck: string[] = []
        for (const channel of Object.keys(CHAT) as Channel[]) {
            const id = `${RUN}_stuck_${channel}`
            stuck.push(id)
            await prisma.message.create({ data: { id, chatId: CHAT[channel], direction: 'outbound', channel, content: `stuck ${channel}`, status: 'sent', sentAt: new Date(Date.now() - 10 * 60_000) } })
        }
        // Stuck mid-retry, still carrying the safe outcome of the failure before it.
        const midRetry = `${RUN}_stuck_retry`
        stuck.push(midRetry)
        await prisma.message.create({ data: {
            id: midRetry, chatId: CHAT.max, direction: 'outbound', channel: 'max', content: 'mid retry', status: 'sent',
            sentAt: new Date(Date.now() - 10 * 60_000),
            metadata: { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2, retryAttempt: 1, maxRetries: 3, retryLeaseId: 'lease' },
        } })

        await expect(recoverStuckMessagingDeliveriesV1()).resolves.toBe(4)
        await expect(recoverStuckMessagingDeliveriesV1()).resolves.toBe(0)

        for (const id of stuck) {
            const settled = await row(id)
            expect(settled.status).toBe('failed')
            expect(meta(settled.metadata).deliveryOutcome).toBe('unknown')
            expect(isSafeToRedeliver(meta(settled.metadata))).toBe(false)
        }
        await expect(retryEligibleMessagingDeliveriesV1()).resolves.toEqual({ retriedCount: 0, candidatesFound: 0 })
        await everyRetryPath(stuck)
        expect(sends()).toBe(0)
    })

    it('a send orphaned by a process crash is recovered as unknown and never resent', async () => {
        mocks.maxSendText.mockImplementation(() => new Promise(() => {}))
        void MessageService.send(CHAT.max, 'orphan', 'max', undefined, `${RUN}-cmid-orphan`)
        await vi.waitFor(() => expect(mocks.maxSendText).toHaveBeenCalledTimes(1))
        const orphan = await prisma.message.findUniqueOrThrow({ where: { clientMessageId: `${RUN}-cmid-orphan` } })
        expect(orphan).toMatchObject({ status: 'sent', externalId: null })

        // The next process.
        mocks.maxSendText.mockReset()
        mocks.maxSendText.mockResolvedValue({ outcome: 'delivered', externalId: `${RUN}-second-copy`, resolvedChatId: null })
        await age(orphan.id)
        await recoverStuckMessagingDeliveriesV1()
        await everyRetryPath([orphan.id])
        const replay = await MessageService.send(CHAT.max, 'orphan', 'max', undefined, `${RUN}-cmid-orphan`)

        expect(replay).toMatchObject({ duplicate: true, id: orphan.id, deliveryOutcome: 'unknown', retryable: false })
        expect(mocks.maxSendText).not.toHaveBeenCalled()
        expect(await prisma.message.count({ where: { chatId: CHAT.max } })).toBe(1)
    })

    it('a real double submit of one intent makes one row and one dispatch', async () => {
        let release!: () => void
        const released = new Promise<void>(resolve => { release = resolve })
        mocks.tgSendText.mockImplementation(async () => {
            await released
            return { externalId: `${RUN}-tg-1` }
        })

        const first = MessageService.send(CHAT.telegram, 'double tap', 'telegram', undefined, `${RUN}-cmid-double`)
        const second = MessageService.send(CHAT.telegram, 'double tap', 'telegram', undefined, `${RUN}-cmid-double`)
        await vi.waitFor(() => expect(mocks.tgSendText).toHaveBeenCalledTimes(1))
        release()
        const results = await Promise.all([first, second])

        expect(mocks.tgSendText).toHaveBeenCalledTimes(1)
        expect(new Set(results.map(result => result.id)).size).toBe(1)
        expect(await prisma.message.count({ where: { chatId: CHAT.telegram } })).toBe(1)
    })

    it('two different sends in the same millisecond are two rows', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T19:26:01.000Z'))
        mocks.waSendText.mockResolvedValue({ externalId: '' })

        await MessageService.send(CHAT.whatsapp, 'same ms A', 'whatsapp', undefined, `${RUN}-cmid-ms-a`)
        await MessageService.send(CHAT.whatsapp, 'same ms B', 'whatsapp', undefined, `${RUN}-cmid-ms-b`)

        expect(await prisma.message.count({ where: { chatId: CHAT.whatsapp } })).toBe(2)
        expect(mocks.waSendText).toHaveBeenCalledTimes(2)
    })

    it('a WhatsApp sync twin of this send keeps the id; the send stands and nothing throws', async () => {
        const waId = `true_${RUN}@c.us_3EB0TWIN`
        await prisma.message.create({ data: { id: `${RUN}_mirror`, chatId: CHAT.whatsapp, direction: 'outbound', channel: 'whatsapp', content: 'twin', status: 'delivered', externalId: waId } })
        mocks.waSendText.mockResolvedValue({ externalId: waId })

        const result = await MessageService.send(CHAT.whatsapp, 'twin', 'whatsapp', undefined, `${RUN}-cmid-twin`)

        expect(result).toMatchObject({ success: true, status: 'delivered' })
        expect(await row(result.id)).toMatchObject({ status: 'delivered', externalId: null })
        expect(await row(`${RUN}_mirror`)).toMatchObject({ externalId: waId })
        await everyRetryPath([result.id])
        expect(mocks.waSendText).toHaveBeenCalledTimes(1)
    })
})
