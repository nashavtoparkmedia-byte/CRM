import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryRaw, recoverStuckMessages, retrySend } = vi.hoisted(() => ({
    queryRaw: vi.fn(),
    recoverStuckMessages: vi.fn(),
    retrySend: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: { $queryRaw: queryRaw },
}))
vi.mock('@/lib/MessageService', () => ({
    MessageService: { recoverStuckMessages, retrySend },
}))

import {
    recoverStuckMessagingDeliveriesV1,
    retryEligibleMessagingDeliveriesV1,
} from './delivery-recovery-operations'

describe('Messaging delivery recovery operations', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('keeps the stuck-delivery recovery age fixed at five minutes', async () => {
        recoverStuckMessages.mockResolvedValueOnce(3)

        await expect(recoverStuckMessagingDeliveriesV1()).resolves.toBe(3)
        expect(recoverStuckMessages).toHaveBeenCalledOnce()
        expect(recoverStuckMessages).toHaveBeenCalledWith(5)
    })

    it('retries the bounded owner-selected batch and preserves backoff counting', async () => {
        queryRaw.mockResolvedValueOnce([{ id: 'message-1' }, { id: 'message-2' }, { id: 'message-3' }])
        retrySend
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false, error: 'Backoff not elapsed' })
            .mockResolvedValueOnce({ success: false, error: 'Provider unavailable' })

        await expect(retryEligibleMessagingDeliveriesV1()).resolves.toEqual({
            retriedCount: 2,
            candidatesFound: 3,
        })
        expect(retrySend.mock.calls).toEqual([
            ['message-1'],
            ['message-2'],
            ['message-3'],
        ])

        const [strings] = queryRaw.mock.calls[0]
        const sql = strings.join(' ')
        expect(sql).toContain("status = 'failed'")
        expect(sql).toContain("direction = 'outbound'")
        expect(sql).toContain("metadata->>'retryable'")
        expect(sql).toContain("INTERVAL '24 hours'")
        expect(sql).toContain('ORDER BY "sentAt" ASC')
        expect(sql).toContain('LIMIT 10')
    })
})
