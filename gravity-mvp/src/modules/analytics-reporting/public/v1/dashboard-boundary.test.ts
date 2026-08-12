import { describe, expect, it, vi } from 'vitest'

const capabilities = vi.hoisted(() => ({
    getDashboardStats: vi.fn(),
    DashboardCard: vi.fn(),
    DashboardKPI: vi.fn(),
}))

vi.mock('@/app/dashboard/actions', () => ({ getDashboardStats: capabilities.getDashboardStats }))
vi.mock('@/app/dashboard/components/DashboardCard', () => ({ DashboardCard: capabilities.DashboardCard }))
vi.mock('@/app/dashboard/components/DashboardKPI', () => ({ DashboardKPI: capabilities.DashboardKPI }))

import { getDashboardStatsV1 } from './dashboard-query'
import { DashboardCardV1 } from './dashboard-card-view'
import { DashboardKpiV1 } from './dashboard-kpi-view'

describe('Analytics public dashboard boundary', () => {
    it('exposes only the reviewed query and projections', () => {
        expect(getDashboardStatsV1).toBe(capabilities.getDashboardStats)
        expect(DashboardCardV1).toBe(capabilities.DashboardCard)
        expect(DashboardKpiV1).toBe(capabilities.DashboardKPI)
    })
})
