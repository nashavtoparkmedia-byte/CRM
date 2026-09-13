import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression for ambiguous inbound rebinding.
 *
 * When an inbound MAX message names a conversation the CRM has not seen, the
 * webhook may attach it to an existing conversation and rewrite that
 * conversation's canonical externalChatId. It used to pick the most recently
 * active chat matching senderId. senderId is not unique in production: one
 * operator account id is shared by 66 chats, and 69 of 139 chats with a senderId
 * share it with another. Choosing by recency therefore rewrote the identity of a
 * conversation chosen essentially at random.
 *
 * The rule now is: exactly one match rebinds, anything else creates a new
 * conversation instead.
 */
const mocks = vi.hoisted(() => ({
    chatFindMany: vi.fn(),
    chatFindUnique: vi.fn(),
    chatFindFirst: vi.fn(),
    messageFindUnique: vi.fn(),
    patchExternalConversationV1: vi.fn(),
    createExternalConversationV1: vi.fn(),
    upsertExternalMessageV1: vi.fn(),
    opsLog: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findMany: mocks.chatFindMany, findUnique: mocks.chatFindUnique, findFirst: mocks.chatFindFirst },
        message: { findUnique: mocks.messageFindUnique, findFirst: vi.fn().mockResolvedValue(null) },
    },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.opsLog }))
vi.mock('@/modules/messaging/public/v1/persisted-message-ingress', () => ({ publishPersistedMessageV1: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/modules/messaging/public/v1/message-stream', () => ({ broadcastChatMessageV1: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/modules/fleet-operations/public/v1/channel-driver-match', () => ({
    channelDriverMatchV1: { matchDriver: vi.fn().mockResolvedValue(null) },
}))
vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
    channelConversationWorkflowV1: { onInboundMessage: vi.fn().mockResolvedValue(undefined), onOutboundMessage: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@/modules/contacts/public/v1/phone-identity', () => ({ normalizePhoneE164: (v: string) => v }))
vi.mock('@/modules/contacts/public/v1', () => ({
    resolveChannelContactOperationV1: vi.fn().mockResolvedValue(null),
    startMaxContactResolutionShadowV1: vi.fn().mockResolvedValue({
        complete: vi.fn().mockResolvedValue(undefined),
        recordLegacyOutcome: vi.fn(),
        finish: vi.fn().mockResolvedValue(undefined),
    }),
}))
vi.mock('@/modules/messaging/public/v2', () => ({ attachMessageMediaV2: vi.fn() }))
vi.mock('@/modules/messaging/public/v1', () => ({
    createExternalConversationV1: mocks.createExternalConversationV1,
    deleteMessageMediaV1: vi.fn(),
    deleteMessageV1: vi.fn(),
    ensureConversationContactLinkV1: vi.fn(),
    linkMatchedDriverToConversationCapabilityV1: vi.fn(),
    patchExternalConversationV1: mocks.patchExternalConversationV1,
    replaceExternalMessageV1: vi.fn(),
    upsertExternalMessageV1: mocks.upsertExternalMessageV1,
}))

import { POST } from '../src/app/api/webhooks/max/route'

const CONVERSATION = { id: 'chat-existing', externalChatId: '111111111', metadata: {}, name: 'MAX:1' }

function inbound(body: Record<string, unknown>) {
    return new Request('http://localhost/api/webhooks/max', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            externalId: 'd3010000000000000099',
            chatId: '902100000001',
            senderId: '228621088',
            text: 'hello',
            timestamp: new Date().toISOString(),
            messageType: 'text',
            isOutgoing: false,
            ...body,
        }),
    })
}

describe('Ambiguous inbound rebinding fails closed', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.chatFindUnique.mockResolvedValue(null)
        // findFirst must behave like the database the pre-fix code queried: it returned
        // the most recently active candidate. Stubbing it to null would make these tests
        // pass on the old code for the wrong reason — no rebind because the mock was
        // empty, rather than no rebind because the guard refused. Wiring it to the same
        // candidate list is what makes this a regression test rather than a
        // characterisation of the mocks.
        mocks.chatFindFirst.mockImplementation(async () => {
            const candidates = await mocks.chatFindMany()
            return Array.isArray(candidates) && candidates.length ? candidates[0] : null
        })
        mocks.messageFindUnique.mockResolvedValue(null)
        mocks.createExternalConversationV1.mockResolvedValue({ conversation: { ...CONVERSATION, id: 'chat-new' } })
        mocks.patchExternalConversationV1.mockResolvedValue({ conversation: CONVERSATION })
        mocks.upsertExternalMessageV1.mockResolvedValue({ message: { id: 'm1', chatId: 'chat-new' } })
    })

    it('rebinds when exactly one conversation matches the senderId', async () => {
        mocks.chatFindMany.mockResolvedValue([CONVERSATION])
        await POST(inbound({}))
        expect(mocks.patchExternalConversationV1.mock.calls[0][0]).toMatchObject({
            chatId: 'chat-existing',
            patch: { externalChatId: '902100000001' },
        })
        expect(mocks.createExternalConversationV1).not.toHaveBeenCalled()
    })

    it('refuses to rebind when the production-shaped collision is present', async () => {
        // The real shape: one operator account id shared by 66 conversations.
        const many = Array.from({ length: 66 }, (_, i) => ({
            ...CONVERSATION, id: `chat-${i}`, externalChatId: `1000000${i}`,
        }))
        mocks.chatFindMany.mockResolvedValue(many.slice(0, 2)) // the query takes 2
        await POST(inbound({}))

        expect(mocks.patchExternalConversationV1).not.toHaveBeenCalled()
        expect(mocks.createExternalConversationV1).toHaveBeenCalledTimes(1)
        expect(mocks.opsLog).toHaveBeenCalledWith('warn', 'max_inbound_rebind_ambiguous', expect.objectContaining({
            matchedBy: 'senderId',
            candidateCount: 2,
        }))
    })

    it('never asks the database to order candidates by recency', async () => {
        mocks.chatFindMany.mockResolvedValue([])
        await POST(inbound({}))
        for (const call of mocks.chatFindMany.mock.calls) {
            expect(call[0]).not.toHaveProperty('orderBy')
            expect(call[0]).toMatchObject({ take: 2 })
        }
    })

    it('creates a new conversation when nothing matches', async () => {
        mocks.chatFindMany.mockResolvedValue([])
        await POST(inbound({}))
        expect(mocks.patchExternalConversationV1).not.toHaveBeenCalled()
        expect(mocks.createExternalConversationV1).toHaveBeenCalledTimes(1)
    })
})
