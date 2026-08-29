export const REASSIGN_TASKS_COMMAND_V1 = 'work_management.ReassignTasksCommand.v1' as const
export const REASSIGN_TASKS_RESULT_V1 = 'work_management.ReassignTasksResult.v1' as const

export interface ReassignTasksCommandV1 {
    contract: typeof REASSIGN_TASKS_COMMAND_V1
    taskIds: string[]
    newAssigneeId: string
}

export interface ReassignTasksResultV1 {
    contract: typeof REASSIGN_TASKS_RESULT_V1
    reassigned: number
}

export class ReassignTasksContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ReassignTasksContractValidationError['code'], message: string) {
        super(message)
        this.name = 'ReassignTasksContractValidationError'
        this.code = code
    }
}

function invalid(message: string): never {
    throw new ReassignTasksContractValidationError('INVALID_CONTRACT', message)
}

export function parseReassignTasksCommandV1(input: unknown): ReassignTasksCommandV1 {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        invalid('reassign tasks command must be an object')
    }

    const record = input as Record<string, unknown>
    const unexpected = Object.keys(record).filter((key) => (
        !['contract', 'taskIds', 'newAssigneeId'].includes(key)
    ))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)

    if (record.contract !== REASSIGN_TASKS_COMMAND_V1) {
        if (typeof record.contract === 'string' && record.contract.startsWith('work_management.ReassignTasksCommand.')) {
            throw new ReassignTasksContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${record.contract}`,
            )
        }
        invalid(`contract must equal ${REASSIGN_TASKS_COMMAND_V1}`)
    }

    if (!Array.isArray(record.taskIds) || record.taskIds.some((taskId) => (
        typeof taskId !== 'string' || taskId.trim() === ''
    ))) {
        invalid('taskIds must be an array of non-empty strings')
    }
    if (typeof record.newAssigneeId !== 'string' || record.newAssigneeId.trim() === '') {
        invalid('newAssigneeId must be a non-empty string')
    }

    return record as unknown as ReassignTasksCommandV1
}
