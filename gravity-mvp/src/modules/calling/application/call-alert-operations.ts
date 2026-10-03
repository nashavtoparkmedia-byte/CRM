import {
    makeCallAlertRequestedEventV1,
    parseCallAlertDeliveryRequestedEventV1,
    parseCallAlertRequestedEventV1,
    type CallAlertKindV1,
} from '@/contracts/calling/v1'
import { isMobileDeliveryEnabledV1 } from '@/modules/identity-access/public/v1/mobile-delivery'
import { callAlertDispatchV1 } from '../internal/call-alerts/call-alert-runtime'
import { prismaCallAlertOutboxV1 } from '../internal/call-alerts/call-alert-prisma-adapter'
import {
    callAlertKindForTransitionV1,
    type CallAlertTransitionV1,
} from '../internal/call-alerts/call-alert-transition'

/**
 * Call alerts: the operations the rest of Calling calls.
 *
 * `recordCallStateTransitionV1` is the one entry point for state changes that
 * might warrant an alert, so every path that moves a call - the hangup handler,
 * the reconciliation sweep, the inbound create - gets the same answer without
 * knowing the rule.
 *
 * Nothing is written while global mobile delivery is disabled. That keeps the
 * promise the switch makes: off means no intent anywhere, so turning delivery on
 * later cannot flush a backlog of stale alerts at operators' phones.
 */

export async function recordCallStateTransitionV1(transition: CallAlertTransitionV1, callId: string): Promise<CallAlertKindV1 | null> {
    const kind = callAlertKindForTransitionV1(transition)
    if (kind === null) return null
    if (!isMobileDeliveryEnabledV1()) return null

    await prismaCallAlertOutboxV1.appendAlertEvent(makeCallAlertRequestedEventV1({
        callId,
        kind,
        occurredAt: new Date().toISOString(),
    }))
    return kind
}

export async function handleCallAlertRequestedV1(payload: unknown): Promise<void> {
    await callAlertDispatchV1.fanOut(parseCallAlertRequestedEventV1(payload))
}

export async function handleCallAlertDeliveryRequestedV1(payload: unknown): Promise<void> {
    await callAlertDispatchV1.deliver(parseCallAlertDeliveryRequestedEventV1(payload))
}
