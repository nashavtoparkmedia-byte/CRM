import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getUsers } from '@/lib/users/user-service'

/**
 * GET /api/calls/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&managerId=u1
 *
 * Aggregates call metrics for the analytics dashboard at /calls/stats.
 * All numbers are computed in Postgres via $queryRaw — much faster than
 * pulling every Call row and reducing in JS, especially once the table grows.
 *
 * Date range: defaults to the last 30 days (inclusive of today). If `to` is
 * omitted we use NOW(); if `from` is omitted we use NOW() - 30 days. Both can
 * be overridden via query string.
 *
 * Returned shape (stable contract — UI relies on it):
 *   {
 *     range: { from, to },
 *     totals: { inbound, outbound, answered, missed, total, avgDurationSec, avgAiScore },
 *     byManager: [{ managerId, name, count, answered, missedRate, avgDuration, avgAiScore }],
 *     byDay:    [{ date: 'YYYY-MM-DD', count, answered }],
 *     byHour:   [{ hour: 0-23, count, answered }],
 *     topRedFlags:  [{ flag, count }],   // top-10
 *     criterionAvg: { greeting, needs, presentation, objections, next_step },
 *     managers: [{ id, name }],          // for the filter dropdown
 *   }
 *
 * "answered" is defined as `answeredAt IS NOT NULL` — i.e. the call was
 * actually picked up by a manager. status='completed' is too strict (excludes
 * dropped calls) and status='active' is too loose (call still in progress).
 * TODO ASK USER: confirm this is the right definition; alternative would be
 * `status IN ('completed', 'active')`.
 *
 * "missedRate" in byManager is missed/total for that manager. For inbound
 * managers this is the most useful "team health" metric — for outbound
 * managers it's less meaningful since they initiate the calls.
 * TODO ASK USER: do you want separate inbound/outbound missedRate?
 */

interface TotalsRow {
    inbound: bigint
    outbound: bigint
    answered: bigint
    missed: bigint
    total: bigint
    avgDurationSec: number | null
    avgAiScore: number | null
}
interface ManagerRow {
    managerId: string
    count: bigint
    answered: bigint
    missed: bigint
    avgDuration: number | null
    avgAiScore: number | null
}
interface DayRow {
    date: Date
    count: bigint
    answered: bigint
}
interface HourRow {
    hour: number
    count: bigint
    answered: bigint
}
interface RedFlagRow {
    flag: string
    count: bigint
}
interface CriterionRow {
    greeting: number | null
    needs: number | null
    presentation: number | null
    objections: number | null
    next_step: number | null
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const fromParam = searchParams.get('from')
    const toParam = searchParams.get('to')
    const managerIdParam = searchParams.get('managerId')

