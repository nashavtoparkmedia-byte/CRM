/**
 * Intervention outcome evaluation configuration.
 * Determines whether a manager's health improved after an intervention action.
 */

export const INTERVENTION_OUTCOME_CONFIG = {
    /** Hours after intervention to evaluate outcome */
    outcomeWindowHours: 24,
    /** Minimum score change to count as improvement/worsening */
    improvementThreshold: 3,
}

export const INTERVENTION_OUTCOMES = ['improved', 'unchanged', 'worsened'] as const

export type InterventionOutcome = typeof INTERVENTION_OUTCOMES[number]

export const INTERVENTION_OUTCOME_LABELS: Record<InterventionOutcome, string> = {
    improved: 'Улучшилось',
    unchanged: 'Без изменений',
    worsened: 'Ухудшилось',
}

export const INTERVENTION_OUTCOME_COLORS: Record<InterventionOutcome, { bg: string; text: string }> = {
    improved: { bg: 'bg-green-50', text: 'text-green-600' },
    unchanged: { bg: 'bg-gray-100', text: 'text-gray-500' },
    worsened: { bg: 'bg-red-50', text: 'text-red-600' },
}

/** Effectiveness display thresholds (percentage) */
export const EFFECTIVENESS_THRESHOLDS = {
    /** improvementRate >= this = good (green) */
    good: 60,
    /** improvementRate >= this = moderate (yellow); < this = poor (red) */
    moderate: 30,
}

/**
 * Evaluate intervention outcome by comparing health scores.
 */
export function evaluateOutcome(scoreAtAction: number, currentScore: number): InterventionOutcome {
    const delta = currentScore - scoreAtAction
    const threshold = INTERVENTION_OUTCOME_CONFIG.improvementThreshold
    if (delta >= threshold) return 'improved'
    if (delta <= -threshold) return 'worsened'
    return 'unchanged'
}
