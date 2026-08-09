/* eslint-disable @typescript-eslint/no-explicit-any -- generated Prisma client gains DomainOutboxEvent after the expand migration */
import { prisma } from '@/lib/prisma'
import type {
    ClaimedOutboxEventV1,
    OutboxFailureV1,
    OutboxStoreV1,
} from './v1'
import { OUTBOX_MAX_ATTEMPTS_V1 } from './v1'

function toClaimed(row: any): ClaimedOutboxEventV1 {
    return {
        id: row.id,
        eventId: row.eventId,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
    }
}

export const prismaOutboxStoreV1: OutboxStoreV1 = {
    async recoverStale(now, staleBefore) {
        const exhaustedWaiting = await (prisma as any).domainOutboxEvent.updateMany({
            where: {
                status: { in: ['pending', 'retry_wait'] },
                attempts: { gte: OUTBOX_MAX_ATTEMPTS_V1 },
            },
            data: {
                status: 'dead_letter',
                claimedAt: null,
                availableAt: now,
                lastError: 'RETRY_BUDGET_EXHAUSTED',
            },
        })
        const exhaustedStale = await (prisma as any).domainOutboxEvent.updateMany({
            where: {
                status: 'processing',
                claimedAt: { lte: staleBefore },
                attempts: { gte: OUTBOX_MAX_ATTEMPTS_V1 },
            },
            data: {
                status: 'dead_letter',
                claimedAt: null,
                availableAt: now,
                lastError: 'STALE_CLAIM_RETRY_BUDGET_EXHAUSTED',
            },
        })
        const recovered = await (prisma as any).domainOutboxEvent.updateMany({
            where: {
                status: 'processing',
                claimedAt: { lte: staleBefore },
                attempts: { lt: OUTBOX_MAX_ATTEMPTS_V1 },
            },
            data: {
                status: 'retry_wait',
                claimedAt: null,
                availableAt: now,
                lastError: 'STALE_CLAIM_RECOVERED',
            },
        })
        return {
            retryWait: recovered.count,
            deadLetter: exhaustedWaiting.count + exhaustedStale.count,
        }
    },

    async claimBatch(now, limit) {
        const candidates = await (prisma as any).domainOutboxEvent.findMany({
            where: {
                status: { in: ['pending', 'retry_wait'] },
                availableAt: { lte: now },
                attempts: { lt: OUTBOX_MAX_ATTEMPTS_V1 },
            },
            orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
            take: limit,
        })
        const claimed: ClaimedOutboxEventV1[] = []

        for (const candidate of candidates) {
            const result = await (prisma as any).domainOutboxEvent.updateMany({
                where: {
                    id: candidate.id,
                    status: candidate.status,
                    attempts: candidate.attempts,
                },
                data: {
                    status: 'processing',
                    claimedAt: now,
                    attempts: { increment: 1 },
                },
            })
            if (result.count !== 1) continue
            const row = await (prisma as any).domainOutboxEvent.findUnique({ where: { id: candidate.id } })
            if (row) claimed.push(toClaimed(row))
        }

        return claimed
    },

    async markPublished(id, publishedAt) {
        await (prisma as any).domainOutboxEvent.updateMany({
            where: { id, status: 'processing' },
            data: {
                status: 'published',
                publishedAt,
                claimedAt: null,
                lastError: null,
            },
        })
    },

    async markFailed(id, failure: OutboxFailureV1) {
        await (prisma as any).domainOutboxEvent.updateMany({
            where: { id, status: 'processing' },
            data: {
                status: failure.status,
                availableAt: failure.availableAt,
                claimedAt: null,
                lastError: failure.lastError,
            },
        })
    },
}
