'use server'

import {
    getMergedFieldsForScenario,
    upsertScenarioFieldSetting,
    resetScenarioFieldSetting,
} from '@/lib/tasks/scenario-settings'
import type { MergedFieldConfig, ScenarioFieldSettingPatch } from '@/lib/tasks/scenario-settings-types'

export async function getScenarioFieldsConfig(scenarioId: string): Promise<MergedFieldConfig[]> {
    return getMergedFieldsForScenario(scenarioId)
}

export async function updateScenarioFieldSetting(
    scenarioId: string,
    fieldId: string,
    patch: ScenarioFieldSettingPatch,
): Promise<void> {
    const { cookies } = await import('next/headers')
    const store = await cookies()
    const userId = store.get('crm_user_id')?.value || null
    await upsertScenarioFieldSetting(scenarioId, fieldId, patch, userId)
}

export async function reorderScenarioField(
    scenarioId: string,
    fieldId: string,
    newOrder: number,
): Promise<void> {
    const { cookies } = await import('next/headers')
    const store = await cookies()
    const userId = store.get('crm_user_id')?.value || null
    await upsertScenarioFieldSetting(scenarioId, fieldId, { order: newOrder }, userId)
}

export async function resetScenarioField(scenarioId: string, fieldId: string): Promise<void> {
    await resetScenarioFieldSetting(scenarioId, fieldId)
}
