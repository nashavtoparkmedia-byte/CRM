'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseBlock — renders ONE logical block of a case row.
//
// Layout policy by density:
//   compact      — inline row, no labels (column headers do that job)
//   standard     — inline row, tiny labels above each value
//   comfortable  — VERTICAL stack (label: value per line), all columns
//                  of the block stacked inside one block cell. This is
//                  the "Подробно" mode from the TЗ.
//
// Column sizing:
//   table mode  → fixed widthPx (Excel-like, h-scroll expected)
//   other modes → flex-grow from widthPx (row shrinks to viewport first)
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

    const isFixed = ctx.mode === 'table'
    const isDetailed = ctx.density === 'comfortable' && !isFixed

    // Detailed mode: stack vertical, one row per column (label: value).
    if (isDetailed) {
        const totalFlex = columns.reduce((s, c) => s + c.widthPx, 0)
        return (
            <div className="flex flex-col py-1 px-2 min-w-0"
                 style={{ flex: `${totalFlex} 1 0`, minWidth: '60px' }}>
                {showBlockLabel && (
                    <div className="text-[10px] uppercase tracking-wide text-[#94A3B8] font-semibold mb-0.5">
                        {block.label}
                    </div>
                )}
                {columns.map(col => (
                    <div key={col.id} className="flex items-baseline gap-1.5 min-w-0 text-[13px] leading-tight py-0.5">
                        <span className="text-[#64748B] truncate shrink-0" title={col.label}>
                            {col.labelShort ?? col.label}:
                        </span>
                        <span className="min-w-0 truncate flex items-center">
                            {renderCell(task, col, ctx)}
                        </span>
                    </div>
                ))}
            </div>
        )
    }

    // Inline row mode (compact / standard / table).
    return (
        <div className={`flex items-stretch ${isFixed ? 'shrink-0' : 'flex-1 min-w-0'}`}>
            {showBlockLabel && (
                <div className="flex items-center pr-2 pl-1 text-[10px] uppercase tracking-wide text-[#94A3B8] font-semibold whitespace-nowrap">
                    {block.label}
                </div>
            )}
            {columns.map((col, i) => {
                const cellStyle: React.CSSProperties = isFixed
                    ? { width: `${col.widthPx}px`, minWidth: `${col.widthPx}px` }
                    : { flex: `${col.widthPx} 1 0`, minWidth: '60px' }
                return (
                    <div
                        key={col.id}
                        className={`flex flex-col justify-center px-2 min-w-0 ${i > 0 ? 'border-l border-[#EEF2FF]' : ''}`}
                        style={cellStyle}
                    >
                        {showCellLabels && (
                            <div
                                className="text-[10px] uppercase tracking-wide text-[#94A3B8] leading-tight truncate"
                                title={col.label}
                            >
                                {col.labelShort ?? col.label}
                            </div>
                        )}
                        <div className="flex items-center min-w-0 leading-tight">
                            {renderCell(task, col, ctx)}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
