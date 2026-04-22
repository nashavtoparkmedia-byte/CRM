// ═══════════════════════════════════════════════════════════════════
// List View Store — persisted per-user UI state for Tasks → List.
//
// Stored in localStorage (MVP). A future etape will migrate this to
// a DB-backed TaskListView table with scope=user|team|system.
// ═══════════════════════════════════════════════════════════════════

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ListViewOverrides, ListRowDensity } from '@/lib/tasks/list-schema'
import type { ControlSignal } from '@/lib/tasks/control-signals'

export interface UserPreset {
    id: string
    name: string
    scenario: string
    /** Which system view this preset builds on (operational/control/table). */
    baseViewId: string
    /** Snapshot of overrides at the moment of save. */
    overrides: ListViewOverrides
    createdAt: string
}

interface ListViewState {
    /** Active view id per scenario (e.g. { churn: 'churn_operational' }). */
    activeViewIdByScenario: Record<string, string>
    /** User overrides keyed by view id. */
    overridesByViewId: Record<string, ListViewOverrides>
    /** Named user presets (can be switched by id like system views). */
    userPresets: UserPreset[]
    /** Control-mode chip filter. Empty = show all. */
    controlSignalFilter: ControlSignal[]

    // ── Actions ─────────────────────────────────────────────

    setActiveView: (scenario: string, viewId: string) => void

    setColumnVisibility: (viewId: string, columnId: string, visible: boolean) => void
    setColumnOrder: (viewId: string, orderedIds: string[]) => void
    setColumnWidth: (viewId: string, columnId: string, widthPx: number) => void
    setColumnLabel: (viewId: string, columnId: string, label: string | null) => void
    setColumnBlock: (viewId: string, columnId: string, blockId: string) => void
    setBlockOrder: (viewId: string, orderedBlockIds: string[]) => void
    setBlockLabel: (viewId: string, blockId: string, label: string | null) => void
    setRowDensity: (viewId: string, density: ListRowDensity) => void
    resetOverrides: (viewId: string) => void

    setControlSignalFilter: (signals: ControlSignal[]) => void
    toggleControlSignal: (signal: ControlSignal) => void
    clearControlSignalFilter: () => void

    /** Save current overrides of a view as a named user preset. */
    savePreset: (name: string, scenario: string, baseViewId: string, overrides: ListViewOverrides) => string
    /** Activate a user preset: copy its overrides into overridesByViewId[baseViewId] and switch activeView. */
    activatePreset: (presetId: string) => void
    deletePreset: (presetId: string) => void
    renamePreset: (presetId: string, name: string) => void
}

export const useListViewStore = create<ListViewState>()(
    persist(
        (set) => ({
            activeViewIdByScenario: {},
            overridesByViewId: {},
            userPresets: [],
            controlSignalFilter: [],

            setActiveView: (scenario, viewId) =>
                set((s) => ({
                    activeViewIdByScenario: { ...s.activeViewIdByScenario, [scenario]: viewId },
                })),

            setColumnVisibility: (viewId, columnId, visible) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    const nextVisibility = { ...(prev.columnVisibility ?? {}), [columnId]: visible }
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, columnVisibility: nextVisibility },
                        },
                    }
                }),

            setColumnOrder: (viewId, orderedIds) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, columnOrder: orderedIds },
                        },
                    }
                }),

            setColumnWidth: (viewId, columnId, widthPx) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    const next = { ...(prev.columnWidths ?? {}), [columnId]: widthPx }
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, columnWidths: next },
                        },
                    }
                }),

            setColumnLabel: (viewId, columnId, label) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    const next = { ...(prev.columnLabels ?? {}) }
                    if (label === null || label === '') delete next[columnId]
                    else next[columnId] = label
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, columnLabels: next },
                        },
                    }
                }),

            setColumnBlock: (viewId, columnId, blockId) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    const next = { ...(prev.columnBlock ?? {}), [columnId]: blockId }
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, columnBlock: next },
                        },
                    }
                }),

            setBlockOrder: (viewId, orderedBlockIds) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, blockOrder: orderedBlockIds },
                        },
                    }
                }),

            setBlockLabel: (viewId, blockId, label) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    const next = { ...(prev.blockLabels ?? {}) }
                    if (label === null || label === '') delete next[blockId]
                    else next[blockId] = label
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, blockLabels: next },
                        },
                    }
                }),

            setRowDensity: (viewId, density) =>
                set((s) => {
                    const prev = s.overridesByViewId[viewId] ?? {}
                    return {
                        overridesByViewId: {
                            ...s.overridesByViewId,
                            [viewId]: { ...prev, rowDensity: density },
                        },
                    }
                }),

            resetOverrides: (viewId) =>
                set((s) => {
                    const next = { ...s.overridesByViewId }
                    delete next[viewId]
                    return { overridesByViewId: next }
                }),

            setControlSignalFilter: (signals) => set({ controlSignalFilter: signals }),

            toggleControlSignal: (signal) =>
                set((s) => {
                    const has = s.controlSignalFilter.includes(signal)
                    return {
                        controlSignalFilter: has
                            ? s.controlSignalFilter.filter((x) => x !== signal)
                            : [...s.controlSignalFilter, signal],
                    }
                }),

            clearControlSignalFilter: () => set({ controlSignalFilter: [] }),

            savePreset: (name, scenario, baseViewId, overrides) => {
                const id = `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
                set((s) => ({
                    userPresets: [
                        ...s.userPresets,
                        { id, name, scenario, baseViewId, overrides: structuredClone(overrides), createdAt: new Date().toISOString() },
                    ],
                }))
                return id
            },

            activatePreset: (presetId) => set((s) => {
                const p = s.userPresets.find(x => x.id === presetId)
                if (!p) return s
                return {
                    activeViewIdByScenario: { ...s.activeViewIdByScenario, [p.scenario]: p.baseViewId },
                    overridesByViewId: { ...s.overridesByViewId, [p.baseViewId]: structuredClone(p.overrides) },
                }
            }),

            deletePreset: (presetId) => set((s) => ({
                userPresets: s.userPresets.filter(p => p.id !== presetId),
            })),

            renamePreset: (presetId, name) => set((s) => ({
                userPresets: s.userPresets.map(p => p.id === presetId ? { ...p, name } : p),
            })),
        }),
        {
            name: 'crm-tasks-list-views',
            storage: createJSONStorage(() => localStorage),
            // Persist only view-level UI state; controlSignalFilter is session-like,
            // but keeping it makes "where did I leave off" nicer.
            partialize: (s) => ({
                activeViewIdByScenario: s.activeViewIdByScenario,
                overridesByViewId: s.overridesByViewId,
                userPresets: s.userPresets,
                controlSignalFilter: s.controlSignalFilter,
            }),
            version: 2,
        },
    ),
)
