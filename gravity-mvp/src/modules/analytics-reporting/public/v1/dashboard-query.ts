'use server'

import {
    getDashboardStats,
    type DashboardStats,
} from '@/app/dashboard/actions'

export type DashboardStatsV1 = DashboardStats

export async function getDashboardStatsV1(): Promise<DashboardStatsV1> {
    return getDashboardStats()
}
