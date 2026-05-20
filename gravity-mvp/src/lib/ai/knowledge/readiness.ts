/* eslint-disable @typescript-eslint/no-explicit-any -- $queryRaw returns any[]. */
/**
 * AI Knowledge Core — runtime readiness aggregator (PR5).
 *
 * Pure read-only. Возвращает operational state для UI-readiness row,
 * checklist'а перед runtime enable и smoke-проверки. НИКАКОЙ новой
 * AI-логики и НИКАКИХ retrieval мутаций — только SELECT counts +
 * derived checklist.
 *
 * Этот модуль НЕ дублирует knowledgeQueries.getKnowledgeStats — тот
 * остаётся базовым счётчиком для KnowledgeTab. Здесь — operational
 * readiness слой: с lastExtraction, activity-window и computed
 * checklist'ом.
 */

import { prisma } from '@/lib/prisma'

// ─── Типы ─────────────────────────────────────────────────────────

export interface KnowledgeReadinessCounts {
    activeItems:      number  // status='active' AND isActive=true
    verifiedItems:    number  // active AND isVerified=true
    draftItems:       number  // status='draft'
    archivedItems:    number  // status IN ('archived','superseded')
    conflictGroups:   number  // distinct conflictGroupId among active
    activeSections:   number  // sections.isActive=true
}

export interface KnowledgeLastExtraction {
    id:           string
    status:       string
    startedAt:    string | null
    finishedAt:   string | null
    /** progress JSON блоб — UI решает что вытащить (itemsCreated,
     *  itemsUpdated, durationMs и т.д.). Здесь без типизации, чтобы
     *  не зависеть от внутренней структуры Extractor.progress. */
    progress:     Record<string, unknown> | null
    errorMessage: string | null
    createdAt:    string
}

export interface KnowledgeActivity7d {
    /** Decisions с retrievalMode IS NOT NULL за последние 7 дней. */
    decisionsTotal:    number
    /** Из них shadow (mode='shadow'). */
    shadowDecisions:   number
    /** Из них runtime (mode='runtime'). */
    runtimeDecisions:  number
    /** Decisions где AI escalated (escalated=true). */
    escalated:         number
    /** Decisions с retrievalDecision='no_match'. */
    noMatch:           number
    /** Когда зарегистрирован первый/последний trace (для UX "давно не было traces" warning). */
    firstAt:           string | null
    lastAt:            string | null
}

export type ReadinessCheckStatus = 'ok' | 'warn' | 'fail'

export interface ReadinessCheck {
    id:     'conflicts' | 'verified_coverage' | 'extraction_recency' | 'shadow_activity' | 'escalation_rate'
    label:  string
    status: ReadinessCheckStatus
    detail: string
}

export interface KnowledgeHealth7d {
    /** Доля shadow trace где AI Knowledge решил иначе чем actual
     *  decision (auto_reply vs escalate vs skip). Полезно как сигнал
     *  "стоит ли уже переключать в runtime". null = недостаточно
     *  shadow trace для оценки. */
    shadowRuntimeMismatchPct: number | null
    /** escalated / decisionsTotal. null если decisionsTotal < 10. */
    escalationPct:            number | null
    /** noMatch / decisionsTotal. null если decisionsTotal < 10. */
    noMatchPct:               number | null
    /** Из всех usage logs WHERE usedInReply=true — сколько у verified
     *  items. null если used==0. */
    verifiedUsagePct:         number | null
    /** Базовая стат для UI footnote: total decisions over 7d. */
    decisionsBase:            number
    /** Total used-in-reply usage logs over 7d. */
    usageBase:                number
}

export interface KnowledgeReadinessBundle {
    counts:         KnowledgeReadinessCounts
    lastExtraction: KnowledgeLastExtraction | null
    activity7d:     KnowledgeActivity7d
    /** PR5.10 — read-only health summary. Отдельно от readiness
     *  checks: те — gating "готов ли запускать", health — fitness
     *  "хорошо ли работает уже сейчас". */
    health7d:       KnowledgeHealth7d
    /** Computed на основе counts+activity. Не gating — UI решает
     *  что показать. */
    checks:         ReadinessCheck[]
    /** Worst status среди checks — для readiness-pill цвета. */
    overall:        ReadinessCheckStatus
}

// ─── Пороги (на одном месте чтобы менять без поиска) ──────────────
//
// Это soft-defaults для checklist'а. Намеренно не env-driven —
// hardcoded чтобы любой Admin видел одинаковое определение
// "production-ready" и не было silent drift между инстансами.

