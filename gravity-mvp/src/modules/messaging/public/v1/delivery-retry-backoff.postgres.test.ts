import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The retry job's candidate selector against real PostgreSQL: its backoff
// clause is the declared SQL mirror of isPhysicalRetryDueV1, the rule
// MessageService.retrySend applies. The selector is run exactly as written
// (retryEligibleMessagingDeliveriesV1); only retrySend is a stand-in that
// records which rows the job handed it.
//
// Runs only against a disposable database named by
// MESSAGING_RETRY_BACKOFF_TEST_DATABASE_URL (the Prisma client must point at
// the same database through DATABASE_URL, with `?schema=` naming an EMPTY
// schema: the test creates its own minimal "Message" table there and refuses
// to run where one already exists); skipped otherwise.

const TEST_DATABASE_URL = process.env.MESSAGING_RETRY_BACKOFF_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

const mocks = vi.hoisted(() => ({ retrySend: vi.fn() }))

vi.mock('@/lib/MessageService', () => ({
    MessageService: { retrySend: mocks.retrySend, recoverStuckMessages: vi.fn() },
}))

import { prisma } from '@/lib/prisma'
import { retryEligibleMessagingDeliveriesV1 } from './delivery-recovery-operations'
import { isPhysicalRetryDueV1, physicalRetryBackoffMsV1 } from './delivery-state-policy'

const RUN = `rsel${Date.now().toString(36)}`
// The application clock the selector and retrySend read; whole milliseconds, near the real
// time so the unchanged 24-hour window (database clock) keeps every fixture inside it.
const NOW = Math.floor(Date.now() / 1000) * 1000
const iso = (ms: number) => new Date(ms).toISOString()

type Metadata = Record<string, unknown>

function eligible(extra: Metadata): Metadata {
    return { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2, maxRetries: 9, ...extra }
}

