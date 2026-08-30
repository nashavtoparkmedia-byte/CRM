import { prisma } from '@/lib/prisma'
import {
    TaskIdempotencyConflictError,
    type JsonValueV1,
} from '@/contracts/work-management/v1'
import {
    type IdempotentTaskPersistencePortV1,
} from './create-idempotent-task-handler'
import { mapCreateTaskDataToLegacyRecordV1 } from './legacy-task-record'

const IDEMPOTENCY_METADATA_KEY = 'workManagementIdempotencyV1'

interface StoredIdempotencyMetadata {
    version: 1
    idempotencyKey: string
    payloadFingerprint: string
}

function storedIdempotencyMetadata(value: unknown): StoredIdempotencyMetadata | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const marker = (value as Record<string, unknown>)[IDEMPOTENCY_METADATA_KEY]
    if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return null
    const record = marker as Record<string, unknown>
    if (
        record.version !== 1
        || typeof record.idempotencyKey !== 'string'
        || typeof record.payloadFingerprint !== 'string'
    ) return null
    return record as unknown as StoredIdempotencyMetadata
}

function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/** Work Management-owned adapter; the deterministic Task primary key is the concurrency fence. */
export const legacyPrismaIdempotentTaskPortV1: IdempotentTaskPersistencePortV1 = {
    async createOrReplay(request) {
        const marker: StoredIdempotencyMetadata = {
            version: 1,
            idempotencyKey: request.idempotencyKey,
            payloadFingerprint: request.payloadFingerprint,
        }
        const consumerMetadata = request.data.metadata ?? {}
        const legacy = mapCreateTaskDataToLegacyRecordV1(request.data)

        try {
            const task = await prisma.task.create({
                data: {
                    driverId: legacy.driverId,
                    contactId: legacy.contactId,
                    source: legacy.source,
                    type: legacy.type,
                    title: legacy.title,
                    description: legacy.description,
                    priority: legacy.priority,
                    status: legacy.status,
                    assigneeId: legacy.assigneeId,
                    createdBy: legacy.createdBy,
                    id: request.taskId,
                    dedupeKey: request.idempotencyKey,
                    metadata: {
                        ...consumerMetadata,
                        [IDEMPOTENCY_METADATA_KEY]: marker as unknown as JsonValueV1,
                    },
                },
                select: { id: true, title: true },
            })
            return { status: 'created' as const, task }
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error
        }

        const existing = await prisma.task.findUnique({
            where: { id: request.taskId },
            select: { id: true, title: true, dedupeKey: true, metadata: true },
        })
        const existingMarker = storedIdempotencyMetadata(existing?.metadata)
        if (
            !existing
            || existing.dedupeKey !== request.idempotencyKey
            || existingMarker?.idempotencyKey !== request.idempotencyKey
            || existingMarker.payloadFingerprint !== request.payloadFingerprint
        ) {
            throw new TaskIdempotencyConflictError()
        }

        return {
            status: 'replayed' as const,
            task: { id: existing.id, title: existing.title },
        }
    },
}
