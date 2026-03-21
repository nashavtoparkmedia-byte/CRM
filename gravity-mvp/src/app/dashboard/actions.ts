'use server'

import { prisma } from '@/lib/prisma'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DashboardStats {
    activeDriversToday: number
    tripsToday: number
    tripsLast7Days: number
    driversAtRisk: number
    sleepingDrivers: number
    promotionsActive: number
}

export interface TripDataPoint {
    date: string
    trips: number
}

export interface SegmentData {
    name: string
    value: number
    color: string
}

export interface RiskDriver {
    id: string
    fullName: string
    phone: string | null
    segment: string
    score: number | null
    daysInactive: number
}

export interface PromotionPerf {
    name: string
    assigned: number
    completed: number
    conversion: number
}

export interface HeatmapDay {
    date: string
    dayName: string
    activePercent: number
    totalDrivers: number
    activeDrivers: number
}

// ─── Actions ────────────────────────────────────────────────────────────────

export async function getDashboardStats(): Promise<DashboardStats> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const sevenDaysAgo = new Date(today)
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    // Try to get from pre-aggregated stats first
    const todayStats = await prisma.dailyParkStats.findUnique({
        where: { date: today },
    })

    if (todayStats) {
        // Get 7-day trips
        const weekStats = await prisma.dailyParkStats.findMany({
            where: { date: { gte: sevenDaysAgo } },
            select: { totalTrips: true },
        })
        const tripsLast7Days = weekStats.reduce((s, d) => s + d.totalTrips, 0)

        return {
            activeDriversToday: todayStats.activeDrivers,
            tripsToday: todayStats.totalTrips,
            tripsLast7Days,
            driversAtRisk: todayStats.driversAtRisk,
            sleepingDrivers: todayStats.sleepingDrivers,
            promotionsActive: todayStats.promotionsActive,
        }
    }

    // Fallback: compute from raw data
    const [todaySummaries, weekSummaries, segmentCounts] = await Promise.all([
        prisma.driverDaySummary.findMany({
            where: { date: today },
            select: { tripCount: true, hadPromotion: true },
        }),
        prisma.driverDaySummary.findMany({
            where: { date: { gte: sevenDaysAgo } },
            select: { tripCount: true },
        }),
        prisma.driver.groupBy({
            by: ['segment'],
            _count: { segment: true },
        }),
    ])

    const activeDriversToday = todaySummaries.filter(s => s.tripCount > 0).length
    const tripsToday = todaySummaries.reduce((s, d) => s + d.tripCount, 0)
    const tripsLast7Days = weekSummaries.reduce((s, d) => s + d.tripCount, 0)
    const promotionsActive = todaySummaries.filter(s => s.hadPromotion).length

    const sleeping = segmentCounts.find(g => g.segment === 'sleeping')?._count?.segment ?? 0

    // Count at-risk: drivers with 3+ days without trips
    const allDrivers = await prisma.driver.findMany({ select: { id: true } })
    let atRisk = 0
    for (const driver of allDrivers) {
        const recent = await prisma.driverDaySummary.findMany({
            where: { driverId: driver.id, date: { gte: sevenDaysAgo } },
            orderBy: { date: 'desc' },
            take: 7,
            select: { tripCount: true },
        })
        let consecutive = 0
        for (const r of recent) {
            if (r.tripCount > 0) break
            consecutive++
        }
        if (consecutive >= 3 && consecutive < 30) atRisk++
    }

    return {
        activeDriversToday,
        tripsToday,
        tripsLast7Days,
        driversAtRisk: atRisk,
        sleepingDrivers: sleeping,
        promotionsActive,
    }
}

export async function getDashboardCharts() {
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    thirtyDaysAgo.setHours(0, 0, 0, 0)

    // Try pre-aggregated
    const parkStats = await prisma.dailyParkStats.findMany({
        where: { date: { gte: thirtyDaysAgo } },
        orderBy: { date: 'asc' },
    })

    let tripsPerDay: TripDataPoint[]
    let segmentDistribution: SegmentData[]
    let reactivationData: TripDataPoint[]

    if (parkStats.length > 0) {
        tripsPerDay = parkStats.map(s => ({
            date: s.date.toISOString().split('T')[0],
            trips: s.totalTrips,
        }))

        const latest = parkStats[parkStats.length - 1]
        segmentDistribution = [
            { name: 'Прибыльные', value: latest.profitableCount, color: '#10b981' },
            { name: 'Средние', value: latest.mediumCount, color: '#f59e0b' },
            { name: 'Малые', value: latest.smallCount, color: '#3b82f6' },
            { name: 'Спящие', value: latest.sleepingDrivers, color: '#ef4444' },
        ]

        reactivationData = parkStats.map(s => ({
            date: s.date.toISOString().split('T')[0],
            trips: s.reactivatedDrivers,
        }))
    } else {
        // Fallback: compute from DriverDaySummary
        const summaries = await prisma.driverDaySummary.groupBy({
            by: ['date'],
            where: { date: { gte: thirtyDaysAgo } },
            _sum: { tripCount: true },
            orderBy: { date: 'asc' },
        })

        tripsPerDay = summaries.map(s => ({
            date: s.date.toISOString().split('T')[0],
            trips: s._sum.tripCount ?? 0,
        }))

        const segCounts = await prisma.driver.groupBy({
            by: ['segment'],
            _count: { segment: true },
        })

        segmentDistribution = [
            { name: 'Прибыльные', value: segCounts.find(g => g.segment === 'profitable')?._count?.segment ?? 0, color: '#10b981' },
            { name: 'Средние', value: segCounts.find(g => g.segment === 'medium')?._count?.segment ?? 0, color: '#f59e0b' },
            { name: 'Малые', value: segCounts.find(g => g.segment === 'small')?._count?.segment ?? 0, color: '#3b82f6' },
            { name: 'Спящие', value: segCounts.find(g => g.segment === 'sleeping')?._count?.segment ?? 0, color: '#ef4444' },
        ]

        reactivationData = []
    }

    return { tripsPerDay, segmentDistribution, reactivationData }
}

export async function getRiskDrivers(): Promise<RiskDriver[]> {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    sevenDaysAgo.setHours(0, 0, 0, 0)

    const drivers = await prisma.driver.findMany({
        select: {
            id: true,
            fullName: true,
            phone: true,
            segment: true,
            score: true,
        },
    })

    const riskDrivers: RiskDriver[] = []

    for (const driver of drivers) {
        const summaries = await prisma.driverDaySummary.findMany({
            where: { driverId: driver.id },
            orderBy: { date: 'desc' },
            take: 14,
            select: { tripCount: true },
        })

        let daysInactive = 0
        for (const s of summaries) {
            if (s.tripCount > 0) break
            daysInactive++
        }

        if (daysInactive >= 3) {
            riskDrivers.push({
                ...driver,
                daysInactive,
            })
        }
    }

    // Sort by days inactive desc, take top 10
    return riskDrivers
        .sort((a, b) => b.daysInactive - a.daysInactive)
        .slice(0, 10)
}

export async function getParkHeatmap(): Promise<HeatmapDay[]> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const totalDrivers = await prisma.driver.count()
    const days: HeatmapDay[] = []
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

    for (let i = 6; i >= 0; i--) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)

        const active = await prisma.driverDaySummary.count({
            where: {
                date,
                tripCount: { gt: 0 },
            },
        })

        days.push({
            date: date.toISOString().split('T')[0],
            dayName: dayNames[date.getDay()],
            activePercent: totalDrivers > 0 ? Math.round((active / totalDrivers) * 100) : 0,
            totalDrivers,
            activeDrivers: active,
        })
    }

    return days
}
