import {
    RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
    parseRecordManagerDriverCommunicationCommandV1,
    type ManagerDriverCommunicationActivityV1,
    type RecordManagerDriverCommunicationCommandV1,
    type RecordManagerDriverCommunicationResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface RecordManagerDriverCommunicationPersistencePortV1 {
    recordManagerDriverCommunication(input: {
        driverId: string
        activity: ManagerDriverCommunicationActivityV1
    }): Promise<void>
}

export function createRecordManagerDriverCommunicationHandlerV1(
    port: RecordManagerDriverCommunicationPersistencePortV1,
) {
    return async function recordManagerDriverCommunicationV1(
        command: RecordManagerDriverCommunicationCommandV1 | unknown,
    ): Promise<RecordManagerDriverCommunicationResultV1> {
        const parsed = parseRecordManagerDriverCommunicationCommandV1(command)
        await port.recordManagerDriverCommunication({
            driverId: parsed.driverId,
            activity: parsed.activity,
        })
        return {
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
            logged: true,
        }
    }
}
