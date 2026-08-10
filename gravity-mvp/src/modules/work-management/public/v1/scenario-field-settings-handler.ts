import {
  GET_MERGED_SCENARIO_FIELDS_RESULT_V1,
  RESET_SCENARIO_FIELD_SETTING_RESULT_V1,
  UPSERT_SCENARIO_FIELD_SETTING_RESULT_V1,
  parseGetMergedScenarioFieldsQueryV1,
  parseResetScenarioFieldSettingCommandV1,
  parseUpsertScenarioFieldSettingCommandV1,
  type GetMergedScenarioFieldsQueryV1,
  type GetMergedScenarioFieldsResultV1,
  type MergedScenarioFieldV1,
  type ResetScenarioFieldSettingCommandV1,
  type ResetScenarioFieldSettingResultV1,
  type ScenarioFieldSettingPatchV1,
  type UpsertScenarioFieldSettingCommandV1,
  type UpsertScenarioFieldSettingResultV1,
} from '../../../../contracts/work-management/v1'

export interface ScenarioFieldSettingsPersistencePortV1 {
  getMerged(scenarioId: string): Promise<MergedScenarioFieldV1[]>
  upsert(input: {
    scenarioId: string
    fieldId: string
    patch: ScenarioFieldSettingPatchV1
    userId: string | null
  }): Promise<void>
  reset(scenarioId: string, fieldId: string): Promise<void>
}

export function createGetMergedScenarioFieldsHandlerV1(port: ScenarioFieldSettingsPersistencePortV1) {
  return async function getMergedScenarioFieldsV1(
    query: GetMergedScenarioFieldsQueryV1 | unknown,
  ): Promise<GetMergedScenarioFieldsResultV1> {
    const parsed = parseGetMergedScenarioFieldsQueryV1(query)
    const fields = await port.getMerged(parsed.scenarioId)
    return {
      contract: GET_MERGED_SCENARIO_FIELDS_RESULT_V1,
      fields,
    }
  }
}

export function createUpsertScenarioFieldSettingHandlerV1(port: ScenarioFieldSettingsPersistencePortV1) {
  return async function upsertScenarioFieldSettingV1(
    command: UpsertScenarioFieldSettingCommandV1 | unknown,
  ): Promise<UpsertScenarioFieldSettingResultV1> {
    const parsed = parseUpsertScenarioFieldSettingCommandV1(command)
    await port.upsert({
      scenarioId: parsed.scenarioId,
      fieldId: parsed.fieldId,
      patch: parsed.patch,
      userId: parsed.userId,
    })
    return {
      contract: UPSERT_SCENARIO_FIELD_SETTING_RESULT_V1,
      completed: true,
    }
  }
}

export function createResetScenarioFieldSettingHandlerV1(port: ScenarioFieldSettingsPersistencePortV1) {
  return async function resetScenarioFieldSettingV1(
    command: ResetScenarioFieldSettingCommandV1 | unknown,
  ): Promise<ResetScenarioFieldSettingResultV1> {
    const parsed = parseResetScenarioFieldSettingCommandV1(command)
    await port.reset(parsed.scenarioId, parsed.fieldId)
    return {
      contract: RESET_SCENARIO_FIELD_SETTING_RESULT_V1,
      completed: true,
    }
  }
}
