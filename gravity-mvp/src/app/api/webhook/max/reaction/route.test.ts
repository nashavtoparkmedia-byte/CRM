import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WEBHOOK_SECRET = 'test-max-scraper-webhook-secret'
const mocks = vi.hoisted(() => ({
    messageFindUnique: vi.fn(),
    patchMessageMetadata: vi.fn(),
    broadcast: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        message: {
            findUnique: mocks.messageFindUnique,
        },
    },
}))
vi.mock('@/modules/messaging/public/v1', () => ({
    patchMessageMetadataV1: mocks.patchMessageMetadata,
}))
vi.mock('@/modules/messaging/public/v1/message-stream', () => ({
    broadcastChatMessageV1: mocks.broadcast,
}))

import { POST } from './route'

function request(
    overrides: Record<string, unknown> = {},
    webhookSecret: string | null = WEBHOOK_SECRET,
) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (webhookSecret !== null) headers['X-Max-Scraper-Webhook-Secret'] = webhookSecret
    return new Request('https://crm.example/api/webhook/max/reaction', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            externalMsgId: 'd301abcdef0123',
            emoji: '👍',
            isRemove: false,
            providerAccountId: 'live-account-a',
            ...overrides,
        }),
    })
}

function message(providerAccountId = 'live-account-a') {
    return {
        id: 'message-a',
        chatId: 'chat-a',
        externalId: 'd301abcdef0123',
        metadata: {},
        chat: {
            id: 'chat-a',
            channel: 'max',
            metadata: { providerAccountId },
        },
    }
}

describe('MAX reaction webhook admission', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('MAX_SCRAPER_WEBHOOK_SECRET', WEBHOOK_SECRET)
        mocks.messageFindUnique.mockResolvedValue(message())
        mocks.patchMessageMetadata.mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it.each([
        ['missing secret', null],
        ['wrong secret', 'wrong-secret'],
    ])('rejects %s before lookup or mutation', async (_label, secret) => {
        const response = await POST(request({}, secret) as any)

        expect(response.status).toBe(401)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_SCRAPER_WEBHOOK_UNAUTHORIZED' })
        expect(mocks.messageFindUnique).not.toHaveBeenCalled()
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
        expect(mocks.broadcast).not.toHaveBeenCalled()
    })

    it.each([
        ['missing account', undefined],
        ['legacy account', 'legacy'],
        ['default placeholder', 'max-default'],
    ])('rejects %s before message lookup', async (_label, providerAccountId) => {
        const response = await POST(request({ providerAccountId }) as any)

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
        expect(mocks.messageFindUnique).not.toHaveBeenCalled()
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
    })

    it('rejects another account before mutation', async () => {
        mocks.messageFindUnique.mockResolvedValue(message('live-account-b'))

        const response = await POST(request() as any)

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
        expect(mocks.messageFindUnique).toHaveBeenCalledWith({
            where: { externalId: 'd301abcdef0123' },
            include: { chat: true },
        })
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
        expect(mocks.broadcast).not.toHaveBeenCalled()
    })

    it('rejects a message whose owning MAX Chat has no exact account proof', async () => {
        mocks.messageFindUnique.mockResolvedValue(message('max-default'))

        const response = await POST(request() as any)

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
        expect(mocks.broadcast).not.toHaveBeenCalled()
    })

    it('rejects an exact external id owned by a different channel', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            ...message(),
            chat: { ...message().chat, channel: 'telegram' },
        })

        const response = await POST(request() as any)

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_MESSAGE_IDENTITY_COLLISION' })
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
        expect(mocks.broadcast).not.toHaveBeenCalled()
    })

    it('does not fuzzy-match a differently packed provider id', async () => {
        mocks.messageFindUnique.mockResolvedValue(null)

        const response = await POST(request({ externalMsgId: 'prefix-abcdef0123' }) as any)

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ ok: false, reason: 'message not found' })
        expect(mocks.messageFindUnique).toHaveBeenCalledOnce()
        expect(mocks.messageFindUnique).toHaveBeenCalledWith({
            where: { externalId: 'prefix-abcdef0123' },
            include: { chat: true },
        })
        expect(mocks.patchMessageMetadata).not.toHaveBeenCalled()
    })

    it('updates only an exact message owned by the attested account', async () => {
        const response = await POST(request() as any)

        expect(response.status).toBe(200)
        expect(mocks.patchMessageMetadata).toHaveBeenCalledWith({
            contract: 'messaging.PatchMessageMetadataCommand.v1',
            messageId: 'message-a',
            metadata: { reactions: { '👍': 1 } },
        })
        expect(mocks.broadcast).toHaveBeenCalledOnce()
    })
})
