import {
    CLEAR_FLEET_CHECK_STATUS_RESULT_V1,
    parseClearFleetCheckStatusCommandV1,
    type ClearFleetCheckStatusCommandV1,
    type ClearFleetCheckStatusResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface ClearFleetCheckStatusPersistencePortV1 {
    clearAll(): Promise<{ clearedCount: number }>
}

export function createClearFleetCheckStatusHandlerV1(port: ClearFleetCheckStatusPersistencePortV1) {
    return async function clearFleetCheckStatusV1(
        command: ClearFleetCheckStatusCommandV1 | unknown,
    ): Promise<ClearFleetCheckStatusResultV1> {
        parseClearFleetCheckStatusCommandV1(command)
        const result = await port.clearAll()
        return { contract: CLEAR_FLEET_CHECK_STATUS_RESULT_V1, clearedCount: result.clearedCount }
    }
}
