import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { callingOutboxPublishersV1 } from '@/modules/calling/public/v1'
import { prismaOutboxStoreV1 } from '@/infrastructure/outbox/prisma-outbox-store'
import { normalizeOutboxErrorV1, publishOutboxBatchV1 } from '@/infrastructure/outbox/v1'

const configuredInterval = Number(process.env.DOMAIN_OUTBOX_POLL_MS ?? 2_000)
const OUTBOX_POLL_MS = Number.isFinite(configuredInterval)
    ? Math.max(500, Math.min(configuredInterval, 60_000))
    : 2_000

let tickRunning = false

export async function runDomainOutboxPublisherOnceV1() {
    return publishOutboxBatchV1({
        store: prismaOutboxStoreV1,
        publishers: callingOutboxPublishersV1,
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
