export const ASSIGN_TASK_COMMAND_V1 = 'work_management.AssignTaskCommand.v1' as const
export const ASSIGN_TASK_RESULT_V1 = 'work_management.AssignTaskResult.v1' as const

export type AssignTaskStatusV1 = 'reassigned' | 'not_found' | 'unchanged'

export interface AssignTaskCommandV1 {
    contract: typeof ASSIGN_TASK_COMMAND_V1
    taskId: string
    assigneeId: string
    assigneeName: string
}

export interface AssignTaskResultV1 {
    contract: typeof ASSIGN_TASK_RESULT_V1
    status: AssignTaskStatusV1
}

export class AssignTaskContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: AssignTaskContractValidationError['code'], message: string) {
        super(message)
        this.name = 'AssignTaskContractValidationError'
        this.code = code
    }
}

const COMMAND_FIELDS = new Set(['contract', 'taskId', 'assigneeId', 'assigneeName'])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
    throw new AssignTaskContractValidationError('INVALID_CONTRACT', message)
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') invalid(`${field} is required`)
}

export function parseAssignTaskCommandV1(input: unknown): AssignTaskCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')

    const unexpected = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)

    if (input.contract !== ASSIGN_TASK_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('work_management.AssignTaskCommand.')) {
            throw new AssignTaskContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${ASSIGN_TASK_COMMAND_V1}`)
    }

    requireNonEmptyString(input.taskId, 'taskId')
    requireNonEmptyString(input.assigneeId, 'assigneeId')
    requireNonEmptyString(input.assigneeName, 'assigneeName')

    return input as unknown as AssignTaskCommandV1
}
