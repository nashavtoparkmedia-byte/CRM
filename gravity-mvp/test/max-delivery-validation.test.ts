import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    sendMaxMessage: vi.fn(),
    registerMaxChannelDeliveryV1: vi.fn(),
}))

vi.mock('@/app/max-actions', () => ({
    sendMaxMessage: mocks.sendMaxMessage,
}))

vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    registerMaxChannelDeliveryV1: mocks.registerMaxChannelDeliveryV1,
}))

vi.mock('@/modules/max-channel/public/v1/reaction-delivery', () => ({
    sendMaxReactionDeliveryV1: vi.fn(),
}))

import { registerMaxMessagingDeliveryCapabilityV1 } from '../src/modules/max-channel/public/v1/messaging-delivery-capability'

const providerId = 'd3010000000000000001'
const pendingCases: Array<[Record<string, unknown>, string]> = [
    [{ success: true, deliveryStatus: 'send_requested' }, 'send_requested'],
    [{ success: true, deliveryStatus: 'max_echo_pending' }, 'intermediate'],
    [{}, 'empty'],
    [{ success: true, deliveryConfirmed: true }, 'partial'],
    [{
        success: true,
        deliveryConfirmed: true,
        deliveryStatus: 'delivered',
        deliveryProof: {
            kind: 'ui_send_action',
            clientMessageId: 'different-operation',
            actionConfirmed: true,
        },
    }, 'mismatched UI operation'],
]

const contradictoryFailureCases: Array<Record<string, unknown>> = [
    { success: false, error: 'provider failed', deliveryConfirmed: true, deliveryStatus: 'delivered' },
    { success: true, failed: true, deliveryConfirmed: true, deliveryStatus: 'delivered' },
    { success: true, failure: true, deliveryConfirmed: true, deliveryStatus: 'delivered' },
    { success: true, error: 'provider failed', deliveryConfirmed: true, deliveryStatus: 'delivered' },
    { success: true, error: { code: 'provider.failed' }, deliveryConfirmed: true, deliveryStatus: 'delivered' },
]

describe('MAX-owned text delivery validation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    async function validate(raw: unknown, clientMessageId = 'cmid-ui') {
        mocks.sendMaxMessage.mockResolvedValueOnce(raw)
        registerMaxMessagingDeliveryCapabilityV1()
        const capability = mocks.registerMaxChannelDeliveryV1.mock.calls.at(-1)?.[0]
        return capability.sendText({
            target: '902454841098',
            content: 'Bounded repair',
            options: { isPersonal: true, clientMessageId },
        })
    }

    it('accepts a confirmed real provider message id', async () => {
        await expect(validate({
            success: true,
            externalId: providerId,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
        }, 'cmid-provider')).resolves.toEqual({
            outcome: 'delivered',
            externalId: providerId,
            resolvedChatId: null,
        })
    })

    it('accepts send-specific UI confirmation without a provider id', async () => {
        await expect(validate({
            success: true,
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            deliveryProof: {
                kind: 'ui_send_action',
                clientMessageId: 'cmid-ui',
                actionConfirmed: true,
            },
        })).resolves.toEqual({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: null,
        })
    })

    it.each(pendingCases)('keeps %s result pending (%s)', async (raw) => {
        await expect(validate(raw)).resolves.toEqual({
            outcome: 'pending',
            externalId: null,
            resolvedChatId: null,
        })
    })

    it.each(contradictoryFailureCases)('fails closed when failure contradicts delivered metadata', async (raw) => {
        await expect(validate(raw, 'cmid-error')).rejects.toThrow(/provider failed|MAX delivery failed/)
    })
})
