'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getThresholds, Thresholds, recalculateAllSegments, getSharedSegmentationStats, calculateDriverStatus, calculateSegment } from '@/lib/scoring'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DaySummary {
    date: string          // ISO date string (YYYY-MM-DD)
    tripCount: number
    hadManagerMessage: boolean
    hadManagerCall: boolean
    hadAutoMessage: boolean
    hadPromotion: boolean
    hadAiAction: boolean
    hadGoalAchieved: boolean
}

export interface DriverWithCells {
    id: string
    yandexDriverId: string
    fullName: string
    phone: string | null
    hiredAt: Date | null
    dismissedAt: Date | null
    lastOrderAt: Date | null
    lastExternalPark: string | null
    lastFleetCheckStatus: string | null
    lastFleetCheckAt: Date | null
    licenseNumber: string | null
    segment: string
    segmentOverride: string | null
    statusOverride: string | null
    computedStatus: string        // active / risk / gone
    weeklyTrips: number
    periodTrips: number           // trips in analysis_period (e.g. 45 days)
    filteredTrips: number         // trips in the user-selected date range
    daysWithoutTrips: number
    cells: DaySummary[]
    recentEvents?: string[]
}

export interface DriversWithCellsResult {
    drivers: DriverWithCells[]
    total: number
    page: number
    segmentCounts: {
        profitable: number
        medium: number
        small: number
        dropped: number
        inactive: number
        unknown: number
    }
}

// ─── Main query ─────────────────────────────────────────────────────────────

