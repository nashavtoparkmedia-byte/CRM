import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const row = {
        id: 'row-1',
        eventId: 'event-1',
        eventType: 'calling.AiCallFinalizationFollowUpRequested.v1',
        eventVersion: 1,
        payload: {},
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        availableAt: new Date('2026-08-29T10:00:00.000Z'),
        createdAt: new Date('2026-08-29T10:00:00.000Z'),
    }
    return {
        row,
        findMany: vi.fn(),
        updateMany: vi.fn(),
        findUnique: vi.fn(),
    }
})

vi.mock('@/lib/prisma', () => ({
    prisma: {
        domainOutboxEvent: {
            findMany: mocks.findMany,
            updateMany: mocks.updateMany,
            findUnique: mocks.findUnique,
        },
    },
}))

import { prismaOutboxStoreV1 } from './prisma-outbox-store'

describe('Prisma outbox multi-worker compare-and-set claim', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.row.status = 'pending'
        mocks.row.attempts = 0
        let finders = 0
        let release!: () => void
        const bothSelected = new Promise<void>((resolve) => { release = resolve })
        mocks.findMany.mockImplementation(async () => {
            finders += 1
            if (finders === 2) release()
            await bothSelected
            return [{ ...mocks.row, status: 'pending', attempts: 0 }]
        })
        mocks.updateMany.mockImplementation(async ({ where, data }) => {
            if (where.id !== mocks.row.id
                || where.status !== mocks.row.status
                || where.attempts !== mocks.row.attempts) return { count: 0 }
            mocks.row.status = data.status
            mocks.row.attempts += 1
            return { count: 1 }
        })
        mocks.findUnique.mockImplementation(async () => ({ ...mocks.row }))
    })

    it('allows only one of two concurrent workers to claim the same candidate', async () => {
        const now = new Date('2026-08-29T10:00:01.000Z')
        const [left, right] = await Promise.all([
            prismaOutboxStoreV1.claimBatch(now, 25),
            prismaOutboxStoreV1.claimBatch(now, 25),
        ])
        expect([...left, ...right]).toHaveLength(1)
        expect([...left, ...right][0]).toMatchObject({ id: 'row-1', attempts: 1 })
        expect(mocks.updateMany).toHaveBeenCalledTimes(2)
    })
})
