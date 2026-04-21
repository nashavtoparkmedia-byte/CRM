// ═══════════════════════════════════════════════════════════════════
// Offer Rules — decides whether promo/offer is allowed for a churn case.
//
// MVP contract:
//   - pure function, no DB access
//   - order of rules matters: first match wins
//   - result has: verdict + human reason + stable ruleId (for audit)
//   - manual override lives in scenarioData.offerAllowedOverride
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from './types'
import type { ScenarioData } from './scenario-config'

export type OfferVerdict = 'yes' | 'no' | 'maybe'

export interface OfferAllowedResult {
    verdict: OfferVerdict
    reason: string
    ruleId: string
}

export interface OfferAllowedResolved extends OfferAllowedResult {
    isOverridden: boolean
    computedVerdict: OfferVerdict  // the verdict that would apply without override
    computedReason: string
}

function getVal<T = unknown>(data: ScenarioData | null, fieldId: string): T | null {
    const entry = data?.[fieldId]
    return (entry?.value as T | undefined) ?? null
}

/**
 * Pure rule engine: inspects task + scenarioData and returns a verdict.
 * Does NOT apply manual overrides — see resolveOfferAllowed for that.
 */
export function computeOfferAllowed(
    task: TaskDTO,
    scenarioData: ScenarioData | null,
): OfferAllowedResult {
    const smz = getVal<string>(scenarioData, 'isSelfEmployed')
    const yandexActive = getVal<string>(scenarioData, 'yandexActive')
    const trips = getVal<number>(scenarioData, 'yandexTripsCount')
    const inOtherFleet = getVal<string>(scenarioData, 'isInOtherFleet')
    const churnReason = getVal<string>(scenarioData, 'churnReason')
    const offerResult = getVal<string>(scenarioData, 'offerResult')

    // ── "No" rules (first) ──
    if (yandexActive === 'yes' && inOtherFleet === 'no') {
        return {
            verdict: 'no',
            reason: 'Уже возвращается без акции — катает в Яндекс в нашем парке',
            ruleId: 'returning_without_offer',
        }
    }
    if (churnReason === 'personal') {
        return {
            verdict: 'no',
            reason: 'Причина временная/личная — акция сейчас неактуальна',
            ruleId: 'temporary_reason',
        }
    }
    if (yandexActive === 'yes' && inOtherFleet === 'yes') {
        return {
            verdict: 'no',
            reason: 'Работает напрямую в другом парке — парк ему не нужен',
            ruleId: 'works_elsewhere',
        }
    }
    if (offerResult === 'declined') {
        return {
            verdict: 'no',
            reason: 'Повторный оффер не нужен — условия уже были отклонены',
            ruleId: 'prior_offer_declined',
        }
    }

    // ── "Yes" rules ──
    if (smz === 'yes') {
        return {
            verdict: 'yes',
            reason: 'Есть СМЗ — квалифицированный водитель',
            ruleId: 'smz_ok',
        }
    }
    if (typeof trips === 'number' && trips >= 100) {
        return {
            verdict: 'yes',
            reason: `${trips} поездок — высокая активность, стоит вернуть`,
            ruleId: 'high_activity',
        }
    }
    if (task.priority === 'critical') {
        return {
            verdict: 'yes',
            reason: 'Критический приоритет — пробуем вернуть',
            ruleId: 'critical_priority',
        }
    }

    // ── Fallback: maybe ──
    return {
        verdict: 'maybe',
        reason: 'Недостаточно данных — по согласованию',
        ruleId: 'insufficient_data',
    }
}

/**
 * Apply the manager's manual override on top of the computed verdict.
 * Override lives in scenarioData.offerAllowedOverride / offerOverrideReason.
 */
export function resolveOfferAllowed(
    task: TaskDTO,
    scenarioData: ScenarioData | null,
): OfferAllowedResolved {
    const computed = computeOfferAllowed(task, scenarioData)
    const override = getVal<string>(scenarioData, 'offerAllowedOverride')
    const overrideReason = getVal<string>(scenarioData, 'offerOverrideReason')

    if (override === 'yes' || override === 'no' || override === 'maybe') {
        return {
            verdict: override,
            reason: overrideReason || 'Переопределено вручную',
            ruleId: 'manual_override',
            isOverridden: true,
            computedVerdict: computed.verdict,
            computedReason: computed.reason,
        }
    }
    return {
        ...computed,
        isOverridden: false,
        computedVerdict: computed.verdict,
        computedReason: computed.reason,
    }
}

export function verdictLabel(v: OfferVerdict): string {
    if (v === 'yes') return 'Да'
    if (v === 'no') return 'Нет'
    return 'Согласовать'
}

export function verdictColor(v: OfferVerdict): {
    dot: string
    bg: string
    text: string
} {
    if (v === 'yes') return { dot: 'bg-[#059669]', bg: 'bg-[#ECFDF5]', text: 'text-[#047857]' }
    if (v === 'no')  return { dot: 'bg-[#DC2626]', bg: 'bg-[#FEF2F2]', text: 'text-[#B91C1C]' }
    return              { dot: 'bg-[#CA8A04]', bg: 'bg-[#FEFCE8]', text: 'text-[#A16207]' }
}
