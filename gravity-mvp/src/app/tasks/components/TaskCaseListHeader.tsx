'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseListHeader — two-row column header (Excel-style):
//   • row 1 — coloured block headers spanning their columns
//   • row 2 — column headers, sortable by click
//
// Row 1 mirrors the reference Excel template: 6 blocks, same colors,
// merged across the columns that belong to each block.
//
// MVP sortable fields on row 2: fullName, stage, priority, lastContactAt,
// nextActionAt. Click cycles: off → desc → asc → off.
// ═══════════════════════════════════════════════════════════════════

import type { ResolvedLayout, ResolvedColumn } from '@/lib/tasks/list-schema'
import type { TaskSortField, TaskSortDirection } from '@/lib/tasks/types'
import { ChevronUp, ChevronDown } from 'lucide-react'

const SORTABLE_IDS: Record<string, TaskSortField> = {
    fullName: 'fullName',
    stage: 'stage',
    priority: 'priority',
    lastContactAt: 'lastContactAt',
    nextActionAt: 'nextActionAt',
}

interface Props {
    layout: ResolvedLayout
    sortField: TaskSortField | null
    sortDirection: TaskSortDirection
    onSortChange: (field: TaskSortField | null, direction: TaskSortDirection) => void
}

export default function TaskCaseListHeader({ layout, sortField, sortDirection, onSortChange }: Props) {
    const cycleSort = (field: TaskSortField) => {
        if (sortField !== field) onSortChange(field, 'desc')
        else if (sortDirection === 'desc') onSortChange(field, 'asc')
        else onSortChange(null, 'desc')
    }

    const handleClick = (col: ResolvedColumn) => {
        const field = SORTABLE_IDS[col.id]
        if (!field) return
        cycleSort(field)
    }

    // Identification block owns fullName but fullName lives in the
    // sticky left zone, not inside the block row. So for block-header
    // row we count non-fullName columns, and for column-header row we
    // skip fullName too (it's already in the sticky zone).
    const blocksWithCols = layout.blocks.map(b => ({
        ...b,
        excludedCols: b.visibleColumns.filter(c => c.id !== 'fullName'),
    }))

    return (
        <div className="sticky top-0 z-20 bg-white border-b border-[#CBD5E1]">
            {/* Row 1 — coloured block headers */}
            <div className="flex items-stretch w-full min-h-[28px] border-b border-[#E2E8F0]">
                {/* Sticky-zone spacer for ФИО column */}
                <div className="flex items-center shrink-0 pr-3 bg-[#F3F4F6]"
                     style={{ borderRight: '1px solid #E2E8F0' }}>
                    <div className="w-[3px] self-stretch shrink-0 bg-transparent" />
                    <div className="flex items-center pl-2 text-[11px] uppercase tracking-wide text-[#475569] font-semibold"
                         style={{ width: '220px' }}>
                        Идентификация
                    </div>
                </div>

                {/* One cell per block, width = sum of block.visibleColumns.widthPx */}
                <div className="flex items-stretch flex-1 min-w-0">
                    {blocksWithCols.map(block => {
                        if (block.excludedCols.length === 0) return null
                        const totalWidth = block.excludedCols.reduce((sum, c) => sum + c.widthPx, 0)
                        return (
                            <div
                                key={block.id}
                                className="flex items-center justify-center px-2 text-[11px] uppercase tracking-wide text-[#334155] font-semibold border-l border-[#E2E8F0]"
                                style={{
                                    width: `${totalWidth}px`,
                                    minWidth: `${totalWidth}px`,
                                    backgroundColor: block.color ?? '#F3F4F6',
                                }}
                                title={block.label}
                            >
                                <span className="truncate">{block.label}</span>
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* Row 2 — column headers */}
            <div className="flex items-stretch w-full min-h-[32px] text-[11px] uppercase tracking-wide text-[#475569] font-semibold bg-[#F8FAFC]">
                <div className="flex items-center shrink-0 pr-3 bg-[#F8FAFC]">
                    <div className="w-[3px] self-stretch shrink-0 bg-transparent" />
                    <div className="flex items-center pl-2" style={{ width: '220px' }}>
                        <HeaderButton
                            label="ФИО"
                            sortable
                            active={sortField === 'fullName'}
                            direction={sortDirection}
                            onClick={() => cycleSort('fullName')}
                        />
                    </div>
                </div>

                <div className="flex items-stretch flex-1 min-w-0">
                    {blocksWithCols.map(block =>
                        block.excludedCols.map((col, i) => {
                            const isSortable = !!SORTABLE_IDS[col.id]
                            const field = SORTABLE_IDS[col.id]
                            const active = field && sortField === field
                            return (
                                <div
                                    key={col.id}
                                    className={`flex items-center px-2 ${i > 0 ? 'border-l border-[#E2E8F0]' : 'border-l border-[#CBD5E1]'}`}
                                    style={{ width: `${col.widthPx}px`, minWidth: `${col.widthPx}px` }}
                                >
                                    <HeaderButton
                                        label={col.labelShort ?? col.label}
                                        fullLabel={col.label}
                                        sortable={isSortable}
                                        active={!!active}
                                        direction={sortDirection}
                                        onClick={() => handleClick(col)}
                                    />
                                </div>
                            )
                        })
                    )}
                </div>
            </div>
        </div>
    )
}

function HeaderButton({
    label, fullLabel, sortable, active, direction, onClick,
}: {
    label: string
    fullLabel?: string
    sortable: boolean
    active: boolean
    direction: TaskSortDirection
    onClick: () => void
}) {
    if (!sortable) {
        return <span className="truncate" title={fullLabel}>{label}</span>
    }
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-0.5 min-w-0 hover:text-[#0F172A] transition-colors ${active ? 'text-[#0F172A]' : ''}`}
            title={fullLabel}
        >
            <span className="truncate">{label}</span>
            {active && (
                direction === 'asc'
                    ? <ChevronUp className="w-3 h-3 shrink-0" />
                    : <ChevronDown className="w-3 h-3 shrink-0" />
            )}
        </button>
    )
}
