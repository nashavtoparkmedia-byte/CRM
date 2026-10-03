import type { MobilePushEligibleDeviceV1, MobilePushTargetResolutionV1 } from '@/contracts/identity-access/v1'
import type { MobilePushTransportProblemV1, MobilePushTransportV1 } from '@/contracts/identity-access/v1'
import {
    makeCallAlertDeliveryRequestedEventV1,
    type CallAlertDeliveryRequestedEventV1,
    type CallAlertKindV1,
    type CallAlertRequestedEventV1,
} from '@/contracts/calling/v1'

/**
 * Call alerts, from one semantic alert to one provider request per device.
 *
 * Two steps, each an outbox consumer, so a failure retries at the granularity it
 * happened: fanning out cannot re-send to devices that already succeeded, and one
 * unreachable device cannot hold up the rest.
 *
 * The audience is every eligible registration. That is the product decision for
 * V1 - no operator assignment, no duty manager, no queue, no presence, no
 * first-wins - and it is expressible directly because identity_access's eligible
 * listing takes no arguments.
 *
 * Retrying is safe by construction rather than by bookkeeping: the per-device
 * event id derives from (callId, kind, registrationId) and the append skips
 * duplicates, so a retried fan-out adds nothing.
 */

/** Retryable by the outbox. Never carries a token or a credential value. */
export class CallAlertRetryError extends Error {
    constructor(reason: string) {
        super(reason)
        this.name = 'CallAlertRetryError'
    }
}

export interface CallAlertDispatchDependenciesV1 {
    isEnabled(): boolean
    now(): Date
    listEligibleDevices(): Promise<MobilePushEligibleDeviceV1[]>
    appendDeliveryEvents(events: readonly CallAlertDeliveryRequestedEventV1[]): Promise<number>
    resolveTarget(registrationId: string, sessionBindingId: string): Promise<MobilePushTargetResolutionV1>
    markTokenRejected(registrationId: string, rejectedToken: string): Promise<{ result: 'cleared' | 'already_rotated' }>
    revokeSenderMismatch(registrationId: string, rejectedToken: string): Promise<{ result: 'revoked' | 'already_rotated' }>
    transport(): { ok: true, transport: MobilePushTransportV1 } | { ok: false, problem: MobilePushTransportProblemV1 }
    log(level: 'info' | 'warn' | 'error', event: string, context: Record<string, string | number>): void
}

/** Exactly what a device receives. Privacy-safe by omission: no number, no name. */
export function callAlertDataPayloadV1(kind: CallAlertKindV1, callId: string): Readonly<Record<string, string>> {
    return { v: '1', kind, callId }
}

export function createCallAlertDispatchV1(dependencies: CallAlertDispatchDependenciesV1) {
    return {
        async fanOut(alert: CallAlertRequestedEventV1): Promise<void> {
            const { callId, kind } = alert.data
            if (!dependencies.isEnabled()) {
                dependencies.log('info', 'call_alert_fan_out_skipped', { callId, kind, reason: 'disabled' })
                return
            }

            const devices = await dependencies.listEligibleDevices()
            if (devices.length === 0) {
                dependencies.log('info', 'call_alert_no_eligible_devices', { callId, kind })
                return
            }

            const occurredAt = dependencies.now().toISOString()
            const appended = await dependencies.appendDeliveryEvents(devices.map((device) =>
                makeCallAlertDeliveryRequestedEventV1({
                    callId,
                    kind,
                    registrationId: device.registrationId,
                    sessionBindingId: device.sessionBindingId,
                    occurredAt,
                    correlationId: alert.correlationId,
                    causationId: alert.eventId,
                }),
            ))
            dependencies.log('info', 'call_alert_fanned_out', { callId, kind, devices: devices.length, appended })
        },

        async deliver(delivery: CallAlertDeliveryRequestedEventV1): Promise<void> {
            const { callId, kind, registrationId, sessionBindingId } = delivery.data
            if (!dependencies.isEnabled()) {
                dependencies.log('info', 'call_alert_delivery_skipped', { callId, kind, registrationId, reason: 'disabled' })
                return
            }

            const configured = dependencies.transport()
            if (!configured.ok) {
                // Enabled with unusable provider configuration is operational, not
                // a silent drop: it retries into the outbox's bounded dead letter.
                dependencies.log('error', 'call_alert_transport_misconfigured', { callId, kind, registrationId, problem: configured.problem })
                throw new CallAlertRetryError(`CALL_ALERT_TRANSPORT:${configured.problem}`)
            }

            const target = await dependencies.resolveTarget(registrationId, sessionBindingId)
            if (target.kind === 'skip') {
                dependencies.log('info', 'call_alert_delivery_skipped', { callId, kind, registrationId, reason: target.reason })
                return
            }
            if (target.kind === 'await_token') {
                dependencies.log('warn', 'call_alert_awaiting_token', { callId, kind, registrationId })
                throw new CallAlertRetryError('CALL_ALERT_AWAITING_TOKEN')
            }

            const outcome = await configured.transport.send({
                token: target.token,
                data: callAlertDataPayloadV1(kind, callId),
            })
            switch (outcome.kind) {
                case 'delivered':
                    dependencies.log('info', 'call_alert_delivered', { callId, kind, registrationId })
                    return
                case 'retryable':
                    dependencies.log('warn', 'call_alert_delivery_retryable', { callId, kind, registrationId, code: outcome.code })
                    throw new CallAlertRetryError(`CALL_ALERT_RETRYABLE:${outcome.code}`)
                case 'token_unregistered':
                case 'token_invalid': {
                    // Clear exactly the token the provider rejected, through the
                    // capability that owns it. A device that already rotated keeps
                    // its new token and the retry uses that one.
                    const cleared = await dependencies.markTokenRejected(registrationId, target.token)
                    dependencies.log('warn', 'call_alert_token_rejected', { callId, kind, registrationId, result: cleared.result })
                    throw new CallAlertRetryError(cleared.result === 'cleared' ? 'CALL_ALERT_AWAITING_TOKEN' : 'CALL_ALERT_TOKEN_ROTATED')
                }
                case 'sender_mismatch': {
                    const revoked = await dependencies.revokeSenderMismatch(registrationId, target.token)
                    dependencies.log('error', 'call_alert_sender_mismatch', { callId, kind, registrationId, result: revoked.result })
                    if (revoked.result === 'already_rotated') throw new CallAlertRetryError('CALL_ALERT_TOKEN_ROTATED')
                    return
                }
                case 'terminal':
                    dependencies.log('error', 'call_alert_provider_rejected_request', { callId, kind, registrationId, code: outcome.code })
                    throw new CallAlertRetryError(`CALL_ALERT_PROVIDER_REJECTED:${outcome.code}`)
            }
        },
    }
}
