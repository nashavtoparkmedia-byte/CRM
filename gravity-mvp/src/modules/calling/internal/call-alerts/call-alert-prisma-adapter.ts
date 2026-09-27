/* eslint-disable @typescript-eslint/no-explicit-any -- generated Prisma client gains DomainOutboxEvent after the expand migration */
import { prisma } from '@/lib/prisma'
import { OUTBOX_MAX_ATTEMPTS_V1 } from '@/infrastructure/outbox/v1'
import type { CallAlertDeliveryRequestedEventV1, CallAlertRequestedEventV1 } from '@/contracts/calling/v1'

/**
 * Calling's own outbox writes for call alerts.
 *
 * One explicit row per statement and skipDuplicates on every append, so the
 * event identities do the deduplication: a semantic alert collapses on
 * (callId, kind) and a per-device delivery on (callId, kind, registrationId). A
 * fan-out retried after a partial failure completes the rest and adds nothing.
 */

function outboxRow(event: CallAlertRequestedEventV1 | CallAlertDeliveryRequestedEventV1) {
    return {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        aggregateType: event.aggregate.type,
        aggregateId: event.aggregate.id,
        payload: event,
        maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
        correlationId: event.correlationId,
        causationId: event.causationId,
    }
}

export const prismaCallAlertOutboxV1 = {
    /** Append the semantic alert. Returns how many rows were new. */
    async appendAlertEvent(event: CallAlertRequestedEventV1): Promise<number> {
        const result = await (prisma as any).domainOutboxEvent.createMany({
            data: [outboxRow(event)],
            skipDuplicates: true,
        })
        return result.count
    },

    async appendDeliveryEvents(events: readonly CallAlertDeliveryRequestedEventV1[]): Promise<number> {
        let appended = 0
        for (const event of events) {
            const result = await (prisma as any).domainOutboxEvent.createMany({
                data: [outboxRow(event)],
                skipDuplicates: true,
            })
            appended += result.count
        }
        return appended
    },
}
