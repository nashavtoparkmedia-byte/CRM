// Pure types and constants for scenario settings (safe to import in client & server)

import type { ScenarioFieldDef } from './scenario-config'

export const MAX_LIST_PREVIEW_FIELDS = 8

export interface MergedFieldConfig extends ScenarioFieldDef {
    order: number
    hasOverride: boolean
}

export interface ScenarioFieldSettingPatch {
    showInList?: boolean
    showInCard?: boolean
    filterable?: boolean
    sortable?: boolean
    groupable?: boolean
    order?: number
}
