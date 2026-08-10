import { getMergedFieldsForScenario } from '@/lib/tasks/scenario-settings'
import { resetScenarioFieldSettingV1, upsertScenarioFieldSettingV1 } from '@/modules/configuration/public/v1'
import type { ScenarioFieldSettingsPersistencePortV1 } from './scenario-field-settings-handler'

export const legacyPrismaScenarioFieldSettingsPortV1: ScenarioFieldSettingsPersistencePortV1 = {
  async getMerged(scenarioId) {
    return getMergedFieldsForScenario(scenarioId)
  },

  async upsert(input) {
    await upsertScenarioFieldSettingV1(input)
  },

  async reset(scenarioId, fieldId) {
    await resetScenarioFieldSettingV1(scenarioId, fieldId)
  },
}
