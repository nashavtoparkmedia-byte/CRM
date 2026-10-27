import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// SendToContact end to end against real PostgreSQL, through the real
// composition: the real intent table and its insert-if-absent claim, the real
// Message clientMessageId unique index, Messaging's real ContactConversations
// query, and Contacts' real lineage and permission read (P1 and the shared
// gate, P2). Only the provider adapters and the Platform Shell route proof are
// stand-ins; each adapter counts its physical sends.
//
// Runs only against a disposable, fully migrated database named by
// MESSAGING_SEND_TO_CONTACT_TEST_DATABASE_URL (the Prisma client must point at
// the same database through DATABASE_URL); skipped otherwise.

const TEST_DATABASE_URL = process.env.MESSAGING_SEND_TO_CONTACT_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

const mocks = vi.hoisted(() => ({
    tgSendText: vi.fn(),
    waSendText: vi.fn(),
    maxSendText: vi.fn(),
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: vi.fn(async () => undefined) },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: vi.fn() }))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: vi.fn(async () => ({ outcome: 'updated' })) },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: vi.fn() }))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.tgSendText }),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.waSendText }),
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: vi.fn(), sendText: mocks.maxSendText }),
}))

import { prisma } from '@/lib/prisma'
import { sendToContactV1 } from './messaging-operations'
import { legacyPrismaSendToContactPortV1 } from '../public/v1/legacy-prisma-send-to-contact-adapter'
import { registerOutboundConversationPreparerV1, type OutboundConversationSnapshotV1 } from '../public/v1/outbound-conversation-identity-runtime'

const RUN = `stc${Date.now().toString(36)}`
const CONTACT = `${RUN}_contact`
const ARCHIVED = `${RUN}_archived`

// The Platform Shell proof, reduced to the conversation's own fields; the gate
// that follows it reads Contacts for real.
async function proof(chat: OutboundConversationSnapshotV1) {
    const row = chat as { id: string; channel: 'telegram' | 'whatsapp'; externalChatId: string; contactId: string }
    return {
        chatId: row.id,
        channel: row.channel,
        contactId: row.contactId,
        contactIdentityId: `${row.id}_identity`,
        providerAccountId: null,
        connectionId: `${row.channel}-connection`,
        identityTarget: row.externalChatId,
        target: row.externalChatId,
        isMaxPersonal: false,
    }
}

function sends(): number {
    return mocks.tgSendText.mock.calls.length + mocks.waSendText.mock.calls.length + mocks.maxSendText.mock.calls.length
}

const command = (requestId: string, extra: Record<string, unknown> = {}) => ({
    contract: 'messaging.SendToContactCommand.v1',
    requestId: `${RUN}.${requestId}`,
    contactId: CONTACT,
    content: 'Здравствуйте! Это сообщение из CRM.',
    ...extra,
})

async function chat(id: string, channel: 'telegram' | 'whatsapp', contactId = CONTACT) {
    await prisma.chat.create({
        data: { id: `${RUN}_${id}`, channel, externalChatId: `${channel}:${RUN}_${id}`, chatType: 'private', contactId },
    })
}

