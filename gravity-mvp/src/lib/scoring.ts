// Scoring utilities — imported by server actions

import { prisma } from '@/lib/prisma'

// Default threshold values
const DEFAULT_THRESHOLDS: Record<string, number> = {
    profitable_min: 500,  // trips in analysis period for "profitable"
    medium_min: 150,      // trips in analysis period for "medium"
    small_min: 1,         // trips in analysis period for "small"
    analysis_period: 45,  // primary period for segmentation
    dropped_days: 7,      // N days without trips → "dropped" (Выпал)
    risk_days: 3,         // days without trips → "risk"
    gone_days: 45,        // days without trips → "gone"
}

export interface Thresholds {
    profitable_min: number
    medium_min: number
    small_min: number
    analysis_period: number
    dropped_days: number
    risk_days: number
    gone_days: number
}

/**
 * Load scoring thresholds from DB, falling back to defaults
 */
export async function getThresholds(): Promise<Thresholds> {
    const rows = await prisma.scoringThreshold.findMany()
    const map: Record<string, number> = {}
    for (const row of rows) {
        map[row.key] = row.value
    }
    return {
        profitable_min: map.profitable_min ?? DEFAULT_THRESHOLDS.profitable_min,
        medium_min: map.medium_min ?? DEFAULT_THRESHOLDS.medium_min,
        small_min: map.small_min ?? DEFAULT_THRESHOLDS.small_min,
        analysis_period: map.analysis_period ?? DEFAULT_THRESHOLDS.analysis_period,
        dropped_days: map.dropped_days ?? DEFAULT_THRESHOLDS.dropped_days,
        risk_days: map.risk_days ?? DEFAULT_THRESHOLDS.risk_days,
        gone_days: map.gone_days ?? DEFAULT_THRESHOLDS.gone_days,
    }
}

/**
 * Calculate driver segment based on trip counts over analysis period
 * Priority: 
 * 1. Dropped (0 trips in N days)
 * 2. Tripped count over analysis period (Profitable/Medium/Small)
 */
export function calculateSegment(
    periodTrips: number, 
    daysWithoutTrips: number, 
    thresholds: Thresholds, 
    override?: string | null
): string {
    if (override) return override
    
    // 0. Check if any trips at all in period
    if (periodTrips === 0) return 'inactive'
    
    // 1. Check inactivity (Dropped / Выпал)
    if (daysWithoutTrips >= thresholds.dropped_days) return 'dropped'
    
    // 2. Continuous trip count categories
    if (periodTrips >= thresholds.profitable_min) return 'profitable'
    if (periodTrips >= thresholds.medium_min) return 'medium'
    if (periodTrips >= thresholds.small_min) return 'small'
    
    return 'small' 
}

/**
 * Calculate driver status based on consecutive days without trips
 */
export function calculateDriverStatus(daysWithoutTrips: number, thresholds: Thresholds, override?: string | null): string {
    if (override) return override
    if (daysWithoutTrips >= thresholds.gone_days) return 'gone'
    if (daysWithoutTrips >= thresholds.risk_days) return 'risk'
    return 'active'
}

/**
 * Count consecutive days without trips for a driver (from today backwards)
 * Now uses absolute date difference for accuracy.
 */
export async function countDaysWithoutTrips(driverId: string): Promise<number> {
    const latestTrip = await prisma.driverDaySummary.findFirst({
        where: { driverId, tripCount: { gt: 0 } },
        orderBy: { date: 'desc' },
        select: { date: true }
    })

    if (!latestTrip) {
        // Fallback to lastOrderAt or hiredAt if no summary records found
        const driver = await prisma.driver.findUnique({
            where: { id: driverId },
            select: { lastOrderAt: true, hiredAt: true }
        })
        const lastActive = driver?.lastOrderAt || driver?.hiredAt
        if (!lastActive) return 999
        
        const diff = new Date().getTime() - lastActive.getTime()
        return Math.floor(diff / (1000 * 60 * 60 * 24))
    }

    const today = new Date()
    today.setHours(23, 59, 59, 999)
    const diff = today.getTime() - latestTrip.date.getTime()
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)))
}

/**
 * Count total trips in the last 7 days for a driver
 */
export async function countWeeklyTrips(driverId: string): Promise<number> {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const result = await prisma.driverDaySummary.aggregate({
        where: {
            driverId,
            date: { gte: sevenDaysAgo },
        },
        _sum: { tripCount: true },
    })
    return result._sum.tripCount ?? 0
}

/**
 * Recalculate and persist segment + status + score for one driver
 */
export async function recalculateDriverScoring(driverId: string): Promise<void> {
    const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { segmentOverride: true, statusOverride: true },
    })
    if (!driver) return

    const thresholds = await getThresholds()
    
    // 1. Get total trips in the analysis period (e.g. 45 days)
    const analysisDate = new Date()
    analysisDate.setDate(analysisDate.getDate() - thresholds.analysis_period)
    
    const periodTripsResult = await prisma.driverDaySummary.aggregate({
        where: { driverId, date: { gte: analysisDate } },
        _sum: { tripCount: true }
    })
    const periodTrips = periodTripsResult._sum.tripCount ?? 0
    
    // 2. Get consecutive days without trips
    const daysWithout = await countDaysWithoutTrips(driverId)

    // 3. New segment logic
    const segment = calculateSegment(periodTrips, daysWithout, thresholds, driver.segmentOverride)
    const score = await calculateDriverScore(driverId, segment, thresholds)

    // 4. Update lastOrderAt from real trip history
    const latestTrip = await prisma.driverDaySummary.findFirst({
        where: { driverId, tripCount: { gt: 0 } },
        orderBy: { date: 'desc' },
        select: { date: true }
    })

    await prisma.driver.update({
        where: { id: driverId },
        data: { 
            segment, 
            score,
            ...(latestTrip ? { lastOrderAt: latestTrip.date } : {})
        },
    })
}

