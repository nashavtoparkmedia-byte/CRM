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

/**
 * Regression for the phone-first zero-state path.
 *
 * The scraper resolves a phone by typing into the MAX compose box and confirming
 * the exact text left it, then binds the conversation from a send-bound signal.
 * That is the same evidence the direct-UI and UI-fallback paths report as a
 * delivery proof, but the phone path used to answer 'send_requested' with no
 * proof. Gravity then stored the message as merely sent, the recovery sweeper
 * marked it failed after five minutes, and the retry job sent the contact a
 * second copy of a message they had already received.
 *
 * These are the literal payloads that path emits, before and after the fix.
 */
describe('MAX phone-first zero-state delivery contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    async function validate(raw: unknown, clientMessageId = 'cmid-zero-state') {
        mocks.sendMaxMessage.mockResolvedValueOnce(raw)
        registerMaxMessagingDeliveryCapabilityV1()
        const capability = mocks.registerMaxChannelDeliveryV1.mock.calls.at(-1)?.[0]
        return capability.sendText({
            target: '79222155750',
            content: 'first message from zero state',
            options: { isPersonal: true, clientMessageId },
        })
    }

    it('the pre-fix payload is not a delivery, which is what caused the sweep and the duplicate', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            externalId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'send_requested',
            source: 'ui_resolve_send',
        })).resolves.toEqual({
            outcome: 'pending',
            externalId: null,
            resolvedChatId: '902100000001',
        })
    })

    it('accepts the fixed payload as delivered, and still carries the binding', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            externalId: null,
            maxMessageId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            source: 'ui_resolve_send',
            deliveryProof: {
                kind: 'ui_send_action',
                clientMessageId: 'cmid-zero-state',
                actionConfirmed: true,
            },
        })).resolves.toEqual({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: '902100000001',
        })
    })

    it('refuses a proof bound to somebody else’s message', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            deliveryProof: {
                kind: 'ui_send_action',
                clientMessageId: 'a-different-send',
                actionConfirmed: true,
            },
        })).resolves.toMatchObject({ outcome: 'pending' })
    })

    it('refuses a proof that never confirmed the action', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            deliveryProof: {
                kind: 'ui_send_action',
                clientMessageId: 'cmid-zero-state',
                actionConfirmed: false,
            },
        })).resolves.toMatchObject({ outcome: 'pending' })
    })

    it('keeps an explicit scraper failure a failure', async () => {
        await expect(validate({
            success: false,
            error: 'MAX UI send did not take effect: the message was not submitted',
            chatId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'failed',
        })).rejects.toThrow(/did not take effect/)
    })

    it('reports delivered without asserting a binding when no chat id was bound', async () => {
        await expect(validate({
            success: true,
            chatId: null,
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            source: 'ui_resolve_send_unconfirmed',
            deliveryProof: {
                kind: 'ui_send_action',
                clientMessageId: 'cmid-zero-state',
                actionConfirmed: true,
            },
        })).resolves.toEqual({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: null,
        })
    })
})
