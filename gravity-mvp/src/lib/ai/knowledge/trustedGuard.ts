/**
 * AI Knowledge Core — Trusted Knowledge Guard (PR6).
 *
 * Защитный слой при extraction. Если менеджер в чате сказал что-то,
 * что противоречит подтверждённому правилу компании (verified item
 * или legacy-migrated KB), это НЕ должно автоматически попадать в
 * активное ядро.
 *
 * Trusted = (item.status='active') AND (
 *     item.isVerified=true                  // админ лично подтвердил
 *     OR tags includes 'source:legacy'      // мигрировано из старой KB
 * )
 *
 * Логика:
 *   1. similarity(candidate, trusted) >= TRUSTED_SIMILARITY_FLOOR
 *      ↓ есть смысл сравнивать
 *   2. Если topic похожий И numeric values противоречат → contradicts
 *   3. Если topic очень похожий И числа совпадают / нет чисел → matches
 *   4. Иначе → no_relation (default flow)
 *
 * Pure function, БЕЗ Prisma. Caller грузит trusted items сам и
 * передаёт сюда. Это нужно чтобы smoke мог тестить без db.
 */

import { similarity, extractNumericValues } from '@/lib/ai/knowledge/textUtils'

// ─── Пороги ───────────────────────────────────────────────────────
//
// Намеренно hardcoded — обе стороны сравнения должны быть устойчиво
// тематически связаны, прежде чем мы рассматриваем conflict. Слишком
// низкий floor = ложные срабатывания (любой текст про "комиссию"
// блокирует любой другой про "комиссию"). Слишком высокий = пропуски.

const TRUSTED_SIMILARITY_FLOOR = 0.35  // ниже — игнорим, темы не связаны
const TRUSTED_MATCH_FLOOR      = 0.55  // выше — считаем "то же самое", даже если перефразировано
const NUMERIC_EPSILON          = 0.001 // 0.001-разница не считается conflict

// ─── Типы ─────────────────────────────────────────────────────────

export interface TrustedItemLike {
    id:                  string
    title:               string
    canonicalStatement:  string
    status:              string
    isVerified:          boolean
    tags:                string[]
}

export interface CandidateLike {
    title:              string
    canonicalStatement: string
}

export type TrustedGuardVerdict =
    | { verdict: 'safe' }
    | {
        verdict:  'contradicts'
        trusted:  TrustedItemLike
        /** Краткое objяснение для UI/audit. */
        reason:   string
    }
    | {
        verdict:  'matches_trusted'
        trusted:  TrustedItemLike
        /** Подкрепляет уже подтверждённый факт. UI или extractor может
         *  использовать это для boost confidence или merge. */
        reason:   string
    }

// ─── API ──────────────────────────────────────────────────────────

/** Trusted = active + (verified OR migrated из legacy). */
export function isTrustedItem(item: {
    status: string
    isVerified: boolean
    tags?: string[]
}): boolean {
    if (item.status !== 'active') return false
    if (item.isVerified) return true
    if (item.tags && item.tags.includes('source:legacy')) return true
    return false
}

/** Найти кандидата на conflict / match среди trusted items. Возвращает
 *  первое совпадение с самым высоким score, чтобы UI/extractor могли
 *  показать конкретное правило. */
