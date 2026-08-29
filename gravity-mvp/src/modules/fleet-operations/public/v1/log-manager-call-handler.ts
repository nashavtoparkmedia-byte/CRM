import {
    LOG_MANAGER_CALL_RESULT_V1,
    parseLogManagerCallCommandV1,
    type LogManagerCallCommandV1,
    type LogManagerCallResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface LogManagerCallCompatibilityPortV1 {
    logManagerCall(driverId: string): Promise<void>
}

export function createLogManagerCallHandlerV1(port: LogManagerCallCompatibilityPortV1) {
    return async function logManagerCallV1(
        command: LogManagerCallCommandV1 | unknown,
    ): Promise<LogManagerCallResultV1> {
        const parsed = parseLogManagerCallCommandV1(command)
        await port.logManagerCall(parsed.driverId)
        return { contract: LOG_MANAGER_CALL_RESULT_V1, logged: true }
    }
}
