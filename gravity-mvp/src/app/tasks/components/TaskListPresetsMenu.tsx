'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListPresetsMenu — named user views for the churn list.
// Click the pill to open a menu: activate a saved preset, save current,
// rename, or delete.
//
// A preset = a snapshot of ListViewOverrides for a given scenario
// + the base system view id (operational/control/table).
// ═══════════════════════════════════════════════════════════════════

import { useState, useRef, useEffect } from 'react'
import { Bookmark, BookmarkPlus, Check, Pencil, Trash2, X } from 'lucide-react'
import { useListViewStore, type UserPreset } from '@/store/list-view-store'
import { getDefaultViewId } from '@/lib/tasks/list-views'
import { recordUsage } from '@/lib/tasks/usage'

interface Props {
    scenario: string
}

export default function TaskListPresetsMenu({ scenario }: Props) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    const activeMap = useListViewStore(s => s.activeViewIdByScenario)
    const overridesByViewId = useListViewStore(s => s.overridesByViewId)
    const userPresets = useListViewStore(s => s.userPresets)
    const savePreset = useListViewStore(s => s.savePreset)
    const activatePreset = useListViewStore(s => s.activatePreset)
    const deletePreset = useListViewStore(s => s.deletePreset)
    const renamePreset = useListViewStore(s => s.renamePreset)

    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const activeViewId = activeMap[scenario] ?? getDefaultViewId(scenario)
    const currentOverrides = overridesByViewId[activeViewId]
    const hasCustomizations = !!currentOverrides && Object.keys(currentOverrides).length > 0
    const scenarioPresets = userPresets.filter(p => p.scenario === scenario)

    const handleSave = () => {
        const name = prompt('Название пресета', `Мой вид ${scenarioPresets.length + 1}`)?.trim()
        if (!name) return
        const id = savePreset(name, scenario, activeViewId, currentOverrides ?? {})
        void recordUsage('preset_save', { presetId: id, scenario, baseViewId: activeViewId })
    }

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(o => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECFC] text-[#334155] text-[13px] font-medium hover:bg-[#F1F5FD] transition-colors"
                title="Именованные пресеты представления"
            >
                <Bookmark className="w-3.5 h-3.5" />
                Пресеты
                {scenarioPresets.length > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#1E40AF] text-white text-[11px] font-semibold">
                        {scenarioPresets.length}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1 z-40 min-w-[300px] bg-white rounded-lg shadow-md border border-[#E4ECFC] py-1 text-[13px]">
                    {/* Save current */}
                    <button
                        onClick={() => { setOpen(false); handleSave() }}
                        disabled={!hasCustomizations}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#F8FAFC] transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[#1E40AF]"
                        title={hasCustomizations ? 'Сохранить текущие настройки как пресет' : 'Нет пользовательских настроек для сохранения'}
                    >
                        <BookmarkPlus className="w-4 h-4" />
                        <span className="font-medium">Сохранить текущий вид…</span>
                    </button>

                    {scenarioPresets.length > 0 && (
                        <>
                            <div className="border-t border-[#EEF2FF] my-1" />
                            <div className="px-3 py-1 text-[11px] uppercase text-[#94A3B8] font-semibold">
                                Мои пресеты
                            </div>
                            {scenarioPresets.map(p => (
                                <PresetRow
                                    key={p.id}
                                    preset={p}
                                    onActivate={() => {
                                        activatePreset(p.id)
                                        void recordUsage('preset_activate', { presetId: p.id })
                                        setOpen(false)
                                    }}
                                    onRename={(name) => {
                                        renamePreset(p.id, name)
                                        void recordUsage('preset_rename', { presetId: p.id })
                                    }}
                                    onDelete={() => {
                                        if (confirm(`Удалить пресет «${p.name}»?`)) {
                                            deletePreset(p.id)
                                            void recordUsage('preset_delete', { presetId: p.id })
                                        }
                                    }}
                                />
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

function PresetRow({
    preset, onActivate, onRename, onDelete,
}: {
    preset: UserPreset
    onActivate: () => void
    onRename: (name: string) => void
    onDelete: () => void
}) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(preset.name)

    return (
        <div className="flex items-center gap-1 px-2 py-1 hover:bg-[#F8FAFC] group">
            {editing ? (
                <>
                    <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { onRename(draft.trim() || preset.name); setEditing(false) }
                            if (e.key === 'Escape') { setDraft(preset.name); setEditing(false) }
                        }}
                        className="flex-1 bg-white border border-[#CBD5E1] rounded px-2 py-0.5 outline-none focus:border-[#1E40AF]"
                    />
                    <button onClick={() => { onRename(draft.trim() || preset.name); setEditing(false) }}
                            className="p-1 hover:bg-[#F1F5FD] rounded text-[#1E40AF]">
                        <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => { setDraft(preset.name); setEditing(false) }}
                            className="p-1 hover:bg-[#F1F5FD] rounded text-[#64748B]">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </>
            ) : (
                <>
                    <button
                        onClick={onActivate}
                        className="flex-1 text-left px-1 py-0.5 text-[#0F172A] truncate"
                        title={`Создан ${new Date(preset.createdAt).toLocaleDateString('ru-RU')}`}
                    >
                        {preset.name}
                    </button>
                    <button
                        onClick={() => { setDraft(preset.name); setEditing(true) }}
                        className="p-1 opacity-0 group-hover:opacity-100 hover:bg-[#F1F5FD] rounded text-[#64748B] transition-opacity"
                        title="Переименовать"
                    >
                        <Pencil className="w-3 h-3" />
                    </button>
                    <button
                        onClick={onDelete}
                        className="p-1 opacity-0 group-hover:opacity-100 hover:bg-[#FEE2E2] rounded text-[#DC2626] transition-opacity"
                        title="Удалить"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </>
            )}
        </div>
    )
}
