'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListColumnsSettings — popup for show/hide + reorder columns.
// MVP: no rename, no resize, no user presets. Per-column overrides
// are stored in list-view-store (localStorage).
// ═══════════════════════════════════════════════════════════════════

import { useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Settings2, GripVertical, RotateCcw } from 'lucide-react'
import { useListViewStore } from '@/store/list-view-store'
import { resolveLayout } from '@/lib/tasks/list-columns'
import { recordUsage } from '@/lib/tasks/usage'
import type { ListViewDef, ResolvedBlock, ResolvedColumn } from '@/lib/tasks/list-schema'

interface Props {
    view: ListViewDef
    trigger?: React.ReactNode
}

export default function TaskListColumnsSettings({ view, trigger }: Props) {
    const [open, setOpen] = useState(false)
    const overrides = useListViewStore(s => s.overridesByViewId[view.id])
    const setColumnVisibility = useListViewStore(s => s.setColumnVisibility)
    const setColumnOrder = useListViewStore(s => s.setColumnOrder)
    const resetOverrides = useListViewStore(s => s.resetOverrides)

    const layout = useMemo(() => resolveLayout(view, overrides), [view, overrides])

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <button
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[13px] font-medium hover:bg-[#F1F5FD] transition-colors"
                    >
                        <Settings2 className="w-3.5 h-3.5" />
                        Настроить колонки
                    </button>
                )}
            </DialogTrigger>
            <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Настройка колонок — {view.label}</DialogTitle>
                </DialogHeader>

                <div className="flex items-center justify-between text-[12px] text-[#64748B] mb-2">
                    <span>
                        Показано {layout.blocks.reduce((sum, b) => sum + b.visibleColumns.length, 0)} из{' '}
                        {layout.blocks.reduce((sum, b) => sum + b.columns.length, 0)} колонок
                    </span>
                    {overrides && (
                        <button
                            onClick={() => resetOverrides(view.id)}
                            className="flex items-center gap-1 text-[#DC2626] hover:text-[#B91C1C] transition-colors"
                        >
                            <RotateCcw className="w-3 h-3" /> Сбросить к системным
                        </button>
                    )}
                </div>

                <div className="flex flex-col gap-5">
                    {layout.blocks.map(block => (
                        <BlockSection
                            key={block.id}
                            block={block}
                            onToggle={(columnId, visible) => {
                                setColumnVisibility(view.id, columnId, visible)
                                void recordUsage('column_toggle', { viewId: view.id, columnId, visible })
                            }}
                            onReorder={(ids) => {
                                // Merge this block's new order with the rest of the existing order.
                                const others = layout.blocks
                                    .filter(b => b.id !== block.id)
                                    .flatMap(b => b.columns.map(c => c.id))
                                setColumnOrder(view.id, [...ids, ...others])
                                void recordUsage('column_reorder', { viewId: view.id, block: block.id, count: ids.length })
                            }}
                        />
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}

// ─── Block section (drag-reorder within block) ──────────────────────

interface BlockSectionProps {
    block: ResolvedBlock
    onToggle: (columnId: string, visible: boolean) => void
    onReorder: (ids: string[]) => void
}

function BlockSection({ block, onToggle, onReorder }: BlockSectionProps) {
    const [dragId, setDragId] = useState<string | null>(null)
    const [hoverId, setHoverId] = useState<string | null>(null)

    if (block.columns.length === 0) return null

    const ids = block.columns.map(c => c.id)

    const handleDrop = (targetId: string) => {
        if (!dragId || dragId === targetId) return
        const from = ids.indexOf(dragId)
        const to = ids.indexOf(targetId)
        if (from === -1 || to === -1) return
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        onReorder(next)
        setDragId(null)
        setHoverId(null)
    }

    return (
        <div>
            <div className="text-[11px] uppercase tracking-wide text-[#94A3B8] font-semibold mb-2">
                {block.label}
            </div>
            <div className="flex flex-col gap-1">
                {block.columns.map(col => (
                    <ColumnRow
                        key={col.id}
                        col={col}
                        dragging={dragId === col.id}
                        isDropTarget={hoverId === col.id && dragId !== null && dragId !== col.id}
                        onToggle={(v) => onToggle(col.id, v)}
                        onDragStart={() => setDragId(col.id)}
                        onDragEnd={() => { setDragId(null); setHoverId(null) }}
                        onDragOver={(e) => { e.preventDefault(); if (dragId) setHoverId(col.id) }}
                        onDrop={() => handleDrop(col.id)}
                    />
                ))}
            </div>
        </div>
    )
}

// ─── Single column row ───────────────────────────────────────────────

interface ColumnRowProps {
    col: ResolvedColumn
    dragging: boolean
    isDropTarget: boolean
    onToggle: (visible: boolean) => void
    onDragStart: () => void
    onDragEnd: () => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: () => void
}

function ColumnRow({
    col, dragging, isDropTarget,
    onToggle, onDragStart, onDragEnd, onDragOver, onDrop,
}: ColumnRowProps) {
    return (
        <div
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDrop={onDrop}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors select-none cursor-grab ${
                dragging ? 'opacity-40' : ''
            } ${isDropTarget ? 'bg-[#EEF2FF] ring-2 ring-[#4338CA]' : 'hover:bg-[#F8FAFC]'}`}
        >
            <GripVertical className="w-3.5 h-3.5 text-[#CBD5E1]" />
            <label className="flex items-center gap-2 flex-1 cursor-pointer">
                <input
                    type="checkbox"
                    checked={col.visible}
                    onChange={(e) => onToggle(e.target.checked)}
                    className="w-4 h-4 rounded border-[#CBD5E1]"
                    // Prevent parent drag from intercepting clicks on the checkbox
                    onClick={(e) => e.stopPropagation()}
                />
                <span className={`text-[13px] ${col.visible ? 'text-[#0F172A]' : 'text-[#94A3B8]'}`}>
                    {col.label}
                </span>
                {col.readonly && (
                    <span className="text-[10px] uppercase text-[#94A3B8] bg-[#F1F5F9] px-1.5 py-0.5 rounded">
                        auto
                    </span>
                )}
            </label>
        </div>
    )
}
