export const COMPLETE_TASK_COMMAND_V1 = 'work_management.CompleteTaskCommand.v1' as const
export const COMPLETE_TASK_RESULT_V1 = 'work_management.CompleteTaskResult.v1' as const

export type TaskCompletionOutcomeV1 = 'done' | 'skipped'

export interface CompleteTaskCommandV1 {
    contract: typeof COMPLETE_TASK_COMMAND_V1
    taskId: string
    outcome: TaskCompletionOutcomeV1
    resolvedBy: string
}

export interface CompleteTaskResultV1 {
    contract: typeof COMPLETE_TASK_RESULT_V1
    taskId: string
    status: TaskCompletionOutcomeV1
}

export class CompleteTaskContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: CompleteTaskContractValidationError['code'], message: string) {
        super(message)
        this.name = 'CompleteTaskContractValidationError'
        this.code = code
    }
}

const COMMAND_FIELDS = new Set(['contract', 'taskId', 'outcome', 'resolvedBy'])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
    throw new CompleteTaskContractValidationError('INVALID_CONTRACT', message)
}

export function parseCompleteTaskCommandV1(input: unknown): CompleteTaskCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')

    const unexpected = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)

    if (input.contract !== COMPLETE_TASK_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('work_management.CompleteTaskCommand.')) {
            throw new CompleteTaskContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${COMPLETE_TASK_COMMAND_V1}`)
    }
    if (typeof input.taskId !== 'string' || input.taskId.trim() === '') invalid('taskId is required')
    if (input.outcome !== 'done' && input.outcome !== 'skipped') invalid('outcome must be done or skipped')
    if (typeof input.resolvedBy !== 'string' || input.resolvedBy.trim() === '') invalid('resolvedBy is required')

    return input as unknown as CompleteTaskCommandV1
}