async function insert(id: string, metadata: Metadata, sentAtMs: number) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "Message" (id, direction, status, metadata, "sentAt")
         VALUES ($1, 'outbound', 'failed', $2::jsonb, $3::timestamptz AT TIME ZONE 'UTC')`,
        id,
        JSON.stringify(metadata),
        iso(sentAtMs),
    )
}

async function selectedIds(): Promise<string[]> {
    mocks.retrySend.mockClear()
    const result = await retryEligibleMessagingDeliveriesV1()
    const ids = mocks.retrySend.mock.calls.map(([id]) => id as string)
    expect(result.candidatesFound).toBe(ids.length)
    return ids
}

describeWithDatabase('retry selector backoff against PostgreSQL', () => {
    beforeAll(async () => {
        if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
            throw new Error('DATABASE_URL must equal MESSAGING_RETRY_BACKOFF_TEST_DATABASE_URL for this suite')
        }
        const [{ existing }] = await prisma.$queryRawUnsafe<Array<{ existing: string | null }>>(
            `SELECT to_regclass('"Message"')::text AS existing`,
        )
        if (existing !== null) throw new Error('refusing to run: the target schema already has a "Message" table')
        await prisma.$executeRawUnsafe(`CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound', 'system')`)
        await prisma.$executeRawUnsafe(`CREATE TYPE "MessageStatus" AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed')`)
        await prisma.$executeRawUnsafe(`CREATE TABLE "Message" (
            id TEXT PRIMARY KEY,
            direction "MessageDirection" NOT NULL,
            status "MessageStatus" NOT NULL DEFAULT 'sent',
            metadata JSONB DEFAULT '{}',
            "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`)
    })

    beforeEach(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "Message"`)
        mocks.retrySend.mockReset()
        mocks.retrySend.mockResolvedValue({ success: true })
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Message"`)
        await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "MessageStatus"`)
        await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "MessageDirection"`)
        await prisma.$disconnect()
    })

    it('selects exactly the rows isPhysicalRetryDueV1 calls due, over attempt × anchor', async () => {
        let compared = 0
        for (const retryAttempt of [undefined, 0, 1, 2, 3]) {
            const backoff = physicalRetryBackoffMsV1((retryAttempt ?? 0) + 1)
            const anchors: Array<[string, unknown]> = [
                ['missing', undefined],
                ['null', null],
                ['empty', ''],
                ['malformed', 'not-a-timestamp'],
                ['inside the backoff', iso(NOW - backoff + 1)],
                ['at the boundary', iso(NOW - backoff)],
                ['past the boundary', iso(NOW - backoff - 1)],
                ['long past', iso(NOW - 6 * 60 * 60 * 1000)],
                ['just now', iso(NOW)],
                ['in the future', iso(NOW + 1000)],
            ]
            for (const [label, lastFailedAt] of anchors) {
                await prisma.$executeRawUnsafe(`DELETE FROM "Message"`)
                const metadata = eligible({
                    ...(retryAttempt === undefined ? {} : { retryAttempt }),
                    ...(lastFailedAt === undefined ? {} : { lastFailedAt }),
                })
                await insert(`${RUN}_m`, metadata, NOW - 60_000)
                const selected = (await selectedIds()).includes(`${RUN}_m`)
                expect({ retryAttempt, label, selected }).toEqual({ retryAttempt, label, selected: isPhysicalRetryDueV1(metadata, NOW) })
                compared++
            }
        }
        expect(compared).toBe(50)
    })

    it('is never stricter than retrySend for an anchor Messaging does not write', async () => {
        // Parseable by V8 but not the canonical toISOString form, or not a real date to
        // PostgreSQL: the selector treats each as due, so at worst retrySend answers
        // "Backoff not elapsed" for it — it never starves a row retrySend would retry.
        const anchors = [
            iso(NOW).replace('.000Z', 'Z'),
            iso(NOW).replace('Z', ''),
            iso(NOW).replace('Z', '+00:00'),
            iso(NOW).replace('T', ' '),
            iso(NOW).slice(0, 10),
            '2026-02-30T00:00:00.000Z',
            '2026-04-31T00:00:00.000Z',
            `${iso(NOW).slice(0, 10)}T24:00:00.000Z`,
            NOW,
            String(NOW),
        ]
        for (const lastFailedAt of anchors) {
            await prisma.$executeRawUnsafe(`DELETE FROM "Message"`)
            const metadata = eligible({ retryAttempt: 0, lastFailedAt })
            await insert(`${RUN}_d`, metadata, NOW - 60_000)
            expect({ lastFailedAt, selected: (await selectedIds()).includes(`${RUN}_d`) }).toEqual({ lastFailedAt, selected: true })
        }
    })

    it('no longer lets ten backoff-pending older rows starve a due newer one', async () => {
        for (let index = 0; index < 10; index++) {
            await insert(`${RUN}_pending_${index}`, eligible({ retryAttempt: 1, lastFailedAt: iso(NOW - 1000) }), NOW - 3_600_000 + index)
        }
        await insert(`${RUN}_due`, eligible({ retryAttempt: 0, lastFailedAt: iso(NOW - 61_000) }), NOW - 60_000)
        expect(await selectedIds()).toEqual([`${RUN}_due`])
    })

    it('frees the window from twelve just-deferred older rows for the due newer one', async () => {
        for (let index = 0; index < 12; index++) {
            await insert(`${RUN}_deferred_${index}`, eligible({ retryAttempt: index % 3, lastFailedAt: iso(NOW) }), NOW - 7_200_000 + index)
        }
        await insert(`${RUN}_due`, eligible({ retryAttempt: 2, lastFailedAt: iso(NOW - 240_000) }), NOW - 60_000)
        expect(await selectedIds()).toEqual([`${RUN}_due`])
        // The deferred rows return to the window as their backoff elapses.
        vi.setSystemTime(NOW + physicalRetryBackoffMsV1(1))
        const later = await selectedIds()
        expect(later).toContain(`${RUN}_due`)
        expect(later).toEqual(expect.arrayContaining([`${RUN}_deferred_0`, `${RUN}_deferred_3`]))
        expect(later).not.toContain(`${RUN}_deferred_1`)
    })

    it('keeps the oldest-first order and the limit of ten among due rows', async () => {
        for (let index = 0; index < 12; index++) {
            await insert(`${RUN}_due_${String(index).padStart(2, '0')}`, eligible({ retryAttempt: 0 }), NOW - 3_600_000 + index * 1000)
        }
        expect(await selectedIds()).toEqual(Array.from({ length: 10 }, (_, index) => `${RUN}_due_${String(index).padStart(2, '0')}`))
    })

    it('leaves every other eligibility clause in force', async () => {
        const due = { retryAttempt: 0, lastFailedAt: iso(NOW - 600_000) }
        await insert(`${RUN}_ok`, eligible(due), NOW - 60_000)
        await insert(`${RUN}_unknown`, eligible({ ...due, deliveryOutcome: 'unknown' }), NOW - 60_000)
        await insert(`${RUN}_v1`, eligible({ ...due, errorSchemaVersion: 1 }), NOW - 60_000)
        await insert(`${RUN}_spent`, eligible({ ...due, retryAttempt: 3, maxRetries: 3 }), NOW - 60_000)
        await insert(`${RUN}_old`, eligible(due), NOW - 25 * 3_600_000)
        expect(await selectedIds()).toEqual([`${RUN}_ok`])
    })
})
