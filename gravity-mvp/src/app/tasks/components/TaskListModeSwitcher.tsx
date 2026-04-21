'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListModeSwitcher — switches between 3 system views:
//   Operational / Control / Table (churn scenario on MVP)
// ═══════════════════════════════════════════════════════════════════

import { useListViewStore } from '@/store/list-view-store'
import { getSystemViews, getDefaultViewId } from '@/lib/tasks/list-views'
import { Briefcase, Eye, Table2 } from 'lucide-react'

interface Props {
    scenario: string
}

const MODE_ICON = {
    operational: Briefcase,
    control: Eye,
    table: Table2,
} as const

export default function TaskListModeSwitcher({ scenario }: Props) {
    const views = getSystemViews(scenario)
    const activeMap = useListViewStore(s => s.activeViewIdByScenario)
    const setActive = useListViewStore(s => s.setActiveView)

    const activeId = activeMap[scenario] ?? getDefaultViewId(scenario)

    if (views.length === 0) return null

    return (
        <div className="flex items-center bg-[#F1F5FD] rounded-lg p-0.5">
            {views.map(v => {
                const Icon = MODE_ICON[v.mode]
                const active = v.id === activeId
                return (
                    <button
                        key={v.id}
                        onClick={() => setActive(scenario, v.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                            active
                                ? 'bg-white text-[#1E40AF] shadow-sm'
                                : 'text-[#64748B] hover:text-[#334155]'
                        }`}
                    >
                        <Icon className="w-3.5 h-3.5" />
                        {v.label}
                    </button>
                )
            })}
        </div>
    )
}
