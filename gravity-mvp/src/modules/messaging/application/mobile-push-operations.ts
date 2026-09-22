import { mobilePushDispatchV1 } from '../internal/mobile-push/mobile-push-runtime'

/**
 * Mobile Push v1 outbox operations: the application seam between Messaging's
 * public outbox consumers and its internal dispatch runtime.
 */

export async function handleInboundMessageNotificationRequestedV1(payload: unknown): Promise<void> {
    await mobilePushDispatchV1.handleInboundNotificationRequested(payload)
}

export async function handleMobilePushDeliveryRequestedV1(payload: unknown): Promise<void> {
    await mobilePushDispatchV1.handleDeliveryRequested(payload)
}
