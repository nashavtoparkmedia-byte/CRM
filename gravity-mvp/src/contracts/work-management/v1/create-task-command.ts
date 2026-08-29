export const CREATE_TASK_COMMAND_V1 = 'work_management.CreateTaskCommand.v1' as const
export const CREATE_TASK_RESULT_V1 = 'work_management.CreateTaskResult.v1' as const

export type JsonPrimitiveV1 = string | number | boolean | null
export type JsonValueV1 = JsonPrimitiveV1 | JsonValueV1[] | { [key: string]: JsonValueV1 }

export type TaskPriorityV1 = 'critical' | 'high' | 'medium' | 'low'
export type TaskStatusV1 =
    | 'todo'
    | 'in_progress'
    | 'waiting_reply'
    | 'overdue'
    | 'snoozed'
    | 'done'
    | 'cancelled'
    | 'archived'
export type TaskSourceV1 = 'manual' | 'auto' | 'chat'

export interface CreateTaskDataV1 {
    driverId?: string | null
    contactId?: string | null
    source: TaskSourceV1
    type: string
    title: string
    description?: string | null
    priority?: TaskPriorityV1
    status?: TaskStatusV1
    assigneeId?: string | null
    createdBy?: string | null
    metadata?: { [key: string]: JsonValueV1 } | null
}

export interface CreateTaskCommandV1 {
    contract: typeof CREATE_TASK_COMMAND_V1
    data: CreateTaskDataV1
}

export interface CreateTaskResultV1 {
    contract: typeof CREATE_TASK_RESULT_V1
    task: {
        id: string
        title: string
    }
}

export class ContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ContractValidationError['code'], message: string) {
        super(message)
        this.name = 'ContractValidationError'
        this.code = code
    }
}

const DATA_FIELDS = new Set([
    'driverId',
    'contactId',
    'source',
    'type',
    'title',
    'description',
    'priority',
    'status',
    'assigneeId',
    'createdBy',
    'metadata',
])
const COMMAND_FIELDS = new Set(['contract', 'data'])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null | undefined {
    return value === undefined || value === null || typeof value === 'string'
}

function isJsonValue(value: unknown): value is JsonValueV1 {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(isJsonValue)
    if (!isRecord(value)) return false
    return Object.values(value).every(isJsonValue)
}

function invalid(message: string): never {
    throw new ContractValidationError('INVALID_CONTRACT', message)
}

export function parseCreateTaskCommandV1(input: unknown): CreateTaskCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')

    const unexpectedCommandFields = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (unexpectedCommandFields.length > 0) {
        invalid(`unsupported command field(s): ${unexpectedCommandFields.sort().join(', ')}`)
    }

    if (input.contract !== CREATE_TASK_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('work_management.CreateTaskCommand.')) {
            throw new ContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${CREATE_TASK_COMMAND_V1}`)
    }

    if (!isRecord(input.data)) invalid('data must be an object')
    const data = input.data
    const unexpected = Object.keys(data).filter((key) => !DATA_FIELDS.has(key))
    if (unexpected.length > 0) invalid(`unsupported data field(s): ${unexpected.sort().join(', ')}`)

    if (!isNullableString(data.driverId) || !isNullableString(data.contactId)) {
        invalid('driverId and contactId must be strings, null, or absent')
    }
    if (!['manual', 'auto', 'chat'].includes(String(data.source))) invalid('source is invalid')
    if (typeof data.type !== 'string' || data.type.trim() === '') invalid('type is required')
    if (typeof data.title !== 'string' || data.title.trim() === '') invalid('title is required')
    if (!isNullableString(data.description)) invalid('description must be a string, null, or absent')
    if (data.priority !== undefined && !['critical', 'high', 'medium', 'low'].includes(String(data.priority))) {
        invalid('priority is invalid')
    }
    if (
        data.status !== undefined
        && !['todo', 'in_progress', 'waiting_reply', 'overdue', 'snoozed', 'done', 'cancelled', 'archived']
            .includes(String(data.status))
    ) {
        invalid('status is invalid')
    }
    if (!isNullableString(data.assigneeId) || !isNullableString(data.createdBy)) {
        invalid('assigneeId and createdBy must be strings, null, or absent')
    }
    if (data.metadata !== undefined && data.metadata !== null && (!isRecord(data.metadata) || !isJsonValue(data.metadata))) {
        invalid('metadata must be a JSON object, null, or absent')
    }

    return input as unknown as CreateTaskCommandV1
}
