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

// Canonical blocks — schema C (matches the reference Excel template).
// Each block has a stable id, a user-facing label, and a background color
// that matches the Excel workbook exactly.
export const BLOCKS: BlockDef[] = [
    { id: 'identification',   label: 'Идентификация',     order: 1, color: '#F3F4F6' },
    { id: 'case_management',  label: 'Управление кейсом', order: 2, color: '#EDE9FE' },
    { id: 'driver_context',   label: 'Контекст водителя', order: 3, color: '#EAF2FF' },
    { id: 'manager_work',     label: 'Работа менеджера',  order: 4, color: '#FFF4CC' },
    { id: 'offer_rules',      label: 'Оффер и правила',   order: 5, color: '#E8F5E9' },
    { id: 'closing',          label: 'Закрытие',          order: 6, color: '#FDECEA' },
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
        block: 'case_management',
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
        block: 'case_management',
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
    // ── Block 4: Работа менеджера ──
    {
        id: 'churnReason',
        exportKey: 'churn_reason',
        block: 'manager_work',
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

    {
        id: 'returnProbability',
        exportKey: 'return_probability',
        block: 'case_management',
        label: 'Вероятность возврата',
        labelShort: 'Возврат',
        source: { kind: 'scenarioData', fieldId: 'returnProbability' },
        valueType: 'enum',
        defaultVisible: false,
        defaultOrder: 13,
        defaultWidthPx: 130,
        filterable: false,
        sortable: false,
        readonly: true,
    },
    {
        id: 'semanticStatus',
        exportKey: 'semantic_status',
        block: 'manager_work',
        label: 'Статус по смыслу',
        labelShort: 'Смысл',
        source: { kind: 'scenarioData', fieldId: 'semanticStatus' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 29,
        defaultWidthPx: 180,
        filterable: false,
        sortable: false,
    },
    {
        id: 'lastContactAt',
        exportKey: 'last_contact_at',
        block: 'manager_work',
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
        block: 'manager_work',
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
        block: 'manager_work',
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
        block: 'manager_work',
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

    {
        id: 'nextActionTitle',
        exportKey: 'next_action_title',
        block: 'manager_work',
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
        block: 'manager_work',
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
        block: 'manager_work',
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
        block: 'manager_work',
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
        block: 'manager_work',
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

    // ── Block 5: Оффер и правила ──
    {
        id: 'messageTemplate',
        exportKey: 'message_template',
        block: 'offer_rules',
        label: 'Что написать водителю',
        labelShort: 'Текст',
        source: { kind: 'scenarioData', fieldId: 'messageTemplate' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 49,
        defaultWidthPx: 300,
        filterable: false,
        sortable: false,
    },
    {
        id: 'offerType',
        exportKey: 'offer_type',
        block: 'offer_rules',
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
        block: 'offer_rules',
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
        block: 'offer_rules',
        label: 'Почему даём / не даём',
        labelShort: 'Причина',
        source: { kind: 'computed', id: 'offerReason' },
        valueType: 'string',
        // The TЗ explicitly asks the manager to see not only the verdict
        // but the rule that produced it, so this column is on by default.
        defaultVisible: true,
        defaultOrder: 52,
        defaultWidthPx: 220,
        filterable: false,
        sortable: false,
        readonly: true,
    },
    // ── Block 6: Закрытие ──
    {
        id: 'returnPriority',
        exportKey: 'return_priority',
        block: 'closing',
        label: 'Приоритет / статус возврата',
        labelShort: 'Приоритет',
        source: { kind: 'scenarioData', fieldId: 'returnPriority' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 55,
        defaultWidthPx: 180,
        filterable: false,
        sortable: false,
    },
    {
        id: 'contactResult',
        exportKey: 'contact_result',
        block: 'closing',
        label: 'Результат контакта',
        labelShort: 'Контакт',
        source: { kind: 'scenarioData', fieldId: 'contactResult' },
        valueType: 'string',
        defaultVisible: false,
        defaultOrder: 56,
        defaultWidthPx: 160,
        filterable: false,
        sortable: false,
    },
    {
        id: 'returnResult',
        exportKey: 'return_result',
        block: 'closing',
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
        block: 'closing',
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

    // Build ResolvedColumn[] with per-column overrides applied
    const columnLabels = overrides?.columnLabels ?? {}
    const columnBlock = overrides?.columnBlock ?? {}
    const resolved: ResolvedColumn[] = cols
        .map<ResolvedColumn>(c => ({
            ...c,
            // user-chosen block wins over the declarative one
            block: columnBlock[c.id] ?? c.block,
            // user-chosen label wins over the declarative one (exportKey unchanged)
            label: columnLabels[c.id] ?? c.label,
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

    // Block order: overrides.blockOrder > BLOCKS[].order
    const blockOrderIndex = new Map<string, number>()
    if (overrides?.blockOrder) {
        overrides.blockOrder.forEach((id, idx) => blockOrderIndex.set(id, idx))
    }
    const blockLabels = overrides?.blockLabels ?? {}

    const resolvedBlocks: ResolvedBlock[] = blocks
        .slice()
        .sort((a, b) => {
            const ai = blockOrderIndex.get(a.id) ?? (10000 + a.order)
            const bi = blockOrderIndex.get(b.id) ?? (10000 + b.order)
            return ai - bi
        })
        .map(b => {
            const columns = byBlock.get(b.id) ?? []
            return {
                ...b,
                label: blockLabels[b.id] ?? b.label,
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
