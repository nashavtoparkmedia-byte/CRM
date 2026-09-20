import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The unattended retry job's candidate selection, executed as real SQL.
// Runs only against a disposable database named by
// MESSAGING_RETRY_TEST_DATABASE_URL (the Prisma client must point at the same
// database through DATABASE_URL); skipped otherwise.

const TEST_DATABASE_URL = process.env.MESSAGING_RETRY_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

const { retrySend } = vi.hoisted(() => ({
    retrySend: vi.fn<(messageId: string) => Promise<{ success: boolean }>>(async () => ({ success: true })),
}))
vi.mock('@/lib/MessageService', () => ({
    MessageService: { retrySend, recoverStuckMessages: vi.fn() },
}))

import { prisma } from '@/lib/prisma'
import { retryEligibleMessagingDeliveriesV1 } from './delivery-recovery-operations'

const RUN = `retrysel${Date.now().toString(36)}`
const CHAT_ID = `${RUN}_chat`

// Every row is a failed outbound message inside the job's 24 h window with
// attempts left; only the delivery-safety metadata differs.
const ROWS: Array<{ key: string; metadata: Record<string, unknown>; selected: boolean }> = [
    { key: 'v1_retryable', metadata: { retryable: true, errorCode: 'TIMEOUT' }, selected: false },
    { key: 'v1_retryable_version1', metadata: { retryable: true, errorCode: 'TIMEOUT', errorSchemaVersion: 1 }, selected: false },
    { key: 'v2_unknown', metadata: { retryable: false, deliveryOutcome: 'unknown', errorSchemaVersion: 2 }, selected: false },
    { key: 'v2_unknown_marked_retryable', metadata: { retryable: true, deliveryOutcome: 'unknown', errorSchemaVersion: 2 }, selected: false },
    { key: 'v2_terminal', metadata: { retryable: false, deliveryOutcome: 'terminal', errorSchemaVersion: 2 }, selected: false },
    { key: 'safe_without_version', metadata: { retryable: true, deliveryOutcome: 'safe_to_redeliver' }, selected: false },
    { key: 'safe_non_numeric_version', metadata: { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 'two' }, selected: false },
    { key: 'v2_safe', metadata: { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 }, selected: true },
    { key: 'v3_safe', metadata: { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 3 }, selected: true },
]

describeWithDatabase('retry job candidate selection (PostgreSQL)', () => {
    beforeAll(async () => {
        if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
            throw new Error('DATABASE_URL must equal MESSAGING_RETRY_TEST_DATABASE_URL for this suite')
        }
        await prisma.chat.create({ data: { id: CHAT_ID, channel: 'max', externalChatId: `max:${RUN}` } })
        for (const [index, row] of ROWS.entries()) {
            await prisma.message.create({
                data: {
                    id: `${RUN}_${row.key}`,
                    chatId: CHAT_ID,
                    direction: 'outbound',
                    channel: 'max',
                    content: row.key,
                    status: 'failed',
                    sentAt: new Date(Date.now() - (ROWS.length - index) * 1000),
                    metadata: { retryAttempt: 0, maxRetries: 3, ...row.metadata },
                },
            })
        }
    })

    afterAll(async () => {
        await prisma.message.deleteMany({ where: { chatId: CHAT_ID } })
        await prisma.chat.deleteMany({ where: { id: CHAT_ID } })
        await prisma.$disconnect()
    })

    it('selects only rows the current taxonomy proved safe to redeliver', async () => {
        const result = await retryEligibleMessagingDeliveriesV1()

        const selected = retrySend.mock.calls.map(([id]) => String(id).slice(RUN.length + 1)).sort()
        expect(selected).toEqual(ROWS.filter(row => row.selected).map(row => row.key).sort())
        expect(result.candidatesFound).toBe(2)
    })
})
