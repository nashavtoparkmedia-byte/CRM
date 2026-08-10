import {
    RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
    type DriverDailyActivityV1,
    type RecordDriverDailyActivityCommandV1,
    type RecordDriverDailyActivityResultV1,
} from '@/contracts/fleet-operations/v1'
import {
    RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
    type ManagerDriverCommunicationActivityV1,
    type RecordManagerDriverCommunicationCommandV1,
    type RecordManagerDriverCommunicationResultV1,
} from '@/contracts/messaging/v1'
import { recordDriverDailyActivityV1 } from '@/modules/fleet-operations/public/v1'
import { recordManagerDriverCommunicationV1 } from '@/modules/messaging/public/v1'

export interface ManagerDriverCommunicationOwnerApiV1 {
    recordDriverDailyActivityV1(
        command: RecordDriverDailyActivityCommandV1,
    ): Promise<RecordDriverDailyActivityResultV1>
    recordManagerDriverCommunicationV1(
        command: RecordManagerDriverCommunicationCommandV1,
    ): Promise<RecordManagerDriverCommunicationResultV1>
}

export interface ManagerDriverCommunicationClockV1 {
    now(): number
}

const defaultOwnersV1: ManagerDriverCommunicationOwnerApiV1 = {
    recordDriverDailyActivityV1,
    recordManagerDriverCommunicationV1,
}

const systemClockV1: ManagerDriverCommunicationClockV1 = {
    now: Date.now,
}

const dailyActivityByCommunication: Record<
    ManagerDriverCommunicationActivityV1,
    DriverDailyActivityV1
> = {
    call: 'manager_call',
    message: 'manager_message',
}

export function createManagerDriverCommunicationOrchestratorV1(
    owners: ManagerDriverCommunicationOwnerApiV1,
    clock: ManagerDriverCommunicationClockV1,
) {
    return async function recordManagerDriverCommunication(
        driverId: string,
        activity: ManagerDriverCommunicationActivityV1,
    ): Promise<void> {
        const dayStart = new Date(clock.now())
        dayStart.setHours(0, 0, 0, 0)

        await owners.recordDriverDailyActivityV1({
            contract: RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
            driverId,
            dayStart: dayStart.toISOString(),
            activity: dailyActivityByCommunication[activity],
        })
        await owners.recordManagerDriverCommunicationV1({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId,
            activity,
        })
    }
}

export const recordManagerDriverCommunication = createManagerDriverCommunicationOrchestratorV1(
    defaultOwnersV1,
    systemClockV1,
)
