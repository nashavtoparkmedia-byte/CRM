'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseBlockHeader — two-row sticky column header for the Case list
// in Operational / Control modes.
//
//   Row 1 — coloured block bands. Draggable: drop one band onto another
//           to reorder blocks. ИДЕНТИФИКАЦИЯ band spans ФИО + ВУ +
//           Телефон, because ФИО IS an identification column.
//   Row 2 — column labels (ФИО | ВУ | ТЕЛЕФОН | ПРОЕКТ | …). Draggable:
//           drop one chip onto another to reorder. Cross-block drop also
//           reassigns the column's block. Hover reveals an EyeOff button
//           to hide the column inline.
//
// The whole header is ONE CSS grid: first track = 235px ФИО column,
// remaining tracks are fr-weighted per visible column. Both rows use
// the exact same column tracks so bands/chips/data cells align
// pixel-for-pixel with no drift.
// ═══════════════════════════════════════════════════════════════════

import { useMemo, useState } from 'react'
import { GripVertical, EyeOff } from 'lucide-react'
import type { ResolvedLayout, ResolvedColumn } from '@/lib/tasks/list-schema'
import { useListViewStore } from '@/store/list-view-store'
import { recordUsage } from '@/lib/tasks/usage'

interface Props {
    layout: ResolvedLayout
    viewId: string
}

/** Width of the sticky ФИО track. Keep in sync with TaskCaseRow. */
export const FULLNAME_COL_WIDTH_PX = 235

