export interface TaskDictionaryItemV1 {
    id: string
    label: string
    isActive: boolean
    metadata?: Record<string, any>
}

export type TaskDictionaryTypeV1 =
    | 'scenarios'
    | 'events'
    | 'statuses'
    | 'priorities'
    | 'sources'
    | 'history_actions'
    | 'contact_results'
    | 'next_actions'

export type TaskDictionariesV1 = Record<TaskDictionaryTypeV1, TaskDictionaryItemV1[]>
