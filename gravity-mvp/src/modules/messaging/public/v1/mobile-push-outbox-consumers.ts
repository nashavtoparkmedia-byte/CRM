import {
    INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1,
    MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1,
} from '../../../../contracts/messaging/v1'
import type { OutboxPublisherRegistryV1 } from '../../../../infrastructure/outbox/v1'
import {
    handleInboundMessageNotificationRequestedV1,
    handleMobilePushDeliveryRequestedV1,
} from '../../application/mobile-push-operations'

/**
 * Messaging's outbox consumers (Mobile Push v1). Each handler parses its
 * versioned contract before doing anything; an unsupported payload fails
 * closed into retry and dead letter.
 */
export const messagingOutboxPublishersV1: OutboxPublisherRegistryV1 = {
    [INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1]: async (payload) => {
        await handleInboundMessageNotificationRequestedV1(payload)
    },
    [MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1]: async (payload) => {
        await handleMobilePushDeliveryRequestedV1(payload)
    },
}
