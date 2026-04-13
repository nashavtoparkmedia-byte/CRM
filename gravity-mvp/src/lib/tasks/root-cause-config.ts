/**
 * Root cause options for escalation resolution.
 * Adjustable without schema changes.
 */
export const ROOT_CAUSES = [
    { value: 'client_unreachable', label: 'Клиент недоступен' },
    { value: 'incorrect_data', label: 'Ошибка данных' },
    { value: 'delayed_response', label: 'Медленный ответ' },
    { value: 'reassignment_needed', label: 'Требовалось переназначение' },
    { value: 'other', label: 'Другое' },
] as const

export type RootCause = typeof ROOT_CAUSES[number]['value']

export function getRootCauseLabel(value: string): string {
    return ROOT_CAUSES.find(r => r.value === value)?.label || value
}
