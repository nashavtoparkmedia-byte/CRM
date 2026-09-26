import {
    makeInboundMessageNotificationRequestedEventV1,
    type InboundMessageNotificationRequestedEventV1,
} from '../../../../contracts/messaging/v1'
import {
    isInboundNotificationCandidateV1,
    qualifiesForInboundNotificationV1,
    type InboundNotificationCandidateV1,
    type PersistedInboundMessageV1,
} from './inbound-notification-policy'
import { isMobilePushEnabledV1 } from './mobile-push-config'

/**
 * Mobile Push v1 — the intent side of the three Messaging persistence seams
 * (channel-message create, external-message upsert, receive-message create).
 *
 * `persistsWithNotificationIntentV1` decides, from the write's input alone,
 * whether the write takes the transactional path. When push is disabled, or
 * the write can never qualify, the seam keeps its original single-statement
 * write untouched.
 *
 * `inboundNotificationIntentV1` runs INSIDE that transaction on the persisted
 * row; the seam appends the returned event with an explicit, field-by-field
 * outbox row, so the Message and its intent commit together or not at all.
 */

export function persistsWithNotificationIntentV1(input: InboundNotificationCandidateV1): boolean {
    return isMobilePushEnabledV1() && isInboundNotificationCandidateV1(input)
}

export function inboundNotificationIntentV1(
    message: PersistedInboundMessageV1,
    now: Date,
): InboundMessageNotificationRequestedEventV1 | null {
    const channel = qualifiesForInboundNotificationV1(message, now)
    if (!channel) return null
    return makeInboundMessageNotificationRequestedEventV1({
        messageId: message.id,
        chatId: message.chatId,
        channel,
        occurredAt: now.toISOString(),
    })
}
