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

import { useState } from 'react'
import type { ResolvedLayout, ResolvedColumn } from '@/lib/tasks/list-schema'
import type { TaskSortField, TaskSortDirection } from '@/lib/tasks/types'
import { ChevronUp, ChevronDown, GripVertical, EyeOff } from 'lucide-react'
import { useListViewStore } from '@/store/list-view-store'
import { recordUsage } from '@/lib/tasks/usage'

const SORTABLE_IDS: Record<string, TaskSortField> = {
    fullName: 'fullName',
    stage: 'stage',
    priority: 'priority',
    lastContactAt: 'lastContactAt',
    nextActionAt: 'nextActionAt',
}

interface Props {
    layout: ResolvedLayout
    viewId: string
    sortField: TaskSortField | null
    sortDirection: TaskSortDirection
    onSortChange: (field: TaskSortField | null, direction: TaskSortDirection) => void
}

export default function TaskCaseListHeader({ layout, viewId, sortField, sortDirection, onSortChange }: Props) {
    const setBlockOrder = useListViewStore(s => s.setBlockOrder)
    const setColumnVisibility = useListViewStore(s => s.setColumnVisibility)
    const [dragBlockId, setDragBlockId] = useState<string | null>(null)
    const [hoverBlockId, setHoverBlockId] = useState<string | null>(null)

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

    const handleBlockDrop = (targetBlockId: string) => {
        if (!dragBlockId || dragBlockId === targetBlockId) {
            setDragBlockId(null); setHoverBlockId(null); return
        }
        const ids = layout.blocks.map(b => b.id)
        const from = ids.indexOf(dragBlockId)
        const to = ids.indexOf(targetBlockId)
        if (from === -1 || to === -1) return
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        setBlockOrder(viewId, next)
        void recordUsage('block_reorder', { viewId, dragId: dragBlockId, targetBlockId, via: 'inline-table' })
        setDragBlockId(null); setHoverBlockId(null)
    }

    const hideColumn = (columnId: string) => {
        setColumnVisibility(viewId, columnId, false)
        void recordUsage('column_toggle', { viewId, columnId, visible: false, via: 'inline' })
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
                {/* Spacer under the sticky ФИО column — identification color, no label.
                    The identification block's other columns (licenseNumber, phone…)
                    get their own labelled band below. */}
                <div className="flex items-center shrink-0 pr-3 bg-[#F3F4F6]"
                     style={{ borderRight: '1px solid #E2E8F0' }}>
                    <div className="w-[3px] self-stretch shrink-0 bg-transparent" />
                    <div className="pl-2" style={{ width: '220px' }} />
                </div>

                {/* One draggable cell per block, width = sum of block.visibleColumns.widthPx */}
                <div className="flex items-stretch flex-1 min-w-0">
                    {blocksWithCols.map(block => {
                        if (block.excludedCols.length === 0) return null
                        const totalWidth = block.excludedCols.reduce((sum, c) => sum + c.widthPx, 0)
                        const isDragging = dragBlockId === block.id
                        const isDropTarget = hoverBlockId === block.id && dragBlockId !== null && dragBlockId !== block.id
                        return (
                            <div
                                key={block.id}
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = 'move'
                                    setDragBlockId(block.id)
                                }}
                                onDragOver={(e) => {
                                    if (!dragBlockId) return
                                    e.preventDefault()
                                    setHoverBlockId(block.id)
                                }}
                                onDrop={(e) => { e.preventDefault(); handleBlockDrop(block.id) }}
                                onDragEnd={() => { setDragBlockId(null); setHoverBlockId(null) }}
                                className={`group flex items-center justify-center gap-1 px-2 text-[11px] uppercase tracking-wide text-[#334155] font-semibold border-l border-[#E2E8F0] cursor-grab select-none transition-all ${
                                    isDragging ? 'opacity-40' : ''
                                } ${isDropTarget ? 'ring-2 ring-inset ring-[#4338CA]' : ''}`}
                                style={{
                                    width: `${totalWidth}px`,
                                    minWidth: `${totalWidth}px`,
                                    backgroundColor: block.color ?? '#F3F4F6',
                                }}
                                title={`${block.label} — потяни, чтобы изменить порядок блоков`}
                            >
                                <GripVertical className="w-3 h-3 text-[#94A3B8] opacity-40 group-hover:opacity-100 transition-opacity shrink-0" />
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
                                    className={`group flex items-center px-2 ${i > 0 ? 'border-l border-[#E2E8F0]' : 'border-l border-[#CBD5E1]'}`}
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
                                    <button
                                        onClick={(e) => { e.stopPropagation(); hideColumn(col.id) }}
                                        className="ml-auto p-0.5 opacity-0 group-hover:opacity-100 text-[#94A3B8] hover:text-[#DC2626] transition-opacity shrink-0"
                                        title="Скрыть колонку"
                                    >
                                        <EyeOff className="w-3 h-3" />
                                    </button>
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
