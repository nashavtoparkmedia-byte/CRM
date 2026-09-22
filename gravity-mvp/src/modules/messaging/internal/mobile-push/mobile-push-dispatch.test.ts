// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
    makeInboundMessageNotificationRequestedEventV1,
    makeMobilePushDeliveryRequestedEventV1,
    type MobilePushDeliveryRequestedEventV1,
} from '../../../../contracts/messaging/v1'
import type { MobilePushTargetResolutionV1 } from '../../../../contracts/identity-access/v1'
import type { MobilePushSendOutcomeV1 } from './fcm-http-v1-transport'
import {
    createMobilePushDispatchV1,
    mobilePushDataPayloadV1,
    type MobilePushDispatchDependenciesV1,
} from './mobile-push-dispatch'

const TOKEN = 'dispatch-token_0123456789:abcdefghijklmnopqrstuv'
const BINDING = 'b'.repeat(64)
const OCCURRED = '2026-09-22T12:00:00.000Z'
const intent = makeInboundMessageNotificationRequestedEventV1({ messageId: 'msg_1', chatId: 'chat_1', channel: 'telegram', occurredAt: OCCURRED })
const delivery = makeMobilePushDeliveryRequestedEventV1({
    messageId: 'msg_1', chatId: 'chat_1', channel: 'telegram', registrationId: 'reg_1', sessionBindingId: BINDING, occurredAt: OCCURRED,
})

function harness(overrides: Partial<MobilePushDispatchDependenciesV1> = {}, sendOutcome: MobilePushSendOutcomeV1 = { kind: 'delivered' }) {
    const logs: Array<{ level: string, event: string, context: Record<string, string | number> }> = []
    const appended: MobilePushDeliveryRequestedEventV1[][] = []
    const send = vi.fn(async () => sendOutcome)
    const dependencies: MobilePushDispatchDependenciesV1 = {
        isEnabled: () => true,
        now: () => new Date(OCCURRED),
        findChat: async (chatId) => ({ id: chatId, chatType: 'private' }),
        listEligibleDevices: async () => [
            { registrationId: 'reg_1', sessionBindingId: BINDING },
            { registrationId: 'reg_2', sessionBindingId: 'c'.repeat(64) },
        ],
        appendDeliveryEvents: async (events) => { appended.push([...events]); return events.length },
        resolveTarget: async (): Promise<MobilePushTargetResolutionV1> => ({ kind: 'send', token: TOKEN }),
        markTokenRejected: vi.fn(async () => ({ result: 'cleared' as const })),
        revokeSenderMismatch: vi.fn(async () => ({ result: 'revoked' as const })),
        transport: () => ({ ok: true, transport: { send } }),
        log: (level, event, context) => { logs.push({ level, event, context }) },
        ...overrides,
    }
    return { dispatch: createMobilePushDispatchV1(dependencies), dependencies, logs, appended, send }
}

describe('fan-out of a notification intent', () => {
    it('appends one delivery per eligible registration, snapshotting its session binding', async () => {
        const h = harness()
        await h.dispatch.handleInboundNotificationRequested(intent)
        expect(h.appended).toHaveLength(1)
        expect(h.appended[0].map((event) => event.eventId)).toEqual([
            'messaging.MobilePushDeliveryRequested.v1:msg_1:reg_1',
            'messaging.MobilePushDeliveryRequested.v1:msg_1:reg_2',
        ])
        expect(h.appended[0][0].data).toEqual({ messageId: 'msg_1', chatId: 'chat_1', channel: 'telegram', registrationId: 'reg_1', sessionBindingId: BINDING })
    })

    it('excludes group chats and deleted chats, and is silent when disabled', async () => {
        for (const overrides of [
            { findChat: async (chatId: string) => ({ id: chatId, chatType: 'group' }) },
            { findChat: async () => null },
            { isEnabled: () => false },
        ]) {
            const h = harness(overrides)
            await h.dispatch.handleInboundNotificationRequested(intent)
            expect(h.appended).toEqual([])
        }
    })

    it('never uses assignment: every eligible registration is addressed', async () => {
        const h = harness({ listEligibleDevices: async () => [{ registrationId: 'only', sessionBindingId: BINDING }] })
        await h.dispatch.handleInboundNotificationRequested(intent)
        expect(h.appended[0]).toHaveLength(1)
    })

    it('refuses a malformed intent before touching anything', async () => {
        const h = harness()
        await expect(h.dispatch.handleInboundNotificationRequested({ ...intent, data: { ...intent.data, token: TOKEN } })).rejects.toThrow()
        expect(h.appended).toEqual([])
    })
})

