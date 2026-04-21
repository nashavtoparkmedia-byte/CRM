'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseBlock — renders ONE logical block of a case row.
// Composes column cells in order. Only visible columns are drawn.
//
// The block is a horizontally-laid flex container; each cell has its
// configured width. Comfortable density uses stacked label+value to
// be readable without a table header. Compact density omits labels
// (the table header supplies column names for compact/table mode).
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from '@/lib/tasks/types'
import type { ResolvedBlock } from '@/lib/tasks/list-schema'
import { renderCell, type RenderContext } from '@/lib/tasks/list-renderers'

interface TaskCaseBlockProps {
    task: TaskDTO
    block: ResolvedBlock
    ctx: RenderContext
    showBlockLabel?: boolean
    showCellLabels?: boolean
    /** Column ids to skip (e.g. fullName is rendered in the sticky zone). */
    excludeColumnIds?: string[]
}

export default function TaskCaseBlock({ task, block, ctx, showBlockLabel, showCellLabels, excludeColumnIds }: TaskCaseBlockProps) {
    const excluded = new Set(excludeColumnIds ?? [])
    const columns = block.visibleColumns.filter(c => !excluded.has(c.id))
    if (columns.length === 0) return null

    return (
        <div className="flex items-stretch shrink-0">
            {showBlockLabel && (
                <div className="flex items-center pr-2 pl-1 text-[10px] uppercase tracking-wide text-[#94A3B8] font-semibold whitespace-nowrap">
                    {block.label}
                </div>
            )}
            {columns.map((col, i) => (
                <div
                    key={col.id}
                    className={`flex flex-col justify-center px-2 min-w-0 ${i > 0 ? 'border-l border-[#EEF2FF]' : ''}`}
                    style={{ width: `${col.widthPx}px`, minWidth: `${col.widthPx}px` }}
                >
                    {showCellLabels && (
                        <div className="text-[10px] uppercase tracking-wide text-[#94A3B8] leading-tight truncate">
                            {col.labelShort ?? col.label}
                        </div>
                    )}
                    <div className="flex items-center min-w-0 leading-tight">
                        {renderCell(task, col, ctx)}
                    </div>
                </div>
            ))}
        </div>
    )
}
