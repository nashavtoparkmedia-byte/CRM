'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
    Users, AlertTriangle, CheckCircle, ArrowRight,
    Clock, ChevronRight, Repeat2,
} from 'lucide-react'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import type { TeamOverview, ManagerStats, ManagerNextTask, RootCauseStat, PatternAlert } from './actions'
import ReassignModal from './ReassignModal'

interface TeamOverviewContentProps {
    overview: TeamOverview
}

export default function TeamOverviewContent({ overview }: TeamOverviewContentProps) {
    const router = useRouter()
    const { totals, topRootCauses, patternAlerts, managers } = overview
    const [reassignManager, setReassignManager] = useState<{ managerId: string; managerName: string } | null>(null)

    const allManagersList = managers.map(m => ({ managerId: m.managerId, managerName: m.managerName }))

    return (
        <div className="space-y-5">
            {/* Team totals */}
            <div className="grid grid-cols-4 gap-3">
                <TotalCard label="Активных задач" value={totals.active} color="#4f46e5" />
                <TotalCard label="Просрочено" value={totals.overdue} color={totals.overdue > 0 ? '#dc2626' : '#94A3B8'} />
                <TotalCard label="Закрыто сегодня" value={totals.closedToday} color="#059669" />
                <TotalCard label="Высокий приоритет" value={totals.highPriority} color={totals.highPriority > 0 ? '#ea580c' : '#94A3B8'} />
            </div>
            <div className="grid grid-cols-5 gap-3">
                <TotalCard label="Медленные ответы" value={totals.lateResponses} color={totals.lateResponses > 0 ? '#d97706' : '#94A3B8'} />
                <TotalCard label="Рисковые задачи" value={totals.highRiskTasks} color={totals.highRiskTasks > 0 ? '#dc2626' : '#94A3B8'} />
                <TotalCard label="Эскалированные" value={totals.escalated} color={totals.escalated > 0 ? '#dc2626' : '#94A3B8'} />
                <TotalCard label="Повторные открытия" value={totals.reopened} color={totals.reopened > 0 ? '#dc2626' : '#94A3B8'} />
                <TotalCard label="Быстрые закрытия" value={totals.fastClosed} color={totals.fastClosed > 0 ? '#d97706' : '#94A3B8'} />
            </div>

            {/* Root causes */}
            {topRootCauses.length > 0 && (
                <div className="bg-white rounded-xl border border-[#e5e7eb] px-4 py-3">
                    <div className="text-[12px] text-[#64748B] font-medium mb-2">Причины проблем (сегодня)</div>
                    <div className="flex items-center gap-3">
                        {topRootCauses.map((rc) => (
                            <div key={rc.cause} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-50">
                                <span className="text-[14px] font-bold text-[#374151]">{rc.count}</span>
                                <span className="text-[12px] text-[#64748B]">{rc.label}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Pattern alerts & early warnings */}
            {patternAlerts.length > 0 && (
                <div className={`rounded-xl border px-4 py-3 ${
                    patternAlerts.some(p => p.level === 'pattern')
                        ? 'bg-orange-50 border-orange-200'
                        : 'bg-yellow-50 border-yellow-200'
                }`}>
                    <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className={`w-4 h-4 ${
                            patternAlerts.some(p => p.level === 'pattern') ? 'text-orange-500' : 'text-yellow-500'
                        }`} />
                        <span className={`text-[13px] font-semibold ${
                            patternAlerts.some(p => p.level === 'pattern') ? 'text-orange-700' : 'text-yellow-700'
                        }`}>Повторяющиеся проблемы</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {patternAlerts.map((pa) => (
                            <div key={pa.rootCause} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border ${
                                pa.level === 'pattern' ? 'border-orange-200' : 'border-yellow-200'
                            }`}>
                                <span className={`text-[9px] font-bold uppercase tracking-tight px-1.5 py-0.5 rounded ${
                                    pa.level === 'pattern'
                                        ? 'bg-orange-100 text-orange-600'
                                        : 'bg-yellow-100 text-yellow-600'
                                }`}>
                                    {pa.level === 'pattern' ? 'Паттерн' : 'Предупреждение'}
                                </span>
                                <span className="text-[13px] font-semibold text-[#374151]">{pa.label}</span>
                                <span className={`text-[12px] font-bold ${
                                    pa.level === 'pattern' ? 'text-orange-600' : 'text-yellow-600'
                                }`}>{pa.count}x</span>
                                <span className="text-[11px] text-[#94A3B8]">за {pa.windowHours}ч</span>
                                <span className={`text-[12px] font-bold ${
                                    pa.trend === 'up' ? 'text-red-500' : pa.trend === 'down' ? 'text-green-500' : 'text-gray-400'
                                }`} title={`Пред. период: ${pa.previousCount}x`}>
                                    {pa.trend === 'up' ? '▲' : pa.trend === 'down' ? '▼' : '●'}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

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
                            onReassign={() => setReassignManager({ managerId: manager.managerId, managerName: manager.managerName })}
                        />
                    ))}
                </div>
            )}

            {/* Reassign modal */}
            {reassignManager && (
                <ReassignModal
                    sourceManager={reassignManager}
                    allManagers={allManagersList}
                    onClose={() => setReassignManager(null)}
                    onDone={() => router.refresh()}
                />
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

function ManagerCard({ manager, onOpenTasks, onOpenTask, onReassign }: {
    manager: ManagerStats
    onOpenTasks: () => void
    onOpenTask: (taskId: string) => void
    onReassign: () => void
}) {
    const initials = manager.managerName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    const hasProblems = manager.overdue > 0
    const isOverloaded = manager.isOverloaded

    return (
        <div className={`group relative bg-white rounded-xl border overflow-hidden transition-colors ${
            isOverloaded ? 'border-red-300 bg-red-50/30' : hasProblems ? 'border-red-200' : 'border-[#e5e7eb]'
        }`}>
            {/* Manager header */}
            <button
                onClick={onOpenTasks}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#f9fafb] transition-colors"
            >
                {/* Avatar */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-[14px] font-bold shrink-0 ${
                    isOverloaded ? 'bg-red-600' : hasProblems ? 'bg-red-500' : 'bg-[#4f46e5]'
                }`}>
                    {initials}
                </div>

                {/* Name + role */}
                <div className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold text-[#111827]">{manager.managerName}</span>
                        {isOverloaded && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-600">
                                Перегружен
                            </span>
                        )}
                    </div>
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
                    {manager.lateResponses > 0 && (
                        <StatPill value={manager.lateResponses} label="медлен" color="#d97706" />
                    )}
                    {manager.highRiskTasks > 0 && (
                        <StatPill value={manager.highRiskTasks} label="риск" color="#dc2626" />
                    )}
                    {manager.escalated > 0 && (
                        <StatPill value={manager.escalated} label="эскал." color="#dc2626" />
                    )}
                    {manager.reopened > 0 && (
                        <StatPill value={manager.reopened} label="повторн" color="#dc2626" />
                    )}
                    {manager.fastClosed > 0 && (
                        <StatPill value={manager.fastClosed} label="быстр" color="#d97706" />
                    )}
                    <StatPill value={manager.closedToday} label="закрыто" color="#059669" />
                </div>

                <ChevronRight className="w-4 h-4 text-[#d1d5db] shrink-0" />
            </button>

            {/* Reassign button */}
            {manager.active > 0 && (
                <button
                    onClick={(e) => { e.stopPropagation(); onReassign() }}
                    className="absolute top-3 right-12 px-2 py-1 rounded-lg text-[11px] font-medium text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#4f46e5] transition-colors opacity-0 group-hover:opacity-100 flex items-center gap-1"
                    title="Передать задачи"
                >
                    <Repeat2 className="w-3.5 h-3.5" />
                    Передать
                </button>
            )}

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
