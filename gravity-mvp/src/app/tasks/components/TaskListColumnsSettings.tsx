'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListColumnsSettings — full list constructor:
//   • DnD blocks (reorder block bands)
//   • DnD columns inside a block
//   • DnD columns between blocks (cross-block drop)
//   • rename column / block label (UI label only, exportKey stays)
//   • column width slider
//   • show / hide
//   • reset to system defaults
//
// Persisted per-view in list-view-store (localStorage).
// ═══════════════════════════════════════════════════════════════════

import { useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Settings2, GripVertical, RotateCcw, Pencil, Check, X } from 'lucide-react'
import { useListViewStore } from '@/store/list-view-store'
import { resolveLayout } from '@/lib/tasks/list-columns'
import { recordUsage } from '@/lib/tasks/usage'
import type { ListViewDef, ResolvedBlock, ResolvedColumn } from '@/lib/tasks/list-schema'

interface Props {
    view: ListViewDef
    trigger?: React.ReactNode
}

type DragKind = 'col' | 'block'
interface DragState { kind: DragKind; id: string; fromBlock?: string }

export default function TaskListColumnsSettings({ view, trigger }: Props) {
    const [open, setOpen] = useState(false)
    const [drag, setDrag] = useState<DragState | null>(null)
    const [hoverKey, setHoverKey] = useState<string | null>(null)

    const overrides = useListViewStore(s => s.overridesByViewId[view.id])
    const setColumnVisibility = useListViewStore(s => s.setColumnVisibility)
    const setColumnOrder = useListViewStore(s => s.setColumnOrder)
    const setColumnWidth = useListViewStore(s => s.setColumnWidth)
    const setColumnLabel = useListViewStore(s => s.setColumnLabel)
    const setColumnBlock = useListViewStore(s => s.setColumnBlock)
    const setBlockOrder = useListViewStore(s => s.setBlockOrder)
    const setBlockLabel = useListViewStore(s => s.setBlockLabel)
    const resetOverrides = useListViewStore(s => s.resetOverrides)

    const layout = useMemo(() => resolveLayout(view, overrides), [view, overrides])
    const hasOverrides = !!overrides && Object.keys(overrides).length > 0

    const handleColumnDrop = (targetBlockId: string, targetColId: string | null) => {
        if (!drag || drag.kind !== 'col') return
        const { id: dragId, fromBlock } = drag
        if (dragId === targetColId) { setDrag(null); setHoverKey(null); return }

        // Build a flat order of columns across all blocks
        const flatOrder: string[] = []
        for (const b of layout.blocks) {
            for (const c of b.columns) flatOrder.push(c.id)
        }
        const fromIdx = flatOrder.indexOf(dragId)
        if (fromIdx === -1) return
        flatOrder.splice(fromIdx, 1)

        let toIdx: number
        if (targetColId) {
            toIdx = flatOrder.indexOf(targetColId)
            if (toIdx === -1) toIdx = flatOrder.length
        } else {
            const firstOfBlock = layout.blocks
                .find(b => b.id === targetBlockId)
                ?.columns.find(c => c.id !== dragId)?.id
            toIdx = firstOfBlock ? flatOrder.indexOf(firstOfBlock) : flatOrder.length
        }
        flatOrder.splice(toIdx, 0, dragId)

        setColumnOrder(view.id, flatOrder)
        if (fromBlock !== targetBlockId) setColumnBlock(view.id, dragId, targetBlockId)
        void recordUsage('column_reorder', { viewId: view.id, dragId, targetBlockId, targetColId: targetColId ?? null })
        setDrag(null); setHoverKey(null)
    }

    const handleBlockDrop = (targetBlockId: string) => {
        if (!drag || drag.kind !== 'block') return
        if (drag.id === targetBlockId) { setDrag(null); setHoverKey(null); return }
        const ids = layout.blocks.map(b => b.id)
        const from = ids.indexOf(drag.id)
        const to = ids.indexOf(targetBlockId)
        if (from === -1 || to === -1) return
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        setBlockOrder(view.id, next)
        void recordUsage('block_reorder', { viewId: view.id, dragId: drag.id, targetBlockId })
        setDrag(null); setHoverKey(null)
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[13px] font-medium hover:bg-[#F1F5FD] transition-colors">
                        <Settings2 className="w-3.5 h-3.5" />
                        Настроить колонки
                    </button>
                )}
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Настройка списка — {view.label}</DialogTitle>
                </DialogHeader>

                <div className="flex items-center justify-between text-[12px] text-[#64748B] mb-2">
                    <span>
                        Показано {layout.blocks.reduce((s, b) => s + b.visibleColumns.length, 0)} из{' '}
                        {layout.blocks.reduce((s, b) => s + b.columns.length, 0)} колонок ·{' '}
                        Перетаскивайте <GripVertical className="inline w-3 h-3 -mt-0.5" /> блоки и колонки
                    </span>
                    {hasOverrides && (
                        <button
                            onClick={() => resetOverrides(view.id)}
                            className="flex items-center gap-1 text-[#DC2626] hover:text-[#B91C1C] transition-colors"
                        >
                            <RotateCcw className="w-3 h-3" /> Сбросить к системным
                        </button>
                    )}
                </div>

                <div className="flex flex-col gap-3">
                    {layout.blocks.map(block => (
                        <BlockPanel
                            key={block.id}
                            block={block}
                            drag={drag}
                            hoverKey={hoverKey}
                            onDragStart={(s) => setDrag(s)}
                            onDragEnd={() => { setDrag(null); setHoverKey(null) }}
                            onHover={setHoverKey}
                            onColumnDrop={(colId) => handleColumnDrop(block.id, colId)}
                            onBlockDrop={() => handleBlockDrop(block.id)}
                            onToggleVisibility={(id, v) => {
                                setColumnVisibility(view.id, id, v)
                                void recordUsage('column_toggle', { viewId: view.id, columnId: id, visible: v })
                            }}
                            onRenameColumn={(id, label) => setColumnLabel(view.id, id, label)}
                            onResizeColumn={(id, px) => setColumnWidth(view.id, id, px)}
                            onRenameBlock={(label) => setBlockLabel(view.id, block.id, label)}
                        />
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}

// ─── Block panel ─────────────────────────────────────────────────────

interface BlockPanelProps {
    block: ResolvedBlock
    drag: DragState | null
    hoverKey: string | null
    onDragStart: (s: DragState) => void
    onDragEnd: () => void
    onHover: (k: string | null) => void
    onColumnDrop: (colId: string | null) => void
    onBlockDrop: () => void
    onToggleVisibility: (id: string, v: boolean) => void
    onRenameColumn: (id: string, label: string | null) => void
    onResizeColumn: (id: string, px: number) => void
    onRenameBlock: (label: string | null) => void
}

function BlockPanel({
    block, drag, hoverKey,
    onDragStart, onDragEnd, onHover,
    onColumnDrop, onBlockDrop,
    onToggleVisibility, onRenameColumn, onResizeColumn, onRenameBlock,
}: BlockPanelProps) {
    const [editingLabel, setEditingLabel] = useState(false)
    const [labelDraft, setLabelDraft] = useState(block.label)

    if (block.columns.length === 0) return null

    const isBlockDropTarget = drag?.kind === 'block' && hoverKey === `block:${block.id}` && drag.id !== block.id
    const isDraggingThis = drag?.kind === 'block' && drag.id === block.id

    return (
        <div className="border border-[#E4ECFC] rounded-lg overflow-hidden">
            <div
                draggable={!editingLabel}
                onDragStart={(e) => {
                    if (editingLabel) return
                    e.dataTransfer.effectAllowed = 'move'
                    onDragStart({ kind: 'block', id: block.id })
                }}
                onDragOver={(e) => {
                    if (drag?.kind === 'block' || drag?.kind === 'col') {
                        e.preventDefault(); onHover(`block:${block.id}`)
                    }
                }}
                onDrop={(e) => {
                    e.preventDefault()
                    if (drag?.kind === 'block') onBlockDrop()
                    else if (drag?.kind === 'col') onColumnDrop(null)
                }}
                onDragEnd={onDragEnd}
                className={`flex items-center gap-2 px-3 py-2 select-none transition-colors ${
                    editingLabel ? '' : 'cursor-grab'
                } ${isBlockDropTarget ? 'ring-2 ring-[#4338CA]' : ''} ${isDraggingThis ? 'opacity-40' : ''}`}
                style={{ backgroundColor: block.color ?? '#F3F4F6' }}
            >
                <GripVertical className="w-4 h-4 text-[#64748B] shrink-0" />
                {editingLabel ? (
                    <div className="flex items-center gap-1 flex-1">
                        <input
                            autoFocus
                            value={labelDraft}
                            onChange={(e) => setLabelDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { onRenameBlock(labelDraft.trim() || null); setEditingLabel(false) }
                                if (e.key === 'Escape') { setLabelDraft(block.label); setEditingLabel(false) }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-white border border-[#CBD5E1] rounded px-2 py-0.5 text-[13px] font-semibold flex-1 outline-none focus:border-[#1E40AF]"
                        />
                        <button onClick={() => { onRenameBlock(labelDraft.trim() || null); setEditingLabel(false) }}
                                className="p-1 hover:bg-white/50 rounded"><Check className="w-3.5 h-3.5" /></button>
                        <button onClick={() => { setLabelDraft(block.label); setEditingLabel(false) }}
                                className="p-1 hover:bg-white/50 rounded"><X className="w-3.5 h-3.5" /></button>
                    </div>
                ) : (
                    <>
                        <span className="text-[13px] font-semibold text-[#0F172A] flex-1 uppercase tracking-wide">
                            {block.label}
                        </span>
                        <button
                            onClick={(e) => { e.stopPropagation(); setLabelDraft(block.label); setEditingLabel(true) }}
                            className="p-1 hover:bg-white/50 rounded text-[#64748B]"
                            title="Переименовать блок"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-[11px] text-[#64748B] font-normal shrink-0">
                            {block.visibleColumns.length} / {block.columns.length}
                        </span>
                    </>
                )}
            </div>

            <div className="flex flex-col gap-0.5 p-1 bg-white">
                {block.columns.map(col => (
                    <ColumnRow
                        key={col.id}
                        col={col}
                        blockId={block.id}
                        drag={drag}
                        hoverKey={hoverKey}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onHover={onHover}
                        onDrop={() => onColumnDrop(col.id)}
                        onToggle={(v) => onToggleVisibility(col.id, v)}
                        onRename={(label) => onRenameColumn(col.id, label)}
                        onResize={(px) => onResizeColumn(col.id, px)}
                    />
                ))}
            </div>
        </div>
    )
}

// ─── Column row ──────────────────────────────────────────────────────

interface ColumnRowProps {
    col: ResolvedColumn
    blockId: string
    drag: DragState | null
    hoverKey: string | null
    onDragStart: (s: DragState) => void
    onDragEnd: () => void
    onHover: (k: string | null) => void
    onDrop: () => void
    onToggle: (v: boolean) => void
    onRename: (label: string | null) => void
    onResize: (px: number) => void
}

function ColumnRow({
    col, blockId, drag, hoverKey,
    onDragStart, onDragEnd, onHover, onDrop,
    onToggle, onRename, onResize,
}: ColumnRowProps) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(col.label)

    const isDragging = drag?.kind === 'col' && drag.id === col.id
    const isDropTarget = drag?.kind === 'col' && hoverKey === `col:${col.id}` && drag.id !== col.id

    return (
        <div
            draggable={!editing}
            onDragStart={(e) => {
                if (editing) return
                e.dataTransfer.effectAllowed = 'move'
                onDragStart({ kind: 'col', id: col.id, fromBlock: blockId })
            }}
            onDragOver={(e) => {
                if (drag?.kind === 'col') { e.preventDefault(); onHover(`col:${col.id}`) }
            }}
            onDrop={(e) => { e.preventDefault(); onDrop() }}
            onDragEnd={onDragEnd}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors select-none ${
                isDragging ? 'opacity-40' : ''
            } ${isDropTarget ? 'bg-[#EEF2FF] ring-2 ring-[#4338CA]' : 'hover:bg-[#F8FAFC]'}`}
        >
            <GripVertical className="w-3.5 h-3.5 text-[#CBD5E1] cursor-grab shrink-0" />

            <input
                type="checkbox"
                checked={col.visible}
                onChange={(e) => onToggle(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 rounded border-[#CBD5E1] shrink-0"
                title={col.visible ? 'Скрыть' : 'Показать'}
            />

            <div className="flex-1 min-w-0">
                {editing ? (
                    <div className="flex items-center gap-1">
                        <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { onRename(draft.trim() || null); setEditing(false) }
                                if (e.key === 'Escape') { setDraft(col.label); setEditing(false) }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-white border border-[#CBD5E1] rounded px-1.5 py-0.5 text-[13px] flex-1 outline-none focus:border-[#1E40AF]"
                        />
                        <button onClick={() => { onRename(draft.trim() || null); setEditing(false) }}
                                className="p-0.5 hover:bg-[#F8FAFC] rounded text-[#1E40AF]"><Check className="w-3.5 h-3.5" /></button>
                        <button onClick={() => { setDraft(col.label); setEditing(false) }}
                                className="p-0.5 hover:bg-[#F8FAFC] rounded text-[#64748B]"><X className="w-3.5 h-3.5" /></button>
                    </div>
                ) : (
                    <div className="flex items-center gap-1">
                        <span className={`text-[13px] truncate ${col.visible ? 'text-[#0F172A]' : 'text-[#94A3B8]'}`}>
                            {col.label}
                        </span>
                        {col.readonly && <span className="text-[10px] uppercase text-[#94A3B8] bg-[#F1F5F9] px-1 rounded shrink-0">auto</span>}
                    </div>
                )}
            </div>

            <div className="flex items-center gap-1 text-[11px] text-[#64748B] shrink-0">
                <input
                    type="number"
                    value={col.widthPx}
                    min={60}
                    max={800}
                    step={10}
                    onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 60 && v <= 800) onResize(v)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-14 bg-[#F8FAFC] border border-[#E4ECFC] rounded px-1 py-0.5 text-right outline-none focus:border-[#1E40AF]"
                    title="Ширина, px"
                />
                <span>px</span>
            </div>

            {!editing && (
                <button
                    onClick={(e) => { e.stopPropagation(); setDraft(col.label); setEditing(true) }}
                    className="p-1 hover:bg-[#F8FAFC] rounded text-[#64748B] shrink-0"
                    title="Переименовать"
                >
                    <Pencil className="w-3 h-3" />
                </button>
            )}
        </div>
    )
}
