'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseRow — config-driven list row for a churn case.
//
// Layout:
//   ┌──────────── sticky left zone ────────────┬── scrollable blocks 2..N ──┐
//   │ [stripe] [avatar] [ФИО]                  │  [b2] [b3] [b4] [b5] [b6]  │
//   └──────────────────────────────────────────┴────────────────────────────┘
//
// The identification block renders in blocks 2..N but with fullName
// excluded (already shown in the sticky zone).
//
// Priority stripe color comes from priority or SLA state — follows the
// existing contract used in TaskListRow.
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from '@/lib/tasks/types'
import type { ResolvedLayout } from '@/lib/tasks/list-schema'
import { ROW_DENSITY_PX } from '@/lib/tasks/list-schema'
import TaskCaseBlock from './TaskCaseBlock'
import TaskCaseInlineActions from './TaskCaseInlineActions'
import { primarySignal, CONTROL_SIGNAL_TINT } from '@/lib/tasks/control-signals'
import { Bell, Zap } from 'lucide-react'

interface TaskCaseRowProps {
    task: TaskDTO
    layout: ResolvedLayout
    isSelected: boolean
    onSelect: () => void
}

export default function TaskCaseRow({ task, layout, isSelected, onSelect }: TaskCaseRowProps) {
    const { view, blocks } = layout
    const density = view.rowDensity
    const rowHeight = ROW_DENSITY_PX[density]
    // Block labels only belong in the table header / column settings, not in rows.
    const showBlockLabels = false
    // Only the tallest density has room for cell labels without feeling cramped.
    const showCellLabels  = density === 'comfortable'
    const showAvatar      = density !== 'compact'

    // Control mode: highlight the row tint by its primary signal.
    const signal = view.mode === 'control' ? primarySignal(task) : null
    const controlTint = signal ? CONTROL_SIGNAL_TINT[signal] : ''

    const stripeColor = getStripeColor(task)

    const baseBg = isSelected
        ? 'bg-[#EEF2FF]'
        : controlTint || 'bg-white hover:bg-[#F8FAFC]'

    return (
        <div
            data-task-id={task.id}
            onClick={onSelect}
            className={`group flex items-stretch w-full border-b border-[#EEF2FF] cursor-pointer transition-colors relative ${baseBg}`}
            style={{ minHeight: `${rowHeight}px` }}
        >
            {/* Left zone: stripe + avatar + ФИО.
                Intentionally NOT sticky — 200+ sticky nodes per scroll frame
                stalls the main thread. Horizontal scroll in operational is
                rare; table mode users see the header for context. */}
            <div className="flex items-center shrink-0 pr-3">
                <div className={`w-[3px] self-stretch shrink-0 ${stripeColor}`} />
                <div className="flex items-center gap-2 pl-2" style={{ width: '220px' }}>
                    {showAvatar && (
                        <div className="w-7 h-7 shrink-0 bg-[#EEF2FF] text-[#2AABEE] rounded-full flex items-center justify-center font-bold text-[11px]">
                            {task.driverName.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <div className="min-w-0 flex-1 flex flex-col justify-center">
                        <span className={`text-[${density === 'compact' ? 13 : 14}px] font-semibold text-[#0F172A] truncate leading-tight`}>
                            {task.driverName}
                        </span>
                        {density === 'comfortable' && (
                            <SignalIcons task={task} />
                        )}
                    </div>
                </div>
            </div>

            {/* Scrollable blocks */}
            <div className="flex items-stretch flex-1 min-w-0 overflow-hidden">
                {blocks.map(block => (
                    <TaskCaseBlock
                        key={block.id}
                        task={task}
                        block={block}
                        ctx={{ scenarioId: task.scenario, density, mode: view.mode }}
                        showBlockLabel={showBlockLabels}
                        showCellLabels={showCellLabels}
                        excludeColumnIds={block.id === 'identification' ? ['fullName'] : undefined}
                    />
                ))}
            </div>

            {/* Hover inline actions — sticky on the right */}
            <div
                className="sticky right-0 flex items-center pl-2 pr-2 bg-gradient-to-l from-white via-white to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: isSelected ? 'linear-gradient(to left, #EEF2FF, #EEF2FF, transparent)' : undefined }}
            >
                <TaskCaseInlineActions task={task} />
            </div>
        </div>
    )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function SignalIcons({ task }: { task: TaskDTO }) {
    const icons: React.ReactNode[] = []
    if (task.hasNewReply) {
        icons.push(
            <span key="new" className="inline-flex items-center h-[16px] px-1 rounded bg-blue-100 text-[10px] text-blue-700 font-semibold gap-0.5">
                <Bell size={10} /> NEW
            </span>
        )
    }
    if (task.isEscalated) {
        icons.push(
            <span key="esc" className="inline-flex items-center h-[16px] px-1 rounded bg-red-50 text-red-600">
                <Zap size={10} />
            </span>
        )
    }
    if (icons.length === 0) return null
    return <div className="flex items-center gap-1 mt-0.5">{icons}</div>
}

function getStripeColor(task: TaskDTO): string {
    const now = Date.now()
    const sla = task.slaDeadline ? new Date(task.slaDeadline).getTime() : null
    const breached = sla !== null && sla < now
    if (breached) return 'bg-[#DC2626]'

    const next = task.nextActionAt ? new Date(task.nextActionAt).getTime() : null
    if (next !== null && next < now) return 'bg-[#DC2626]'

    switch (task.priority) {
        case 'critical': return 'bg-[#DC2626]'
        case 'high':     return 'bg-[#EA580C]'
        case 'medium':   return 'bg-[#60A5FA]'
        case 'low':      return 'bg-[#CBD5E1]'
    }
    return 'bg-[#CBD5E1]'
}
