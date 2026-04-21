// ═══════════════════════════════════════════════════════════════════
// List Columns — declarative blocks & columns per scenario.
// Single source of truth for what can appear in Tasks → List.
//
// NB: exportKey values are a contract. DO NOT change once data is in
// the wild — they will be used for Excel import/export on next stage.
// ═══════════════════════════════════════════════════════════════════

import type {
    BlockDef,
    ListColumnDef,
    ListViewDef,
    ListViewOverrides,
    ResolvedBlock,
    ResolvedColumn,
    ResolvedLayout,
} from './list-schema'

// ─── Blocks ──────────────────────────────────────────────────────────

export const BLOCKS: BlockDef[] = [
    { id: 'identification',    label: 'Идентификация',        order: 1 },
    { id: 'case_management',   label: 'Управление кейсом',    order: 2 },
    { id: 'driver_context',    label: 'Контекст водителя',    order: 3 },
    { id: 'last_contact',      label: 'Последний контакт',    order: 4 },
    { id: 'next_action',       label: 'Следующее действие',   order: 5 },
    { id: 'return_management', label: 'Управление возвратом', order: 6 },
]

// ─── Churn columns ───────────────────────────────────────────────────

export const CHURN_COLUMNS: ListColumnDef[] = [
    // ── Block 1: Идентификация ──
    {
        id: 'fullName',
        exportKey: 'full_name',
        block: 'identification',
        label: 'ФИО водителя',
        labelShort: 'ФИО',
        source: { kind: 'driver', field: 'fullName' },
        valueType: 'string',
        defaultVisible: true,
        defaultOrder: 1,
        defaultWidthPx: 200,
        filterable: false,
        sortable: true,
    },
    {
        id: 'licenseNumber',
        exportKey: 'license_number',
        block: 'identification',
        label: 'Номер ВУ',
        labelShort: 'ВУ',
        source: { kind: 'scenarioData', fieldId: 'licenseNumber' },
        valueType: 'string',
        defaultVisible: true,
        defaultOrder: 2,
        defaultWidthPx: 130,
        filterable: false,
        sortable: false,
    },
    {
        id: 'phone',
        exportKey: 'phone',
        block: 'identification',
        label: 'Телефон',
        source: { kind: 'driver', field: 'phone' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 3,
        defaultWidthPx: 140,
        filterable: false,
        sortable: false,
    },
    {
        id: 'project',
        exportKey: 'project',
        block: 'identification',
        label: 'Проект',
        source: { kind: 'computed', id: 'projectPlaceholder' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 4,
        defaultWidthPx: 110,
        filterable: false, // MVP: no driver.projectId migration yet
        sortable: false,
        readonly: true,
        description: 'Отдельное поле «Проект» появится после миграции Driver.projectId',
    },
    {
        id: 'assignee',
        exportKey: 'assignee',
        block: 'identification',
        label: 'Менеджер',
        source: { kind: 'derived', id: 'assigneeName' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 5,
        defaultWidthPx: 140,
        filterable: true,
        sortable: true,
    },

    // ── Block 2: Управление кейсом ──
    {
        id: 'stage',
        exportKey: 'stage',
        block: 'case_management',
        label: 'Этап воронки',
        labelShort: 'Этап',
        source: { kind: 'task', field: 'stage' },
        valueType: 'badge',
        defaultVisible: true,
        defaultOrder: 10,
        defaultWidthPx: 160,
        filterable: true,
        sortable: true,
    },
    {
        id: 'status',
        exportKey: 'status',
        block: 'case_management',
        label: 'Статус',
        source: { kind: 'task', field: 'status' },
        valueType: 'badge',
        defaultVisible: false,
        defaultOrder: 11,
        defaultWidthPx: 130,
        filterable: true,
        sortable: false,
    },
    {
        id: 'priority',
        exportKey: 'priority',
        block: 'case_management',
        label: 'Приоритет',
        source: { kind: 'task', field: 'priority' },
        valueType: 'badge',
        defaultVisible: false, // priority-stripe always visible in the sticky zone
        defaultOrder: 12,
        defaultWidthPx: 110,
        filterable: true,
        sortable: true,
    },

    // ── Block 3: Контекст водителя ──
    {
        id: 'yandexActive',
        exportKey: 'yandex_active',
        block: 'driver_context',
        label: 'Катает в Яндекс?',
        labelShort: 'Яндекс',
        source: { kind: 'scenarioData', fieldId: 'yandexActive' },
        valueType: 'enum',
        defaultVisible: true,
        defaultOrder: 20,
        defaultWidthPx: 100,
        filterable: true,
        sortable: true,
        readonly: true,
    },
    {
        id: 'externalParkName',
        exportKey: 'external_park_name',
        block: 'driver_context',
        label: 'Какой парк?',
        labelShort: 'Парк',
        source: { kind: 'scenarioData', fieldId: 'externalParkName' },
        valueType: 'string',
        defaultVisible: true,
        defaultOrder: 21,
        defaultWidthPx: 140,
        filterable: true,
        sortable: true,
        readonly: true,
    },
    {
        id: 'isSelfEmployed',
        exportKey: 'is_self_employed',
        block: 'driver_context',
        label: 'Есть СМЗ?',
        labelShort: 'СМЗ',
        source: { kind: 'scenarioData', fieldId: 'isSelfEmployed' },
        valueType: 'enum',
        defaultVisible: true,
        defaultOrder: 22,
        defaultWidthPx: 90,
        filterable: true,
        sortable: true,
    },
    {
        id: 'yandexTripsCount',
        exportKey: 'yandex_trips_count',
        block: 'driver_context',
        label: 'Сколько поездок в среднем по данным Яндекс',
        labelShort: 'Поездки',
        source: { kind: 'scenarioData', fieldId: 'yandexTripsCount' },
        valueType: 'number',
        defaultVisible: true,
        defaultOrder: 23,
        defaultWidthPx: 110,
        filterable: true,
        sortable: true,
        readonly: true,
    },
    {
        id: 'inactiveDays',
        exportKey: 'inactive_days',
        block: 'driver_context',
        label: 'Дней без активности',
        labelShort: 'Дней',
        source: { kind: 'scenarioData', fieldId: 'inactiveDays' },
        valueType: 'number',
        defaultVisible: false,
        defaultOrder: 24,
        defaultWidthPx: 100,
        filterable: true,
        sortable: true,
        readonly: true,
    },
    {
        id: 'churnReason',
        exportKey: 'churn_reason',
        block: 'driver_context',
        label: 'Причина оттока',
        labelShort: 'Причина',
        source: { kind: 'scenarioData', fieldId: 'churnReason' },
        valueType: 'enum',
        defaultVisible: true,
        defaultOrder: 25,
        defaultWidthPx: 140,
        filterable: true,
        sortable: false,
    },

    // ── Block 4: Последний контакт ──
    {
        id: 'lastContactAt',
        exportKey: 'last_contact_at',
        block: 'last_contact',
        label: 'Дата последнего контакта',
        labelShort: 'Дата',
        source: { kind: 'derived', id: 'lastContactAt' },
        valueType: 'date',
        defaultVisible: false,
        defaultOrder: 30,
        defaultWidthPx: 120,
        filterable: true,
        sortable: true,
        readonly: true,
    },
    {
        id: 'lastContactType',
        exportKey: 'last_contact_type',
        block: 'last_contact',
        label: 'Тип контакта',
        labelShort: 'Тип',
        source: { kind: 'derived', id: 'lastContactType' },
        valueType: 'enum',
        defaultVisible: false,
        defaultOrder: 31,
        defaultWidthPx: 100,
        filterable: true,
        sortable: false,
        readonly: true,
    },
    {
        id: 'lastContactResult',
        exportKey: 'last_contact_result',
        block: 'last_contact',
        label: 'Результат последнего контакта',
        labelShort: 'Результат',
        source: { kind: 'derived', id: 'lastContactResult' },
        valueType: 'enum',
        defaultVisible: true,
        defaultOrder: 32,
        defaultWidthPx: 160,
        filterable: true,
        sortable: false,
        readonly: true,
    },
    {
        id: 'lastContactBy',
        exportKey: 'last_contact_by',
        block: 'last_contact',
        label: 'Кто контактировал',
        labelShort: 'Кто',
        source: { kind: 'derived', id: 'lastContactBy' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 33,
        defaultWidthPx: 130,
        filterable: false,
        sortable: false,
        readonly: true,
    },

    // ── Block 5: Следующее действие ──
    {
        id: 'nextActionTitle',
        exportKey: 'next_action_title',
        block: 'next_action',
        label: 'Что сделать',
        labelShort: 'Действие',
        source: { kind: 'task', field: 'title' },
        valueType: 'string',
        defaultVisible: true,
        defaultOrder: 40,
        defaultWidthPx: 200,
        filterable: false,
        sortable: false,
    },
    {
        id: 'nextActionChannel',
        exportKey: 'next_action_channel',
        block: 'next_action',
        label: 'Канал',
        source: { kind: 'task', field: 'type' },
        valueType: 'enum',
        defaultVisible: false,
        defaultOrder: 41,
        defaultWidthPx: 110,
        filterable: true,
        sortable: false,
    },
    {
        id: 'nextActionAt',
        exportKey: 'next_action_at',
        block: 'next_action',
        label: 'Дедлайн',
        source: { kind: 'task', field: 'nextActionAt' },
        valueType: 'date',
        defaultVisible: true,
        defaultOrder: 42,
        defaultWidthPx: 120,
        filterable: true,
        sortable: true,
    },
    {
        id: 'mandatoryContact',
        exportKey: 'mandatory_contact',
        block: 'next_action',
        label: 'Обязательный контакт',
        labelShort: 'Обязат.',
        source: { kind: 'computed', id: 'mandatoryContact' },
        valueType: 'boolean',
        defaultVisible: false,
        defaultOrder: 43,
        defaultWidthPx: 90,
        filterable: false,
        sortable: false,
        readonly: true,
    },
    {
        id: 'isOverdue',
        exportKey: 'is_overdue',
        block: 'next_action',
        label: 'Просрочено',
        labelShort: 'Проср.',
        source: { kind: 'computed', id: 'isOverdue' },
        valueType: 'boolean',
        defaultVisible: false,
        defaultOrder: 44,
        defaultWidthPx: 90,
        filterable: true,
        sortable: false,
        readonly: true,
    },

    // ── Block 6: Управление возвратом ──
    {
        id: 'offerType',
        exportKey: 'offer_type',
        block: 'return_management',
        label: 'Оффер',
        source: { kind: 'scenarioData', fieldId: 'offerType' },
        valueType: 'string',
        defaultVisible: true,
        defaultOrder: 50,
        defaultWidthPx: 140,
        filterable: true,
        sortable: false,
    },
    {
        id: 'offerAllowed',
        exportKey: 'offer_allowed',
        block: 'return_management',
        label: 'Можно давать акцию?',
        labelShort: 'Акция',
        source: { kind: 'computed', id: 'offerAllowed' },
        valueType: 'semaphore',
        defaultVisible: true,
        defaultOrder: 51,
        defaultWidthPx: 150,
        filterable: true,
        sortable: false,
        readonly: true,
    },
    {
        id: 'offerReason',
        exportKey: 'offer_reason',
        block: 'return_management',
        label: 'Почему даём / не даём',
        labelShort: 'Причина акции',
        source: { kind: 'computed', id: 'offerReason' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 52,
        defaultWidthPx: 200,
        filterable: false,
        sortable: false,
        readonly: true,
    },
    {
        id: 'returnResult',
        exportKey: 'return_result',
        block: 'return_management',
        label: 'Результат возврата',
        labelShort: 'Итог',
        source: { kind: 'task', field: 'closedReason' },
        valueType: 'enum',
        defaultVisible: false,
        defaultOrder: 53,
        defaultWidthPx: 140,
        filterable: true,
        sortable: false,
    },
    {
        id: 'closedAt',
        exportKey: 'closed_at',
        block: 'return_management',
        label: 'Дата закрытия',
        labelShort: 'Закрыт',
        source: { kind: 'task', field: 'resolvedAt' },
        valueType: 'date',
        defaultVisible: false,
        defaultOrder: 54,
        defaultWidthPx: 120,
        filterable: false,
        sortable: true,
    },
]

// ─── Lookups ─────────────────────────────────────────────────────────

export function getColumns(scenarioId: string): ListColumnDef[] {
    if (scenarioId === 'churn') return CHURN_COLUMNS
    return []
}

export function getBlocks(): BlockDef[] {
    return BLOCKS
}

export function findColumn(scenarioId: string, columnId: string): ListColumnDef | undefined {
    return getColumns(scenarioId).find(c => c.id === columnId)
}

// ─── Layout resolver ─────────────────────────────────────────────────

/**
 * Compose a ResolvedLayout from a view + user overrides.
 *
 * Precedence for visibility (per column):
 *   overrides.columnVisibility[id] if set → wins
 *   else view.showAllColumns        → true
 *   else view.visibleColumnIds      → membership
 *   else col.defaultVisible
 *
 * Precedence for order:
 *   overrides.columnOrder > view.columnOrder > col.defaultOrder
 *   (missing ids retain default order after listed ones)
 *
 * Precedence for width:
 *   overrides.columnWidths[id] > col.defaultWidthPx
 */
export function resolveLayout(
    view: ListViewDef,
    overrides?: ListViewOverrides,
): ResolvedLayout {
    const cols = getColumns(view.scenario)
    const blocks = getBlocks()

    // View-level visibility baseline
    let viewVisibleSet: Set<string>
    if (view.showAllColumns) {
        viewVisibleSet = new Set(cols.map(c => c.id))
    } else if (view.visibleColumnIds) {
        viewVisibleSet = new Set(view.visibleColumnIds)
    } else {
        viewVisibleSet = new Set(cols.filter(c => c.defaultVisible).map(c => c.id))
    }
    const userVisibility = overrides?.columnVisibility ?? {}

    function resolveVisible(id: string): boolean {
        const user = userVisibility[id]
        if (user !== undefined) return user
        return viewVisibleSet.has(id)
    }

    // Order: overrides.columnOrder > view.columnOrder > defaults
    const orderSource = overrides?.columnOrder ?? view.columnOrder ?? null
    const orderIndex = new Map<string, number>()
    if (orderSource) {
        orderSource.forEach((id, idx) => orderIndex.set(id, idx))
    }

    // Build ResolvedColumn[]
    const resolved: ResolvedColumn[] = cols
        .map<ResolvedColumn>(c => ({
            ...c,
            visible: resolveVisible(c.id),
            widthPx: overrides?.columnWidths?.[c.id] ?? c.defaultWidthPx,
            order: orderIndex.get(c.id) ?? c.defaultOrder,
        }))
        .sort((a, b) => a.order - b.order)

    // Group by block
    const byBlock = new Map<string, ResolvedColumn[]>()
    for (const c of resolved) {
        const list = byBlock.get(c.block) ?? []
        list.push(c)
        byBlock.set(c.block, list)
    }

    const resolvedBlocks: ResolvedBlock[] = blocks
        .slice()
        .sort((a, b) => a.order - b.order)
        .map(b => {
            const columns = byBlock.get(b.id) ?? []
            return {
                ...b,
                columns,
                visibleColumns: columns.filter(c => c.visible),
            }
        })

    // Apply density override as if it was baked into the view, so consumers
    // read layout.view.rowDensity without needing to know about overrides.
    const effectiveView: ListViewDef = overrides?.rowDensity
        ? { ...view, rowDensity: overrides.rowDensity }
        : view

    return { view: effectiveView, blocks: resolvedBlocks }
}
