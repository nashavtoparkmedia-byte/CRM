/**
 * Intervention reasons configuration.
 * Labels and priority order for intervention queue explanations.
 */

export const INTERVENTION_REASONS = [
    'critical_health',
    'sustained_decline',
    'escalated_and_overdue',
    'warning_health',
    'declining_trend',
    'high_risk_tasks',
] as const

export type InterventionReason = typeof INTERVENTION_REASONS[number]

export const INTERVENTION_REASON_LABELS: Record<InterventionReason, string> = {
    critical_health: 'Критический health score',
    sustained_decline: 'Устойчивое снижение',
    escalated_and_overdue: 'Есть эскалации и просрочки',
    warning_health: 'Пониженный health score',
    declining_trend: 'Негативный тренд',
    high_risk_tasks: 'Есть рисковые задачи',
}

export const INTERVENTION_REASON_COLORS: Record<InterventionReason, { bg: string; text: string }> = {
    critical_health: { bg: 'bg-red-100', text: 'text-red-600' },
    sustained_decline: { bg: 'bg-red-100', text: 'text-red-600' },
    escalated_and_overdue: { bg: 'bg-red-100', text: 'text-red-600' },
    warning_health: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
    declining_trend: { bg: 'bg-orange-100', text: 'text-orange-600' },
    high_risk_tasks: { bg: 'bg-orange-100', text: 'text-orange-600' },
}

/**
 * Build deterministic list of intervention reasons for a manager.
 * Order follows INTERVENTION_REASONS priority.
 */
export function buildInterventionReasons(params: {
    healthLevel: string
    sustainedDecline: boolean
    escalated: number
    overdue: number
    healthTrend: string
    highRiskTasks: number
}): InterventionReason[] {
    const reasons: InterventionReason[] = []

    if (params.healthLevel === 'critical') reasons.push('critical_health')
    if (params.sustainedDecline) reasons.push('sustained_decline')
    if (params.escalated > 0 && params.overdue > 0) reasons.push('escalated_and_overdue')
    if (params.healthLevel === 'warning') reasons.push('warning_health')
    if (params.healthTrend === 'declining') reasons.push('declining_trend')
    if (params.highRiskTasks > 0) reasons.push('high_risk_tasks')

    return reasons
}
