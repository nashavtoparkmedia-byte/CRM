import {
    ContractValidationError,
    CREATE_TASK_COMMAND_V1,
    parseCreateTaskCommandV1,
    type CreateTaskDataV1,
} from './create-task-command'

export const CREATE_IDEMPOTENT_TASK_COMMAND_V1 =
    'work_management.CreateIdempotentTaskCommand.v1' as const
export const CREATE_IDEMPOTENT_TASK_RESULT_V1 =
    'work_management.CreateIdempotentTaskResult.v1' as const

export interface CreateIdempotentTaskCommandV1 {
    contract: typeof CREATE_IDEMPOTENT_TASK_COMMAND_V1
    idempotencyKey: string
    data: CreateTaskDataV1
}

export interface CreateIdempotentTaskResultV1 {
    contract: typeof CREATE_IDEMPOTENT_TASK_RESULT_V1
    status: 'created' | 'replayed'
    task: {
        id: string
        title: string
    }
}

export class TaskIdempotencyConflictError extends Error {
    readonly code = 'TASK_IDEMPOTENCY_CONFLICT' as const

    constructor(message = 'idempotency key is already bound to a different task payload') {
        super(message)
        this.name = 'TaskIdempotencyConflictError'
    }
}

const COMMAND_FIELDS = new Set(['contract', 'idempotencyKey', 'data'])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCreateIdempotentTaskCommandV1(input: unknown): CreateIdempotentTaskCommandV1 {
    if (!isRecord(input)) throw new ContractValidationError('INVALID_CONTRACT', 'command must be an object')

    const unexpected = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (unexpected.length > 0) {
        throw new ContractValidationError(
            'INVALID_CONTRACT',
            `unsupported command field(s): ${unexpected.sort().join(', ')}`,
        )
    }

    if (input.contract !== CREATE_IDEMPOTENT_TASK_COMMAND_V1) {
        if (
            typeof input.contract === 'string'
            && input.contract.startsWith('work_management.CreateIdempotentTaskCommand.')
        ) {
            throw new ContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        throw new ContractValidationError(
            'INVALID_CONTRACT',
            `contract must equal ${CREATE_IDEMPOTENT_TASK_COMMAND_V1}`,
        )
    }

    if (
        typeof input.idempotencyKey !== 'string'
        || input.idempotencyKey.trim() === ''
        || input.idempotencyKey.length > 255
    ) {
        throw new ContractValidationError(
            'INVALID_CONTRACT',
            'idempotencyKey must be a non-empty string of at most 255 characters',
        )
    }

    const parsedData = parseCreateTaskCommandV1({
        contract: CREATE_TASK_COMMAND_V1,
        data: input.data,
    }).data

    return {
        contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1,
        idempotencyKey: input.idempotencyKey,
        data: parsedData,
    }
}
