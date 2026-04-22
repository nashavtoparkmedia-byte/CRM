// ═══════════════════════════════════════════════════════════════════
// List Schema — canonical display model for Tasks → List
// Independent from ScenarioFieldDef (which describes scenarioData storage).
// One ListColumnDef per visible list column, regardless of value origin.
// ═══════════════════════════════════════════════════════════════════

// ─── Value source ────────────────────────────────────────────────────

export type ListColumnSource =
    | { kind: 'task'; field: string }              // task.status, task.priority, task.title, task.nextActionAt, ...
    | { kind: 'driver'; field: string }            // driver.fullName, driver.phone
    | { kind: 'scenarioData'; fieldId: string }    // scenarioData[fieldId].value
    | { kind: 'derived'; id: string }              // computed once at DTO build (e.g. lastContactType)
    | { kind: 'computed'; id: string }             // computed at render time (e.g. isOverdue)

export type ListColumnType =
    | 'string'
    | 'number'
    | 'enum'
    | 'date'
    | 'boolean'
    | 'badge'      // stage / status / priority rendered as chip
    | 'semaphore'  // yes/no/maybe with colored dot

// ─── Column definition ───────────────────────────────────────────────

export interface ListColumnDef {
    id: string                  // stable identifier used across code
    exportKey: string           // stable snake_case for Excel headers — NEVER change
    block: string               // BlockDef.id
    label: string               // full label (column settings, tooltips, exports)
    labelShort?: string         // compact label for row / header in table mode
    source: ListColumnSource
    valueType: ListColumnType
    defaultVisible: boolean
    defaultOrder: number
    defaultWidthPx: number
    filterable: boolean
    sortable: boolean
    readonly?: boolean          // derived/computed/auto values (user cannot edit in list)
    description?: string        // tooltip text for column settings
}

// ─── Block definition ────────────────────────────────────────────────

export interface BlockDef {
    id: string
    label: string
    order: number
    /** Background color for the block header — matches the Excel template. */
    color?: string
}

// ─── View definition ─────────────────────────────────────────────────

export type ListViewMode = 'operational' | 'control' | 'table'
export type ListRowDensity = 'compact' | 'standard' | 'comfortable'
export type ListGrouping = 'stage' | 'control_signal' | 'none'

/** Pixel height per density — single source of truth. */
export const ROW_DENSITY_PX: Record<ListRowDensity, number> = {
    compact: 32,
    standard: 48,
    comfortable: 64,
}

export interface ListViewDef {
    id: string
    label: string
    scenario: string
    mode: ListViewMode
    rowDensity: ListRowDensity
    grouping: ListGrouping
    /** If provided — overrides defaultVisible for each column. */
    visibleColumnIds?: string[]
    /** If true — ignores defaultVisible, shows every column of the scenario. */
    showAllColumns?: boolean
    /** If provided — overrides defaultOrder. */
    columnOrder?: string[]
    /** Hard-pinned filters baked into the view (e.g. for Control). */
    pinnedFilters?: Record<string, unknown>
    isSystem: boolean
}

// ─── User-level overrides (persisted in localStorage on MVP) ─────────

export interface ListViewOverrides {
    /** Per-column visibility override. If unset for a column → view default applies. */
    columnVisibility?: Record<string, boolean>
    /** Explicit column order (partial allowed: missing ids keep their default order after listed ones). */
    columnOrder?: string[]
    /** Per-column width in px (overrides ListColumnDef.defaultWidthPx). */
    columnWidths?: Record<string, number>
    /** Per-column label override (UI only; exportKey stays stable). */
    columnLabels?: Record<string, string>
    /** Per-column block assignment (lets the user move a column between blocks). */
    columnBlock?: Record<string, string>
    /** Explicit block order (partial allowed). */
    blockOrder?: string[]
    /** Per-block label override. */
    blockLabels?: Record<string, string>
    /** User-level density override. If unset → view.rowDensity applies. */
    rowDensity?: ListRowDensity
}

// ─── Runtime resolved shapes (consumed by renderers) ─────────────────

export interface ResolvedColumn extends ListColumnDef {
    visible: boolean
    widthPx: number
    order: number
}

export interface ResolvedBlock extends BlockDef {
    columns: ResolvedColumn[]          // ALL columns of this block, ordered
    visibleColumns: ResolvedColumn[]   // only visible ones, ordered
}

export interface ResolvedLayout {
    view: ListViewDef
    blocks: ResolvedBlock[]
}
