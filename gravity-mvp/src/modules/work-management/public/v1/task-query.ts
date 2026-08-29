'use server'

import { getDriverActiveTasks } from '@/app/tasks/actions'

export async function getDriverActiveTasksV1(driverId: string) {
    return getDriverActiveTasks(driverId)
}