    // Defaults: last 30 days. Days are aligned to midnight UTC — display
    // layer renders them in the user's TZ.
    const to = toParam ? endOfDay(new Date(toParam)) : new Date()
    const from = fromParam ? startOfDay(new Date(fromParam)) : startOfDay(addDays(to, -29))

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        return NextResponse.json({ error: 'invalid date range' }, { status: 400 })
    }

    // managerId can be: "all" / null / "" → no filter, or an actual user id (u1, u2, ...)
    const managerId = managerIdParam && managerIdParam !== 'all' ? managerIdParam : null

    try {
        // Reused filter snippet — Postgres parameters get unrolled by Prisma.sql.
        const filter = Prisma.sql`
            "startedAt" >= ${from}
            AND "startedAt" <= ${to}
            ${managerId ? Prisma.sql`AND "managerId" = ${managerId}` : Prisma.empty}
        `
        // Same filter but for inside a subquery that already joined "Call" alias 'c'
        const filterC = Prisma.sql`
            c."startedAt" >= ${from}
            AND c."startedAt" <= ${to}
            ${managerId ? Prisma.sql`AND c."managerId" = ${managerId}` : Prisma.empty}
        `

        const [totalsRows, managerRows, dayRows, hourRows, redFlagRows, criterionRows] = await Promise.all([
            prisma.$queryRaw<TotalsRow[]>`
                SELECT
                    COUNT(*) FILTER (WHERE "direction" = 'inbound')          AS inbound,
                    COUNT(*) FILTER (WHERE "direction" = 'outbound')         AS outbound,
                    COUNT(*) FILTER (WHERE "answeredAt" IS NOT NULL)         AS answered,
                    COUNT(*) FILTER (WHERE "status" = 'missed')              AS missed,
                    COUNT(*)                                                 AS total,
                    AVG("durationSec")::float FILTER (WHERE "answeredAt" IS NOT NULL) AS "avgDurationSec",
                    AVG("aiScore")::float FILTER (WHERE "aiScore" IS NOT NULL)        AS "avgAiScore"
                FROM "Call"
                WHERE ${filter}
            `,
            prisma.$queryRaw<ManagerRow[]>`
                SELECT
                    "managerId"                                              AS "managerId",
                    COUNT(*)                                                 AS count,
                    COUNT(*) FILTER (WHERE "answeredAt" IS NOT NULL)         AS answered,
                    COUNT(*) FILTER (WHERE "status" = 'missed')              AS missed,
                    AVG("durationSec")::float FILTER (WHERE "answeredAt" IS NOT NULL) AS "avgDuration",
                    AVG("aiScore")::float FILTER (WHERE "aiScore" IS NOT NULL)        AS "avgAiScore"
                FROM "Call"
                WHERE ${filter}
                  AND "managerId" IS NOT NULL
                GROUP BY "managerId"
                ORDER BY count DESC
            `,
            prisma.$queryRaw<DayRow[]>`
                SELECT
                    DATE_TRUNC('day', "startedAt")::date                     AS date,
                    COUNT(*)                                                 AS count,
                    COUNT(*) FILTER (WHERE "answeredAt" IS NOT NULL)         AS answered
                FROM "Call"
                WHERE ${filter}
                GROUP BY 1
                ORDER BY 1 ASC
            `,
            prisma.$queryRaw<HourRow[]>`
                SELECT
                    EXTRACT(HOUR FROM "startedAt")::int                      AS hour,
                    COUNT(*)                                                 AS count,
                    COUNT(*) FILTER (WHERE "answeredAt" IS NOT NULL)         AS answered
                FROM "Call"
                WHERE ${filter}
                GROUP BY 1
                ORDER BY 1 ASC
            `,
            // jsonb_array_elements_text needs a lateral join — we alias the
            // table as 'c' so we can refer to it in the unnest.
            prisma.$queryRaw<RedFlagRow[]>`
                SELECT flag, COUNT(*)::int AS count
                FROM "Call" c,
                     jsonb_array_elements_text(c."aiAnalysis"->'red_flags') AS flag
                WHERE ${filterC}
                  AND c."aiAnalysis" IS NOT NULL
                GROUP BY flag
                ORDER BY count DESC
                LIMIT 10
            `,
            prisma.$queryRaw<CriterionRow[]>`
                SELECT
                    AVG(("aiAnalysis"->'scores'->>'greeting')::int)::float     AS greeting,
                    AVG(("aiAnalysis"->'scores'->>'needs')::int)::float        AS needs,
                    AVG(("aiAnalysis"->'scores'->>'presentation')::int)::float AS presentation,
                    AVG(("aiAnalysis"->'scores'->>'objections')::int)::float   AS objections,
                    AVG(("aiAnalysis"->'scores'->>'next_step')::int)::float    AS next_step
                FROM "Call"
                WHERE ${filter}
                  AND "aiAnalysis" IS NOT NULL
            `,
        ])

        const totalsRaw = totalsRows[0] ?? emptyTotals()
        const criterionRaw = criterionRows[0] ?? emptyCriteria()

        // Resolve manager names from src/data/users.json (CRM users don't live in DB)
        const users = await getUsers()
        const userIndex = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]))

        const byManager = managerRows.map((r) => {
            const count = Number(r.count)
            const missed = Number(r.missed)
            return {
                managerId: r.managerId,
                name: userIndex.get(r.managerId) ?? r.managerId,
                count,
                answered: Number(r.answered),
                missed,
                missedRate: count > 0 ? missed / count : 0,
                avgDuration: r.avgDuration !== null ? Number(r.avgDuration) : null,
                avgAiScore: r.avgAiScore !== null ? Number(r.avgAiScore) : null,
            }
        })

        // byDay: fill gaps so the chart has a smooth 30-day axis even on slow days.
        const byDay = fillDailyGaps(dayRows, from, to)

        // byHour: ensure all 24 buckets exist (some hours may be empty).
        const byHour = fillHourly(hourRows)

        // Manager dropdown options — every CRM user is a candidate, not only
        // ones that already appear in byManager.
        const managers = users
            .filter(u => u.status === 'Активен')
            .map(u => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role }))

        return NextResponse.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            totals: {
                inbound: Number(totalsRaw.inbound),
                outbound: Number(totalsRaw.outbound),
                answered: Number(totalsRaw.answered),
                missed: Number(totalsRaw.missed),
                total: Number(totalsRaw.total),
                avgDurationSec: totalsRaw.avgDurationSec !== null ? Number(totalsRaw.avgDurationSec) : null,
                avgAiScore: totalsRaw.avgAiScore !== null ? Number(totalsRaw.avgAiScore) : null,
            },
            byManager,
            byDay,
            byHour,
            topRedFlags: redFlagRows.map(r => ({ flag: r.flag, count: Number(r.count) })),
            criterionAvg: {
                greeting: criterionRaw.greeting,
                needs: criterionRaw.needs,
                presentation: criterionRaw.presentation,
                objections: criterionRaw.objections,
                next_step: criterionRaw.next_step,
            },
            managers,
        })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

