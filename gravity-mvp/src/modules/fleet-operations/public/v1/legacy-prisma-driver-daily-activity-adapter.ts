import { prisma } from '@/lib/prisma'
import type { DriverDailyActivityV1 } from '../../../../contracts/fleet-operations/v1'
import type { RecordDriverDailyActivityPersistencePortV1 } from './record-driver-daily-activity-handler'

const FIELD_BY_ACTIVITY: Record<DriverDailyActivityV1, string> = {
    manager_message: 'hadManagerMessage',
    manager_call: 'hadManagerCall',
    auto_message: 'hadAutoMessage',
    goal_achieved: 'hadGoalAchieved',
}

export const legacyPrismaRecordDriverDailyActivityPortV1: RecordDriverDailyActivityPersistencePortV1 = {
    async recordActivity({ driverId, dayStart, activity }) {
        const date = new Date(dayStart)
        const update = { [FIELD_BY_ACTIVITY[activity]]: true }
        await prisma.driverDaySummary.upsert({
            where: { driverId_date: { driverId, date } },
            update,
            create: { driverId, date, ...update },
        })
    },
}
