'use server'

import {
    retryFailedOutboundMessageV1,
    type OperatorDeliveryRetryResultV1,
} from '@/modules/messaging/public/v1/operator-delivery-retry'

/**
 * «Повторить» on a persisted failed outbound message. Retries THAT message —
 * same row, same clientMessageId — through the Messaging-owned retry
 * capability; it never sends a new message.
 *
 * An action that throws answers HTTP 500 to the page, so a failure is returned
 * as data instead.
 */
export async function retryFailedMessageAction(messageId: string): Promise<OperatorDeliveryRetryResultV1> {
    try {
        return await retryFailedOutboundMessageV1(messageId)
    } catch (error: unknown) {
        console.error('[retryFailedMessageAction] retry failed:', error instanceof Error ? error.message : error)
        return { ok: false, error: 'Не удалось повторить отправку', message: null }
    }
}