const THRESHOLDS = {
    /** Минимум verified items чтобы checklist считал coverage OK. */
    verifiedMinimum:           10,
    /** Доля verified от active при которой warn. */
    verifiedRatioWarn:         0.30,
    /** Доля verified от active при которой ok. */
    verifiedRatioOk:           0.60,
    /** Часов с последнего extraction после которых warn. */
    extractionStaleWarnHours:  72,   // 3 дня
    /** Часов с последнего extraction после которых fail. */
    extractionStaleFailHours:  168,  // 7 дней
    /** Минимум shadow-decisions за 7д чтобы считать что shadow собрал данных. */
    shadowMinActivity:         20,
    /** Допустимая доля escalated (escalated / total) за 7д. */
    escalationOkRatio:         0.40,
    escalationWarnRatio:       0.65,
}

export { THRESHOLDS as READINESS_THRESHOLDS }

// ─── Основная функция ────────────────────────────────────────────

export async function getKnowledgeReadiness(): Promise<KnowledgeReadinessBundle> {
    const counts        = await loadCounts()
    const lastExtraction = await loadLastExtraction()
    const activity7d    = await loadActivity7d()
    const health7d      = await loadHealth7d(activity7d)
    const checks        = computeChecks(counts, lastExtraction, activity7d)
    const overall       = worstStatus(checks.map(c => c.status))
    return { counts, lastExtraction, activity7d, health7d, checks, overall }
}

// ─── Implementation ──────────────────────────────────────────────

async function loadCounts(): Promise<KnowledgeReadinessCounts> {
    const empty: KnowledgeReadinessCounts = {
        activeItems: 0, verifiedItems: 0, draftItems: 0,
        archivedItems: 0, conflictGroups: 0, activeSections: 0,
    }
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status = 'active' AND "isActive" = true)       AS "activeItems",
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status = 'active' AND "isActive" = true
                      AND "isVerified" = true)                            AS "verifiedItems",
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status = 'draft')                               AS "draftItems",
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status IN ('archived','superseded'))            AS "archivedItems",
                (SELECT COUNT(DISTINCT "conflictGroupId")
                    FROM "AiKnowledgeItem"
                    WHERE "conflictGroupId" IS NOT NULL
                      AND status = 'active')                              AS "conflictGroups",
                (SELECT COUNT(*) FROM "AiKnowledgeSection"
                    WHERE "isActive" = true)                              AS "activeSections"
        `
        const r = rows[0] ?? {}
        return {
            activeItems:    Number(r.activeItems    ?? 0),
            verifiedItems:  Number(r.verifiedItems  ?? 0),
            draftItems:     Number(r.draftItems     ?? 0),
            archivedItems:  Number(r.archivedItems  ?? 0),
            conflictGroups: Number(r.conflictGroups ?? 0),
            activeSections: Number(r.activeSections ?? 0),
        }
    } catch {
        return empty
    }
}

async function loadLastExtraction(): Promise<KnowledgeLastExtraction | null> {
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                id,
                status::text AS status,
                "startedAt", "finishedAt",
                progress, "errorMessage",
                "createdAt"
            FROM "AiExtractionJob"
            ORDER BY "createdAt" DESC
            LIMIT 1
        `
        if (!rows[0]) return null
        const r = rows[0]
        return {
            id:           r.id,
            status:       r.status,
            startedAt:    r.startedAt    ? new Date(r.startedAt).toISOString()    : null,
            finishedAt:   r.finishedAt   ? new Date(r.finishedAt).toISOString()   : null,
            progress:     r.progress ?? null,
            errorMessage: r.errorMessage ?? null,
            createdAt:    new Date(r.createdAt).toISOString(),
        }
    } catch {
        return null
    }
}

