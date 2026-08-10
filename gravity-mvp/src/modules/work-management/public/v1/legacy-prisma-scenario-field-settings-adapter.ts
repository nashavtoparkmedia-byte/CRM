import { prisma } from '@/lib/prisma'
import { getMergedFieldsForScenario } from '@/lib/tasks/scenario-settings'
import type { ScenarioFieldSettingsPersistencePortV1 } from './scenario-field-settings-handler'

const UPSERT_SCENARIO_FIELD_SETTING_SQL = `
INSERT INTO scenario_field_settings (
  id, "scenarioId", "fieldId",
  "showInList", "showInCard", "filterable", "sortable", "groupable", "order",
  "updatedAt", "updatedBy"
)
VALUES (
  $1, $2, $3,
  $4, $5, $6, $7, $8, $9,
  $10::timestamp, $11
)
ON CONFLICT ("scenarioId", "fieldId") DO UPDATE SET
  "showInList" = COALESCE(EXCLUDED."showInList", scenario_field_settings."showInList"),
  "showInCard" = COALESCE(EXCLUDED."showInCard", scenario_field_settings."showInCard"),
  "filterable" = COALESCE(EXCLUDED."filterable", scenario_field_settings."filterable"),
  "sortable"   = COALESCE(EXCLUDED."sortable",   scenario_field_settings."sortable"),
  "groupable"  = COALESCE(EXCLUDED."groupable",  scenario_field_settings."groupable"),
  "order"      = COALESCE(EXCLUDED."order",      scenario_field_settings."order"),
  "updatedAt"  = EXCLUDED."updatedAt",
  "updatedBy"  = EXCLUDED."updatedBy"`

const RESET_SCENARIO_FIELD_SETTING_SQL = `
DELETE FROM scenario_field_settings
WHERE "scenarioId" = $1 AND "fieldId" = $2`

export const legacyPrismaScenarioFieldSettingsPortV1: ScenarioFieldSettingsPersistencePortV1 = {
  async getMerged(scenarioId) {
    return getMergedFieldsForScenario(scenarioId)
  },

  async upsert(input) {
    const id = `${input.scenarioId}_${input.fieldId}`
    const nowIso = new Date().toISOString()
    await prisma.$executeRawUnsafe(
      UPSERT_SCENARIO_FIELD_SETTING_SQL,
      id,
      input.scenarioId,
      input.fieldId,
      input.patch.showInList ?? null,
      input.patch.showInCard ?? null,
      input.patch.filterable ?? null,
      input.patch.sortable ?? null,
      input.patch.groupable ?? null,
      input.patch.order ?? null,
      nowIso,
      input.userId ?? null,
    )
  },

  async reset(scenarioId, fieldId) {
    await prisma.$executeRawUnsafe(RESET_SCENARIO_FIELD_SETTING_SQL, scenarioId, fieldId)
  },
}
