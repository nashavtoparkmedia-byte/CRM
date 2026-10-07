import type { Prisma } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// S2 delivery evidence against real PostgreSQL: the compare-and-set a send's
// settled write makes on the row version (Prisma's P2025 when it moved), the
// evidence adapter's candidate query (time window, JSON-path outcome filter,
// order) and its compare-and-set apply with the real externalId unique index.
// Only the provider adapters are stand-ins, and each counts its physical sends.
//
// Runs only against a disposable database named by
// MESSAGING_EVIDENCE_TEST_DATABASE_URL (the Prisma client must point at the
// same database through DATABASE_URL); skipped otherwise.

const TEST_DATABASE_URL = process.env.MESSAGING_EVIDENCE_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

const mocks = vi.hoisted(() => ({
    tgSendText: vi.fn(),
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
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: vi.fn() }),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.tgSendText }),
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: vi.fn(), sendText: vi.fn() }),
}))

import { prisma } from '@/lib/prisma'
import { MessageService } from '@/lib/MessageService'
import { PATCH_MESSAGE_DELIVERY_COMMAND_V2 } from '../../../../contracts/messaging/v1'
import { deriveDeliveryStateV1 } from './delivery-state-policy'
import { legacyPrismaMessageDeliveryEvidencePortV1 } from './legacy-prisma-message-delivery-evidence-adapter'
import { createApplyMessageDeliveryEvidenceHandlerV1 } from './message-delivery-evidence-handler'
import { registerOutboundConversationPreparerV1, type OutboundConversationSnapshotV1 } from './outbound-conversation-identity-runtime'

const RUN = `s2ev${Date.now().toString(36)}`
const CHAT = `${RUN}_tg`
const applyEvidence = createApplyMessageDeliveryEvidenceHandlerV1(legacyPrismaMessageDeliveryEvidencePortV1)

async function preparedBinding(chat: OutboundConversationSnapshotV1) {
    const row = chat as { id: string; externalChatId: string }
    return {
        chatId: row.id,
        channel: 'telegram' as const,
        contactId: `${row.id}_contact`,
        contactIdentityId: `${row.id}_identity`,
        providerAccountId: 'telegram-account',
        connectionId: 'telegram-connection',
        identityTarget: row.externalChatId,
        target: row.externalChatId,
        isMaxPersonal: false,
    }
}

function echo(providerMessageId: string, content: string, providerSentAt = new Date()) {
    return applyEvidence({ contract: PATCH_MESSAGE_DELIVERY_COMMAND_V2, chatId: CHAT, channel: 'telegram', providerMessageId, evidence: 'provider_echo', content, providerSentAt })
}

type OutboundFields = { chatId?: string; status?: 'sent' | 'failed'; sentAt?: Date; externalId?: string; metadata?: Prisma.InputJsonValue }

async function outbound(id: string, fields: OutboundFields = {}) {
    return prisma.message.create({
        data: {
            id,
            chatId: fields.chatId ?? CHAT,
            direction: 'outbound',
            channel: 'telegram',
            content: 'Привет',
            status: fields.status ?? 'sent',
            sentAt: fields.sentAt,
            externalId: fields.externalId,
            metadata: fields.metadata,
        },
    })
}