export async function getDriversWithCells(
    page: number = 1,
    pageSize: number = 50,
    filters: {
        segment?: string
        status?: string
        search?: string
        dateRange?: number  // days to show, default 14
        fromDate?: string   // ISO date string
        toDate?: string     // ISO date string
        excludeGone?: boolean
        excludeInactive?: boolean
    } = {}
): Promise<DriversWithCellsResult> {
    let startDate: Date
    let endDate: Date

    const parseLocalDate = (dateStr: string, setToEnd: boolean = false) => {
        const [year, month, day] = dateStr.split('-').map(Number)
        const date = new Date(year, month - 1, day)
        if (setToEnd) {
            date.setHours(23, 59, 59, 999)
        } else {
            date.setHours(0, 0, 0, 0)
        }
        return date
    }

    const formatLocalDate = (date: Date) => {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
    }

    const dateRange = filters.dateRange || 14
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    if (filters.fromDate && filters.toDate) {
        const [fY, fM, fD] = filters.fromDate.split('-').map(Number)
        startDate = new Date(fY, fM - 1, fD)
        const [tY, tM, tD] = filters.toDate.split('-').map(Number)
        endDate = new Date(tY, tM - 1, tD)
    } else {
        startDate = new Date(today)
        startDate.setDate(today.getDate() - dateRange + 1)
        endDate = today
    }
    
    // Ensure endDate is end of day for DB queries
    const startOfRange = new Date(startDate)
    startOfRange.setHours(0, 0, 0, 0)
    const endOfRange = new Date(endDate)
    endOfRange.setHours(23, 59, 59, 999)

    // Get thresholds early to use in DB where clause if needed
    const thresholds = await getThresholds()

    // Build where clause
    const conditions: any[] = []

    if (filters.segment && filters.segment !== 'all') {
        conditions.push({ segment: filters.segment })
    }

    if (filters.search) {
        conditions.push({
            fullName: { contains: filters.search, mode: 'insensitive' }
        })
    }

    if (filters.excludeGone) {
        const goneThresholdDate = new Date()
        goneThresholdDate.setHours(0, 0, 0, 0)
        goneThresholdDate.setDate(goneThresholdDate.getDate() - 45)
        
        conditions.push({ dismissedAt: null })
        // Use lastOrderAt from DB which we'll backfill/sync
        conditions.push({ 
            OR: [
                { lastOrderAt: { gte: goneThresholdDate } },
                // If they were hired recently but haven't made a trip yet, keep them
                { 
                    AND: [
                        { lastOrderAt: null },
                        { hiredAt: { gte: goneThresholdDate } }
                    ]
                }
            ]
        })
    }

    if (filters.excludeInactive) {
        // Exclude those already marked as sleeping OR handle in-memory refinement
        // For the DB part, we exclude 'sleeping' segment
        conditions.push({ segment: { not: 'sleeping' } })
    }

    const where: any = conditions.length > 0 ? { AND: conditions } : {}
    if (filters.status && filters.status !== 'all') {
        // Note: status is computed in-memory, but we can approximate it for total count if needed
        // For now, we still filter in-memory, but the excludeGone filter helps reduce the set
    }

    // Use getSharedSegmentationStats to get accurate counts AND the list of active drivers
    // We'll also use this to implement custom priority sorting: Profitable > Medium > Small > Dropped
    const analysisDate = new Date()
    analysisDate.setDate(analysisDate.getDate() - thresholds.analysis_period)
    analysisDate.setHours(0, 0, 0, 0)

    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)

    // Build base "Active" query.
    // Driver is "active" if any of these is within the analysis period:
    //   - has a daySummary with trips
    //   - was hired in the period
    //   - lastOrderAt was in the period (resilient when daySummary sync lags)
    const activeWhere: any = {
        dismissedAt: filters.excludeGone ? null : undefined,
        OR: [
            { daySummaries: { some: { date: { gte: analysisDate }, tripCount: { gt: 0 } } } },
            { hiredAt: { gte: analysisDate } },
            { lastOrderAt: { gte: analysisDate } }
        ]
    }

    if (filters.search) {
        activeWhere.fullName = { contains: filters.search, mode: 'insensitive' }
    }

    const allActiveDrivers = await prisma.driver.findMany({
        where: activeWhere,
        select: {
            id: true,
            fullName: true,
            phone: true,
            licenseNumber: true,
            hiredAt: true,
            dismissedAt: true,
            lastOrderAt: true,
            segment: true,
            segmentOverride: true,
            statusOverride: true,
            lastExternalPark: true,
            lastFleetCheckStatus: true,
            lastFleetCheckAt: true,
            daySummaries: {
                where: { date: { gte: analysisDate } },
                select: { tripCount: true, date: true, hadManagerCall: true, hadManagerMessage: true, hadAutoMessage: true, hadPromotion: true, hadAiAction: true, hadGoalAchieved: true }
            }
        }
    })

    const segmentPriority: Record<string, number> = {
        profitable: 0,
        medium: 1,
        small: 2,
        dropped: 3,
        inactive: 4,
        unknown: 5
    }

    // Standardize allDates (local strings)
    const allDates: string[] = []
    let curr = new Date(startDate)
    while (curr <= endDate) {
        allDates.push(formatLocalDate(curr))
        curr.setDate(curr.getDate() + 1)
    }

    const processedDrivers = allActiveDrivers.map(d => {
        const periodTrips = d.daySummaries.reduce((sum, s) => sum + s.tripCount, 0)
        
        // Count days since last trip in 45-day period
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

        const calculatedSegment = calculateSegment(periodTrips, daysWithout, thresholds, d.segmentOverride)
        return {
            ...d,
            calculatedSegment,
            periodTrips,
            daysWithout
        }
    })

    // Filter by segment if specified
    const filteredDrivers = filters.segment && filters.segment !== 'all'
        ? processedDrivers.filter(d => d.calculatedSegment === filters.segment)
        : processedDrivers

    // Optional: Filter by status
    let finalFiltered = filteredDrivers
    if (filters.status && filters.status !== 'all') {
        finalFiltered = finalFiltered.filter(d => {
            const status = calculateDriverStatus(d.daysWithout, thresholds, d.statusOverride)
            return status === filters.status
        })
    }
    
    // Optional: Filter excludeInactive
    if (filters.excludeInactive) {
        finalFiltered = finalFiltered.filter(d => d.periodTrips > 0) // Example definition of inactive
    }

    // Sort by priority (Profitable > Medium > Small > Dropped)
    finalFiltered.sort((a, b) => {
        const pA = segmentPriority[a.calculatedSegment] ?? 99
        const pB = segmentPriority[b.calculatedSegment] ?? 99
        if (pA !== pB) return pA - pB
        return a.fullName.localeCompare(b.fullName)
    })

    const segmentMap: Record<string, number> = {
        profitable: 0,
        medium: 0,
        small: 0,
        dropped: 0,
        inactive: 0,
        unknown: 0
    }
    processedDrivers.forEach(d => {
        if (d.calculatedSegment in segmentMap) segmentMap[d.calculatedSegment]++
    })

    const total = finalFiltered.length
    const offset = pageSize === -1 ? 0 : (page - 1) * pageSize
    const paginatedDrivers = pageSize === -1 ? finalFiltered : finalFiltered.slice(offset, offset + pageSize)

    // Build the final array with cells for the VISIBLE range
    const resultDrivers: DriverWithCells[] = paginatedDrivers.map(d => {
        const summaryMap = new Map(d.daySummaries.map(s => [formatLocalDate(s.date), s]))
        
        const filledCells: DaySummary[] = allDates.map(dateStr => {
            const s = summaryMap.get(dateStr)
            return s ? {
                date: formatLocalDate(s.date),
                tripCount: s.tripCount,
                hadManagerMessage: s.hadManagerMessage,
                hadManagerCall: s.hadManagerCall,
                hadAutoMessage: s.hadAutoMessage,
                hadPromotion: s.hadPromotion,
                hadAiAction: s.hadAiAction,
                hadGoalAchieved: s.hadGoalAchieved,
            } : {
                date: dateStr,
                tripCount: 0,
                hadManagerMessage: false,
                hadManagerCall: false,
                hadAutoMessage: false,
                hadPromotion: false,
                hadAiAction: false,
                hadGoalAchieved: false,
            }
        })

        const filteredTrips = filledCells.reduce((sum, c) => sum + c.tripCount, 0)
        
        const sevenDaysAgo = new Date(todayEnd)
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
        const weeklyTrips = filledCells
            .filter(c => new Date(c.date) >= sevenDaysAgo)
            .reduce((sum, c) => sum + c.tripCount, 0)

        // Count days without (absolute)
        const computedStatus = calculateDriverStatus(d.daysWithout, thresholds, d.statusOverride)

        return {
            id: d.id,
            yandexDriverId: (d as any).yandexDriverId || d.id,
            fullName: d.fullName,
            phone: d.phone,
            licenseNumber: d.licenseNumber,
            hiredAt: d.hiredAt,
            dismissedAt: d.dismissedAt,
            lastOrderAt: d.lastOrderAt,
            segment: d.calculatedSegment,
            segmentOverride: d.segmentOverride,
            statusOverride: d.statusOverride,
            lastExternalPark: d.lastExternalPark,
            lastFleetCheckStatus: d.lastFleetCheckStatus,
            lastFleetCheckAt: d.lastFleetCheckAt,
            computedStatus,
            weeklyTrips,
            periodTrips: d.periodTrips,
            filteredTrips,
            daysWithoutTrips: d.daysWithout,
            cells: filledCells,
            recentEvents: [] 
        } as DriverWithCells
    })

    return {
        drivers: resultDrivers,
        total,
        page,
        segmentCounts: segmentMap as any
    }
}

