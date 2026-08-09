import {
    makeRecordingReadyEventV1,
    type RecordingReadyEventV1,
} from '../../../contracts/calling/v1'

export interface RecordingReadyTransactionV1 {
    updateCallRecording(callId: string, recordingPath: string): Promise<void>
    appendOutboxEvent(event: RecordingReadyEventV1): Promise<void>
}

export interface RecordingReadyUnitOfWorkV1 {
    run<T>(operation: (transaction: RecordingReadyTransactionV1) => Promise<T>): Promise<T>
}

export function createPersistRecordingReadyV1(
    unitOfWork: RecordingReadyUnitOfWorkV1,
    clock: () => Date = () => new Date(),
) {
    return async function persistRecordingReadyV1(input: {
        callId: string
        recordingPath: string
        correlationId?: string | null
        causationId?: string | null
    }): Promise<RecordingReadyEventV1> {
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
