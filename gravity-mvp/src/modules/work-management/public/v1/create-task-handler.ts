import {
    CREATE_TASK_RESULT_V1,
    parseCreateTaskCommandV1,
    type CreateTaskCommandV1,
    type CreateTaskDataV1,
    type CreateTaskResultV1,
} from '../../../../contracts/work-management/v1'

export interface CreateTaskPersistencePortV1 {
    create(data: CreateTaskDataV1): Promise<{ id: string; title: string }>
}

export function createCreateTaskHandlerV1(port: CreateTaskPersistencePortV1) {
    return async function createTaskV1(command: CreateTaskCommandV1 | unknown): Promise<CreateTaskResultV1> {
        const parsed = parseCreateTaskCommandV1(command)
        const task = await port.create(parsed.data)

        return {
            contract: CREATE_TASK_RESULT_V1,
            task: {
                id: task.id,
                title: task.title,
            },
        }
    }
}