export function checkAgainstTrusted(
    candidate: CandidateLike,
    items: TrustedItemLike[],
): TrustedGuardVerdict {
    const trusted = items.filter(isTrustedItem)
    if (trusted.length === 0) return { verdict: 'safe' }

    // Ranked by topic-similarity (best topic match сверху). Numeric
    // conflict проверяем по всем, чтобы не пропустить "комиссия 7%
    // против комиссия 3.99%" даже если topic-similarity 0.4 (короткий
    // candidate vs длинный statement).
    type Pair = { item: TrustedItemLike; sim: number }
    const pairs: Pair[] = trusted
        .map(item => ({ item, sim: topicSimilarity(candidate, item) }))
        .filter(p => p.sim >= TRUSTED_SIMILARITY_FLOOR)
        .sort((a, b) => b.sim - a.sim)

    if (pairs.length === 0) return { verdict: 'safe' }

    // Сначала ищем conflict — он strongest signal. Conflict = topic
    // similar (sim >= floor) И есть несовместимая численная пара.
    for (const { item } of pairs) {
        const conflict = numericConflict(candidate.canonicalStatement, item.canonicalStatement)
        if (conflict) {
            return {
                verdict: 'contradicts',
                trusted: item,
                reason:  conflict.reason,
            }
        }
    }

    // Conflict не найден — может быть match. Match = topic очень похож
    // (sim >= match floor) и в обоих statement'ах либо нет чисел, либо
    // числа совпадают (то же ещё раз сказали).
    const top = pairs[0]
    if (top.sim >= TRUSTED_MATCH_FLOOR) {
        return {
            verdict: 'matches_trusted',
            trusted: top.item,
            reason:  `Подтверждает «${truncate(top.item.title, 50)}» (sim ${top.sim.toFixed(2)})`,
        }
    }

    return { verdict: 'safe' }
}

// ─── Internals ────────────────────────────────────────────────────

function topicSimilarity(c: CandidateLike, item: TrustedItemLike): number {
    const sStmt  = similarity(c.canonicalStatement, item.canonicalStatement)
    const sTitle = similarity(c.title, item.title)
    return 0.7 * sStmt + 0.3 * sTitle
}

interface NumericConflictResult {
    reason: string
}

/**
 * Возвращает details если в двух текстах есть пара чисел с
 * одинаковыми единицами измерения но разными значениями. Например:
 *   candidate: "комиссия 2%"
 *   trusted:   "комиссия 3.99%"
 *   → conflict (unit '%', 2 vs 3.99)
 */
function numericConflict(a: string, b: string): NumericConflictResult | null {
    const an = extractNumericValues(a)
    const bn = extractNumericValues(b)
    if (an.length === 0 || bn.length === 0) return null

    for (const x of an) {
        for (const y of bn) {
            if (x.unit === y.unit && Math.abs(x.value - y.value) > NUMERIC_EPSILON) {
                return {
                    reason: `Цифры расходятся: ${formatNum(x.value)}${x.unit} в чате против ${formatNum(y.value)}${y.unit} в подтверждённом правиле`,
                }
            }
        }
    }
    return null
}

function formatNum(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ─── Tag helpers (для Extractor integration) ──────────────────────

/** Tag-формат для метки candidate, заблокированного trusted guard'ом.
 *  Парсится в UI для показа badge. */
export const CONFLICTS_WITH_TRUSTED_TAG_PREFIX = 'conflicts_with_trusted:'

/** Tag-формат для candidate, который подтверждает trusted item. */
export const MATCHES_TRUSTED_TAG_PREFIX = 'matches_trusted:'

export function makeConflictsTag(trustedItemId: string): string {
    return CONFLICTS_WITH_TRUSTED_TAG_PREFIX + trustedItemId
}

export function makeMatchesTag(trustedItemId: string): string {
    return MATCHES_TRUSTED_TAG_PREFIX + trustedItemId
}

/** Извлекает trustedItemId из тегов item'а. null если нет такого тега. */
export function parseConflictsWithTrusted(tags: string[]): string | null {
    const t = tags.find(t => t.startsWith(CONFLICTS_WITH_TRUSTED_TAG_PREFIX))
    return t ? t.slice(CONFLICTS_WITH_TRUSTED_TAG_PREFIX.length) : null
}

export function parseMatchesTrusted(tags: string[]): string | null {
    const t = tags.find(t => t.startsWith(MATCHES_TRUSTED_TAG_PREFIX))
    return t ? t.slice(MATCHES_TRUSTED_TAG_PREFIX.length) : null
}
