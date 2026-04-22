'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListDensitySwitcher — single dropdown button with 3 options
// (Компактный / Стандартный / Полный). Matches the visual weight of
// neighboring Excel / Massовая забота buttons in Row 1.
// ═══════════════════════════════════════════════════════════════════

import { useState, useRef, useEffect } from 'react'
import { Rows2, Rows3, Rows4, ChevronDown, Check } from 'lucide-react'
import { useListViewStore } from '@/store/list-view-store'
import { getSystemView, getDefaultViewId } from '@/lib/tasks/list-views'
import { recordUsage } from '@/lib/tasks/usage'
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
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    const activeMap = useListViewStore(s => s.activeViewIdByScenario)
    const overridesByViewId = useListViewStore(s => s.overridesByViewId)
    const setRowDensity = useListViewStore(s => s.setRowDensity)

    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const activeId = activeMap[scenario] ?? getDefaultViewId(scenario)
    const view = getSystemView(activeId)
    if (!view) return null

    const current: ListRowDensity = overridesByViewId[activeId]?.rowDensity ?? view.rowDensity
    const currentOpt = OPTIONS.find(o => o.value === current) ?? OPTIONS[2]
    const CurrentIcon = currentOpt.icon

    const pick = (value: ListRowDensity) => {
        setRowDensity(activeId, value)
        void recordUsage('density_switch', { density: value, viewId: activeId })
        setOpen(false)
    }

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(o => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e5e7eb] text-[#374151] text-[13px] font-medium hover:bg-[#f3f4f6] transition-colors"
                title="Плотность строк"
            >
                <CurrentIcon className="w-4 h-4 text-[#6b7280]" />
                {currentOpt.label}
                <ChevronDown className="w-3 h-3 text-[#9ca3af]" />
            </button>
            {open && (
                <div className="absolute right-0 top-full mt-1 z-40 min-w-[180px] bg-white rounded-lg shadow-md border border-[#E4ECFC] py-1 text-[13px]">
                    {OPTIONS.map(opt => {
                        const active = opt.value === current
                        const Icon = opt.icon
                        return (
                            <button
                                key={opt.value}
                                onClick={() => pick(opt.value)}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#F8FAFC] transition-colors ${
                                    active ? 'text-[#1E40AF] font-medium' : 'text-[#0F172A]'
                                }`}
                            >
                                <Icon className="w-4 h-4 text-[#6b7280] shrink-0" />
                                <span className="flex-1 text-left">{opt.label}</span>
                                {active && <Check className="w-3.5 h-3.5 text-[#1E40AF]" />}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
