import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { callingOutboxPublishersV1 } from '@/modules/calling/public/v1'
import { messagingOutboxPublishersV1 } from '@/modules/messaging/public/v1'
import { prismaOutboxStoreV1 } from '@/infrastructure/outbox/prisma-outbox-store'
import {
    normalizeOutboxErrorV1,
    publishOutboxBatchV1,
    type OutboxPublisherRegistryV1,
} from '@/infrastructure/outbox/v1'

const configuredInterval = Number(process.env.DOMAIN_OUTBOX_POLL_MS ?? 2_000)
const OUTBOX_POLL_MS = Number.isFinite(configuredInterval)
    ? Math.max(500, Math.min(configuredInterval, 60_000))
    : 2_000

let tickRunning = false

/**
 * Every declared outbox flow's consumers, one handler per event type. The
 * Calling flows are unchanged; Messaging adds the Mobile Push v1 flows. An
 * event type claimed by two contexts would silently shadow a handler, so the
 * composition refuses to start instead.
 */
function composeDomainOutboxPublishersV1(...registries: OutboxPublisherRegistryV1[]): OutboxPublisherRegistryV1 {
    const composed: Record<string, OutboxPublisherRegistryV1[string]> = {}
    for (const registry of registries) {
        for (const [eventType, publisher] of Object.entries(registry)) {
            if (Object.hasOwn(composed, eventType)) throw new Error(`DUPLICATE_OUTBOX_PUBLISHER:${eventType}`)
            composed[eventType] = publisher
        }
    }
    return Object.freeze(composed)
}

const domainOutboxPublishersV1 = composeDomainOutboxPublishersV1(
    callingOutboxPublishersV1,
    messagingOutboxPublishersV1,
)

export async function runDomainOutboxPublisherOnceV1() {
    return publishOutboxBatchV1({
        store: prismaOutboxStoreV1,
        publishers: domainOutboxPublishersV1,
    })
}

export function startDomainOutboxPublisherV1(): NodeJS.Timeout {
    const tick = async () => {
        if (tickRunning) return
        tickRunning = true
        try {
            const result = await runDomainOutboxPublisherOnceV1()
            if (result.claimed > 0 || result.recovered > 0 || result.deadLetter > 0) {
                opsLog(result.deadLetter > 0 ? 'error' : 'info', 'domain_outbox_batch', {
                    operation: 'domain_outbox',
                    ...result,
                })
            }
        } catch (error) {
            opsLog('error', 'domain_outbox_batch_failed', {
                operation: 'domain_outbox',
                error: normalizeOutboxErrorV1(error, 500),
            })
        } finally {
            tickRunning = false
        }
    }

    void tick()
    return setInterval(() => { void tick() }, OUTBOX_POLL_MS)
}