describeWithDatabase('S2 delivery evidence (PostgreSQL)', () => {
    let unregister: (() => void) | undefined

    beforeAll(async () => {
        if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
            throw new Error('DATABASE_URL must equal MESSAGING_EVIDENCE_TEST_DATABASE_URL for this suite')
        }
        await prisma.chat.create({ data: { id: CHAT, channel: 'telegram', externalChatId: `telegram:${CHAT}` } })
    })

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.tgSendText.mockReset()
        unregister = registerOutboundConversationPreparerV1(preparedBinding)
    })

    afterEach(async () => {
        unregister?.()
        await prisma.message.deleteMany({ where: { chatId: CHAT } })
    })

    afterAll(async () => {
        await prisma.message.deleteMany({ where: { chatId: CHAT } })
        await prisma.chat.deleteMany({ where: { id: CHAT } })
        await prisma.$disconnect()
    })

    it('a write on a moved row version raises the real P2025', async () => {
        const created = await outbound(`${RUN}_cas`)
        await prisma.message.update({ where: { id: created.id }, data: { content: 'moved' } })

        const error = await prisma.message.update({ where: { id: created.id, updatedAt: created.updatedAt }, data: { status: 'failed' } })
            .catch((caught: unknown) => caught)

        expect(error).toMatchObject({ code: 'P2025' })
        expect((await prisma.message.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('sent')
    })

    it('an echo during the send settles the row; the timeout that follows never overwrites it', async () => {
        mocks.tgSendText.mockImplementation(async () => {
            await expect(echo(`${RUN}-tg-1`, 'Гонка')).resolves.toMatchObject({ outcome: 'applied' })
            throw new Error('Telegram delivery failed: Telegram sendMessage timeout (25s)')
        })

        const answer = await MessageService.send(CHAT, 'Гонка', undefined, undefined, `${RUN}-cmid-race`)

        const row = await prisma.message.findUniqueOrThrow({ where: { id: answer.id } })
        expect(row).toMatchObject({ status: 'sent', externalId: `${RUN}-tg-1` })
        expect(deriveDeliveryStateV1(row)).toBe('provider_accepted')
        expect(answer).toMatchObject({ success: true, deliveryState: 'provider_accepted' })
        expect(mocks.tgSendText).toHaveBeenCalledTimes(1)
    })

    it('selects only unsettled candidates in the window, oldest first, by the real JSON-path filter', async () => {
        const now = Date.now()
        await outbound(`${RUN}_unknown`, { status: 'failed', sentAt: new Date(now - 120_000), metadata: { deliveryOutcome: 'unknown' } })
        await outbound(`${RUN}_safe`, { status: 'failed', sentAt: new Date(now - 180_000), metadata: { deliveryOutcome: 'safe_to_redeliver', retryable: true, errorSchemaVersion: 2 } })
        await outbound(`${RUN}_old`, { sentAt: new Date(now - 20 * 60_000) })
        await outbound(`${RUN}_pending`, { sentAt: new Date(now - 30_000) })
        await outbound(`${RUN}_ided`, { sentAt: new Date(now - 240_000), externalId: `${RUN}-held` })

        await expect(echo(`${RUN}-e1`, 'Привет', new Date(now))).resolves.toMatchObject({ outcome: 'applied', messageId: `${RUN}_unknown` })
        await expect(echo(`${RUN}-e2`, 'Привет', new Date(now))).resolves.toMatchObject({ outcome: 'applied', messageId: `${RUN}_pending` })
        await expect(echo(`${RUN}-e3`, 'Привет', new Date(now))).resolves.toMatchObject({ outcome: 'no_match' })

        const promoted = await prisma.message.findUniqueOrThrow({ where: { id: `${RUN}_unknown` } })
        expect(promoted.status).toBe('sent')
        expect(promoted.metadata).not.toHaveProperty('deliveryOutcome')
        expect((await prisma.message.findUniqueOrThrow({ where: { id: `${RUN}_safe` } })).status).toBe('failed')
    })

    it('refuses an id that another row already holds, through the real unique index', async () => {
        await prisma.chat.create({ data: { id: `${CHAT}_other`, channel: 'telegram', externalChatId: `telegram:${CHAT}_other` } })
        try {
            await outbound(`${RUN}_elsewhere`, { chatId: `${CHAT}_other`, externalId: `${RUN}-taken` })
            await outbound(`${RUN}_candidate`)
            await expect(echo(`${RUN}-taken`, 'Привет')).resolves.toMatchObject({ outcome: 'refused', reason: 'provider_id_collision' })
            expect((await prisma.message.findUniqueOrThrow({ where: { id: `${RUN}_candidate` } })).externalId).toBeNull()
        } finally {
            await prisma.message.deleteMany({ where: { chatId: `${CHAT}_other` } })
            await prisma.chat.deleteMany({ where: { id: `${CHAT}_other` } })
        }
    })
})
