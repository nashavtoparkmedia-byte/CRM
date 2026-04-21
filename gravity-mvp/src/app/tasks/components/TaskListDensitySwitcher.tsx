'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListDensitySwitcher — 3-way density toggle (Компактный / Стандартный / Полный).
// Writes to list-view-store overrides for the active churn view, so
// density is persisted per view (and per user via localStorage).
// ═══════════════════════════════════════════════════════════════════

import { Rows2, Rows3, Rows4 } from 'lucide-react'
import { useListViewStore } from '@/store/list-view-store'
import { getSystemView, getDefaultViewId } from '@/lib/tasks/list-views'
import type { ListRowDensity } from '@/lib/tasks/list-schema'

const OPTIONS: { value: ListRowDensity; label: string; icon: typeof Rows2 }[] = [
    { value: 'compact',     label: 'Компактный',   icon: Rows4 },
    { value: 'standard',    label: 'Стандартный',  icon: Rows3 },
    { value: 'comfortable', label: 'Полный',       icon: Rows2 },
]

interface Props {
    scenario: string
}

export default function TaskListDensitySwitcher({ scenario }: Props) {
    const activeMap = useListViewStore(s => s.activeViewIdByScenario)
    const overridesByViewId = useListViewStore(s => s.overridesByViewId)
    const setRowDensity = useListViewStore(s => s.setRowDensity)

    const activeId = activeMap[scenario] ?? getDefaultViewId(scenario)
    const view = getSystemView(activeId)
    if (!view) return null

    const current: ListRowDensity = overridesByViewId[activeId]?.rowDensity ?? view.rowDensity

    return (
        <div className="flex items-center bg-[#F1F5FD] rounded-lg p-0.5" role="group" aria-label="Плотность строк">
            {OPTIONS.map(opt => {
                const active = current === opt.value
                const Icon = opt.icon
                return (
                    <button
                        key={opt.value}
                        onClick={() => setRowDensity(activeId, opt.value)}
                        title={opt.label}
                        className={`flex items-center justify-center w-8 h-7 rounded-md transition-colors ${
                            active
                                ? 'bg-white text-[#1E40AF] shadow-sm'
                                : 'text-[#64748B] hover:text-[#334155]'
                        }`}
                    >
                        <Icon className="w-3.5 h-3.5" />
                    </button>
                )
            })}
        </div>
    )
}
