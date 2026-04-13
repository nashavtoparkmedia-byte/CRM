'use client'

import { useRouter } from 'next/navigation'
import {
    Users, AlertTriangle, CheckCircle, ArrowRight,
    Clock, ChevronRight,
} from 'lucide-react'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import type { TeamOverview, ManagerStats, ManagerNextTask } from './actions'

interface TeamOverviewContentProps {
    overview: TeamOverview
}

export default function TeamOverviewContent({ overview }: TeamOverviewContentProps) {
    const router = useRouter()
    const { totals, managers } = overview

    return (
        <div className="space-y-5">
            {/* Team totals */}
            <div className="grid grid-cols-4 gap-3">
                <TotalCard label="Активных задач" value={totals.active} color="#4f46e5" />
                <TotalCard label="Просрочено" value={totals.overdue} color={totals.overdue > 0 ? '#dc2626' : '#94A3B8'} />
                <TotalCard label="Высокий приоритет" value={totals.highPriority} color={totals.highPriority > 0 ? '#ea580c' : '#94A3B8'} />
                <TotalCard label="Закрыто сегодня" value={totals.closedToday} color="#059669" />
            </div>

            {/* Manager cards */}
            {managers.length === 0 ? (
                <div className="bg-white rounded-xl border border-[#e5e7eb] px-6 py-12 text-center">
                    <Users className="w-10 h-10 text-[#d1d5db] mx-auto mb-3" />
                    <p className="text-[15px] font-semibold text-[#374151]">Нет менеджеров</p>
                    <p className="text-[13px] text-[#94A3B8] mt-1">Добавьте CRM-пользователей для отображения статистики</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {managers.map(manager => (
                        <ManagerCard
                            key={manager.managerId}
                            manager={manager}
                            onOpenTasks={() => router.push(`/tasks?assigneeId=${manager.managerId}`)}
                            onOpenTask={(taskId) => router.push(`/tasks?taskId=${taskId}`)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// ─── Total Card ──────────────────────────────────────────────

function TotalCard({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="bg-white rounded-xl border border-[#e5e7eb] px-4 py-3">
            <div className="text-[28px] font-bold leading-none" style={{ color }}>
                {value}
            </div>
            <div className="text-[12px] text-[#64748B] font-medium mt-1.5">{label}</div>
        </div>
    )
}

// ─── Manager Card ────────────────────────────────────────────

function ManagerCard({ manager, onOpenTasks, onOpenTask }: {
    manager: ManagerStats
    onOpenTasks: () => void
    onOpenTask: (taskId: string) => void
}) {
    const initials = manager.managerName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    const hasProblems = manager.overdue > 0

    return (
        <div className={`bg-white rounded-xl border overflow-hidden transition-colors ${
            hasProblems ? 'border-red-200' : 'border-[#e5e7eb]'
        }`}>
            {/* Manager header */}
            <button
                onClick={onOpenTasks}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#f9fafb] transition-colors"
            >
                {/* Avatar */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-[14px] font-bold shrink-0 ${
                    hasProblems ? 'bg-red-500' : 'bg-[#4f46e5]'
                }`}>
                    {initials}
                </div>

                {/* Name + role */}
                <div className="flex-1 min-w-0 text-left">
                    <div className="text-[15px] font-semibold text-[#111827]">{manager.managerName}</div>
                    <div className="text-[12px] text-[#94A3B8]">
                        {manager.role === 'lead' ? 'Руководитель' : 'Менеджер'}
                    </div>
                </div>

                {/* Stats pills */}
                <div className="flex items-center gap-2 shrink-0">
                    <StatPill value={manager.active} label="актив" color="#4f46e5" />
                    {manager.overdue > 0 && (
                        <StatPill value={manager.overdue} label="просроч" color="#dc2626" />
                    )}
                    {manager.highPriority > 0 && (
                        <StatPill value={manager.highPriority} label="высок" color="#ea580c" />
                    )}
                    <StatPill value={manager.closedToday} label="закрыто" color="#059669" />
                </div>

                <ChevronRight className="w-4 h-4 text-[#d1d5db] shrink-0" />
            </button>

            {/* Next task preview */}
            {manager.nextTask && (
                <div
                    onClick={() => onOpenTask(manager.nextTask!.id)}
                    className="flex items-center gap-2 px-4 py-2 border-t border-[#f3f4f6] cursor-pointer hover:bg-[#f9fafb] transition-colors"
                >
                    <ArrowRight className="w-3.5 h-3.5 text-[#94A3B8] shrink-0" />
                    <NextTaskPreview task={manager.nextTask} />
                </div>
            )}
        </div>
    )
}

// ─── Stat Pill ───────────────────────────────────────────────

function StatPill({ value, label, color }: { value: number; label: string; color: string }) {
    return (
        <div className="flex items-center gap-1 px-2 py-1 rounded-lg" style={{ backgroundColor: `${color}10` }}>
            <span className="text-[14px] font-bold" style={{ color }}>{value}</span>
            <span className="text-[10px] font-medium" style={{ color: `${color}99` }}>{label}</span>
        </div>
    )
}

// ─── Next Task Preview ───────────────────────────────────────

function NextTaskPreview({ task }: { task: ManagerNextTask }) {
    const scenarioLabel = task.scenario ? getScenario(task.scenario)?.label : null
    const stageLabel = task.scenario && task.stage ? getStage(task.scenario, task.stage)?.label : null

    return (
        <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-[12px] font-medium text-[#374151] truncate">
                {task.driverName}
            </span>
            {scenarioLabel && (
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-indigo-50 text-indigo-600">
                    {scenarioLabel}
                    {stageLabel && <> · {stageLabel}</>}
                </span>
            )}
            {task.isOverdue && (
                <span className="shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-600">
                    Просрочено
                </span>
            )}
            {task.isSlaBreached && !task.isOverdue && (
                <span className="shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-600">
                    SLA
                </span>
            )}
            {task.dueAt && (
                <span className={`shrink-0 text-[11px] ml-auto ${task.isOverdue ? 'text-red-500 font-medium' : 'text-[#94A3B8]'}`}>
                    {new Date(task.dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                    {', '}
                    {new Date(task.dueAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </span>
            )}
        </div>
    )
}
