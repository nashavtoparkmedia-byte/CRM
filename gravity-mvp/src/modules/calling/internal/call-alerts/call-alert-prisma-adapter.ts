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
 *
 * The envelope is spelled out at each call site rather than built by a shared
 * helper, which is how every other outbox adapter in this repository writes it.
 * A row assembled by a helper is a dynamic payload to the credential analyzer:
 * it can no longer prove which fields the write touches, so it files the site as
 * an ambiguity that needs a hand-written reviewed disposition. Two literals cost
 * less than two permanent review records and a source-hash rebind on every
 * later edit to this file.
 */

export const prismaCallAlertOutboxV1 = {
    /** Append the semantic alert. Returns how many rows were new. */
    async appendAlertEvent(event: CallAlertRequestedEventV1): Promise<number> {
        const result = await (prisma as any).domainOutboxEvent.createMany({
            data: [{
                eventId: event.eventId,
                eventType: event.eventType,
                eventVersion: event.eventVersion,
                aggregateType: event.aggregate.type,
                aggregateId: event.aggregate.id,
                payload: event,
                maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
                correlationId: event.correlationId,
                causationId: event.causationId,
            }],
            skipDuplicates: true,
        })
        return result.count
    },

    async appendDeliveryEvents(events: readonly CallAlertDeliveryRequestedEventV1[]): Promise<number> {
        let appended = 0
        for (const event of events) {
            const result = await (prisma as any).domainOutboxEvent.createMany({
                data: [{
                    eventId: event.eventId,
                    eventType: event.eventType,
                    eventVersion: event.eventVersion,
                    aggregateType: event.aggregate.type,
                    aggregateId: event.aggregate.id,
                    payload: event,
                    maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
                    correlationId: event.correlationId,
                    causationId: event.causationId,
                }],
                skipDuplicates: true,
            })
            appended += result.count
        }
        return appended
    },
}