async function loadActivity7d(): Promise<KnowledgeActivity7d> {
    const empty: KnowledgeActivity7d = {
        decisionsTotal: 0, shadowDecisions: 0, runtimeDecisions: 0,
        escalated: 0, noMatch: 0, firstAt: null, lastAt: null,
    }
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                COUNT(*)::int                                                          AS "decisionsTotal",
                COUNT(*) FILTER (WHERE "retrievalMode" = 'shadow')::int                AS "shadowDecisions",
                COUNT(*) FILTER (WHERE "retrievalMode" = 'runtime')::int               AS "runtimeDecisions",
                COUNT(*) FILTER (WHERE escalated = true)::int                          AS "escalated",
                COUNT(*) FILTER (WHERE "retrievalDecision" = 'no_match')::int          AS "noMatch",
                MIN("createdAt")                                                       AS "firstAt",
                MAX("createdAt")                                                       AS "lastAt"
            FROM "AiDecisionLog"
            WHERE "retrievalMode" IS NOT NULL
              AND "createdAt" > NOW() - INTERVAL '7 days'
        `
        const r = rows[0] ?? {}
        return {
            decisionsTotal:    Number(r.decisionsTotal    ?? 0),
            shadowDecisions:   Number(r.shadowDecisions   ?? 0),
            runtimeDecisions:  Number(r.runtimeDecisions  ?? 0),
            escalated:         Number(r.escalated         ?? 0),
            noMatch:           Number(r.noMatch           ?? 0),
            firstAt:           r.firstAt ? new Date(r.firstAt).toISOString() : null,
            lastAt:            r.lastAt  ? new Date(r.lastAt).toISOString()  : null,
        }
    } catch {
        return empty
    }
}

async function loadHealth7d(activity: KnowledgeActivity7d): Promise<KnowledgeHealth7d> {
    const empty: KnowledgeHealth7d = {
        shadowRuntimeMismatchPct: null,
        escalationPct: null,
        noMatchPct: null,
        verifiedUsagePct: null,
        decisionsBase: activity.decisionsTotal,
        usageBase: 0,
    }
    try {
        // 1. Shadow mismatch: для shadow-mode trace где
        //    shadowRetrievalSummary->>'decision' отличается от
        //    actual decision (auto_reply vs escalate vs skip).
        let shadowMismatchPct: number | null = null
        if (activity.shadowDecisions >= 10) {
            const shadowRows = await prisma.$queryRaw<any[]>`
                SELECT
                    COUNT(*) FILTER (
                        WHERE "shadowRetrievalSummary" IS NOT NULL
                        AND (
                            ("shadowRetrievalSummary"->>'decision' = 'answer' AND decision != 'auto_reply')
                            OR
                            ("shadowRetrievalSummary"->>'decision' = 'escalate' AND decision != 'escalate')
                            OR
                            ("shadowRetrievalSummary"->>'decision' = 'no_knowledge' AND decision = 'auto_reply')
                        )
                    )::int AS mismatched,
                    COUNT(*) FILTER (
                        WHERE "shadowRetrievalSummary" IS NOT NULL
                    )::int AS total
                FROM "AiDecisionLog"
                WHERE "retrievalMode" = 'shadow'
                  AND "createdAt" > NOW() - INTERVAL '7 days'
            `
            const r = shadowRows[0] ?? {}
            const total = Number(r.total ?? 0)
            if (total > 0) {
                shadowMismatchPct = Number(r.mismatched ?? 0) / total
            }
        }

        // 2. Escalation / no-match — reuse activity counts
        const escalationPct = activity.decisionsTotal >= 10
            ? activity.escalated / activity.decisionsTotal
            : null
        const noMatchPct = activity.decisionsTotal >= 10
            ? activity.noMatch / activity.decisionsTotal
            : null

        // 3. Verified usage %: from AiKnowledgeUsageLog joined with Item
        const usageRows = await prisma.$queryRaw<any[]>`
            SELECT
                COUNT(*) FILTER (WHERE ul."usedInReply" = true)::int AS "usedTotal",
                COUNT(*) FILTER (
                    WHERE ul."usedInReply" = true AND ki."isVerified" = true
                )::int AS "usedVerified"
            FROM "AiKnowledgeUsageLog" ul
            LEFT JOIN "AiKnowledgeItem" ki ON ki.id = ul."itemId"
            WHERE ul."usedAt" > NOW() - INTERVAL '7 days'
        `
        const u = usageRows[0] ?? {}
        const usedTotal = Number(u.usedTotal ?? 0)
        const verifiedUsagePct = usedTotal > 0
            ? Number(u.usedVerified ?? 0) / usedTotal
            : null

        return {
            shadowRuntimeMismatchPct: shadowMismatchPct,
            escalationPct,
            noMatchPct,
            verifiedUsagePct,
            decisionsBase: activity.decisionsTotal,
            usageBase: usedTotal,
        }
    } catch {
        return empty
    }
}

function computeChecks(
    counts: KnowledgeReadinessCounts,
    lastExtraction: KnowledgeLastExtraction | null,
    activity: KnowledgeActivity7d,
): ReadinessCheck[] {
    const checks: ReadinessCheck[] = []

    // 1. Conflicts: 0 → ok, >0 → fail (нужно вмешательство)
    checks.push({
        id:     'conflicts',
        label:  'Конфликты в ядре',
        status: counts.conflictGroups === 0 ? 'ok' : 'fail',
        detail: counts.conflictGroups === 0
            ? 'Нет неразрешённых конфликтов'
            : `${counts.conflictGroups} неразрешённых конфликт${plural(counts.conflictGroups, '', 'а', 'ов')} требуют решения`,
    })

    // 2. Verified coverage
    const ratio = counts.activeItems > 0 ? counts.verifiedItems / counts.activeItems : 0
    let vStatus: ReadinessCheckStatus = 'fail'
    let vDetail = ''
    if (counts.activeItems === 0) {
        vStatus = 'fail'
        vDetail = 'Ядро пустое — запустите сбор'
    } else if (counts.verifiedItems < THRESHOLDS.verifiedMinimum) {
        vStatus = 'warn'
        vDetail = `Подтверждено ${counts.verifiedItems} из ${counts.activeItems} — рекомендуется ${THRESHOLDS.verifiedMinimum}+`
    } else if (ratio >= THRESHOLDS.verifiedRatioOk) {
        vStatus = 'ok'
        vDetail = `Подтверждено ${counts.verifiedItems} из ${counts.activeItems} (${Math.round(ratio * 100)}%)`
    } else if (ratio >= THRESHOLDS.verifiedRatioWarn) {
        vStatus = 'warn'
        vDetail = `Подтверждено ${counts.verifiedItems} из ${counts.activeItems} (${Math.round(ratio * 100)}%) — стоит дотянуть до 60%`
    } else {
        vStatus = 'warn'
        vDetail = `Подтверждено только ${counts.verifiedItems} из ${counts.activeItems} (${Math.round(ratio * 100)}%)`
    }
    checks.push({ id: 'verified_coverage', label: 'Подтверждённое покрытие', status: vStatus, detail: vDetail })

    // 3. Extraction recency
    let eStatus: ReadinessCheckStatus = 'fail'
    let eDetail = 'Ни одного сбора ядра не запускалось'
    if (lastExtraction) {
        const ref = lastExtraction.finishedAt ?? lastExtraction.startedAt ?? lastExtraction.createdAt
        if (ref) {
            const hoursAgo = (Date.now() - new Date(ref).getTime()) / 3600000
            const humanAgo = humanizeHours(hoursAgo)
            if (lastExtraction.status === 'failed') {
                eStatus = 'fail'
                eDetail = `Последний сбор завершился ошибкой (${humanAgo} назад)`
            } else if (hoursAgo > THRESHOLDS.extractionStaleFailHours) {
                eStatus = 'fail'
                eDetail = `Последний сбор был ${humanAgo} назад — данные устарели`
            } else if (hoursAgo > THRESHOLDS.extractionStaleWarnHours) {
                eStatus = 'warn'
                eDetail = `Последний сбор ${humanAgo} назад`
            } else {
                eStatus = 'ok'
                eDetail = `Сбор актуален: ${humanAgo} назад`
            }
        }
    }
    checks.push({ id: 'extraction_recency', label: 'Свежесть сбора ядра', status: eStatus, detail: eDetail })

    // 4. Shadow activity: должно набраться достаточно traces за 7д
    let sStatus: ReadinessCheckStatus = 'warn'
    let sDetail = ''
    if (activity.shadowDecisions === 0 && activity.runtimeDecisions === 0) {
        sStatus = 'warn'
        sDetail = 'Нет shadow-trace за 7 дней — нечем оценить retrieval до runtime'
    } else if (activity.shadowDecisions >= THRESHOLDS.shadowMinActivity) {
        sStatus = 'ok'
        sDetail = `Shadow собрал ${activity.shadowDecisions} trace за 7 дней`
    } else {
        sStatus = 'warn'
        sDetail = `Shadow собрал ${activity.shadowDecisions} trace за 7 дней — мало для надёжной оценки`
    }
    checks.push({ id: 'shadow_activity', label: 'Shadow-наблюдения', status: sStatus, detail: sDetail })

    // 5. Escalation rate (только если есть base)
    let escStatus: ReadinessCheckStatus = 'ok'
    let escDetail = 'Недостаточно данных для оценки эскалации'
    if (activity.decisionsTotal >= 10) {
        const escRatio = activity.escalated / activity.decisionsTotal
        const pct = Math.round(escRatio * 100)
        if (escRatio <= THRESHOLDS.escalationOkRatio) {
            escStatus = 'ok'
            escDetail = `${pct}% решений переданы менеджеру за 7 дней`
        } else if (escRatio <= THRESHOLDS.escalationWarnRatio) {
            escStatus = 'warn'
            escDetail = `${pct}% решений переданы менеджеру — повышенный уровень`
        } else {
            escStatus = 'fail'
            escDetail = `${pct}% решений переданы менеджеру — AI почти всегда передаёт, не готов к runtime`
        }
    }
    checks.push({ id: 'escalation_rate', label: 'Уровень эскалации', status: escStatus, detail: escDetail })

    return checks
}

function worstStatus(arr: ReadinessCheckStatus[]): ReadinessCheckStatus {
    if (arr.includes('fail')) return 'fail'
    if (arr.includes('warn')) return 'warn'
    return 'ok'
}

function humanizeHours(h: number): string {
    if (h < 1)  return 'меньше часа'
    if (h < 2)  return '1 час'
    if (h < 24) return `${Math.floor(h)} ч`
    const days = Math.floor(h / 24)
    return `${days} ${plural(days, 'день', 'дня', 'дней')}`
}

function plural(n: number, one: string, few: string, many: string): string {
    const mod10  = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11)                     return one
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
    return many
}