describe('delivery to one device', () => {
    it('sends the identifiers-only payload to the token resolved at send time', async () => {
        const h = harness()
        await h.dispatch.handleDeliveryRequested(delivery)
        expect(h.send).toHaveBeenCalledWith({ token: TOKEN, data: { v: '1', kind: 'chat_message', chatId: 'chat_1', messageId: 'msg_1', channel: 'telegram' } })
        expect(Object.keys(mobilePushDataPayloadV1(delivery)).sort()).toEqual(['channel', 'chatId', 'kind', 'messageId', 'v'])
    })

    it('publishes a deliberate skip for stale, revoked or ineligible targets without sending', async () => {
        for (const reason of ['stale_session', 'revoked', 'ineligible', 'not_found'] as const) {
            const h = harness({ resolveTarget: async () => ({ kind: 'skip', reason }) })
            await expect(h.dispatch.handleDeliveryRequested(delivery)).resolves.toBeUndefined()
            expect(h.send).not.toHaveBeenCalled()
        }
    })

    it('retries while the registration awaits a new token', async () => {
        const h = harness({ resolveTarget: async () => ({ kind: 'await_token' }) })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).rejects.toThrow('MOBILE_PUSH_AWAITING_TOKEN')
        expect(h.send).not.toHaveBeenCalled()
    })

    it('does nothing at all when push is disabled', async () => {
        const transport = vi.fn()
        const h = harness({ isEnabled: () => false, transport })
        await h.dispatch.handleDeliveryRequested(delivery)
        expect(transport).not.toHaveBeenCalled()
        expect(h.send).not.toHaveBeenCalled()
    })

    it('treats enabled-but-misconfigured as a visible failure, never a success', async () => {
        const h = harness({ transport: () => ({ ok: false, problem: 'missing_private_key' }) })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).rejects.toThrow('MOBILE_PUSH_TRANSPORT_MISCONFIGURED:missing_private_key')
        expect(h.logs).toContainEqual(expect.objectContaining({ level: 'error', event: 'mobile_push_transport_misconfigured' }))
    })

    it('clears exactly the rejected token and retries toward the next one', async () => {
        const h = harness({}, { kind: 'token_unregistered' })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).rejects.toThrow('MOBILE_PUSH_AWAITING_TOKEN')
        expect(h.dependencies.markTokenRejected).toHaveBeenCalledWith('reg_1', TOKEN)
    })

    it('retries on the new token when the device rotated during the send (CAS miss)', async () => {
        const h = harness({ markTokenRejected: vi.fn(async () => ({ result: 'already_rotated' as const })) }, { kind: 'token_invalid' })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).rejects.toThrow('MOBILE_PUSH_TOKEN_ROTATED')
    })

    it('revokes the registration on a sender mismatch and publishes', async () => {
        const h = harness({}, { kind: 'sender_mismatch' })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).resolves.toBeUndefined()
        expect(h.dependencies.revokeSenderMismatch).toHaveBeenCalledWith('reg_1', TOKEN)
    })

    it('never retires a token for a malformed-request rejection', async () => {
        const h = harness({}, { kind: 'terminal', code: 'INVALID_ARGUMENT' })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).rejects.toThrow('MOBILE_PUSH_PROVIDER_REJECTED:INVALID_ARGUMENT')
        expect(h.dependencies.markTokenRejected).not.toHaveBeenCalled()
        expect(h.dependencies.revokeSenderMismatch).not.toHaveBeenCalled()
    })

    it('retries transient provider failures', async () => {
        const h = harness({}, { kind: 'retryable', code: 'UNAVAILABLE' })
        await expect(h.dispatch.handleDeliveryRequested(delivery)).rejects.toThrow('MOBILE_PUSH_RETRYABLE:UNAVAILABLE')
    })

    it('never puts the device token into a thrown error or a log line', async () => {
        const outcomes: MobilePushSendOutcomeV1[] = [
            { kind: 'delivered' }, { kind: 'token_unregistered' }, { kind: 'token_invalid' }, { kind: 'sender_mismatch' },
            { kind: 'retryable', code: 'UNAVAILABLE' }, { kind: 'terminal', code: 'INVALID_ARGUMENT' },
        ]
        for (const outcome of outcomes) {
            const h = harness({}, outcome)
            const error = await h.dispatch.handleDeliveryRequested(delivery).then(() => null, (thrown: unknown) => thrown)
            expect(String(error)).not.toContain(TOKEN)
            expect(JSON.stringify(h.logs)).not.toContain(TOKEN)
        }
    })
})
