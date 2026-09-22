import {
    makeMobilePushDeliveryRequestedEventV1,
    parseInboundMessageNotificationRequestedEventV1,
    parseMobilePushDeliveryRequestedEventV1,
    type MobilePushDeliveryRequestedEventV1,
} from '../../../../contracts/messaging/v1'
import type {
    MobilePushEligibleDeviceV1,
    MobilePushTargetResolutionV1,
} from '../../../../contracts/identity-access/v1'
import type { FcmTransportConfigProblemV1 } from './mobile-push-config'
import type { MobilePushTransportV1 } from './fcm-http-v1-transport'

/**
 * Mobile Push v1 outbox consumers: intent → per-device deliveries → provider.
 *
 * Outcomes follow the outbox's own contract. Returning normally publishes the
 * event (delivered, or deliberately skipped); throwing retries it with bounded
 * backoff and dead-letters it when the budget is spent. So:
 *
 *  - disabled, stale session, revoked, ineligible, group chat, deleted chat →
 *    a deliberate, logged skip (published);
 *  - awaiting a token, token rotated mid-send, provider transient failure,
 *    enabled-but-misconfigured → retry, and visible dead letter if it persists;
 *  - a provider rejection of the request itself → retry into dead letter,
 *    never a token retirement.
 *
 * Error messages are fixed codes. No token, credential or content ever reaches
 * a thrown error, a log line or an outbox row.
 */

export class MobilePushRetryError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = 'MobilePushRetryError'
    }
}

/** The data payload the device receives. Identifiers only; the device rebuilds navigation. */
export function mobilePushDataPayloadV1(event: MobilePushDeliveryRequestedEventV1): Readonly<Record<string, string>> {
    return {
        v: '1',
        kind: 'chat_message',
        chatId: event.data.chatId,
        messageId: event.data.messageId,
        channel: event.data.channel,
    }
}

export interface MobilePushDispatchDependenciesV1 {
    isEnabled(): boolean
    now(): Date
    findChat(chatId: string): Promise<{ id: string, chatType: string } | null>
    listEligibleDevices(): Promise<MobilePushEligibleDeviceV1[]>
    appendDeliveryEvents(events: readonly MobilePushDeliveryRequestedEventV1[]): Promise<number>
    resolveTarget(registrationId: string, sessionBindingId: string): Promise<MobilePushTargetResolutionV1>
    markTokenRejected(registrationId: string, rejectedToken: string): Promise<{ result: 'cleared' | 'already_rotated' }>
    revokeSenderMismatch(registrationId: string, rejectedToken: string): Promise<{ result: 'revoked' | 'already_rotated' }>
    transport(): { ok: true, transport: MobilePushTransportV1 } | { ok: false, problem: FcmTransportConfigProblemV1 }
    log(level: 'info' | 'warn' | 'error', event: string, context: Record<string, string | number>): void
}

export function createMobilePushDispatchV1(dependencies: MobilePushDispatchDependenciesV1) {
    return {
        async handleInboundNotificationRequested(payload: unknown): Promise<void> {
            const intent = parseInboundMessageNotificationRequestedEventV1(payload)
            const { messageId, chatId, channel } = intent.data
            if (!dependencies.isEnabled()) {
                dependencies.log('info', 'mobile_push_intent_suppressed', { messageId, reason: 'disabled' })
                return
            }
            const chat = await dependencies.findChat(chatId)
            if (!chat) {
                dependencies.log('info', 'mobile_push_intent_skipped', { messageId, reason: 'chat_missing' })
                return
            }
            if (chat.chatType !== 'private') {
                dependencies.log('info', 'mobile_push_intent_skipped', { messageId, reason: 'group_chat' })
                return
            }
            const devices = await dependencies.listEligibleDevices()
            const occurredAt = dependencies.now().toISOString()
            const deliveries = devices.map((device) => makeMobilePushDeliveryRequestedEventV1({
                messageId,
                chatId,
                channel,
                registrationId: device.registrationId,
                sessionBindingId: device.sessionBindingId,
                occurredAt,
            }))
            const appended = await dependencies.appendDeliveryEvents(deliveries)
            dependencies.log('info', 'mobile_push_fanned_out', { messageId, devices: deliveries.length, appended })
        },

        async handleDeliveryRequested(payload: unknown): Promise<void> {
            const delivery = parseMobilePushDeliveryRequestedEventV1(payload)
            const { messageId, registrationId, sessionBindingId } = delivery.data
            if (!dependencies.isEnabled()) {
                dependencies.log('info', 'mobile_push_delivery_suppressed', { messageId, registrationId, reason: 'disabled' })
                return
            }
            const configured = dependencies.transport()
            if (!configured.ok) {
                dependencies.log('error', 'mobile_push_transport_misconfigured', { messageId, registrationId, problem: configured.problem })
                throw new MobilePushRetryError(`MOBILE_PUSH_TRANSPORT_MISCONFIGURED:${configured.problem}`)
            }

            const target = await dependencies.resolveTarget(registrationId, sessionBindingId)
            if (target.kind === 'skip') {
                dependencies.log('info', 'mobile_push_delivery_skipped', { messageId, registrationId, reason: target.reason })
                return
            }
            if (target.kind === 'await_token') {
                dependencies.log('warn', 'mobile_push_delivery_awaiting_token', { messageId, registrationId })
                throw new MobilePushRetryError('MOBILE_PUSH_AWAITING_TOKEN')
            }

            const outcome = await configured.transport.send({ token: target.token, data: mobilePushDataPayloadV1(delivery) })
            switch (outcome.kind) {
                case 'delivered':
                    dependencies.log('info', 'mobile_push_delivered', { messageId, registrationId })
                    return
                case 'retryable':
                    dependencies.log('warn', 'mobile_push_delivery_retryable', { messageId, registrationId, code: outcome.code })
                    throw new MobilePushRetryError(`MOBILE_PUSH_RETRYABLE:${outcome.code}`)
                case 'token_unregistered':
                case 'token_invalid': {
                    // Clear exactly the token the provider rejected. If the device
                    // already rotated, its new token survives and the retry uses it.
                    const cleared = await dependencies.markTokenRejected(registrationId, target.token)
                    dependencies.log('warn', 'mobile_push_token_rejected', { messageId, registrationId, result: cleared.result })
                    throw new MobilePushRetryError(cleared.result === 'cleared' ? 'MOBILE_PUSH_AWAITING_TOKEN' : 'MOBILE_PUSH_TOKEN_ROTATED')
                }
                case 'sender_mismatch': {
                    const revoked = await dependencies.revokeSenderMismatch(registrationId, target.token)
                    dependencies.log('error', 'mobile_push_sender_mismatch', { messageId, registrationId, result: revoked.result })
                    if (revoked.result === 'already_rotated') throw new MobilePushRetryError('MOBILE_PUSH_TOKEN_ROTATED')
                    return
                }
                case 'terminal':
                    dependencies.log('error', 'mobile_push_provider_rejected_request', { messageId, registrationId, code: outcome.code })
                    throw new MobilePushRetryError(`MOBILE_PUSH_PROVIDER_REJECTED:${outcome.code}`)
            }
        },
    }
}

export type MobilePushDispatchV1 = ReturnType<typeof createMobilePushDispatchV1>
