import { createCreateTaskHandlerV1 } from './create-task-handler'
import { createAssignTaskHandlerV1 } from './assign-task-handler'
import { createCompleteTaskHandlerV1 } from './complete-task-handler'
import { legacyPrismaTaskPortV1 } from './legacy-prisma-adapter'
import { legacyPrismaTaskAssignmentPortV1 } from './legacy-prisma-assignment-adapter'
import { legacyPrismaTaskCompletionPortV1 } from './legacy-prisma-completion-adapter'

export { createCreateTaskHandlerV1 } from './create-task-handler'
export type { CreateTaskPersistencePortV1 } from './create-task-handler'
export { mapCreateTaskDataToLegacyRecordV1 } from './legacy-task-record'
export { createAssignTaskHandlerV1 } from './assign-task-handler'
export type { AssignTaskPersistencePortV1 } from './assign-task-handler'
export { createCompleteTaskHandlerV1 } from './complete-task-handler'
export type { CompleteTaskPersistencePortV1 } from './complete-task-handler'

export const createTaskV1 = createCreateTaskHandlerV1(legacyPrismaTaskPortV1)
export const assignTaskV1 = createAssignTaskHandlerV1(legacyPrismaTaskAssignmentPortV1)
export const completeTaskV1 = createCompleteTaskHandlerV1(legacyPrismaTaskCompletionPortV1)
