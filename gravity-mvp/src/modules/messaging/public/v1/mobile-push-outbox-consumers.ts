import {
    INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1,
    MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1,
} from '../../../../contracts/messaging/v1'
import type { OutboxPublisherRegistryV1 } from '../../../../infrastructure/outbox/v1'
import { mobilePushDispatchV1 } from '../../internal/mobile-push/mobile-push-runtime'

/**
 * Messaging's outbox consumers (Mobile Push v1). Each handler parses its
 * versioned contract before doing anything; an unsupported payload fails
 * closed into retry and dead letter.
 */
export const messagingOutboxPublishersV1: OutboxPublisherRegistryV1 = {
    [INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1]: async (payload) => {
        await mobilePushDispatchV1.handleInboundNotificationRequested(payload)
    },
    [MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1]: async (payload) => {
        await mobilePushDispatchV1.handleDeliveryRequested(payload)
    },
}
