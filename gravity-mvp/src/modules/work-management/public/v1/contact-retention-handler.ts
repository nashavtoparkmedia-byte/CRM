import {
  DETACH_CONTACT_TASKS_RESULT_V1,
  parseDetachContactTasksCommandV1,
  type DetachContactTasksCommandV1,
  type DetachContactTasksResultV1,
} from '../../../../contracts/work-management/v1'

export interface ContactTaskRetentionPersistencePortV1 {
  detachContactTasks(contactId: string): Promise<void>
}

export function createDetachContactTasksHandlerV1(port: ContactTaskRetentionPersistencePortV1) {
  return async function detachContactTasksV1(
    command: DetachContactTasksCommandV1 | unknown,
  ): Promise<DetachContactTasksResultV1> {
    const parsed = parseDetachContactTasksCommandV1(command)
    await port.detachContactTasks(parsed.contactId)
    return {
      contract: DETACH_CONTACT_TASKS_RESULT_V1,
      completed: true,
    }
  }
}
