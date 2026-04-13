/**
 * Seed script: populate team-overview dashboard with realistic demo data.
 * Creates drivers, tasks, task events, health history, and intervention records.
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function daysAgo(d) { return new Date(Date.now() - d * 24 * 60 * 60 * 1000) }
function hoursAgo(h) { return new Date(Date.now() - h * 60 * 60 * 1000) }
function cuid() { return 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-5) }

const SCENARIOS = ['churn', 'onboarding', 'quality', 'activation']
const STAGES = ['initial', 'followup', 'escalated', 'final']
const PRIORITIES = ['critical', 'high', 'medium', 'low']
const ROOT_CAUSES = ['no_trips', 'low_rating', 'high_cancellation', 'park_switch', 'inactive', 'penalty']
const EVENT_TYPES = ['created', 'status_changed', 'priority_changed', 'comment', 'escalated', 'sla_escalated', 'reopened', 'auto_closed', 'intervention_action', 'intervention_outcome']
const INTERVENTION_ACTIONS = ['call', 'message', 'reassign', 'escalate', 'schedule_followup']
const INTERVENTION_OUTCOMES = ['improved', 'unchanged', 'worsened']

async function main() {
    console.log('🌱 Seeding team-overview demo data...\n')

    // ── 1. Ensure CRM Users exist ───────────────────────────────
    const users = [
        { id: 'mgr-anna',   name: 'Анна Петрова',    role: 'manager' },
        { id: 'mgr-ivan',   name: 'Иван Сидоров',    role: 'manager' },
        { id: 'mgr-elena',  name: 'Елена Козлова',    role: 'manager' },
        { id: 'mgr-dmitry', name: 'Дмитрий Волков',   role: 'manager' },
        { id: 'lead-alex',  name: 'Александр Ремезов', role: 'lead' },
    ]

    for (const u of users) {
        await prisma.crmUser.upsert({
            where: { id: u.id },
            update: { name: u.name, role: u.role, isActive: true },
            create: { id: u.id, name: u.name, role: u.role, isActive: true },
        })
    }
    console.log(`  ✓ ${users.length} CRM users`)

    // ── 2. Create demo drivers ──────────────────────────────────
    const driverNames = [
        'Алексей Смирнов', 'Борис Кузнецов', 'Виктор Лебедев', 'Григорий Новиков',
        'Дмитрий Морозов', 'Евгений Попов', 'Захар Соколов', 'Игорь Козлов',
        'Кирилл Васильев', 'Леонид Павлов', 'Максим Семёнов', 'Николай Голубев',
        'Олег Виноградов', 'Пётр Богданов', 'Роман Воронов', 'Сергей Михайлов',
        'Тимур Фёдоров', 'Ульян Жуков', 'Филипп Белов', 'Хасан Медведев',
        'Юрий Тарасов', 'Андрей Беляев', 'Василий Комаров', 'Геннадий Орлов',
    ]

    const driverIds = []
    for (let i = 0; i < driverNames.length; i++) {
        const id = `drv-demo-${i}`
        const yandexId = `ydemo${String(i).padStart(4, '0')}`
        try {
            await prisma.driver.upsert({
                where: { yandexDriverId: yandexId },
                update: { fullName: driverNames[i] },
                create: {
                    id,
                    yandexDriverId: yandexId,
                    fullName: driverNames[i],
                    phone: `+7900${String(1000000 + i).slice(1)}`,
                    segment: randomPick(['profitable', 'medium', 'small', 'sleeping']),
                    lastOrderAt: Math.random() > 0.3 ? daysAgo(randomInt(0, 14)) : null,
                },
            })
            driverIds.push(id)
        } catch { driverIds.push(id) }
    }
    console.log(`  ✓ ${driverIds.length} drivers`)

    // ── 3. Create tasks distributed across managers ─────────────
    const managers = users.filter(u => u.role === 'manager')
    const taskIds = []
    let taskCount = 0

    for (const mgr of managers) {
        const numTasks = randomInt(5, 12)
        for (let t = 0; t < numTasks; t++) {
            const id = cuid()
            const driverId = randomPick(driverIds)
            const scenario = randomPick(SCENARIOS)
            const isOverdue = Math.random() < 0.2
            const isDone = Math.random() < 0.3
            const isEscalated = Math.random() < 0.15
            const priority = isOverdue || isEscalated ? randomPick(['critical', 'high']) : randomPick(PRIORITIES)
            const createdAt = daysAgo(randomInt(1, 14))
            const dueAt = isOverdue ? daysAgo(randomInt(0, 2)) : new Date(Date.now() + randomInt(1, 5) * 24 * 60 * 60 * 1000)

            let status = 'in_progress'
            let resolvedAt = null
            let closedReason = null
            if (isDone) {
                status = 'done'
                resolvedAt = new Date(createdAt.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000)
                closedReason = randomPick(['resolved', 'returned', 'launched', 'no_action_needed'])
            } else if (isOverdue) {
                status = 'overdue'
            } else {
                status = randomPick(['todo', 'in_progress', 'waiting_reply'])
            }

            const rootCause = randomPick(ROOT_CAUSES)

            try {
                await prisma.task.create({
                    data: {
                        id,
                        driverId,
                        source: 'auto',
                        type: scenario,
                        title: `${scenario} — ${driverNames[driverIds.indexOf(driverId)] || 'Водитель'}`,
                        status,
                        priority,
                        isActive: !isDone,
                        assigneeId: mgr.id,
                        dueAt,
                        scenario,
                        stage: randomPick(STAGES),
                        stageEnteredAt: createdAt,
                        slaDeadline: dueAt,
                        closedReason,
                        createdAt,
                        resolvedAt,
                        lastInboundMessageAt: Math.random() > 0.5 ? hoursAgo(randomInt(1, 72)) : null,
                        lastOutboundMessageAt: Math.random() > 0.4 ? hoursAgo(randomInt(1, 48)) : null,
                        metadata: { rootCause, attempts: randomInt(0, 5) },
                    }
                })
                taskIds.push(id)
                taskCount++
            } catch (e) { /* skip duplicates */ }
        }
    }
    console.log(`  ✓ ${taskCount} tasks`)

    // ── 4. Create task events ───────────────────────────────────
    let eventCount = 0
    for (const taskId of taskIds) {
        const numEvents = randomInt(2, 6)
        for (let e = 0; e < numEvents; e++) {
            const eventType = randomPick(EVENT_TYPES)
            let payload = {}

            if (eventType === 'intervention_action') {
                payload = {
                    action: randomPick(INTERVENTION_ACTIONS),
                    comment: 'Демо-действие',
                    scoreAtAction: randomInt(30, 90),
                }
            } else if (eventType === 'intervention_outcome') {
                payload = {
                    outcome: randomPick(INTERVENTION_OUTCOMES),
                    scoreBefore: randomInt(30, 70),
                    scoreAfter: randomInt(40, 100),
                }
            } else if (eventType === 'reopened') {
                payload = { reason: 'driver_inactive' }
            }

            try {
                await prisma.taskEvent.create({
                    data: {
                        id: cuid(),
                        taskId,
                        eventType,
                        payload: JSON.stringify(payload),
                        actorType: eventType.startsWith('intervention') ? 'user' : 'system',
                        actorId: eventType.startsWith('intervention') ? randomPick(managers).id : null,
                        createdAt: hoursAgo(randomInt(1, 168)),
                    }
                })
                eventCount++
            } catch { /* skip */ }
        }
    }
    console.log(`  ✓ ${eventCount} task events`)

    // ── 5. Seed health score history ────────────────────────────
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS health_score_history (
                id SERIAL PRIMARY KEY,
                manager_id TEXT NOT NULL,
                score INT NOT NULL,
                health_level TEXT NOT NULL,
                recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS idx_hsh_manager_time
            ON health_score_history (manager_id, recorded_at DESC)
        `)
    } catch { /* exists */ }

    let historyCount = 0
    for (const mgr of managers) {
        // Generate 7 days of hourly-ish data with realistic trends
        let score = randomInt(50, 90)
        const trend = randomPick([-1, 0, 0, 1]) // slight bias towards stable

        for (let h = 168; h >= 0; h -= randomInt(2, 4)) {
            // Random walk with trend
            score += trend * randomInt(0, 3) + randomInt(-5, 5)
            score = Math.max(15, Math.min(100, score))

            const level = score >= 70 ? 'healthy' : score >= 45 ? 'warning' : 'critical'
            const recordedAt = hoursAgo(h)

            try {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO health_score_history (manager_id, score, health_level, recorded_at)
                     VALUES ($1, $2, $3, $4)`,
                    mgr.id, Math.round(score), level, recordedAt
                )
                historyCount++
            } catch { /* skip */ }
        }
    }
    console.log(`  ✓ ${historyCount} health history points`)

    // ── 6. Seed some cron health data ───────────────────────────
    try {
        const cronNames = ['auto-close-tasks', 'enforce-followup', 'escalations', 'pattern-alerts', 'sla-escalation']
        let cronCount = 0
        for (const name of cronNames) {
            for (let h = 24; h >= 0; h -= randomInt(1, 3)) {
                const status = Math.random() < 0.05 ? 'error' : 'ok'
                const durationMs = randomInt(50, 2000)
                await prisma.$executeRawUnsafe(
                    `INSERT INTO cron_health_log (cron_name, status, executed_at, duration_ms, error_message)
                     VALUES ($1, $2, $3, $4, $5)`,
                    name, status, hoursAgo(h), durationMs,
                    status === 'error' ? 'Simulated demo error' : null
                )
                cronCount++
            }
        }
        console.log(`  ✓ ${cronCount} cron health records`)
    } catch (e) { console.log(`  ⚠ Cron health: ${e.message}`) }

    // ── Done ────────────────────────────────────────────────────
    console.log('\n✅ Demo data seeded successfully!')
    console.log('   Reload http://localhost:3002/team-overview to see the data.\n')

    await prisma.$disconnect()
}

main().catch(async e => {
    console.error('Seed error:', e.message)
    await prisma.$disconnect()
    process.exit(1)
})
