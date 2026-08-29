export type OutboxStatusV1 = 'pending' | 'processing' | 'retry_wait' | 'published' | 'dead_letter'

export interface ClaimedOutboxEventV1 {
    id: string
    eventId: string
    eventType: string
    eventVersion: number
    payload: unknown
    attempts: number
    maxAttempts: number
}

export interface OutboxFailureV1 {
    status: 'retry_wait' | 'dead_letter'
    availableAt: Date
    lastError: string
}

export interface OutboxStoreV1 {
    recoverStale(now: Date, staleBefore: Date): Promise<{ retryWait: number; deadLetter: number }>
    claimBatch(now: Date, limit: number): Promise<ClaimedOutboxEventV1[]>
    markPublished(id: string, publishedAt: Date): Promise<void>
    markFailed(id: string, failure: OutboxFailureV1): Promise<void>
}

export type OutboxPublisherV1 = (payload: unknown) => Promise<void>
export type OutboxPublisherRegistryV1 = Readonly<Record<string, OutboxPublisherV1>>

export interface OutboxBatchResultV1 {
    recovered: number
    claimed: number
    published: number
    retryWait: number
    deadLetter: number
}

export const OUTBOX_BATCH_LIMIT_V1 = 25
export const OUTBOX_STALE_CLAIM_MS_V1 = 5 * 60_000
export const OUTBOX_PUBLISH_TIMEOUT_MS_V1 = 5_000
export const OUTBOX_MAX_ATTEMPTS_V1 = 5

export function outboxRetryDelayMsV1(attempts: number): number {
    if (attempts <= 1) return 5_000
    if (attempts === 2) return 30_000
    if (attempts === 3) return 2 * 60_000
    if (attempts === 4) return 10 * 60_000
    return 30 * 60_000
}

export function normalizeOutboxErrorV1(error: unknown, max = 1000): string {
    const raw = error instanceof Error ? `${error.name}:${error.message}` : String(error)
    const redacted = raw
        .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
        .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/:\/\/[^/@\s]+@/g, '://[REDACTED]@')
    return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`
}

async function publishWithTimeoutV1(
    publisher: OutboxPublisherV1,
    payload: unknown,
    timeoutMs: number,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PUBLISH_TIMEOUT:${timeoutMs}ms`)), timeoutMs)
    })
    try {
        await Promise.race([publisher(payload), timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

export async function publishOutboxBatchV1(input: {
    store: OutboxStoreV1
    publishers: OutboxPublisherRegistryV1
    now?: Date
    limit?: number
    publishTimeoutMs?: number
}): Promise<OutboxBatchResultV1> {
    const now = input.now ?? new Date()
    const limit = Math.max(1, Math.min(input.limit ?? OUTBOX_BATCH_LIMIT_V1, OUTBOX_BATCH_LIMIT_V1))
    const publishTimeoutMs = Math.max(
        1,
        Math.min(input.publishTimeoutMs ?? OUTBOX_PUBLISH_TIMEOUT_MS_V1, OUTBOX_PUBLISH_TIMEOUT_MS_V1),
    )
    const recovery = await input.store.recoverStale(
        now,
        new Date(now.getTime() - OUTBOX_STALE_CLAIM_MS_V1),
    )
    const result: OutboxBatchResultV1 = {
        recovered: recovery.retryWait + recovery.deadLetter,
        claimed: 0,
        published: 0,
        retryWait: 0,
        deadLetter: recovery.deadLetter,
    }

    const events = await input.store.claimBatch(now, limit)
    result.claimed = events.length

    for (const event of events) {
        const publisher = input.publishers[event.eventType]
        try {
            if (!publisher) throw new Error(`UNREGISTERED_EVENT_TYPE:${event.eventType}`)
            await publishWithTimeoutV1(publisher, event.payload, publishTimeoutMs)
            await input.store.markPublished(event.id, now)
            result.published += 1
        } catch (error) {
            const terminal = event.attempts >= event.maxAttempts
            await input.store.markFailed(event.id, {
                status: terminal ? 'dead_letter' : 'retry_wait',
                availableAt: terminal
                    ? now
                    : new Date(now.getTime() + outboxRetryDelayMsV1(event.attempts)),
                lastError: normalizeOutboxErrorV1(error),
            })
            if (terminal) result.deadLetter += 1
            else result.retryWait += 1
        }
    }

    return result
}
