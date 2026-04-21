// Backfill scenarioData for existing active tasks with scenario.
// Re-runs on each invocation: merges auto/derived values (doesn't overwrite manual).
// Run: node scripts/backfill-scenario-data.js

const { PrismaClient } = require('@prisma/client')

// All auto/derived fields per scenario (what we can backfill)
const AUTO_DERIVED_FIELDS = {
    churn: [
        'licenseNumber',         // auto from Driver.licenseNumber
        'isInOtherFleet',        // derived enum yes/no/unknown
        'yandexActive',          // derived enum yes/no/unknown
        'yandexTripsCount',      // derived
        'completedOrders',       // derived
        'inactiveDays',          // derived
        'recentTripsCount',      // derived
        'monthOfChurn',          // derived from lastOrderAt
        'tripsDecember', 'tripsJanuary', 'tripsFebruary', 'tripsMarch',
        'driverSegment',         // auto
        'externalParkName',      // auto from lastExternalPark
        'isSelfEmployed',        // try from customFields
    ],
    onboarding: ['docsReady', 'carAssigned', 'daysSinceRegister', 'driverSegment'],
    care: ['careType', 'driverSegment', 'recentTripsCount'],
    promo_control: ['tripsDuringPromo'],
}

const SOURCE_MAP = {
    licenseNumber: 'auto',
    driverSegment: 'auto',
    externalParkName: 'auto',
    isSelfEmployed: 'auto',
    // derived
    isInOtherFleet: 'derived',
    yandexActive: 'derived',
    yandexTripsCount: 'derived',
    completedOrders: 'derived',
    inactiveDays: 'derived',
    recentTripsCount: 'derived',
    monthOfChurn: 'derived',
    tripsDecember: 'derived',
    tripsJanuary: 'derived',
    tripsFebruary: 'derived',
    tripsMarch: 'derived',
    daysSinceRegister: 'derived',
    tripsDuringPromo: 'derived',
}

async function computeCtx(prisma, driverId) {
    const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: {
            fullName: true, licenseNumber: true, segment: true,
            lastOrderAt: true, lastExternalPark: true, customFields: true,
        },
    })
    if (!driver) return null

    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const longRange = await prisma.driverDaySummary.findMany({
        where: { driverId, date: { gte: sixMonthsAgo } },
        select: { date: true, tripCount: true },
        orderBy: { date: 'desc' },
    })
    const recent = longRange.filter(s => s.date >= sevenDaysAgo)

    const recentTripsCount = recent.reduce((s, r) => s + r.tripCount, 0)
    const completedOrders = longRange.reduce((s, r) => s + r.tripCount, 0)

    let inactiveDays = 180
    if (longRange.length > 0) {
        const lastActive = longRange.find(s => s.tripCount > 0)
        if (lastActive) {
            inactiveDays = Math.floor((Date.now() - lastActive.date.getTime()) / (1000 * 60 * 60 * 24))
        }
    }

    const tripsByMonth = {}
    for (const s of longRange) {
        const m = s.date.getMonth() + 1
        tripsByMonth[m] = (tripsByMonth[m] ?? 0) + s.tripCount
    }

    return {
        driver,
        daySummary: { recentTripsCount, completedOrders, inactiveDays, tripsByMonth, yandexTripsCount: completedOrders },
    }
}

function resolve(fieldId, ctx) {
    const { driver, daySummary } = ctx
    switch (fieldId) {
        case 'licenseNumber': return driver.licenseNumber ?? undefined
        case 'driverSegment': return driver.segment
        case 'externalParkName': return driver.lastExternalPark ?? undefined
        case 'isInOtherFleet':
            if (driver.lastExternalPark) return 'yes'
            if (daySummary.completedOrders === 0 && !driver.lastOrderAt) return 'unknown'
            return 'no'
        case 'yandexActive':
            if (daySummary.recentTripsCount > 0) return 'yes'
            if (driver.lastOrderAt) {
                const d = (Date.now() - driver.lastOrderAt.getTime()) / (1000 * 60 * 60 * 24)
                return d < 30 ? 'yes' : 'no'
            }
            if (daySummary.completedOrders > 0) return 'no'
            return 'unknown'
        case 'yandexTripsCount': return daySummary.yandexTripsCount
        case 'completedOrders': return daySummary.completedOrders
        case 'inactiveDays': return daySummary.inactiveDays
        case 'recentTripsCount': return daySummary.recentTripsCount
        case 'monthOfChurn':
            if (!driver.lastOrderAt) return undefined
            return String(driver.lastOrderAt.getMonth() + 1)
        case 'tripsDecember': return daySummary.tripsByMonth[12] ?? 0
        case 'tripsJanuary':  return daySummary.tripsByMonth[1] ?? 0
        case 'tripsFebruary': return daySummary.tripsByMonth[2] ?? 0
        case 'tripsMarch':    return daySummary.tripsByMonth[3] ?? 0
        case 'isSelfEmployed':
            const raw = driver.customFields?.isSelfEmployed
            if (raw === true) return 'yes'
            if (raw === false) return 'no'
            return undefined
        default: return undefined
    }
}

async function main() {
    const prisma = new PrismaClient()
    try {
        const tasks = await prisma.$queryRaw`
            SELECT id, "driverId", scenario, "scenarioData"::jsonb as "scenarioData"
            FROM tasks
            WHERE scenario IS NOT NULL AND "isActive" = true
        `
        console.log(`Found ${tasks.length} active scenario tasks`)

        let updated = 0, skipped = 0
        const now = new Date().toISOString()

        for (const task of tasks) {
            const fieldIds = AUTO_DERIVED_FIELDS[task.scenario] || []
            if (fieldIds.length === 0) { skipped++; continue }

            const ctx = await computeCtx(prisma, task.driverId)
            if (!ctx) { skipped++; continue }

            const existing = task.scenarioData || {}
            const merged = { ...existing }

            for (const fieldId of fieldIds) {
                const source = SOURCE_MAP[fieldId] || 'derived'
                // Do not overwrite manual values
                if (existing[fieldId]?.source === 'manual') continue

                const value = resolve(fieldId, ctx)
                if (value !== undefined) {
                    merged[fieldId] = { value, source, updatedAt: now }
                }
            }

            await prisma.$executeRaw`
                UPDATE tasks SET "scenarioData" = ${JSON.stringify(merged)}::jsonb WHERE id = ${task.id}
            `
            updated++
        }

        console.log(`Updated: ${updated}, Skipped: ${skipped}`)
    } catch (err) {
        console.error('Error:', err)
    } finally {
        await prisma.$disconnect()
    }
}

main()
