import {
    COMPLETE_TASK_RESULT_V1,
    parseCompleteTaskCommandV1,
    type CompleteTaskCommandV1,
    type CompleteTaskResultV1,
    type TaskCompletionOutcomeV1,
} from '../../../../contracts/work-management/v1'

export interface CompleteTaskPersistencePortV1 {
    complete(input: {
        taskId: string
        outcome: TaskCompletionOutcomeV1
        resolvedBy: string
    }): Promise<void>
}

export function createCompleteTaskHandlerV1(port: CompleteTaskPersistencePortV1) {
    return async function completeTaskV1(command: CompleteTaskCommandV1 | unknown): Promise<CompleteTaskResultV1> {
        const parsed = parseCompleteTaskCommandV1(command)
        await port.complete({
            taskId: parsed.taskId,
            outcome: parsed.outcome,
            resolvedBy: parsed.resolvedBy,
        })

        return {
            contract: COMPLETE_TASK_RESULT_V1,
            taskId: parsed.taskId,
            status: parsed.outcome,
        }
    }
}
