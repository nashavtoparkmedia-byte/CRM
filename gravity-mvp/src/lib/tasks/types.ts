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

    // Timestamps
    createdAt: string
    updatedAt: string
    resolvedAt: string | null
}

// ─── Task Detail DTO (loaded on-demand in TaskDetailsPane) ─────────────────

export interface TaskDetailDTO extends TaskDTO {
    events: TaskEventDTO[]
    // Future: driverContext, chatPreview, etc.
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
}

// ─── View Types ────────────────────────────────────────────────────────────

export type TaskView = 'list' | 'board' | 'timeline'

export type TaskSortField = 'dueAt' | 'priority' | 'createdAt' | 'updatedAt'
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