// ─── Manager action logging ────────────────────────────────────────────────

export async function logManagerCall(driverId: string): Promise<void> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    await prisma.driverDaySummary.upsert({
        where: { driverId_date: { driverId, date: today } },
        update: { hadManagerCall: true },
        create: {
            driverId,
            date: today,
            hadManagerCall: true,
        },
    })

    // Also log to CommunicationEvent
    await prisma.communicationEvent.create({
        data: {
            driverId,
            channel: 'phone',
            direction: 'outbound',
            eventType: 'call',
            content: 'Звонок менеджера',
            createdBy: 'manager',
        },
    })
}

export async function logManagerMessage(driverId: string): Promise<void> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    await prisma.driverDaySummary.upsert({
        where: { driverId_date: { driverId, date: today } },
        update: { hadManagerMessage: true },
        create: {
            driverId,
            date: today,
            hadManagerMessage: true,
        },
    })

    // Also log to CommunicationEvent
    await prisma.communicationEvent.create({
        data: {
            driverId,
            channel: 'telegram',
            direction: 'outbound',
            eventType: 'message',
            content: 'Сообщение менеджера',
            createdBy: 'manager',
        },
    })
}

export async function logAutoMessage(driverId: string): Promise<void> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    await prisma.driverDaySummary.upsert({
        where: { driverId_date: { driverId, date: today } },
        update: { hadAutoMessage: true },
        create: {
            driverId,
            date: today,
            hadAutoMessage: true,
        },
    })
}

// ─── Driver Cards (Tinder-style) ───────────────────────────────────────────