describeWithDatabase('SendToContact (PostgreSQL)', () => {
    let unregister: (() => void) | undefined

    beforeAll(async () => {
        if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
            throw new Error('DATABASE_URL must equal MESSAGING_SEND_TO_CONTACT_TEST_DATABASE_URL for this suite')
        }
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Contact" (id, "displayName", "updatedAt") VALUES ($1, 'Proof contact', now()), ($2, 'Archived proof contact', now())`,
            CONTACT,
            ARCHIVED,
        )
        await prisma.$executeRawUnsafe(`UPDATE "Contact" SET "isArchived" = true WHERE id = $1`, ARCHIVED)
    })

    beforeEach(() => {
        vi.clearAllMocks()
        // A typed provider acknowledgement with a fresh provider id per physical send.
        let providerIds = 0
        const acknowledged = async () => ({ evidence: 'provider_ack', providerMessageId: `${RUN}_provider_${providerIds++}` })
        mocks.tgSendText.mockImplementation(acknowledged)
        mocks.waSendText.mockImplementation(acknowledged)
        unregister = registerOutboundConversationPreparerV1(proof)
    })

    afterEach(async () => {
        unregister?.()
        await prisma.message.deleteMany({ where: { chatId: { startsWith: RUN } } })
        await prisma.chat.deleteMany({ where: { id: { startsWith: RUN } } })
    })

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "MessagingSendIntent" WHERE "requestId" LIKE $1`, `${RUN}.%`)
        await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE id IN ($1, $2)`, CONTACT, ARCHIVED)
        await prisma.$disconnect()
    })

    it('sends once into the one provable conversation, then replays that Message without sending again', async () => {
        await chat('tg', 'telegram')
        const first = await sendToContactV1(command('a'))
        expect(first).toMatchObject({ outcome: 'admitted', replayed: false, channel: 'telegram', deliveryState: 'provider_accepted' })
        const row = await prisma.message.findUniqueOrThrow({ where: { clientMessageId: `stc:${RUN}.a` } })
        expect(row).toMatchObject({ chatId: `${RUN}_tg`, direction: 'outbound', content: 'Здравствуйте! Это сообщение из CRM.' })
        expect(sends()).toBe(1)

        const again = await sendToContactV1(command('a'))
        expect(again).toMatchObject({ outcome: 'admitted', replayed: true, messageId: row.id })
        expect(sends()).toBe(1)
        expect(await prisma.message.count({ where: { clientMessageId: `stc:${RUN}.a` } })).toBe(1)
    })

    it('binds the requestId to its first payload in the real table, refused or not', async () => {
        // No conversation yet: refused, and nothing but the intent row is written.
        expect(await sendToContactV1(command('b'))).toMatchObject({ outcome: 'refused', reason: 'route_unavailable', detail: 'no_conversation' })
        const rows = await prisma.$queryRawUnsafe<Array<{ semanticPayloadSha256: string }>>(
            `SELECT "semanticPayloadSha256" FROM "MessagingSendIntent" WHERE "requestId" = $1`,
            `${RUN}.b`,
        )
        expect(rows).toHaveLength(1)
        expect(await sendToContactV1(command('b', { content: 'другой текст' }))).toMatchObject({ outcome: 'idempotency_conflict' })
        // The same payload is evaluated again and succeeds once a conversation exists.
        await chat('tg', 'telegram')
        expect(await sendToContactV1(command('b'))).toMatchObject({ outcome: 'admitted', replayed: false })
        expect(await sendToContactV1(command('b', { content: 'другой текст' }))).toMatchObject({ outcome: 'idempotency_conflict' })
        expect(sends()).toBe(1)
    })

    it('admits one Message and one provider call for many concurrent copies of one intent', async () => {
        await chat('tg', 'telegram')
        const results = await Promise.all(Array.from({ length: 8 }, () => sendToContactV1(command('c'))))
        expect(results.every(result => result.outcome === 'admitted')).toBe(true)
        expect(new Set(results.map(result => (result as { messageId: string }).messageId)).size).toBe(1)
        expect(await prisma.message.count({ where: { clientMessageId: `stc:${RUN}.c` } })).toBe(1)
        expect(sends()).toBe(1)
    })

    it('lets exactly one of many concurrent payloads claim a requestId; every other one conflicts', async () => {
        await chat('tg', 'telegram')
        const results = await Promise.all(Array.from({ length: 6 }, (_, index) => sendToContactV1(command('d', { content: `вариант ${index}` }))))
        expect(results.filter(result => result.outcome === 'admitted')).toHaveLength(1)
        expect(results.filter(result => result.outcome === 'idempotency_conflict')).toHaveLength(5)
        expect(await prisma.message.count({ where: { clientMessageId: `stc:${RUN}.d` } })).toBe(1)
        expect(sends()).toBe(1)
    })

    it('refuses two provable conversations as ambiguous, and the narrowing picks one', async () => {
        await chat('tg', 'telegram')
        await chat('wa', 'whatsapp')
        expect(await sendToContactV1(command('e'))).toMatchObject({ outcome: 'refused', reason: 'route_ambiguous', candidateChannels: ['telegram', 'whatsapp'] })
        expect(await sendToContactV1(command('f', { allowedChannels: ['whatsapp'] }))).toMatchObject({ outcome: 'admitted', channel: 'whatsapp' })
        expect(mocks.waSendText).toHaveBeenCalledTimes(1)
        expect(mocks.tgSendText).not.toHaveBeenCalled()
    })

    it('reads Contacts for real: an unknown or archived Contact is refused before any route or Message', async () => {
        await chat('tg', 'telegram')
        expect(await sendToContactV1(command('g', { contactId: `${RUN}_nobody` }))).toMatchObject({ outcome: 'refused', reason: 'contact_unknown', retryable: false })
        await chat('archived', 'telegram', ARCHIVED)
        expect(await sendToContactV1(command('h', { contactId: ARCHIVED }))).toMatchObject({ outcome: 'refused', reason: 'contact_archived', retryable: false })
        expect(await prisma.message.count({ where: { chatId: { startsWith: RUN } } })).toBe(0)
        expect(sends()).toBe(0)
    })

    it('the gate refuses a conversation whose Contact is not the one SendToContact read (no row, no send)', async () => {
        // The route proof names an archived Contact for this conversation: P2 refuses it as a standing denial.
        await chat('tg', 'telegram')
        unregister?.()
        unregister = registerOutboundConversationPreparerV1(async snapshot => ({ ...await proof(snapshot), contactId: ARCHIVED }))
        expect(await sendToContactV1(command('i'))).toMatchObject({ outcome: 'refused', reason: 'contact_archived' })
        expect(await prisma.message.count({ where: { chatId: { startsWith: RUN } } })).toBe(0)
        expect(sends()).toBe(0)
    })

    it('the intent table refuses a malformed row at the database', async () => {
        await expect(legacyPrismaSendToContactPortV1.claimIntent(`${RUN}.j`, 'not-a-sha')).rejects.toThrow()
        await expect(legacyPrismaSendToContactPortV1.claimIntent(`-${RUN}`, 'a'.repeat(64))).rejects.toThrow()
        expect(await legacyPrismaSendToContactPortV1.claimIntent(`${RUN}.k`, 'a'.repeat(64))).toBe('a'.repeat(64))
        expect(await legacyPrismaSendToContactPortV1.claimIntent(`${RUN}.k`, 'b'.repeat(64))).toBe('a'.repeat(64))
    })
})