function emptyTotals(): TotalsRow {
    return { inbound: 0n, outbound: 0n, answered: 0n, missed: 0n, total: 0n, avgDurationSec: null, avgAiScore: null }
}
function emptyCriteria(): CriterionRow {
    return { greeting: null, needs: null, presentation: null, objections: null, next_step: null }
}

function startOfDay(d: Date): Date {
    const x = new Date(d)
    x.setUTCHours(0, 0, 0, 0)
    return x
}
function endOfDay(d: Date): Date {
    const x = new Date(d)
    x.setUTCHours(23, 59, 59, 999)
    return x
}
function addDays(d: Date, n: number): Date {
    const x = new Date(d)
    x.setUTCDate(x.getUTCDate() + n)
    return x
}

function fillDailyGaps(rows: DayRow[], from: Date, to: Date): Array<{ date: string; count: number; answered: number }> {
    const byDate = new Map<string, { count: number; answered: number }>()
    for (const r of rows) {
        const iso = r.date.toISOString().slice(0, 10)
        byDate.set(iso, { count: Number(r.count), answered: Number(r.answered) })
    }
    const out: Array<{ date: string; count: number; answered: number }> = []
    const cursor = startOfDay(from)
    const end = startOfDay(to)
    while (cursor <= end) {
        const iso = cursor.toISOString().slice(0, 10)
        const v = byDate.get(iso) ?? { count: 0, answered: 0 }
        out.push({ date: iso, ...v })
        cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return out
}

function fillHourly(rows: HourRow[]): Array<{ hour: number; count: number; answered: number }> {
    const byHour = new Map<number, { count: number; answered: number }>()
    for (const r of rows) byHour.set(r.hour, { count: Number(r.count), answered: Number(r.answered) })
    return Array.from({ length: 24 }, (_, h) => ({ hour: h, ...(byHour.get(h) ?? { count: 0, answered: 0 }) }))
}
