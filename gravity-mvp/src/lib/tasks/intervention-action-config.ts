/**
 * Intervention action types and labels.
 * Used when a lead marks an action taken for a manager in the intervention queue.
 */

export const INTERVENTION_ACTIONS = [
    'coaching',
    'reassigned_tasks',
    'workload_adjusted',
    'escalation_reviewed',
    'no_action_needed',
] as const

export type InterventionAction = typeof INTERVENTION_ACTIONS[number]

export const INTERVENTION_ACTION_LABELS: Record<InterventionAction, string> = {
    coaching: 'Проведён разбор',
    reassigned_tasks: 'Перераспределены задачи',
    workload_adjusted: 'Скорректирована нагрузка',
    escalation_reviewed: 'Эскалация рассмотрена',
    no_action_needed: 'Действие не требуется',
}
