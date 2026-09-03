import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    messageFindUnique: vi.fn(),
    messageFindFirst: vi.fn(),
    messageCreate: vi.fn(),
    messageUpdate: vi.fn(),
    messageUpdateMany: vi.fn(),
    onOutboundMessage: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
    prisma: {
        message: {
            findUnique: mocks.messageFindUnique,
            findFirst: mocks.messageFindFirst,
            create: mocks.messageCreate,
            update: mocks.messageUpdate,
            updateMany: mocks.messageUpdateMany,
        },
    },
}))
vi.mock('@/contracts/messaging/v1', () => ({
    DELETE_CONVERSATIONS_BY_ID_COMMAND_V1: 'delete-conversations',
    DELETE_LEGACY_EXTERNAL_CONVERSATIONS_COMMAND_V1: 'delete-legacy-conversations',
    DELETE_QUEUED_MESSAGES_FOR_CONNECTION_COMMAND_V1: 'delete-queued-messages',
    DELIVER_QUEUED_MESSAGES_FOR_CONNECTION_COMMAND_V1: 'deliver-queued-messages',
}))
vi.mock('@/modules/messaging/public/v1', () => ({
    deleteConversationsByIdV1: vi.fn(),
    deleteLegacyExternalConversationsV1: vi.fn(),
    deleteQueuedMessagesForConnectionV1: vi.fn(),
    deliverQueuedMessagesForConnectionV1: vi.fn(),
}))
vi.mock('@/modules/max-channel/public/v1/max-connection-public-metadata', () => ({
    projectMaxConnectionMetadata: vi.fn(),
}))
vi.mock('@/modules/identity-access/public/v1', () => ({
    requireIntegrationAdminAccess: vi.fn(),
}))
vi.mock('@/modules/contacts/public/v1', () => ({
    cleanupDanglingContactIdentitiesV1: vi.fn(),
}))
vi.mock('@/modules/max-channel/public/v1/reaction-delivery', () => ({
    sendMaxReactionDeliveryV1: vi.fn(),
}))
vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: mocks.onOutboundMessage },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: vi.fn(),
}))
vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({
    buildCanonicalContactSummary: vi.fn(),
}))

import { registerMaxMessagingDeliveryCapabilityV1 } from '../src/modules/max-channel/public/v1/messaging-delivery-capability'
import { getMaxChannelDeliveryV1 } from '../src/modules/messaging/public/v1/channel-delivery-runtime'
import { MessageService } from '../src/lib/MessageService'
import { registerOutboundConversationPreparerV1 } from '../src/modules/messaging/public/v1/outbound-conversation-identity-runtime'

const providerId = 'd3010000000000000001'
const providerAccountId = 'max-account-42'
const failurePayloads: Array<[string, Record<string, unknown>]> = [
    ['success:false', { success: false }],
    ['failed:true', { success: true, failed: true }],
    ['failure:true', { success: true, failure: true }],
    ['non-empty error', { success: true, error: 'provider failed' }],
    ['structured error', { success: true, error: { code: 'provider.failed' } }],
]

function mockHttpPayload(payload: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(payload),
    }))
}

async function sendThroughRealHttpBoundary() {
    return getMaxChannelDeliveryV1().sendText({
        target: '902454841098',
        content: 'Bounded repair',
        options: {
            providerAccountId,
            isPersonal: true,
            clientMessageId: 'cmid-http-boundary',
        },
    })
}

describe('MAX HTTP 2xx delivery boundary', () => {
    let unregisterOutboundPreparer: (() => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllGlobals()
        mocks.messageFindFirst.mockResolvedValue(null)
        mocks.messageUpdate.mockResolvedValue({ id: 'message-http-retry' })
        mocks.messageUpdateMany.mockResolvedValue({ count: 1 })
        mocks.onOutboundMessage.mockResolvedValue(undefined)
        registerMaxMessagingDeliveryCapabilityV1()
        unregisterOutboundPreparer = registerOutboundConversationPreparerV1(async () => ({
            chatId: 'chat-max',
            channel: 'max',
            contactId: 'contact-max',
            contactIdentityId: 'identity-max',
            providerAccountId,
            connectionId: 'max_scraper',
            identityTarget: 'max-sender-42',
            target: '902454841098',
            isMaxPersonal: true,
        }))
    })

    afterEach(() => unregisterOutboundPreparer?.())

    it('preserves a consistent real d301 delivery through max-actions and the capability', async () => {
        mockHttpPayload({
            success: true,
            providerAccountId,
            externalId: providerId,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
        })

        await expect(sendThroughRealHttpBoundary()).resolves.toEqual({
            outcome: 'delivered',
            externalId: providerId,
            resolvedChatId: null,
        })
    })

    it.each(failurePayloads)('rejects %s before contradictory delivered metadata can win', async (_label, failure) => {
        mockHttpPayload({
            ...failure,
            providerAccountId,
            externalId: providerId,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
        })

        await expect(sendThroughRealHttpBoundary()).rejects.toThrow(/provider failed|MAX text delivery failed/)
    })

    it('keeps a retry failed when failure:true contradicts delivered through the real MAX boundary', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-http-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry through real boundary',
            clientMessageId: 'cmid-http-retry',
            status: 'failed',
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: {
                id: 'chat-max',
                externalChatId: 'max:902454841098',
                metadata: {},
                driver: null,
            },
        })
        mockHttpPayload({
            success: true,
            failure: true,
            providerAccountId,
            externalId: providerId,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
        })

        await expect(MessageService.retrySend('message-http-retry')).resolves.toEqual({
            success: false,
            error: 'MAX text delivery failed',
        })

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.messageUpdateMany.mock.calls.at(-1)?.[0]).toMatchObject({
            where: expect.objectContaining({ id: 'message-http-retry', status: 'sent' }),
            data: {
                status: 'failed',
                externalId: undefined,
                metadata: expect.objectContaining({
                    error: 'MAX text delivery failed',
                }),
            },
        })
        expect(mocks.onOutboundMessage).not.toHaveBeenCalled()
    })
})
