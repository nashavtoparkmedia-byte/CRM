/* eslint-disable @typescript-eslint/no-explicit-any -- generated Prisma client gains DomainOutboxEvent after the expand migration */
import { prisma } from '@/lib/prisma'
import { OUTBOX_MAX_ATTEMPTS_V1 } from '@/infrastructure/outbox/v1'
import { createPersistRecordingReadyV1, type RecordingReadyUnitOfWorkV1 } from './recording-ready'

const prismaRecordingReadyUnitOfWorkV1: RecordingReadyUnitOfWorkV1 = {
    async run(operation) {
        return (prisma as any).$transaction(async (transaction: any) => operation({
            async updateCallRecording(callId, recordingPath) {
                await transaction.call.update({
                    where: { id: callId },
                    data: { recordingPath },
                })
            },
            async appendOutboxEvent(event) {
                await transaction.domainOutboxEvent.createMany({
                    data: [{
                        eventId: event.eventId,
                        eventType: event.eventType,
                        eventVersion: event.eventVersion,
                        aggregateType: event.aggregate.type,
                        aggregateId: event.aggregate.id,
                        payload: event,
                        maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
                        correlationId: event.correlationId,
                        causationId: event.causationId,
                    }],
                    skipDuplicates: true,
                })
            },
        }))
    },
}

export const persistRecordingReadyV1 = createPersistRecordingReadyV1(prismaRecordingReadyUnitOfWorkV1)
