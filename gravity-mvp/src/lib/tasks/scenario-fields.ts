// ═══════════════════════════════════════════════════════════════════
// Scenario Fields — Wave 1 + Отток extension
// Auto-population, validation, and update logic for scenarioData.
// ═══════════════════════════════════════════════════════════════════

import { prisma } from '@/lib/prisma'
import type { ScenarioData, ScenarioFieldDef } from './scenario-config'
import { getScenarioFields } from './scenario-config'

// ─── Types ────────────────────────────────────────────────────────

interface DriverContext {
    fullName: string
    licenseNumber: string | null
    segment: string
    lastOrderAt: Date | null
    lastExternalPark: string | null
    customFields: Record<string, unknown>
}

interface DaySummaryContext {
    recentTripsCount: number          // sum of tripCount for last 7 days
    inactiveDays: number              // days since last day with tripCount > 0
    completedOrders: number           // sum of tripCount for last 180 days
    yandexTripsCount: number          // same as completedOrders (from DriverDaySummary — only Yandex)
    tripsByMonth: Record<number, number>  // month number (1-12) → trip count (last 6 months)
}

// ─── Auto-populate on task creation ───────────────────────────────

export async function buildInitialScenarioData(
    scenarioId: string,
    driverId: string,
): Promise<ScenarioData> {
    const fields = getScenarioFields(scenarioId)
    if (fields.length === 0) return {}

    const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: {
            fullName: true,
            licenseNumber: true,
            segment: true,
            lastOrderAt: true,
            lastExternalPark: true,
            customFields: true,
        },
    })
    if (!driver) return {}

    const driverCtx: DriverContext = {
        fullName: driver.fullName,
        licenseNumber: driver.licenseNumber,
        segment: driver.segment,
        lastOrderAt: driver.lastOrderAt,
        lastExternalPark: driver.lastExternalPark,
        customFields: (driver.customFields as Record<string, unknown>) ?? {},
    }

    const daySummaryCtx = await computeDaySummaryContext(driverId)

    const now = new Date().toISOString()
    const data: ScenarioData = {}

    for (const field of fields) {
        if (field.source === 'manual') continue

        const value = resolveFieldValue(field, driverCtx, daySummaryCtx)
        if (value !== undefined) {
            data[field.id] = { value, source: field.source, updatedAt: now }
        }
    }

    return data
}

// ─── Update a single manual field ─────────────────────────────────

export async function updateScenarioField(
    taskId: string,
    fieldId: string,
    value: unknown,
): Promise<void> {
    const rows = await prisma.$queryRaw<{ scenario: string | null; scenarioData: ScenarioData | null }[]>`
        SELECT scenario, "scenarioData"::jsonb as "scenarioData" FROM tasks WHERE id = ${taskId} LIMIT 1
    `
    const task = rows[0]
    if (!task?.scenario) {
        throw new Error('Task has no scenario')
    }

    const fields = getScenarioFields(task.scenario)
    const fieldDef = fields.find(f => f.id === fieldId)
    if (!fieldDef) {
        throw new Error(`Unknown field: ${fieldId} for scenario: ${task.scenario}`)
    }
    // Любое поле можно переопределить вручную — оно получит source: 'manual'.
    // Авто/derived поля впоследствии не перезаписывают manual override.

    validateFieldValue(fieldDef, value)

    const existing = task.scenarioData ?? {}
    const updated: ScenarioData = {
        ...existing,
        [fieldId]: {
            value,
            source: 'manual',
            updatedAt: new Date().toISOString(),
        },
    }

    await prisma.$executeRaw`
        UPDATE tasks SET "scenarioData" = ${JSON.stringify(updated)}::jsonb WHERE id = ${taskId}
    `
}

// ─── Reset a field to auto/derived (removes manual override) ──────

export async function resetScenarioField(taskId: string, fieldId: string): Promise<void> {
    const rows = await prisma.$queryRaw<{ driverId: string; scenario: string | null; scenarioData: ScenarioData | null }[]>`
        SELECT "driverId", scenario, "scenarioData"::jsonb as "scenarioData" FROM tasks WHERE id = ${taskId} LIMIT 1
    `
    const task = rows[0]
    if (!task?.scenario) throw new Error('Task has no scenario')

    const fields = getScenarioFields(task.scenario)
    const fieldDef = fields.find(f => f.id === fieldId)
    if (!fieldDef) throw new Error(`Unknown field: ${fieldId}`)

    const existing = task.scenarioData ?? {}
    const updated: ScenarioData = { ...existing }

    // Удаляем текущее значение, затем пересчитываем auto/derived, если возможно
    delete updated[fieldId]

    if (fieldDef.source !== 'manual') {
        // Try to recompute auto/derived
        const driver = await prisma.driver.findUnique({
            where: { id: task.driverId },
            select: {
                fullName: true, licenseNumber: true, segment: true,
                lastOrderAt: true, lastExternalPark: true, customFields: true,
            },
        })
        if (driver) {
            const daySummaryCtx = await computeDaySummaryContext(task.driverId)
            const driverCtx: DriverContext = {
                fullName: driver.fullName,
                licenseNumber: driver.licenseNumber,
                segment: driver.segment,
                lastOrderAt: driver.lastOrderAt,
                lastExternalPark: driver.lastExternalPark,
                customFields: (driver.customFields as Record<string, unknown>) ?? {},
            }
            const value = resolveFieldValue(fieldDef, driverCtx, daySummaryCtx)
            if (value !== undefined) {
                updated[fieldId] = {
                    value,
                    source: fieldDef.source,
                    updatedAt: new Date().toISOString(),
                }
            }
        }
    }

    await prisma.$executeRaw`
        UPDATE tasks SET "scenarioData" = ${JSON.stringify(updated)}::jsonb WHERE id = ${taskId}
    `
}

