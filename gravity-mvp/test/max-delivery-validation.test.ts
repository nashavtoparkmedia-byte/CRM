import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    sendMaxTransportTextV1: vi.fn(),
    registerMaxChannelDeliveryV1: vi.fn(),
}))

vi.mock('@/modules/max-channel/application/messaging-transport', () => ({
    sendMaxTransportTextV1: mocks.sendMaxTransportTextV1,
}))

vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    registerMaxChannelDeliveryV1: mocks.registerMaxChannelDeliveryV1,
}))

vi.mock('@/modules/max-channel/public/v1/reaction-delivery', () => ({
    sendMaxReactionDeliveryV1: vi.fn(),
}))

import { registerMaxMessagingDeliveryCapabilityV1 } from '../src/modules/max-channel/public/v1/messaging-delivery-capability'

const providerId = 'd3010000000000000001'
const providerAccountId = 'live-account-a'
const pendingCases: Array<[Record<string, unknown>, string]> = [
    [{ success: true, deliveryStatus: 'send_requested', providerAccountId }, 'send_requested'],
    [{ success: true, deliveryStatus: 'max_echo_pending', providerAccountId }, 'intermediate'],
    [{ providerAccountId }, 'empty'],
    [{ success: true, deliveryConfirmed: true, providerAccountId }, 'partial'],
    [{
        success: true,
        deliveryConfirmed: true,
        deliveryStatus: 'delivered',
        providerAccountId,
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
        mocks.sendMaxTransportTextV1.mockResolvedValueOnce(raw)
        registerMaxMessagingDeliveryCapabilityV1()
        const capability = mocks.registerMaxChannelDeliveryV1.mock.calls.at(-1)?.[0]
        return capability.sendText({
            target: '902454841098',
            content: 'Bounded repair',
            options: {
                isPersonal: true,
                connectionId: 'max_scraper',
                providerAccountId,
                clientMessageId,
            },
        })
    }

    it('accepts a confirmed real provider message id', async () => {
        await expect(validate({
            success: true,
            externalId: providerId,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            providerAccountId,
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
            providerAccountId,
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

    it('fails closed when text delivery lacks exact live-account proof', async () => {
        await expect(validate({ success: true, deliveryStatus: 'send_requested' }))
            .rejects.toThrow('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    })
})

/**
 * The phone-first zero-state send. The scraper resolves a phone by typing into
 * the MAX compose box, confirming the exact text left it, and binding the new
 * conversation from a send-bound signal when one appears. These are the literal
 * responses that `/send-message` branch emits, captured by executing it.
 *
 * Before the fix it neither echoed the live account nor carried a proof, so this
 * boundary threw MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH and MessageService stored a
 * message the contact had received as failed. Echoing the account alone would
 * still leave it pending: stored as 'sent' without a provider id, which recovery
 * marks failed and retryable after five minutes, and the retry job re-sends.
 */
describe('MAX phone-first UI send contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    async function validate(raw: unknown, clientMessageId?: string) {
        mocks.sendMaxTransportTextV1.mockResolvedValueOnce(raw)
        registerMaxMessagingDeliveryCapabilityV1()
        const capability = mocks.registerMaxChannelDeliveryV1.mock.calls.at(-1)?.[0]
        return capability.sendText({
            target: '79222155750',
            content: 'first message from zero state',
            options: { isPersonal: true, connectionId: 'max_scraper', providerAccountId, clientMessageId },
        })
    }

    it('rejects the pre-fix response, which carries no live-account echo', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            externalId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'send_requested',
            source: 'ui_resolve_send',
        }, 'msg_phone_first')).rejects.toThrow('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    })

    it('keeps an echoed but proof-less response pending, which is what the sweep re-sends', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            providerAccountId,
            externalId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'send_requested',
            source: 'ui_resolve_send',
        }, 'msg_phone_first')).resolves.toEqual({
            outcome: 'pending',
            externalId: null,
            resolvedChatId: '902100000001',
        })
    })

    it('accepts the proven response as delivered and keeps the bound conversation', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            providerAccountId,
            externalId: null,
            maxMessageId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            source: 'ui_resolve_send',
            deliveryProof: { kind: 'ui_send_action', clientMessageId: 'msg_phone_first', actionConfirmed: true },
        }, 'msg_phone_first')).resolves.toEqual({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: '902100000001',
        })
    })

    it('accepts a proven send with no bound conversation as delivered without inventing a binding', async () => {
        await expect(validate({
            success: true,
            chatId: null,
            providerAccountId,
            externalId: null,
            maxMessageId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            source: 'ui_resolve_send_unconfirmed',
            deliveryProof: { kind: 'ui_send_action', clientMessageId: 'msg_phone_first', actionConfirmed: true },
        }, 'msg_phone_first')).resolves.toEqual({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: null,
        })
    })

    it('refuses a phone-first proof bound to a different message', async () => {
        await expect(validate({
            success: true,
            chatId: '902100000001',
            providerAccountId,
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            source: 'ui_resolve_send',
            deliveryProof: { kind: 'ui_send_action', clientMessageId: 'a-different-send', actionConfirmed: true },
        }, 'msg_phone_first')).resolves.toMatchObject({ outcome: 'pending' })
    })

    it('keeps an unproven submit a failure', async () => {
        await expect(validate({
            success: false,
            error: 'MAX UI send did not take effect: the message was not submitted',
            phone: '79222155750',
            chatId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'failed',
        }, 'msg_phone_first')).rejects.toThrow(/did not take effect/)
    })
})
