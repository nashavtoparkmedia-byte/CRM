import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    listPushEligibleMobileDevicesV1,
    markMobilePushTokenRejectedV1,
    revokeMobilePushSenderMismatchV1,
} from '@/modules/identity-access/public/v1'
// The reviewed secret-bearing capability; this runtime is its only consumer.
import { resolveMobilePushTargetV1 } from '@/modules/identity-access/public/v1/mobile-push-target-capability'
import {
    isMobileDeliveryEnabledV1,
    resolveMobileDeliveryTransportV1,
} from '@/modules/mobile-delivery/public/v1'
import { createMobilePushDispatchV1 } from './mobile-push-dispatch'
import { prismaMobilePushFanOutStoreV1 } from './push-fan-out-prisma-adapter'

/**
 * Production wiring for Mobile Push v1.
 *
 * The transport and the global enablement switch come from mobile_delivery's
 * public surface. This runtime holds no provider configuration: memoisation and
 * the access-token cache live with the context that owns the provider.
 */

export const mobilePushDispatchV1 = createMobilePushDispatchV1({
    isEnabled: () => isMobileDeliveryEnabledV1(),
    now: () => new Date(),
    findChat: (chatId) => prismaMobilePushFanOutStoreV1.findChatForNotification(chatId),
    listEligibleDevices: () => listPushEligibleMobileDevicesV1(),
    appendDeliveryEvents: (events) => prismaMobilePushFanOutStoreV1.appendDeliveryEvents(events),
    resolveTarget: (registrationId, sessionBindingId) => resolveMobilePushTargetV1(registrationId, sessionBindingId),
    markTokenRejected: (registrationId, rejectedToken) => markMobilePushTokenRejectedV1(registrationId, rejectedToken),
    revokeSenderMismatch: (registrationId, rejectedToken) => revokeMobilePushSenderMismatchV1(registrationId, rejectedToken),
    transport: resolveMobileDeliveryTransportV1,
    log: (level, event, context) => opsLog(level, event, { operation: 'mobile_push', ...context }),
})