export default function TaskCaseBlockHeader({ layout, viewId }: Props) {
    const setBlockOrder = useListViewStore(s => s.setBlockOrder)
    const setColumnOrder = useListViewStore(s => s.setColumnOrder)
    const setColumnBlock = useListViewStore(s => s.setColumnBlock)
    const setColumnVisibility = useListViewStore(s => s.setColumnVisibility)

    const [dragBlockId, setDragBlockId] = useState<string | null>(null)
    const [hoverBlockId, setHoverBlockId] = useState<string | null>(null)
    const [dragColId, setDragColId] = useState<string | null>(null)
    const [hoverColId, setHoverColId] = useState<string | null>(null)

    // Non-fullName visible columns (the ones that get their own grid tracks
    // besides the fixed 235px ФИО first track).
    const blocksWithCols = useMemo(() => layout.blocks.map(b => ({
        ...b,
        excludedCols: b.visibleColumns.filter(c => c.id !== 'fullName'),
    })), [layout.blocks])

    // Global ordered list (ФИО first, then all other visible columns).
    // Used to compute grid columns + as the DnD reorder target list.
    const otherCols = useMemo(() => {
        const out: ResolvedColumn[] = []
        for (const b of blocksWithCols) out.push(...b.excludedCols)
        return out
    }, [blocksWithCols])

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
        void recordUsage('block_reorder', { viewId, dragId: dragBlockId, targetBlockId, via: 'inline' })
        setDragBlockId(null); setHoverBlockId(null)
    }

    const handleColumnDrop = (targetColId: string) => {
        if (!dragColId || dragColId === targetColId) {
            setDragColId(null); setHoverColId(null); return
        }
        const ids = otherCols.map(c => c.id)
        const from = ids.indexOf(dragColId)
        const to = ids.indexOf(targetColId)
        if (from === -1 || to === -1) { setDragColId(null); setHoverColId(null); return }

        const dragCol = otherCols[from]
        const targetCol = otherCols[to]
        if (dragCol.block !== targetCol.block) {
            setColumnBlock(viewId, dragColId, targetCol.block)
        }
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        setColumnOrder(viewId, next)
        void recordUsage('column_reorder', { viewId, dragId: dragColId, targetColId, via: 'inline-band' })
        setDragColId(null); setHoverColId(null)
    }

    const hideColumn = (columnId: string) => {
        setColumnVisibility(viewId, columnId, false)
        void recordUsage('column_toggle', { viewId, columnId, visible: false, via: 'inline-band' })
    }

    // Grid: first track = 235px (ФИО), rest = fr-weighted per col.widthPx.
    // Same string is consumed by TaskCaseRow so rows align pixel-perfect.
    const gridTemplate = `${FULLNAME_COL_WIDTH_PX}px ${
        otherCols.length > 0
            ? otherCols.map(c => `minmax(0, ${c.widthPx}fr)`).join(' ')
            : ''
    }`

    // Column index (1-based) for each column id — used to place row-2 chips.
    const colIndexById = new Map<string, number>()
    otherCols.forEach((c, i) => colIndexById.set(c.id, i + 2)) // +1 for 1-based, +1 for ФИО first track

    return (
        <div className="sticky top-0 z-20 bg-white border-b border-[#E2E8F0]">
            <div
                className="grid w-full"
                style={{ gridTemplateColumns: gridTemplate, gridAutoRows: 'min-content' }}
            >
                {/* ─── Row 1 — coloured block bands ───────────────────
                    ИДЕНТИФИКАЦИЯ starts at column 1 (ФИО) so the band
                    visually covers ФИО + ВУ + Телефон + …  The other
                    bands start from column 2 or later. */}
                {blocksWithCols.map(block => {
                    const isIdentification = block.id === 'identification'
                    const spanCols = isIdentification
                        ? 1 + block.excludedCols.length   // ФИО + other identif. cols
                        : block.excludedCols.length
                    if (spanCols === 0) return null

                    // Start column: identification always at 1. Others at
                    // the index of their first visible column.
                    let startCol: number
                    if (isIdentification) {
                        startCol = 1
                    } else {
                        const firstCol = block.excludedCols[0]
                        startCol = firstCol ? (colIndexById.get(firstCol.id) ?? 2) : 2
                    }

                    const isDragging = dragBlockId === block.id
                    const isDropTarget = hoverBlockId === block.id && dragBlockId !== null && dragBlockId !== block.id
                    return (
                        <div
                            key={`band-${block.id}`}
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move'
                                e.dataTransfer.setData('text/x-drag-kind', 'block')
                                setDragBlockId(block.id)
                            }}
                            onDragOver={(e) => {
                                if (!dragBlockId) return
                                e.preventDefault()
                                setHoverBlockId(block.id)
                            }}
                            onDrop={(e) => { e.preventDefault(); handleBlockDrop(block.id) }}
                            onDragEnd={() => { setDragBlockId(null); setHoverBlockId(null) }}
                            className={`group flex items-center justify-center gap-1 px-2 min-w-0 min-h-[28px] text-[11px] uppercase tracking-wide text-[#334155] font-semibold border-b border-[#E2E8F0] cursor-grab select-none transition-all ${
                                isIdentification ? '' : 'border-l'
                            } ${isDragging ? 'opacity-40' : ''} ${
                                isDropTarget ? 'ring-2 ring-inset ring-[#4338CA]' : ''
                            }`}
                            style={{
                                gridRow: 1,
                                gridColumn: `${startCol} / span ${spanCols}`,
                                backgroundColor: block.color ?? '#F3F4F6',
                            }}
                            title={`${block.label} — потяни, чтобы изменить порядок блоков`}
                        >
                            <GripVertical className="w-3 h-3 text-[#94A3B8] opacity-40 group-hover:opacity-100 transition-opacity shrink-0" />
                            <span className="truncate">{block.label}</span>
                        </div>
                    )
                })}

                {/* ─── Row 2 — ФИО + per-column chips ───────────────── */}
                <div
                    className="flex items-center px-3 min-h-[26px] bg-[#F8FAFC] text-[10px] uppercase tracking-wide text-[#64748B] font-semibold"
                    style={{ gridRow: 2, gridColumn: '1 / span 1' }}
                >
                    <span className="truncate">ФИО</span>
                </div>

                {otherCols.map((col) => {
                    const isDragging = dragColId === col.id
                    const isDropTarget = hoverColId === col.id && dragColId !== null && dragColId !== col.id
                    const gridCol = colIndexById.get(col.id) ?? 2
                    return (
                        <div
                            key={`chip-${col.id}`}
                            draggable
                            onDragStart={(e) => {
                                e.stopPropagation()
                                e.dataTransfer.effectAllowed = 'move'
                                e.dataTransfer.setData('text/x-drag-kind', 'column')
                                setDragColId(col.id)
                            }}
                            onDragOver={(e) => {
                                if (!dragColId) return
                                e.preventDefault()
                                setHoverColId(col.id)
                            }}
                            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleColumnDrop(col.id) }}
                            onDragEnd={() => { setDragColId(null); setHoverColId(null) }}
                            className={`group flex items-center gap-1 px-2 min-w-0 min-h-[26px] text-[10px] uppercase tracking-wide text-[#64748B] font-semibold bg-[#F8FAFC] border-l border-[#E2E8F0] cursor-grab select-none transition-all ${
                                isDragging ? 'opacity-40' : ''
                            } ${isDropTarget ? 'ring-2 ring-inset ring-[#4338CA]' : ''}`}
                            style={{ gridRow: 2, gridColumn: `${gridCol} / span 1` }}
                            title={`${col.label} — потяни, чтобы изменить порядок колонок`}
                        >
                            <span className="truncate">{col.labelShort ?? col.label}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); hideColumn(col.id) }}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="ml-auto p-0.5 opacity-0 group-hover:opacity-100 text-[#94A3B8] hover:text-[#DC2626] transition-opacity shrink-0"
                                title="Скрыть колонку"
                                draggable={false}
                            >
                                <EyeOff className="w-3 h-3" />
                            </button>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