export interface DriverCard {
    id: string
    fullName: string
    phone: string | null
    segment: string
    score: number | null
    computedStatus: string
    weeklyTrips: number
    daysWithoutTrips: number
    cells: DaySummary[]
}

export interface DriverCardsResult {
    drivers: DriverCard[]
    total: number
    page: number
}

export async function getDriverCards(
    page: number = 1,
    limit: number = 20,
    filters: {
        segment?: string
        status?: string
        search?: string
        dateRange?: number
        sortBy?: 'score' | 'name'
        sortOrder?: 'asc' | 'desc'
    } = {}
): Promise<DriverCardsResult> {
    const dateRange = filters.dateRange || 14
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - dateRange)
    startDate.setHours(0, 0, 0, 0)

    const endDate = new Date()
    endDate.setHours(23, 59, 59, 999)

    const formatLocalDate = (date: Date) => {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
    }

    // Build where clause
    const where: any = {}
    if (filters.segment && filters.segment !== 'all') {
        where.segment = filters.segment
    }
    if (filters.search) {
        where.fullName = { contains: filters.search, mode: 'insensitive' }
    }

    const total = await prisma.driver.count({ where })
    const offset = (page - 1) * limit

    // Determine sort
    const orderBy: any = filters.sortBy === 'name'
        ? { fullName: filters.sortOrder || 'asc' }
        : { score: filters.sortOrder || 'desc' }

    const drivers = await prisma.driver.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        select: {
            id: true,
            fullName: true,
            phone: true,
            segment: true,
            /*
            hiredAt: true,
            dismissedAt: true,
            lastOrderAt: true,
            */
            score: true,
            statusOverride: true,
        },
    })

    // Get day summaries
    const driverIds = drivers.map(d => d.id)
    const summaries = await prisma.driverDaySummary.findMany({
        where: {
            driverId: { in: driverIds },
            date: { gte: startDate, lte: endDate },
        },
        orderBy: { date: 'asc' },
    })

    // Group summaries by driver
    const summaryMap = new Map<string, DaySummary[]>()
    for (const s of summaries) {
        const cells = summaryMap.get(s.driverId) || []
        cells.push({
            date: formatLocalDate(s.date),
            tripCount: s.tripCount,
            hadManagerMessage: s.hadManagerMessage,
            hadManagerCall: s.hadManagerCall,
            hadAutoMessage: s.hadAutoMessage,
            hadPromotion: s.hadPromotion,
            hadAiAction: s.hadAiAction,
            hadGoalAchieved: s.hadGoalAchieved,
        })
        summaryMap.set(s.driverId, cells)
    }

    // Fill missing days
    const allDates: string[] = []
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        allDates.push(formatLocalDate(d))
    }

    const thresholds = await getThresholds()
    const cards: DriverCard[] = []

    for (const driver of drivers) {
        const existingCells = summaryMap.get(driver.id) || []
        const cellMap = new Map(existingCells.map(c => [c.date, c]))

        const filledCells: DaySummary[] = allDates.map(date => cellMap.get(date) || {
            date,
            tripCount: 0,
            hadManagerMessage: false,
            hadManagerCall: false,
            hadAutoMessage: false,
            hadPromotion: false,
            hadAiAction: false,
            hadGoalAchieved: false,
        })

        const weeklyTrips = filledCells
            .slice(-7)
            .reduce((sum, c) => sum + c.tripCount, 0)

        let daysWithoutTrips = 0
        for (let i = filledCells.length - 1; i >= 0; i--) {
            if (filledCells[i].tripCount > 0) break
            daysWithoutTrips++
        }

        const computedStatus = calculateDriverStatus(daysWithoutTrips, thresholds, driver.statusOverride)

        // Filter by status in-memory
        if (filters.status && filters.status !== 'all' && computedStatus !== filters.status) continue

        cards.push({
            id: driver.id,
            fullName: driver.fullName,
            phone: driver.phone,
            segment: driver.segment,
            score: driver.score,
            computedStatus,
            weeklyTrips,
            daysWithoutTrips,
            cells: filledCells,
        })
    }

    return { drivers: cards, total, page }
}


/**
 * Internal helper: syncs Yandex Fleet driver profiles for the given work_status set.
 * Used by both syncArchivedDrivers (['dismissed']) and syncActiveDrivers (['working']).
 * Pagination handled here. Retries on 429 rate limit.
 */
