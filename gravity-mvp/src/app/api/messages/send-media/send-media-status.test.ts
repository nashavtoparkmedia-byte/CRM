import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveDeliveryStateV1, readDeliveryEvidenceV1 } from '@/modules/messaging/public/v1/delivery-state-policy'

const state = vi.hoisted(() => ({
    channel: 'whatsapp' as string,
    created: [] as Array<Record<string, any>>,
    sendMedia: null as null | ((input: unknown) => Promise<unknown>),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: vi.fn(async () => ({ id: 'chat-1', contactId: 'c-1', contactIdentityId: 'ci-1', channel: state.channel, externalChatId: 'x', chatType: 'private', metadata: {} })),
            update: vi.fn(async () => ({})),
        },
        message: {
            create: vi.fn(async ({ data }: { data: Record<string, any> }) => { state.created.push(data); return { id: 'm-1', ...data } }),
            findUnique: vi.fn(async () => null),
        },
        messageAttachment: { create: vi.fn(async () => ({})) },
    },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: vi.fn() }))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: vi.fn(async () => ({
        chatId: 'chat-1', channel: state.channel, target: 'peer-target', providerAccountId: 'acct-1',
        connectionId: 'conn-1', identityTarget: 'peer-target', isMaxPersonal: true,
    })),
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => {
    const capability = { sendMedia: (input: unknown) => (state.sendMedia as (input: unknown) => Promise<unknown>)(input) }
    return {
        getMaxChannelDeliveryV1: () => capability,
        getWhatsAppChannelDeliveryV1: () => capability,
        getTelegramChannelDeliveryV1: () => capability,
    }
})

async function post() {
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/messages/send-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-1', base64: 'aGVsbG8=', filename: 'a.png', mimeType: 'image/png', clientMessageId: 'cm-1' }),
    })
    return POST(request as never)
}

describe('POST /api/messages/send-media: the initial status is what the send proved, never delivered', () => {
    beforeEach(() => {
        state.created = []
    })

    for (const channel of ['whatsapp', 'max', 'telegram'] as const) {
        it(`${channel}: a provider message id is provider_ack, stored as sent (provider_accepted), not delivered`, async () => {
            state.channel = channel
            state.sendMedia = async () => ({ externalId: `${channel}-provider-id-1` })
            const response = await post()
            expect((await response.json()).success).toBe(true)
            expect(state.created).toHaveLength(1)
            const row = state.created[0]
            expect(row.status).toBe('sent')
            expect(readDeliveryEvidenceV1(row.metadata)).toMatchObject({ v: 1, evidence: 'provider_ack', source: 'send' })
            expect(deriveDeliveryStateV1({ direction: row.direction, status: row.status, metadata: row.metadata })).toBe('provider_accepted')
        })

        it(`${channel}: no provider id is a client action, stored as sent (send_requested)`, async () => {
            state.channel = channel
            state.sendMedia = async () => ({ externalId: '' })
            await post()
            const row = state.created[0]
            expect(row.status).toBe('sent')
            expect(row.externalId).toBeNull()
            expect(readDeliveryEvidenceV1(row.metadata)).toMatchObject({ evidence: 'client_action', source: 'send' })
            expect(deriveDeliveryStateV1({ direction: row.direction, status: row.status, metadata: row.metadata })).toBe('send_requested')
        })
    }

    it('max: a failed send is stored as failed, with no delivery evidence', async () => {
        state.channel = 'max'
        state.sendMedia = async () => { throw new Error('scraper down') }
        const body = await (await post()).json()
        expect(body.success).toBe(false)
        const row = state.created[0]
        expect(row.status).toBe('failed')
        expect(row.metadata.sendError).toBe('scraper down')
        expect(readDeliveryEvidenceV1(row.metadata)).toBeNull()
    })

    it('no channel ever stores delivered or read at send time', async () => {
        for (const channel of ['whatsapp', 'max', 'telegram']) {
            state.channel = channel
            state.sendMedia = async () => ({ externalId: 'p-1' })
            await post()
        }
        expect(state.created.map((row) => row.status)).toEqual(['sent', 'sent', 'sent'])
    })
})
