'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseBlockHeader — single sticky row with colored block labels,
// shown above the list in Operational / Control modes.
//
// Block bands are drag-and-drop — grab a colored band and drop it on
// another band to reorder blocks right from the list (no popup needed).
// ═══════════════════════════════════════════════════════════════════

import { useState } from 'react'
import { GripVertical, EyeOff } from 'lucide-react'
import type { ResolvedLayout } from '@/lib/tasks/list-schema'
import { useListViewStore } from '@/store/list-view-store'
import { recordUsage } from '@/lib/tasks/usage'

interface Props {
    layout: ResolvedLayout
    viewId: string
}

export default function TaskCaseBlockHeader({ layout, viewId }: Props) {
    const setBlockOrder = useListViewStore(s => s.setBlockOrder)
    const setColumnVisibility = useListViewStore(s => s.setColumnVisibility)
    const [dragId, setDragId] = useState<string | null>(null)
    const [hoverId, setHoverId] = useState<string | null>(null)

    // Identification's fullName already lives in the sticky ФИО zone.
    // If the identification block has no other visible columns, we don't
    // need to render a second "Идентификация" band in the flex area.
    const blocksWithCols = layout.blocks.map(b => ({
        ...b,
        excludedCols: b.visibleColumns.filter(c => c.id !== 'fullName'),
    }))

    const handleDrop = (targetBlockId: string) => {
        if (!dragId || dragId === targetBlockId) {
            setDragId(null); setHoverId(null); return
        }
        const ids = layout.blocks.map(b => b.id)
        const from = ids.indexOf(dragId)
        const to = ids.indexOf(targetBlockId)
        if (from === -1 || to === -1) return
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        setBlockOrder(viewId, next)
        void recordUsage('block_reorder', { viewId, dragId, targetBlockId, via: 'inline' })
        setDragId(null); setHoverId(null)
    }

    return (
        <div className="sticky top-0 z-20 bg-white border-b border-[#E2E8F0]">
            <div className="flex items-stretch w-full min-h-[28px]">
                {/* Sticky ФИО zone — colored to match identification, but
                    no label here. Any extra identification columns (licenseNumber
                    etc.) render their own block band in the flex area below. */}
                <div className="flex items-center shrink-0 pr-3"
                     style={{ backgroundColor: '#F3F4F6' }}>
                    <div className="w-[3px] self-stretch shrink-0 bg-transparent" />
                    <div className="pl-2" style={{ width: '220px' }} />
                </div>

                <div className="flex items-stretch flex-1 min-w-0">
                    {blocksWithCols.map(block => {
                        if (block.excludedCols.length === 0) return null
                        const flexGrow = block.excludedCols.reduce((sum, c) => sum + c.widthPx, 0)
                        const isDragging = dragId === block.id
                        const isDropTarget = hoverId === block.id && dragId !== null && dragId !== block.id
                        return (
                            <div
                                key={block.id}
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = 'move'
                                    setDragId(block.id)
                                }}
                                onDragOver={(e) => {
                                    if (!dragId) return
                                    e.preventDefault()
                                    setHoverId(block.id)
                                }}
                                onDrop={(e) => { e.preventDefault(); handleDrop(block.id) }}
                                onDragEnd={() => { setDragId(null); setHoverId(null) }}
                                className={`group flex items-center justify-center gap-1 px-2 text-[11px] uppercase tracking-wide text-[#334155] font-semibold border-l border-[#E2E8F0] cursor-grab select-none transition-all ${
                                    isDragging ? 'opacity-40' : ''
                                } ${isDropTarget ? 'ring-2 ring-inset ring-[#4338CA]' : ''}`}
                                style={{
                                    flex: `${flexGrow} 1 0`,
                                    minWidth: '60px',
                                    backgroundColor: block.color ?? '#F3F4F6',
                                }}
                                title={`${block.label} — потяни чтобы изменить порядок блоков`}
                            >
                                <GripVertical className="w-3 h-3 text-[#94A3B8] opacity-40 group-hover:opacity-100 transition-opacity shrink-0" />
                                <span className="truncate">{block.label}</span>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