async function syncDriversByStatuses(
    statuses: string[],
    label: string
): Promise<{ success: boolean; count: number }> {
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
    })

    if (!connection) {
        throw new Error('No API connection configured')
    }

    // Local fetch wrapper with retry on 429 (matches YandexFleetService.yandexFetch).
    async function yandexFetch(url: string, init: RequestInit): Promise<Response> {
        const MAX_ATTEMPTS = 5
        let attempt = 0
        while (true) {
            attempt++
            const res = await fetch(url, init)
            if (res.status !== 429) return res
            if (attempt >= MAX_ATTEMPTS) return res
            const retryAfter = res.headers.get('retry-after')
            const backoffMs = retryAfter
                ? Math.min(60_000, parseInt(retryAfter, 10) * 1000 || 2000)
                : Math.min(32_000, 2_000 * Math.pow(2, attempt - 1))
            console.warn(`[${label}] 429 rate limit, retry ${attempt}/${MAX_ATTEMPTS} in ${backoffMs}ms`)
            await new Promise(r => setTimeout(r, backoffMs))
        }
    }

    const yandexEndpoint = `https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list`
    let offset = 0
    const limit = 1000
    let totalCount = 0
    let totalInPark = 0

    try {
        do {
            const payload: any = {
                query: {
                    park: { id: connection.parkId },
                    driver: { status: statuses }
                },
                fields: {
                    driver_profile: [
                        "id",
                        "first_name",
                        "last_name",
                        "phones",
                        "work_status",
                        "created_date",
                        "driver_license"
                    ],
                    current_status: [
                        "status",
                        "status_updated_at"
                    ]
                },
                limit,
                offset
            }

            const res = await yandexFetch(yandexEndpoint, {
                method: 'POST',
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            })

            if (!res.ok) {
                const errorText = await res.text()
                throw new Error(`Yandex API Error: ${res.status} ${errorText}`)
            }

            const data = await res.json()
            const profiles = data.driver_profiles || []
            totalInPark = data.total || 0

            console.log(`[${label}] Fetched ${profiles.length} profiles (offset: ${offset}, total in park: ${totalInPark}).`)

            for (const p of profiles) {
                const profile = p.driver_profile
                const currentStatus = p.current_status
                const fullName = `${profile.last_name || ''} ${profile.first_name || ''}`.trim() || 'No Name'
                const phone = profile.phones?.[0] || null

                const isDismissed = profile.work_status === 'fired' || currentStatus?.status === 'fired'
                const dismissedAt = isDismissed && currentStatus?.status_updated_at
                    ? new Date(currentStatus.status_updated_at)
                    : null

                const hiredAt = profile.created_date ? new Date(profile.created_date) : null

                const licenseData = profile.driver_license
                const licenseNumber = typeof licenseData === 'string'
                    ? licenseData
                    : (licenseData?.number || null)

                const updateData: any = {
                    fullName,
                    phone,
                    dismissedAt,
                }

                if (hiredAt) updateData.hiredAt = hiredAt
                if (licenseNumber) updateData.licenseNumber = licenseNumber

                await prisma.driver.upsert({
                    where: { yandexDriverId: profile.id },
                    update: updateData,
                    create: {
                        ...updateData,
                        yandexDriverId: profile.id,
                        segment: 'unknown',
                    }
                })
            }

            totalCount += profiles.length
            offset += limit

            if (offset >= totalInPark || profiles.length === 0) break

            // Polite pause between paginated calls
            await new Promise(r => setTimeout(r, 400))

        } while (true)

        return { success: true, count: totalCount }
    } catch (err: any) {
        console.error(`${label} error:`, err)
        throw err
    }
}

/**
 * Syncs ACTIVE (working) drivers from Yandex Fleet API.
 * New drivers will be created; existing drivers will have name/phone/etc updated.
 */
export async function syncActiveDrivers() {
    const result = await syncDriversByStatuses(['working'], 'syncActiveDrivers')
    revalidatePath('/drivers')
    return result
}

/**
 * Syncs archived (dismissed) drivers from Yandex Fleet API to the local database.
 * Supports pagination via cursor to fetch all records.
 */
export async function syncArchivedDrivers() {
    try {
        const result = await syncDriversByStatuses(['dismissed'], 'syncArchivedDrivers')
        revalidatePath('/drivers/archive')
        return result
    } catch (err: any) {
        throw err
    }
}