// ─── Helpers ──────────────────────────────────────────────────────

async function computeDaySummaryContext(driverId: string): Promise<DaySummaryContext> {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

    const recentSummaries = await prisma.driverDaySummary.findMany({
        where: { driverId, date: { gte: sevenDaysAgo } },
        select: { date: true, tripCount: true },
        orderBy: { date: 'desc' },
    })

    const longRangeSummaries = await prisma.driverDaySummary.findMany({
        where: { driverId, date: { gte: sixMonthsAgo } },
        select: { date: true, tripCount: true },
        orderBy: { date: 'desc' },
    })

    const recentTripsCount = recentSummaries.reduce((sum, s) => sum + s.tripCount, 0)
    const completedOrders = longRangeSummaries.reduce((sum, s) => sum + s.tripCount, 0)
    const yandexTripsCount = completedOrders

    // inactiveDays: days since last activity in the 6mo window
    let inactiveDays = 180  // default if no data at all
    if (longRangeSummaries.length > 0) {
        const lastActive = longRangeSummaries.find(s => s.tripCount > 0)
        if (lastActive) {
            const diffMs = Date.now() - lastActive.date.getTime()
            inactiveDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
        }
    }

    // Monthly aggregates
    const tripsByMonth: Record<number, number> = {}
    for (const s of longRangeSummaries) {
        const m = s.date.getMonth() + 1   // 1-12
        tripsByMonth[m] = (tripsByMonth[m] ?? 0) + s.tripCount
    }

    return { recentTripsCount, inactiveDays, completedOrders, yandexTripsCount, tripsByMonth }
}

function resolveFieldValue(
    field: ScenarioFieldDef,
    driver: DriverContext,
    daySummary: DaySummaryContext,
): unknown | undefined {
    switch (field.id) {
        // ── Driver identity ──
        case 'licenseNumber':
            return driver.licenseNumber ?? undefined

        // ── Driver segment ──
        case 'driverSegment':
            return driver.segment

        // ── Park info ──
        case 'externalParkName':
            return driver.lastExternalPark ?? undefined
        case 'isInOtherFleet':
            // 3-state enum: yes / no / unknown
            if (driver.lastExternalPark) return 'yes'
            // unknown if we have no recent data at all
            if (daySummary.completedOrders === 0 && !driver.lastOrderAt) return 'unknown'
            return 'no'

        // ── Yandex activity ──
        case 'yandexActive': {
            // 3-state: yes / no / unknown
            if (daySummary.recentTripsCount > 0) return 'yes'
            if (driver.lastOrderAt) {
                const diffDays = (Date.now() - driver.lastOrderAt.getTime()) / (1000 * 60 * 60 * 24)
                if (diffDays < 30) return 'yes'
                return 'no'
            }
            if (daySummary.completedOrders > 0) return 'no'
            return 'unknown'
        }
        case 'yandexTripsCount':
            return daySummary.yandexTripsCount
        case 'completedOrders':
            return daySummary.completedOrders

        // ── Activity metrics ──
        case 'inactiveDays':
            return daySummary.inactiveDays
        case 'recentTripsCount':
            return daySummary.recentTripsCount

        // ── Month of churn (derived from lastOrderAt) ──
        case 'monthOfChurn': {
            if (!driver.lastOrderAt) return undefined
            const m = driver.lastOrderAt.getMonth() + 1
            return String(m)
        }

        // ── Monthly aggregates ──
        case 'tripsDecember': return daySummary.tripsByMonth[12] ?? 0
        case 'tripsJanuary':  return daySummary.tripsByMonth[1] ?? 0
        case 'tripsFebruary': return daySummary.tripsByMonth[2] ?? 0
        case 'tripsMarch':    return daySummary.tripsByMonth[3] ?? 0

        // ── Self-employed (manual — fallback) ──
        case 'isSelfEmployed': {
            // Try to auto-detect from customFields if stored there
            const raw = (driver.customFields as any)?.isSelfEmployed
            if (raw === true) return 'yes'
            if (raw === false) return 'no'
            return undefined
        }

        default:
            return undefined
    }
}

function validateFieldValue(field: ScenarioFieldDef, value: unknown): void {
    if (value === null || value === undefined) return

    switch (field.type) {
        case 'boolean':
            if (typeof value !== 'boolean') throw new Error(`Field ${field.id}: expected boolean`)
            break
        case 'number':
            if (typeof value !== 'number') throw new Error(`Field ${field.id}: expected number`)
            break
        case 'string':
            if (typeof value !== 'string') throw new Error(`Field ${field.id}: expected string`)
            break
        case 'enum':
            if (typeof value !== 'string') throw new Error(`Field ${field.id}: expected string`)
            if (field.enumOptions && !field.enumOptions.some(o => o.value === value)) {
                throw new Error(`Field ${field.id}: invalid enum value: ${value}`)
            }
            break
        case 'date':
            if (typeof value !== 'string') throw new Error(`Field ${field.id}: expected date string`)
            break
    }
}
