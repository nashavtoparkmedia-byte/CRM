import {
    ASSIGN_TASK_RESULT_V1,
    parseAssignTaskCommandV1,
    type AssignTaskCommandV1,
    type AssignTaskResultV1,
    type AssignTaskStatusV1,
} from '../../../../contracts/work-management/v1'

export interface AssignTaskPersistencePortV1 {
    assign(input: {
        taskId: string
        assigneeId: string
        assigneeName: string
    }): Promise<AssignTaskStatusV1>
}

export function createAssignTaskHandlerV1(port: AssignTaskPersistencePortV1) {
    return async function assignTaskV1(command: AssignTaskCommandV1 | unknown): Promise<AssignTaskResultV1> {
        const parsed = parseAssignTaskCommandV1(command)
        const status = await port.assign({
            taskId: parsed.taskId,
            assigneeId: parsed.assigneeId,
            assigneeName: parsed.assigneeName,
        })

        return {
            contract: ASSIGN_TASK_RESULT_V1,
            status,
        }
    }
}
