import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    listPushEligibleMobileDevicesV1,
    markMobilePushTokenRejectedV1,
    revokeMobilePushSenderMismatchV1,
} from '@/modules/identity-access/public/v1'
// The reviewed secret-bearing capability: the only way a token is obtained.
import { resolveMobilePushTargetV1 } from '@/modules/identity-access/public/v1/mobile-push-target-capability'
import {
    isMobileDeliveryEnabledV1,
    resolveMobileDeliveryTransportV1,
} from '@/modules/identity-access/public/v1/mobile-delivery'
import { createCallAlertDispatchV1 } from './call-alert-dispatch'
import { prismaCallAlertOutboxV1 } from './call-alert-prisma-adapter'

/**
 * Production wiring for call alerts.
 *
 * Every dependency crosses a context boundary through a public surface: device
 * eligibility, the push target and token state from identity_access, and
 * delivery enablement and the provider transport from the mobile-delivery
 * boundary identity_access owns. Calling holds no provider configuration and no
 * device registry of its own.
 */

export const callAlertDispatchV1 = createCallAlertDispatchV1({
    isEnabled: () => isMobileDeliveryEnabledV1(),
    now: () => new Date(),
    listEligibleDevices: () => listPushEligibleMobileDevicesV1(),
    appendDeliveryEvents: (events) => prismaCallAlertOutboxV1.appendDeliveryEvents(events),
    resolveTarget: (registrationId, sessionBindingId) => resolveMobilePushTargetV1(registrationId, sessionBindingId),
    markTokenRejected: (registrationId, rejectedToken) => markMobilePushTokenRejectedV1(registrationId, rejectedToken),
    revokeSenderMismatch: (registrationId, rejectedToken) => revokeMobilePushSenderMismatchV1(registrationId, rejectedToken),
    transport: resolveMobileDeliveryTransportV1,
    log: (level, event, context) => opsLog(level, event, { operation: 'call_alert', ...context }),
})
