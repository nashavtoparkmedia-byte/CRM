import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskIdempotencyConflictError } from '@/contracts/work-management/v1'

const mocks = vi.hoisted(() => ({ create: vi.fn(), findUnique: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { task: mocks } }))

import { legacyPrismaIdempotentTaskPortV1 } from './legacy-prisma-idempotent-task-adapter'

const REQUEST = {
    taskId: 'task_idem_abc',
    idempotencyKey: 'ai-call-finalization-follow-up:v1:call-1',
    payloadFingerprint: 'payload-sha',
    data: {
        driverId: 'driver-1',
        source: 'auto' as const,
        type: 'ai_call_followup',
        title: 'Call back',
        metadata: { aiCallId: 'call-1' },
    },
}

describe('legacy Prisma idempotent Task owner adapter', () => {
    beforeEach(() => vi.clearAllMocks())

    it('creates with the deterministic primary key and owner idempotency marker', async () => {
        mocks.create.mockResolvedValue({ id: REQUEST.taskId, title: 'Call back' })
        await expect(legacyPrismaIdempotentTaskPortV1.createOrReplay(REQUEST)).resolves.toEqual({
            status: 'created',
            task: { id: REQUEST.taskId, title: 'Call back' },
        })
        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                id: REQUEST.taskId,
                dedupeKey: REQUEST.idempotencyKey,
                metadata: {
                    aiCallId: 'call-1',
                    workManagementIdempotencyV1: {
                        version: 1,
                        idempotencyKey: REQUEST.idempotencyKey,
                        payloadFingerprint: REQUEST.payloadFingerprint,
                    },
                },
            }),
        }))
    })

    it('replays an exact duplicate after the primary-key create race is lost', async () => {
        mocks.create.mockRejectedValue({ code: 'P2002' })
        mocks.findUnique.mockResolvedValue({
            id: REQUEST.taskId,
            title: 'Call back',
            dedupeKey: REQUEST.idempotencyKey,
            metadata: {
                workManagementIdempotencyV1: {
                    version: 1,
                    idempotencyKey: REQUEST.idempotencyKey,
                    payloadFingerprint: REQUEST.payloadFingerprint,
                },
            },
        })
        await expect(legacyPrismaIdempotentTaskPortV1.createOrReplay(REQUEST)).resolves.toEqual({
            status: 'replayed',
            task: { id: REQUEST.taskId, title: 'Call back' },
        })
    })

    it('rejects a deterministic-key collision with a different payload', async () => {
        mocks.create.mockRejectedValue({ code: 'P2002' })
        mocks.findUnique.mockResolvedValue({
            id: REQUEST.taskId,
            title: 'Other',
            dedupeKey: REQUEST.idempotencyKey,
            metadata: {
                workManagementIdempotencyV1: {
                    version: 1,
                    idempotencyKey: REQUEST.idempotencyKey,
                    payloadFingerprint: 'different-sha',
                },
            },
        })
        await expect(legacyPrismaIdempotentTaskPortV1.createOrReplay(REQUEST))
            .rejects.toBeInstanceOf(TaskIdempotencyConflictError)
    })

    it('does not reinterpret non-uniqueness persistence errors as replay', async () => {
        const error = new Error('database unavailable')
        mocks.create.mockRejectedValue(error)
        await expect(legacyPrismaIdempotentTaskPortV1.createOrReplay(REQUEST)).rejects.toBe(error)
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })
})
