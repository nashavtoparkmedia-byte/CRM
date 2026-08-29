'use server'

import {
    GET_MERGED_SCENARIO_FIELDS_QUERY_V1,
    RESET_SCENARIO_FIELD_SETTING_COMMAND_V1,
    UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
    type MergedScenarioFieldV1,
    type ScenarioFieldSettingPatchV1,
} from '@/contracts/work-management/v1'
import {
    getMergedScenarioFieldsV1,
    resetScenarioFieldSettingV1,
    upsertScenarioFieldSettingV1,
} from '@/modules/work-management/public/v1'

export async function getScenarioFieldsConfig(scenarioId: string): Promise<MergedScenarioFieldV1[]> {
    const result = await getMergedScenarioFieldsV1({
        contract: GET_MERGED_SCENARIO_FIELDS_QUERY_V1,
        scenarioId,
    })
    return result.fields
}

export async function updateScenarioFieldSetting(
    scenarioId: string,
    fieldId: string,
    patch: ScenarioFieldSettingPatchV1,
): Promise<void> {
    const { cookies } = await import('next/headers')
    const store = await cookies()
    const userId = store.get('crm_user_id')?.value || null
    await upsertScenarioFieldSettingV1({
        contract: UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
        scenarioId,
        fieldId,
        patch,
        userId,
    })
}

export async function reorderScenarioField(
    scenarioId: string,
    fieldId: string,
    newOrder: number,
): Promise<void> {
    const { cookies } = await import('next/headers')
    const store = await cookies()
    const userId = store.get('crm_user_id')?.value || null
    await upsertScenarioFieldSettingV1({
        contract: UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
        scenarioId,
        fieldId,
        patch: { order: newOrder },
        userId,
    })
}

export async function resetScenarioField(scenarioId: string, fieldId: string): Promise<void> {
    await resetScenarioFieldSettingV1({
        contract: RESET_SCENARIO_FIELD_SETTING_COMMAND_V1,
        scenarioId,
        fieldId,
    })
}
