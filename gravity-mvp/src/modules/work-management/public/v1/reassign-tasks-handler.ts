import {
    REASSIGN_TASKS_RESULT_V1,
    parseReassignTasksCommandV1,
    type AssignTaskStatusV1,
    type ReassignTasksCommandV1,
    type ReassignTasksResultV1,
} from '../../../../contracts/work-management/v1'

export interface ReassignTasksPortV1 {
    findTargetUser(userId: string): Promise<{ id: string; name: string } | null>
    assign(input: {
        taskId: string
        assigneeId: string
        assigneeName: string
    }): Promise<AssignTaskStatusV1>
}

export function createReassignTasksHandlerV1(port: ReassignTasksPortV1) {
    return async function reassignTasksV1(
        command: ReassignTasksCommandV1 | unknown,
    ): Promise<ReassignTasksResultV1> {
        const parsed = parseReassignTasksCommandV1(command)
        if (parsed.taskIds.length === 0) {
            return { contract: REASSIGN_TASKS_RESULT_V1, reassigned: 0 }
        }

        const targetUser = await port.findTargetUser(parsed.newAssigneeId)
        if (!targetUser) throw new Error('Target user not found')

        let reassigned = 0
        for (const taskId of parsed.taskIds) {
            const status = await port.assign({
                taskId,
                assigneeId: parsed.newAssigneeId,
                assigneeName: targetUser.name,
            })
            if (status === 'reassigned') reassigned++
        }

        return { contract: REASSIGN_TASKS_RESULT_V1, reassigned }
    }
}
