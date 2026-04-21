// Local enum definitions matching prisma/schema.prisma
// (Prisma client generate is blocked while dev server runs; these are the local source of truth)

export type TaskSource = 'auto' | 'manual' | 'chat'

export const TASK_TYPES = [
    { value: 'check_docs', label: 'Проверка документов' },
    { value: 'call_back', label: 'Перезвонить' },
    { value: 'inactive_followup', label: 'Узнать почему' },
    { value: 'payment_issue', label: 'Проблема с выплатой' },
    { value: 'other', label: 'Другое' },
]
export type TaskStatus = 'todo' | 'in_progress' | 'waiting_reply' | 'overdue' | 'snoozed' | 'done' | 'cancelled' | 'archived'
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

// ─── Base Task DTO (used for all views: list, board, timeline) ─────────────

export interface TaskDTO {
    id: string
    driverId: string
    driverName: string
    driverPhone: string | null
    driverSegment: string
    driverLastOrderAt: string | null

    source: TaskSource
    type: string
    title: string
    description: string | null
    status: TaskStatus
    priority: TaskPriority
    isActive: boolean

    // Trigger / Dedupe
    triggerType: string | null
    triggerKey: string | null
    dedupeKey: string | null

    // Scheduling
    dueAt: string | null   // ISO string

    // Assignment
    assigneeId: string | null
    createdBy: string | null

    // Chat linkage
    chatId: string | null
    originMessageId: string | null
    originExcerpt: string | null

    // Reactive sync
    hasNewReply: boolean
    lastInboundMessageAt: string | null
    lastOutboundMessageAt: string | null

    // Scenario
    scenario: string | null
    stage: string | null
    stageEnteredAt: string | null
    nextActionAt: string | null
    slaDeadline: string | null
    closedReason: string | null
    closedComment: string | null

    // Legacy metadata (kept for backward compat)
    attempts?: number
    nextActionId?: string
    escalated?: boolean

    // ─── Wave 1: Enriched fields ──────────────────────────────────

    // Importance signals
    priorityLabel: string
    isEscalated: boolean

    // Assignee display data
    assignee: { id: string; name: string } | null

    // Work summary (derived from TaskEvent)
    lastContactAt: string | null
    lastContactType: string | null      // 'called' | 'wrote' | 'message_sent' | 'contacted' | null
    lastContactResult: string | null
    lastContactBy: string | null        // Display name of the actor who made the last contact
    touchCount: number

    // Offer decision (computed on the server via offer-rules.resolveOfferAllowed)
    offerAllowed: {
        verdict: 'yes' | 'no' | 'maybe'
        reason: string
        ruleId: string
        isOverridden: boolean
    } | null

    // Scenario fields preview (for list view)
    scenarioFieldsPreview: {
        fieldId: string
        label: string
        type: 'boolean' | 'number' | 'string' | 'enum' | 'date'
        value: unknown
    }[] | null

    // Мета-сводка по scenarioData (для фильтров и сортировки)
    scenarioMeta?: {
        sourceTypes: ('auto' | 'manual' | 'derived')[]   // какие source присутствуют
        filledCount: number                               // сколько полей заполнено
        requiredCount: number                             // сколько полей с showInCard=true в сценарии
        completeness: 'full' | 'partial' | 'empty'
    } | null

    // Timestamps
    createdAt: string
    updatedAt: string
    resolvedAt: string | null
}

// ─── Task Detail DTO (loaded on-demand in TaskDetailsPane) ─────────────────

export interface TaskDetailDTO extends TaskDTO {
    events: TaskEventDTO[]
    // Полный scenarioData для карточки (все поля showInCard, не только preview)
    scenarioDataFull: Record<string, {
        value: unknown
        source: 'auto' | 'manual' | 'derived'
        updatedAt: string
    }> | null
}

// ─── Task Event DTO ────────────────────────────────────────────────────────

export interface TaskEventDTO {
    id: string
    taskId: string
    eventType: string
    payload: Record<string, unknown>
    actorType: string | null
    actorId: string | null
    createdAt: string
}

// ─── Input Types ───────────────────────────────────────────────────────────

export interface CreateTaskInput {
    driverId: string
    source: TaskSource
    type: string
    title: string
    description?: string
    priority?: TaskPriority
    dueAt?: string
    assigneeId?: string

    // Chat context
    chatId?: string
    originMessageId?: string
    originExcerpt?: string
    originCreatedAt?: string

    // Auto-task fields
    triggerType?: string
    triggerKey?: string
    dedupeKey?: string

    // Scenario
    scenario?: string
    stage?: string
}

export interface UpdateTaskInput {
    title?: string
    description?: string
    status?: TaskStatus
    priority?: TaskPriority
    type?: string
    source?: TaskSource
    dueAt?: string | null
    assigneeId?: string | null
    hasNewReply?: boolean
    isActive?: boolean

    // Scenario
    stage?: string
    nextActionAt?: string | null
    slaDeadline?: string | null
    closedReason?: string
    closedComment?: string

    // Legacy metadata
    attempts?: number
    nextActionId?: string
}

// ─── Filter Types ──────────────────────────────────────────────────────────

export interface TaskFilters {
    status?: TaskStatus | 'all'
    priority?: TaskPriority | 'all'
    source?: TaskSource | 'all'
    assigneeId?: string
    driverId?: string
    search?: string
    isActive?: boolean
    hasNewReply?: boolean

    // Scenario filters
    scenario?: string | null   // null = "без сценария", undefined = "все"
    stage?: string

    // Extended filters
    type?: string
    dateFrom?: string
    dateTo?: string

    // Wave 1: Scenario field filters
    scenarioFields?: {
        fieldId: string
        operator: 'eq' | 'gt' | 'lt' | 'exists' | 'not_exists'
        value?: unknown
    }[]

    // Wave 1: Presets
    preset?: 'hot' | 'no_contact' | 'sla_burning' | 'has_reply'

    // Churn: мета-фильтры по scenario data
    // Источник данных: присутствие хотя бы одного поля с таким source
    scenarioSource?: 'auto' | 'manual' | 'derived'
    // Заполненность карточки: полная / частичная / пустая
    scenarioCompleteness?: 'full' | 'partial' | 'empty'

    // Block E: extra list filters
    /** true → only cases where the deadline is in the past or task.status==='overdue' */
    overdue?: boolean
    /** Filter by computed offer verdict (override-aware) */
    offerAllowed?: 'yes' | 'no' | 'maybe'
    /** Filter by externalParkName (scenarioData) — exact match */
    park?: string
}

// ─── View Types ────────────────────────────────────────────────────────────

export type TaskView = 'list' | 'board' | 'timeline'

export type TaskSortField =
    | 'dueAt' | 'priority' | 'createdAt' | 'updatedAt'
    // Table-mode sortable fields (MVP churn)
    | 'fullName' | 'stage' | 'nextActionAt' | 'lastContactAt'
export type TaskSortDirection = 'asc' | 'desc'

export interface TaskSort {
    field: TaskSortField
    direction: TaskSortDirection
}

// ─── Similar Task (for soft-dedupe) ────────────────────────────────────────

export interface SimilarTaskHint {
    id: string
    title: string
    status: TaskStatus
    dueAt: string | null
    createdAt: string
}
