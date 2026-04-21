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

interface ListViewState {
    /** Active view id per scenario (e.g. { churn: 'churn_operational' }). */
    activeViewIdByScenario: Record<string, string>
    /** User overrides keyed by view id. */
    overridesByViewId: Record<string, ListViewOverrides>
    /** Control-mode chip filter. Empty = show all. */
    controlSignalFilter: ControlSignal[]

    // ── Actions ─────────────────────────────────────────────

    setActiveView: (scenario: string, viewId: string) => void

    setColumnVisibility: (viewId: string, columnId: string, visible: boolean) => void
    setColumnOrder: (viewId: string, orderedIds: string[]) => void
    setRowDensity: (viewId: string, density: ListRowDensity) => void
    resetOverrides: (viewId: string) => void

    setControlSignalFilter: (signals: ControlSignal[]) => void
    toggleControlSignal: (signal: ControlSignal) => void
    clearControlSignalFilter: () => void
}

export const useListViewStore = create<ListViewState>()(
    persist(
        (set) => ({
            activeViewIdByScenario: {},
            overridesByViewId: {},
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
        }),
        {
            name: 'crm-tasks-list-views',
            storage: createJSONStorage(() => localStorage),
            // Persist only view-level UI state; controlSignalFilter is session-like,
            // but keeping it makes "where did I leave off" nicer.
            partialize: (s) => ({
                activeViewIdByScenario: s.activeViewIdByScenario,
                overridesByViewId: s.overridesByViewId,
                controlSignalFilter: s.controlSignalFilter,
            }),
            version: 1,
        },
    ),
)
