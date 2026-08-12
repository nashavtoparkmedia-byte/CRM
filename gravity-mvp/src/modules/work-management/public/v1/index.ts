import { createCreateTaskHandlerV1 } from './create-task-handler'
import { createAssignTaskHandlerV1 } from './assign-task-handler'
import { createCompleteTaskHandlerV1 } from './complete-task-handler'
import { legacyPrismaTaskPortV1 } from './legacy-prisma-adapter'
import { legacyPrismaTaskAssignmentPortV1 } from './legacy-prisma-assignment-adapter'
import { legacyPrismaTaskCompletionPortV1 } from './legacy-prisma-completion-adapter'
import { createDetachContactTasksHandlerV1 } from './contact-retention-handler'
import { legacyPrismaContactTaskRetentionPortV1 } from './legacy-prisma-contact-retention-adapter'
import {
  createGetMergedScenarioFieldsHandlerV1,
  createResetScenarioFieldSettingHandlerV1,
  createUpsertScenarioFieldSettingHandlerV1,
} from './scenario-field-settings-handler'
import { legacyPrismaScenarioFieldSettingsPortV1 } from './legacy-prisma-scenario-field-settings-adapter'
import { CRM_USER_QUERY_V1 } from '../../../../contracts/identity-access/v1'
import { queryCrmUserV1 } from '../../../identity-access/public/v1'
import { createReassignTasksHandlerV1 } from './reassign-tasks-handler'

export { createCreateTaskHandlerV1 } from './create-task-handler'
export type { CreateTaskPersistencePortV1 } from './create-task-handler'
export { mapCreateTaskDataToLegacyRecordV1 } from './legacy-task-record'
export { createAssignTaskHandlerV1 } from './assign-task-handler'
export type { AssignTaskPersistencePortV1 } from './assign-task-handler'
export { createReassignTasksHandlerV1 } from './reassign-tasks-handler'
export type { ReassignTasksPortV1 } from './reassign-tasks-handler'
export { createCompleteTaskHandlerV1 } from './complete-task-handler'
export type { CompleteTaskPersistencePortV1 } from './complete-task-handler'

export const createTaskV1 = createCreateTaskHandlerV1(legacyPrismaTaskPortV1)
export const assignTaskV1 = createAssignTaskHandlerV1(legacyPrismaTaskAssignmentPortV1)
const reassignTasksV1 = createReassignTasksHandlerV1({
  async findTargetUser(userId) {
    const result = await queryCrmUserV1({ contract: CRM_USER_QUERY_V1, userId })
    return result.user
  },
  assign: legacyPrismaTaskAssignmentPortV1.assign,
})
export const taskReassignmentV1 = Object.freeze({
  reassignTasks: reassignTasksV1,
})
export const completeTaskV1 = createCompleteTaskHandlerV1(legacyPrismaTaskCompletionPortV1)
export { createDetachContactTasksHandlerV1 } from './contact-retention-handler'
export type { ContactTaskRetentionPersistencePortV1 } from './contact-retention-handler'
export const detachContactTasksV1 = createDetachContactTasksHandlerV1(legacyPrismaContactTaskRetentionPortV1)
export {
  createGetMergedScenarioFieldsHandlerV1,
  createResetScenarioFieldSettingHandlerV1,
  createUpsertScenarioFieldSettingHandlerV1,
} from './scenario-field-settings-handler'
export type { ScenarioFieldSettingsPersistencePortV1 } from './scenario-field-settings-handler'
export const getMergedScenarioFieldsV1 = createGetMergedScenarioFieldsHandlerV1(
  legacyPrismaScenarioFieldSettingsPortV1,
)
export const upsertScenarioFieldSettingV1 = createUpsertScenarioFieldSettingHandlerV1(
  legacyPrismaScenarioFieldSettingsPortV1,
)
export const resetScenarioFieldSettingV1 = createResetScenarioFieldSettingHandlerV1(
  legacyPrismaScenarioFieldSettingsPortV1,
)
