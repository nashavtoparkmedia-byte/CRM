import { createCreateTaskHandlerV1 } from './create-task-handler'
import { legacyPrismaTaskPortV1 } from './legacy-prisma-adapter'

export { createCreateTaskHandlerV1 } from './create-task-handler'
export type { CreateTaskPersistencePortV1 } from './create-task-handler'
export { mapCreateTaskDataToLegacyRecordV1 } from './legacy-task-record'

export const createTaskV1 = createCreateTaskHandlerV1(legacyPrismaTaskPortV1)
