import { MessageService } from '@/lib/MessageService'
import { prisma } from '@/lib/prisma'

const STUCK_MESSAGE_AGE_MINUTES_V1 = 5

export type RetryEligibleMessagingDeliveriesResultV1 = {
    retriedCount: number
    candidatesFound: number
}

/**
 * Messaging-owned startup/periodic recovery policy. The caller cannot widen
 * the age window or select another message class.
 */
export async function recoverStuckMessagingDeliveriesV1(): Promise<number> {
    return MessageService.recoverStuckMessages(STUCK_MESSAGE_AGE_MINUTES_V1)
}

/**
 * Messaging-owned bounded retry job. Candidate selection and per-message
 * delivery stay behind this exact capability so schedulers never read or
 * mutate Message records directly. Only rows the current taxonomy (error
 * schema v2+) recorded as safe_to_redeliver are candidates; a v1 row marked
 * retryable, or any unknown or terminal outcome, is never selected, and
 * retrySend refuses it as well.
 */
export async function retryEligibleMessagingDeliveriesV1(): Promise<RetryEligibleMessagingDeliveriesResultV1> {
    const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Message"
        WHERE status = 'failed'
          AND direction = 'outbound'
          AND (metadata->>'retryable')::text = 'true'
          AND metadata->>'deliveryOutcome' = 'safe_to_redeliver'
          AND CASE WHEN metadata->>'errorSchemaVersion' ~ '^[0-9]+$'
                   THEN (metadata->>'errorSchemaVersion')::int ELSE 0 END >= 2
          AND COALESCE((metadata->>'retryAttempt')::int, 0) < COALESCE((metadata->>'maxRetries')::int, 3)
          AND "sentAt" > NOW() - INTERVAL '24 hours'
        ORDER BY "sentAt" ASC
        LIMIT 10
    `

    let retriedCount = 0
    for (const { id } of candidates) {
        const result = await MessageService.retrySend(id)
        if (result.error !== 'Backoff not elapsed') {
            retriedCount++
        }
    }

    return { retriedCount, candidatesFound: candidates.length }
}
