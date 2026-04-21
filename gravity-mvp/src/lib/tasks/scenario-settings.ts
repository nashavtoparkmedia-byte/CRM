// ═══════════════════════════════════════════════════════════════════
// Scenario Settings — runtime overrides for ScenarioFieldDef
// Stored in table `scenario_field_settings`, merged with code defaults.
// ═══════════════════════════════════════════════════════════════════

import { prisma } from '@/lib/prisma'
import { getScenarioFields } from './scenario-config'
import type { ScenarioFieldDef } from './scenario-config'
import type { MergedFieldConfig, ScenarioFieldSettingPatch } from './scenario-settings-types'

export type { MergedFieldConfig, ScenarioFieldSettingPatch }
export { MAX_LIST_PREVIEW_FIELDS } from './scenario-settings-types'

export interface ScenarioFieldSetting {
    scenarioId: string
    fieldId: string
    showInList: boolean | null
    showInCard: boolean | null
    filterable: boolean | null
    sortable: boolean | null
    groupable: boolean | null
    order: number | null
    updatedAt: Date | null
    updatedBy: string | null
}

// ─── Read ─────────────────────────────────────────────────────────

export async function getScenarioFieldSettings(scenarioId: string): Promise<ScenarioFieldSetting[]> {
    const rows = await prisma.$queryRaw<ScenarioFieldSetting[]>`
        SELECT "scenarioId", "fieldId", "showInList", "showInCard", "filterable",
               "sortable", "groupable", "order", "updatedAt", "updatedBy"
        FROM scenario_field_settings
        WHERE "scenarioId" = ${scenarioId}
    `
    return rows
}

export async function getMergedFieldsForScenario(scenarioId: string): Promise<MergedFieldConfig[]> {
    const defaults = getScenarioFields(scenarioId)
    const overrides = await getScenarioFieldSettings(scenarioId)
    const overrideMap = new Map(overrides.map(o => [o.fieldId, o]))

    return defaults.map((def, index) => {
        const ov = overrideMap.get(def.id)
        return {
            ...def,
            showInList: ov?.showInList ?? def.showInList,
            showInCard: ov?.showInCard ?? def.showInCard,
            filterable: ov?.filterable ?? def.filterable,
            sortable: ov?.sortable ?? def.sortable ?? false,
            groupable: ov?.groupable ?? def.groupable ?? false,
            order: ov?.order ?? index,
            hasOverride: !!ov,
        }
    }).sort((a, b) => a.order - b.order)
}

// Synchronous batch: preload settings for multiple scenarios at once
export async function getAllScenarioSettingsMap(scenarioIds: string[]): Promise<Map<string, ScenarioFieldSetting[]>> {
    if (scenarioIds.length === 0) return new Map()
    const rows = await prisma.$queryRaw<ScenarioFieldSetting[]>`
        SELECT "scenarioId", "fieldId", "showInList", "showInCard", "filterable",
               "sortable", "groupable", "order", "updatedAt", "updatedBy"
        FROM scenario_field_settings
        WHERE "scenarioId" = ANY(${scenarioIds})
    `
    const map = new Map<string, ScenarioFieldSetting[]>()
    for (const row of rows) {
        if (!map.has(row.scenarioId)) map.set(row.scenarioId, [])
        map.get(row.scenarioId)!.push(row)
    }
    return map
}

export function mergeFieldsWithOverrides(
    scenarioId: string,
    overrides: ScenarioFieldSetting[],
): MergedFieldConfig[] {
    const defaults = getScenarioFields(scenarioId)
    const overrideMap = new Map(overrides.map(o => [o.fieldId, o]))
    return defaults.map((def, index) => {
        const ov = overrideMap.get(def.id)
        return {
            ...def,
            showInList: ov?.showInList ?? def.showInList,
            showInCard: ov?.showInCard ?? def.showInCard,
            filterable: ov?.filterable ?? def.filterable,
            sortable: ov?.sortable ?? def.sortable ?? false,
            groupable: ov?.groupable ?? def.groupable ?? false,
            order: ov?.order ?? index,
            hasOverride: !!ov,
        }
    }).sort((a, b) => a.order - b.order)
}

// ─── Write ────────────────────────────────────────────────────────

export async function upsertScenarioFieldSetting(
    scenarioId: string,
    fieldId: string,
    patch: ScenarioFieldSettingPatch,
    userId?: string | null,
): Promise<void> {
    const id = `${scenarioId}_${fieldId}`
    const nowIso = new Date().toISOString()
    // Use $executeRaw — upsert
    await prisma.$executeRaw`
        INSERT INTO scenario_field_settings (
            id, "scenarioId", "fieldId",
            "showInList", "showInCard", "filterable", "sortable", "groupable", "order",
            "updatedAt", "updatedBy"
        )
        VALUES (
            ${id}, ${scenarioId}, ${fieldId},
            ${patch.showInList ?? null}, ${patch.showInCard ?? null},
            ${patch.filterable ?? null}, ${patch.sortable ?? null},
            ${patch.groupable ?? null}, ${patch.order ?? null},
            ${nowIso}::timestamp, ${userId ?? null}
        )
        ON CONFLICT ("scenarioId", "fieldId") DO UPDATE SET
            "showInList" = COALESCE(EXCLUDED."showInList", scenario_field_settings."showInList"),
            "showInCard" = COALESCE(EXCLUDED."showInCard", scenario_field_settings."showInCard"),
            "filterable" = COALESCE(EXCLUDED."filterable", scenario_field_settings."filterable"),
            "sortable"   = COALESCE(EXCLUDED."sortable",   scenario_field_settings."sortable"),
            "groupable"  = COALESCE(EXCLUDED."groupable",  scenario_field_settings."groupable"),
            "order"      = COALESCE(EXCLUDED."order",      scenario_field_settings."order"),
            "updatedAt"  = EXCLUDED."updatedAt",
            "updatedBy"  = EXCLUDED."updatedBy"
    `
}

export async function resetScenarioFieldSetting(scenarioId: string, fieldId: string): Promise<void> {
    await prisma.$executeRaw`
        DELETE FROM scenario_field_settings
        WHERE "scenarioId" = ${scenarioId} AND "fieldId" = ${fieldId}
    `
}
