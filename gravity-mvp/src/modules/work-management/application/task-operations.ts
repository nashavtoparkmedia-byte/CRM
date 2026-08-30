import { createCreateTaskHandlerV1 } from '../public/v1/create-task-handler'
import { createCreateIdempotentTaskHandlerV1 } from '../public/v1/create-idempotent-task-handler'
import { createAssignTaskHandlerV1 } from '../public/v1/assign-task-handler'
import { createCompleteTaskHandlerV1 } from '../public/v1/complete-task-handler'
import { legacyPrismaTaskPortV1 } from '../public/v1/legacy-prisma-adapter'
import { legacyPrismaIdempotentTaskPortV1 } from '../public/v1/legacy-prisma-idempotent-task-adapter'
import { legacyPrismaTaskAssignmentPortV1 } from '../public/v1/legacy-prisma-assignment-adapter'
import { legacyPrismaTaskCompletionPortV1 } from '../public/v1/legacy-prisma-completion-adapter'
import { createDetachContactTasksHandlerV1 } from '../public/v1/contact-retention-handler'
import { legacyPrismaContactTaskRetentionPortV1 } from '../public/v1/legacy-prisma-contact-retention-adapter'
import {
    createGetMergedScenarioFieldsHandlerV1,
    createResetScenarioFieldSettingHandlerV1,
    createUpsertScenarioFieldSettingHandlerV1,
} from '../public/v1/scenario-field-settings-handler'
import { legacyPrismaScenarioFieldSettingsPortV1 } from '../public/v1/legacy-prisma-scenario-field-settings-adapter'
import { CRM_USER_QUERY_V1 } from '@/contracts/identity-access/v1'
import { queryCrmUserV1 } from '@/modules/identity-access/public/v1'
import { createReassignTasksHandlerV1 } from '../public/v1/reassign-tasks-handler'

const createTask = createCreateTaskHandlerV1(legacyPrismaTaskPortV1)
const createIdempotentTask = createCreateIdempotentTaskHandlerV1(legacyPrismaIdempotentTaskPortV1)
const assignTask = createAssignTaskHandlerV1(legacyPrismaTaskAssignmentPortV1)
const completeTask = createCompleteTaskHandlerV1(legacyPrismaTaskCompletionPortV1)
const detachContactTasks = createDetachContactTasksHandlerV1(legacyPrismaContactTaskRetentionPortV1)
const getMergedScenarioFields = createGetMergedScenarioFieldsHandlerV1(legacyPrismaScenarioFieldSettingsPortV1)
const upsertScenarioFieldSetting = createUpsertScenarioFieldSettingHandlerV1(legacyPrismaScenarioFieldSettingsPortV1)
const resetScenarioFieldSetting = createResetScenarioFieldSettingHandlerV1(legacyPrismaScenarioFieldSettingsPortV1)
const reassignTasks = createReassignTasksHandlerV1({
    async findTargetUser(userId) {
        const result = await queryCrmUserV1({ contract: CRM_USER_QUERY_V1, userId })
        return result.user
    },
    assign: legacyPrismaTaskAssignmentPortV1.assign,
})

export const createTaskV1 = (...args: Parameters<typeof createTask>) => createTask(...args)
export const createIdempotentTaskV1 = (...args: Parameters<typeof createIdempotentTask>) => createIdempotentTask(...args)
export const assignTaskV1 = (...args: Parameters<typeof assignTask>) => assignTask(...args)
export const completeTaskV1 = (...args: Parameters<typeof completeTask>) => completeTask(...args)
export const detachContactTasksV1 = (...args: Parameters<typeof detachContactTasks>) => detachContactTasks(...args)
export const getMergedScenarioFieldsV1 = (...args: Parameters<typeof getMergedScenarioFields>) => getMergedScenarioFields(...args)
export const upsertScenarioFieldSettingV1 = (...args: Parameters<typeof upsertScenarioFieldSetting>) => upsertScenarioFieldSetting(...args)
export const resetScenarioFieldSettingV1 = (...args: Parameters<typeof resetScenarioFieldSetting>) => resetScenarioFieldSetting(...args)
export async function reassignTasksV1(...args: Parameters<typeof reassignTasks>) {
  return reassignTasks(...args)
}
