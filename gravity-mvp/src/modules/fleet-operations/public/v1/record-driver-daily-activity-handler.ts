import {
    RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1,
    parseRecordDriverDailyActivityCommandV1,
    type DriverDailyActivityV1,
    type RecordDriverDailyActivityCommandV1,
    type RecordDriverDailyActivityResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface RecordDriverDailyActivityPersistencePortV1 {
    recordActivity(input: { driverId: string; dayStart: string; activity: DriverDailyActivityV1 }): Promise<void>
}

export function createRecordDriverDailyActivityHandlerV1(port: RecordDriverDailyActivityPersistencePortV1) {
    return async function recordDriverDailyActivityV1(
        command: RecordDriverDailyActivityCommandV1 | unknown,
    ): Promise<RecordDriverDailyActivityResultV1> {
        const parsed = parseRecordDriverDailyActivityCommandV1(command)
        await port.recordActivity({ driverId: parsed.driverId, dayStart: parsed.dayStart, activity: parsed.activity })
        return { contract: RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1, recorded: true }
    }
}
