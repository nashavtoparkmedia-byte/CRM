// ═══════════════════════════════════════════════════════════════════
// List Views — system presets for Tasks → List.
// MVP: 3 system views per scenario (operational / control / table).
// User-level presets are NOT in MVP; overrides live in list-view-store
// (localStorage-persisted) as ListViewOverrides.
// ═══════════════════════════════════════════════════════════════════

import type { ListViewDef } from './list-schema'

// ─── Churn view columns ──────────────────────────────────────────────
// Key operational set — what the manager must see on every row.
// Mirrors TЗ §6.

const CHURN_OPERATIONAL_COLUMNS = [
    // Block 1 — Identification
    'fullName',
    'licenseNumber',
    // Block 2 — Case management
    'project',
    'assignee',
    'stage',
    // Block 3 — Driver context
    'yandexActive',
    'externalParkName',
    'isSelfEmployed',
    'yandexTripsCount',
    // Block 4 — Manager work
    'churnReason',
    'lastContactResult',
    'nextActionTitle',
    'nextActionAt',
    // Block 5 — Offer rules (per TЗ §11 — verdict + rule side by side)
    'offerAllowed',
    'offerReason',
    'offerType',
]

// Control = operational + a bit more context for the head-of-ops to spot stuck cases.
const CHURN_CONTROL_COLUMNS = [
    ...CHURN_OPERATIONAL_COLUMNS,
    'lastContactAt',
    'lastContactType',
    'priority',
]

// ─── System Views ────────────────────────────────────────────────────

export const SYSTEM_VIEWS: ListViewDef[] = [
    {
        id: 'churn_operational',
        label: 'Операционный',
        scenario: 'churn',
        mode: 'operational',
        rowDensity: 'comfortable',
        grouping: 'stage',
        visibleColumnIds: CHURN_OPERATIONAL_COLUMNS,
        isSystem: true,
    },
    {
        id: 'churn_control',
        label: 'Контроль',
        scenario: 'churn',
        mode: 'control',
        rowDensity: 'comfortable',
        grouping: 'control_signal',
        visibleColumnIds: CHURN_CONTROL_COLUMNS,
        isSystem: true,
    },
    {
        id: 'churn_table',
        label: 'Таблица',
        scenario: 'churn',
        mode: 'table',
        rowDensity: 'compact',
        grouping: 'none',
        showAllColumns: true,
        isSystem: true,
    },
]

export function getSystemViews(scenario: string): ListViewDef[] {
    return SYSTEM_VIEWS.filter(v => v.scenario === scenario)
}

export function getSystemView(viewId: string): ListViewDef | undefined {
    return SYSTEM_VIEWS.find(v => v.id === viewId)
}

export function getDefaultViewId(scenario: string): string {
    const op = SYSTEM_VIEWS.find(v => v.scenario === scenario && v.mode === 'operational')
    return op?.id ?? SYSTEM_VIEWS[0]?.id ?? 'churn_operational'
}
