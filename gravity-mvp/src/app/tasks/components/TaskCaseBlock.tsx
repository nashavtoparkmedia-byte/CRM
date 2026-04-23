'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseBlock — renders ONE logical block of a case row.
//
// The parent TaskCaseRow owns a CSS Grid whose columns match the header
// (TaskCaseBlockHeader / TaskCaseListHeader) track-for-track. Each block
// renders as a grid child that spans `block.visibleColumns.length`
// tracks, so bands/labels/values line up pixel-for-pixel with no drift.
//
// Layout policy by density:
//   compact      — one grid cell per column, inline value only
//   standard     — one grid cell per column, tiny label above value
//   comfortable  — ONE cell spans the block's tracks, vertical "label:
//                  value" stack inside. This is the "Подробно" mode.
//
// Column sizing:
//   table mode  → fixed widthPx (the header uses `width: Npx` too)
//   other modes → grid track with `fr` weight from widthPx
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

    // Detailed mode — ONE grid cell spanning all columns of the block.
    // Vertical "label: value" lines inside.
    if (isDetailed) {
        return (
            <div
                className="flex flex-col py-1 px-2 min-w-0 border-l border-[#EEF2FF]"
                style={{ gridColumn: `span ${columns.length}` }}
            >
                {showBlockLabel && (
                    <div className="text-[10px] uppercase tracking-wide text-[#94A3B8] font-semibold mb-0.5">
                        {block.label}
                    </div>
                )}
                {columns.map(col => (
                    <div
                        key={col.id}
                        className="grid items-baseline gap-1.5 min-w-0 text-[13px] leading-tight py-0.5"
                        style={{ gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.1fr)' }}
                    >
                        <span className="text-[#64748B] truncate text-right" title={col.label}>
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

    // Inline mode — each column is its own grid cell (span 1). For the
    // fixed (table) mode we use explicit pixel widths, for flex modes
    // the parent grid's fr tracks drive the width.
    return (
        <>
            {columns.map((col, i) => {
                const cellStyle: React.CSSProperties = isFixed
                    ? { width: `${col.widthPx}px`, minWidth: `${col.widthPx}px` }
                    : { gridColumn: 'span 1', minWidth: 0 }
                // Mark the first column of a block with a stronger divider
                // so blocks stay visually separated even without a header band.
                const isBlockStart = i === 0
                return (
                    <div
                        key={col.id}
                        className={`flex flex-col justify-center px-2 min-w-0 ${
                            isBlockStart ? 'border-l border-[#EEF2FF]' : 'border-l border-[#F1F5F9]'
                        }`}
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
        </>
    )
}