/**
 * Bulk recalculate all drivers
 */
export async function recalculateAllSegments(): Promise<{ count: number }> {
    const thresholds = await getThresholds()
    const analysisDate = new Date()
    analysisDate.setDate(analysisDate.getDate() - thresholds.analysis_period)

    // Only process drivers who have been active in the analysis period
    // to avoid processing thousands of archived/old drivers
    const drivers = await prisma.driver.findMany({
        where: {
            OR: [
                { daySummaries: { some: { date: { gte: analysisDate }, tripCount: { gt: 0 } } } },
                { hiredAt: { gte: analysisDate } },
                { lastOrderAt: { gte: analysisDate } }
            ]
        },
        select: { id: true }
    })
    
    for (const d of drivers) {
        await recalculateDriverScoring(d.id)
    }
    return { count: drivers.length }
}

/**
 * Shared logic to calculate segment distribution for any set of drivers.
 * Used by both the main list (actions.ts) and the settings preview.
 */
export async function getSharedSegmentationStats(
    thresholds: Thresholds,
    filters?: { search?: string; excludeGone?: boolean }
): Promise<{ counts: Record<string, number>; total: number }> {
    const analysisDate = new Date()
    analysisDate.setDate(analysisDate.getDate() - thresholds.analysis_period)
    analysisDate.setHours(0, 0, 0, 0)

    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)

    // Build base where clause for "Active" drivers.
    // Includes lastOrderAt as a fallback when DriverDaySummary sync lags behind.
    const activeWhere: any = {
        OR: [
            { daySummaries: { some: { date: { gte: analysisDate }, tripCount: { gt: 0 } } } },
            { hiredAt: { gte: analysisDate } },
            { lastOrderAt: { gte: analysisDate } }
        ]
    }

    if (filters?.search) {
        activeWhere.fullName = { contains: filters.search, mode: 'insensitive' }
    }
    if (filters?.excludeGone) {
        activeWhere.dismissedAt = null
    }

    const drivers = await prisma.driver.findMany({
        where: activeWhere,
        select: {
            id: true,
            segmentOverride: true,
            lastOrderAt: true,
            hiredAt: true,
            daySummaries: {
                where: { date: { gte: analysisDate } },
                select: { tripCount: true, date: true }
            }
        }
    })

    const counts: Record<string, number> = {
        profitable: 0,
        medium: 0,
        small: 0,
        dropped: 0,
        inactive: 0,
        unknown: 0
    }

    for (const d of drivers) {
        const periodTrips = d.daySummaries.reduce((sum, s) => sum + s.tripCount, 0)
        
        const lastTrip = [...d.daySummaries]
            .filter(s => s.tripCount > 0)
            .sort((a, b) => b.date.getTime() - a.date.getTime())[0]
            
        let daysWithout = 0
        const lastActive = lastTrip?.date || d.lastOrderAt || d.hiredAt
        if (lastActive) {
            const diff = todayEnd.getTime() - lastActive.getTime()
            daysWithout = Math.floor(diff / (1000 * 60 * 60 * 24))
        } else {
            daysWithout = 999
        }

        const segment = calculateSegment(periodTrips, daysWithout, thresholds, d.segmentOverride)
        if (segment in counts) {
            counts[segment]++
        } else {
            counts.unknown++
        }
    }

    return { counts, total: drivers.length }
}

// ─── Score calculation ─────────────────────────────────────────────────────

const SEGMENT_WEIGHTS: Record<string, number> = {
    profitable: 100,
    medium: 70,
    small: 40,
    sleeping: 0,
    unknown: 20,
}

/**
 * Calculate driver score (0-100):
 *   50% — activity ratio over last 14 days
 *   30% — segment weight
 *   20% — promotion + goal engagement
 */
export async function calculateDriverScore(
    driverId: string,
    segment: string,
    thresholds: Thresholds
): Promise<number> {
    const fourteenDaysAgo = new Date()
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

    const summaries = await prisma.driverDaySummary.findMany({
        where: {
            driverId,
            date: { gte: fourteenDaysAgo },
        },
        select: {
            tripCount: true,
            hadPromotion: true,
            hadGoalAchieved: true,
        },
    })

    // 50% — activity ratio
    const totalTrips = summaries.reduce((sum, s) => sum + s.tripCount, 0)
    const maxTrips = thresholds.profitable_min * 2 // e.g. 40 trips in 14 days = 100%
    const activityRatio = Math.min(totalTrips / Math.max(maxTrips, 1), 1)

    // 30% — segment weight
    const segmentWeight = (SEGMENT_WEIGHTS[segment] ?? 20) / 100

    // 20% — engagement (promotions + goals over 14 days)
    const promotionDays = summaries.filter(s => s.hadPromotion).length
    const goalDays = summaries.filter(s => s.hadGoalAchieved).length
    const engagementRatio = Math.min((promotionDays + goalDays) / 14, 1)

    const score = Math.round(
        activityRatio * 50 +
        segmentWeight * 30 +
        engagementRatio * 20
    )

    return Math.max(0, Math.min(100, score))
}

