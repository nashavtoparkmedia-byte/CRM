'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskControlChips — chip-filters visible only in "Контроль" mode.
// Empty selection = show everything (with highlights), selecting chips
// narrows the list to matching problem signals.
// ═══════════════════════════════════════════════════════════════════

import { useFilteredTasks } from '@/store/tasks-selectors'
import { useListViewStore } from '@/store/list-view-store'
import {
    CONTROL_SIGNALS,
    CONTROL_SIGNAL_SHORT_LABELS,
    CONTROL_SIGNAL_TINT,
    detectSignals,
    type ControlSignal,
} from '@/lib/tasks/control-signals'
import { AlertTriangle, Zap, Clock, MessageSquare, X } from 'lucide-react'
import { useMemo } from 'react'

const SIGNAL_ICON: Record<ControlSignal, React.ComponentType<{ className?: string }>> = {
    overdue: AlertTriangle,
    has_reply: MessageSquare,
    no_next_action: Zap,
    stale: Clock,
}

export default function TaskControlChips() {
    const tasks = useFilteredTasks()
    const active = useListViewStore(s => s.controlSignalFilter)
    const toggle = useListViewStore(s => s.toggleControlSignal)
    const clear = useListViewStore(s => s.clearControlSignalFilter)

    // Compute counts per signal across currently filtered tasks
    const counts = useMemo(() => {
        const now = new Date()
        const c: Record<ControlSignal, number> = { overdue: 0, has_reply: 0, no_next_action: 0, stale: 0 }
        for (const t of tasks) {
            for (const s of detectSignals(t, now)) c[s]++
        }
        return c
    }, [tasks])

    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {CONTROL_SIGNALS.map(signal => {
                const Icon = SIGNAL_ICON[signal]
                const isOn = active.includes(signal)
                const count = counts[signal]
                return (
                    <button
                        key={signal}
                        onClick={() => toggle(signal)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors border ${
                            isOn
                                ? 'bg-[#1E40AF] text-white border-[#1E40AF]'
                                : `${CONTROL_SIGNAL_TINT[signal]} text-[#334155] border-[#E4ECFC] hover:border-[#CBD5E1]`
                        }`}
                    >
                        <Icon className="w-3 h-3" />
                        {CONTROL_SIGNAL_SHORT_LABELS[signal]}
                        <span className={`text-[11px] font-semibold ${isOn ? 'text-white/80' : 'text-[#64748B]'}`}>
                            {count}
                        </span>
                    </button>
                )
            })}
            {active.length > 0 && (
                <button
                    onClick={clear}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] text-[#64748B] hover:text-[#DC2626] transition-colors"
                >
                    <X className="w-3 h-3" /> сбросить
                </button>
            )}
        </div>
    )
}
