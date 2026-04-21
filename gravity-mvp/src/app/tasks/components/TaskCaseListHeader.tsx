'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseListHeader — column labels row for table mode.
//
// MVP sortable fields: fullName, stage, priority, lastContactAt, nextActionAt.
// Click on a sortable header cycles direction: off → desc → asc → off.
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

    return (
        <div className="flex items-stretch w-full border-b border-[#CBD5E1] bg-[#F8FAFC] sticky top-0 z-20 text-[11px] uppercase tracking-wide text-[#475569] font-semibold min-h-[32px]">
            {/* Left zone — mirrors TaskCaseRow left width (3 + 220 + padding).
                Not horizontally sticky to keep scroll cheap (see TaskCaseRow note). */}
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

            {/* Block columns (skip fullName — it lives in the sticky zone) */}
            <div className="flex items-stretch flex-1 min-w-0">
                {layout.blocks.map(block =>
                    block.visibleColumns
                        .filter(c => c.id !== 'fullName')
                        .map((col, i) => {
                            const isSortable = !!SORTABLE_IDS[col.id]
                            const field = SORTABLE_IDS[col.id]
                            const active = field && sortField === field
                            return (
                                <div
                                    key={col.id}
                                    className={`flex items-center px-2 ${i > 0 ? 'border-l border-[#E2E8F0]' : ''}`}
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
