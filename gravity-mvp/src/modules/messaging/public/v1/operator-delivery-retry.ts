import { MessageService } from '@/lib/MessageService'
import { broadcastChatMessageV1 } from './message-stream'

export interface OperatorRetriedMessageV1 {
    id: string
    chatId: string
    clientMessageId: string | null
    status: string
    externalId: string | null
    error: string | null
    retryable: boolean
    deliveryOutcome: string | null
}

export type OperatorDeliveryRetryResultV1 = {
    ok: boolean
    error: string | null
    /** The persisted row after the attempt, or null when no such message exists. */
    message: OperatorRetriedMessageV1 | null
}

function metadataRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Messaging-owned operator retry of ONE persisted outbound message.
 *
 * It is the unattended retry job's own MessageService.retrySend: the same
 * Message row and clientMessageId, the same failed+updatedAt lease that lets
 * only one concurrent attempt dispatch, and the same refusal of anything not
 * failed, not safe to redeliver or past its attempt limit. Only the job's
 * pacing backoff is skipped, because a person asked. It never creates a
 * Message and never resends a message whose delivery outcome is unknown.
 */
export async function retryFailedOutboundMessageV1(messageId: unknown): Promise<OperatorDeliveryRetryResultV1> {
    if (typeof messageId !== 'string' || messageId.trim() === '' || messageId !== messageId.trim()) {
        return { ok: false, error: 'MESSAGE_ID_REQUIRED', message: null }
    }

    const attempt = await MessageService.retrySend(messageId, { operatorInitiated: true })
    const row = await MessageService.readSendState(messageId)
    if (!row) return { ok: false, error: attempt.error ?? 'Message not found', message: null }

    const metadata = metadataRecord(row.metadata)
    const message: OperatorRetriedMessageV1 = {
        id: row.id,
        chatId: row.chatId,
        clientMessageId: row.clientMessageId,
        status: row.status,
        externalId: row.externalId,
        error: row.status === 'failed' ? optionalString(metadata.error) : null,
        retryable: row.status === 'failed' && metadata.retryable === true,
        deliveryOutcome: row.status === 'failed' ? optionalString(metadata.deliveryOutcome) : null,
    }
    // Other open views of this conversation settle on the same row.
    broadcastChatMessageV1(row.chatId, row)

    return { ok: attempt.success, error: attempt.success ? null : attempt.error ?? null, message }
}
