import {
    makeRecordingReadyEventV1,
    type RecordingReadyEventV1,
} from '../../../contracts/calling/v1'
import type {
    PersistRecordingReadyInputV1,
    PersistRecordingReadyV1,
} from '../public/v1/recording-ready-operation'

/** Internal-only write capabilities used by the owner adapter. */
export interface RecordingReadyTransactionV1 {
    updateCallRecording(callId: string, recordingPath: string): Promise<void>
    appendOutboxEvent(event: RecordingReadyEventV1): Promise<void>
}

/** Internal-only atomicity boundary; never accepted by the public operation. */
export interface RecordingReadyUnitOfWorkV1 {
    run<T>(operation: (transaction: RecordingReadyTransactionV1) => Promise<T>): Promise<T>
}

export function createPersistRecordingReadyV1(
    unitOfWork: RecordingReadyUnitOfWorkV1,
    clock: () => Date = () => new Date(),
): PersistRecordingReadyV1 {
    return async function persistRecordingReadyV1(
        input: PersistRecordingReadyInputV1,
    ): Promise<RecordingReadyEventV1> {
        const event = makeRecordingReadyEventV1({
            ...input,
            occurredAt: clock().toISOString(),
        })

        await unitOfWork.run(async (transaction) => {
            await transaction.updateCallRecording(input.callId, input.recordingPath)
            await transaction.appendOutboxEvent(event)
        })

        return event
    }
}
