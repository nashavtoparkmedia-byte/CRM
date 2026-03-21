/**
 * Seed script: generates demo DriverDaySummary data for testing cell visualization.
 * Run: npx tsx scripts/seed-cells.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const DEFAULT_THRESHOLDS = [
    { key: 'profitable_min', value: 20 },
    { key: 'medium_min', value: 10 },
    { key: 'small_min', value: 1 },
    { key: 'sleeping_days', value: 3 },
    { key: 'risk_days', value: 3 },
    { key: 'gone_days', value: 30 },
]

function randomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomBool(probability: number = 0.15) {
    return Math.random() < probability
}

async function main() {
    console.log('🌱 Seeding DriverDaySummary data...')

    // Seed default scoring thresholds
    for (const t of DEFAULT_THRESHOLDS) {
        await prisma.scoringThreshold.upsert({
            where: { key: t.key },
            update: {},
            create: t,
        })
    }
    console.log('✅ Scoring thresholds seeded')

    // Get all existing drivers
    const drivers = await prisma.driver.findMany({ select: { id: true, fullName: true } })

    if (drivers.length === 0) {
        console.log('⚠️  No drivers found. Creating demo drivers...')

        const demoNames = [
            'Иван Петров', 'Пётр Иванов', 'Алексей Смирнов',
            'Мария Козлова', 'Дмитрий Сидоров', 'Анна Волкова',
            'Сергей Николаев', 'Елена Фёдорова', 'Андрей Морозов',
            'Ольга Павлова', 'Михаил Лебедев', 'Наталья Егорова',
        ]

        for (const name of demoNames) {
            const created = await prisma.driver.create({
                data: {
                    yandexDriverId: `demo_${name.replace(/\s/g, '_').toLowerCase()}_${Date.now()}`,
                    fullName: name,
                    phone: `+7999${randomInt(1000000, 9999999)}`,
                    segment: 'unknown',
                },
            })
            drivers.push({ id: created.id, fullName: created.fullName })
        }
        console.log(`✅ Created ${demoNames.length} demo drivers`)
    }

    console.log(`📊 Seeding cells for ${drivers.length} drivers...`)

    // Generate 30 days of data for each driver
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    for (const driver of drivers) {
        // Determine driver "personality" for realistic data
        const personality = Math.random()
        let tripProbability: number
        let maxTrips: number

        if (personality < 0.3) {
            // Active driver
            tripProbability = 0.85
            maxTrips = 15
        } else if (personality < 0.6) {
            // Medium driver
            tripProbability = 0.6
            maxTrips = 8
        } else if (personality < 0.85) {
            // Low activity driver
            tripProbability = 0.3
            maxTrips = 4
        } else {
            // Sleeping / risk driver
            tripProbability = 0.1
            maxTrips = 2
        }

        for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
            const date = new Date(today)
            date.setDate(date.getDate() - dayOffset)

            const hasTrips = Math.random() < tripProbability
            const tripCount = hasTrips ? randomInt(1, maxTrips) : 0

            await prisma.driverDaySummary.upsert({
                where: {
                    driverId_date: { driverId: driver.id, date },
                },
                update: {
                    tripCount,
                    hadManagerMessage: randomBool(0.1),
                    hadManagerCall: randomBool(0.05),
                    hadAutoMessage: randomBool(0.08),
                    hadPromotion: randomBool(0.06),
                    hadAiAction: false,
                    hadGoalAchieved: randomBool(0.04),
                },
                create: {
                    driverId: driver.id,
                    date,
                    tripCount,
                    hadManagerMessage: randomBool(0.1),
                    hadManagerCall: randomBool(0.05),
                    hadAutoMessage: randomBool(0.08),
                    hadPromotion: randomBool(0.06),
                    hadAiAction: false,
                    hadGoalAchieved: randomBool(0.04),
                },
            })
        }

        // Recalculate segment + score
        const last7Days: Date[] = []
        for (let i = 0; i < 7; i++) {
            const d = new Date(today)
            d.setDate(d.getDate() - i)
            last7Days.push(d)
        }

        const weekData = await prisma.driverDaySummary.aggregate({
            where: {
                driverId: driver.id,
                date: { gte: last7Days[6], lte: last7Days[0] },
            },
            _sum: { tripCount: true },
        })
        const weeklyTrips = weekData._sum.tripCount ?? 0

        let segment = 'unknown'
        if (weeklyTrips >= 20) segment = 'profitable'
        else if (weeklyTrips >= 10) segment = 'medium'
        else if (weeklyTrips >= 1) segment = 'small'
        else segment = 'sleeping'

        // Calculate score (same formula as scoring.ts)
        const fourteenDaysAgo = new Date(today)
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

        const last14 = await prisma.driverDaySummary.findMany({
            where: {
                driverId: driver.id,
                date: { gte: fourteenDaysAgo },
            },
            select: { tripCount: true, hadPromotion: true, hadGoalAchieved: true },
        })

        const totalTrips14 = last14.reduce((sum: number, s: any) => sum + s.tripCount, 0)
        const maxTrips14 = 20 * 2 // profitable_min * 2 = 40
        const activityRatio = Math.min(totalTrips14 / maxTrips14, 1)

        const segmentWeights: Record<string, number> = { profitable: 100, medium: 70, small: 40, sleeping: 0, unknown: 20 }
        const segWeight = (segmentWeights[segment] ?? 20) / 100

        const promoDays = last14.filter((s: any) => s.hadPromotion).length
        const goalDays = last14.filter((s: any) => s.hadGoalAchieved).length
        const engagementRatio = Math.min((promoDays + goalDays) / 14, 1)

        const score = Math.round(activityRatio * 50 + segWeight * 30 + engagementRatio * 20)
        const finalScore = Math.max(0, Math.min(100, score))

        await prisma.driver.update({
            where: { id: driver.id },
            data: { segment, score: finalScore },
        })

        console.log(`  ✓ ${driver.fullName}: ${segment} (${weeklyTrips} trips/wk, score: ${finalScore})`)
    }

    console.log('\n🎉 Driver data seeded!')

    // ─── Seed default triggers ─────────────────────────────────────
    console.log('\n⚡ Seeding communication triggers...')

    const defaultTriggers = [
        {
            name: 'Не катал 3 дня',
            condition: 'days_without_trips',
            threshold: 3,
            action: 'auto_message',
            messageTemplate: 'Привет, {name}! Заметили, что вы не катаете уже {days} дней. Всё в порядке? Мы готовы помочь!',
            channel: 'telegram',
        },
        {
            name: 'Не катал 7 дней — задача менеджеру',
            condition: 'days_without_trips',
            threshold: 7,
            action: 'manager_task',
            channel: 'telegram',
        },
        {
            name: 'Спящий водитель',
            condition: 'segment_sleeping',
            threshold: 1,
            action: 'manager_task',
            channel: 'telegram',
        },
        {
            name: 'После акции не катает',
            condition: 'after_promotion',
            threshold: 3,
            action: 'auto_message',
            messageTemplate: '{name}, вы получили акцию, но пока не воспользовались! Не упустите выгоду — начните катать сегодня.',
            channel: 'telegram',
        },
    ]

    for (const t of defaultTriggers) {
        // Check if a trigger with this name already exists
        const existing = await prisma.communicationTrigger.findFirst({ where: { name: t.name } })
        if (!existing) {
            await prisma.communicationTrigger.create({ data: t })
        }
    }
    console.log(`✅ ${defaultTriggers.length} triggers seeded`)

    // ─── Seed demo communication events ────────────────────────────
    console.log('\n📩 Seeding demo communication events...')
    const allDrivers = await prisma.driver.findMany({ select: { id: true, fullName: true } })

    const eventTemplates = [
        { channel: 'telegram', direction: 'outbound', eventType: 'message', content: 'Привет! Как дела с поездками?' },
        { channel: 'phone', direction: 'outbound', eventType: 'call', content: 'Звонок менеджера' },
        { channel: 'auto', direction: 'outbound', eventType: 'auto_message', content: 'Заметили, что вы не катаете уже 3 дня. Всё в порядке?' },
        { channel: 'system', direction: 'system', eventType: 'trigger_fired', content: 'Триггер: Не катал 3 дня' },
        { channel: 'telegram', direction: 'outbound', eventType: 'message', content: 'Есть новая акция для вас! Подробности в приложении.' },
        { channel: 'phone', direction: 'outbound', eventType: 'call', content: 'Обсудили план реактивации' },
    ]

    let eventsCreated = 0
    for (const driver of allDrivers) {
        // Create 3-6 random events per driver
        const numEvents = randomInt(3, 6)
        for (let i = 0; i < numEvents; i++) {
            const template = eventTemplates[randomInt(0, eventTemplates.length - 1)]
            const daysAgo = randomInt(0, 14)
            const date = new Date()
            date.setDate(date.getDate() - daysAgo)
            date.setHours(randomInt(8, 20), randomInt(0, 59), 0, 0)

            await prisma.communicationEvent.create({
                data: {
                    driverId: driver.id,
                    ...template,
                    createdBy: template.direction === 'system' ? 'system' : 'manager',
                    createdAt: date,
                },
            })
            eventsCreated++
        }
    }
    console.log(`✅ ${eventsCreated} communication events seeded`)

    // ─── Seed demo manager tasks ───────────────────────────────────
    console.log('\n📋 Seeding demo manager tasks...')

    const taskTypes = [
        { type: 'contact_risk', titlePrefix: 'Риск ухода', priority: 'high' },
        { type: 'contact_after_promo', titlePrefix: 'После акции', priority: 'medium' },
        { type: 'contact_risk', titlePrefix: 'Нет поездок', priority: 'medium' },
    ]

    let tasksCreated = 0
    for (const driver of allDrivers) {
        if (Math.random() < 0.4) { // ~40% of drivers get tasks
            const taskTemplate = taskTypes[randomInt(0, taskTypes.length - 1)]
            const daysAgo = randomInt(0, 5)
            const date = new Date()
            date.setDate(date.getDate() - daysAgo)

            await prisma.managerTask.create({
                data: {
                    driverId: driver.id,
                    type: taskTemplate.type,
                    title: `${taskTemplate.titlePrefix} — ${driver.fullName}`,
                    priority: taskTemplate.priority,
                    status: 'open',
                    createdBy: 'system',
                    createdAt: date,
                },
            })
            tasksCreated++
        }
    }
    console.log(`✅ ${tasksCreated} manager tasks seeded`)

    // ─── Seed DailyParkStats for dashboard ─────────────────────────
    console.log('\n📊 Seeding DailyParkStats...')

    const totalDriverCount = allDrivers.length
    for (let i = 30; i >= 0; i--) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        date.setHours(0, 0, 0, 0)

        // Simulate realistic fleet activity with some variation
        const dayOfWeek = date.getDay()
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
        const baseFactor = isWeekend ? 0.6 : 0.85
        const noise = 0.9 + Math.random() * 0.2 // ±10% random noise

        const activeDrivers = Math.round(totalDriverCount * baseFactor * noise)
        const totalTrips = Math.round(activeDrivers * (randomInt(5, 12)))
        const driversAtRisk = randomInt(Math.max(1, Math.round(totalDriverCount * 0.05)), Math.round(totalDriverCount * 0.15))
        const sleepingDrivers = randomInt(Math.max(1, Math.round(totalDriverCount * 0.08)), Math.round(totalDriverCount * 0.2))
        const promotionsActive = randomInt(3, 15)
        const profitableCount = Math.round(totalDriverCount * (0.15 + Math.random() * 0.1))
        const mediumCount = Math.round(totalDriverCount * (0.35 + Math.random() * 0.1))
        const smallCount = Math.round(totalDriverCount * (0.25 + Math.random() * 0.1))
        const reactivatedDrivers = randomInt(0, 4)

        await prisma.dailyParkStats.upsert({
            where: { date },
            update: {
                activeDrivers,
                totalTrips,
                driversAtRisk,
                sleepingDrivers,
                promotionsActive,
                profitableCount,
                mediumCount,
                smallCount,
                reactivatedDrivers,
            },
            create: {
                date,
                activeDrivers,
                totalTrips,
                driversAtRisk,
                sleepingDrivers,
                promotionsActive,
                profitableCount,
                mediumCount,
                smallCount,
                reactivatedDrivers,
            },
        })
    }
    console.log('✅ 30 days of DailyParkStats seeded')

    console.log('\n🎉 Full seed complete!')
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
