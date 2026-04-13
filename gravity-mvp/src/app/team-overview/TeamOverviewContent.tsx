'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
    Users, AlertTriangle, CheckCircle, ArrowRight,
    Clock, ChevronRight, Repeat2, Heart,
} from 'lucide-react'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import type { TeamOverview, ManagerStats, ManagerNextTask, RootCauseStat, PatternAlert, InterventionPriority } from './actions'
import type { HealthLevel, HealthScoreBreakdown, HealthTrend } from '@/lib/tasks/manager-health-config'
import { INTERVENTION_REASON_LABELS, INTERVENTION_REASON_COLORS, type InterventionReason } from '@/lib/tasks/intervention-config'
import { INTERVENTION_ACTION_LABELS } from '@/lib/tasks/intervention-action-config'
import type { InterventionAction } from '@/lib/tasks/intervention-action-config'
import { INTERVENTION_OUTCOME_LABELS, INTERVENTION_OUTCOME_COLORS, type InterventionOutcome } from '@/lib/tasks/intervention-outcome-config'
import ReassignModal from './ReassignModal'
import InterventionActionModal from './InterventionActionModal'

interface TeamOverviewContentProps {
    overview: TeamOverview
}

export default function TeamOverviewContent({ overview }: TeamOverviewContentProps) {
    const router = useRouter()
    const { totals, topRootCauses, patternAlerts, interventionQueue, managers } = overview
    const [reassignManager, setReassignManager] = useState<{ managerId: string; managerName: string } | null>(null)
    const [interventionManager, setInterventionManager] = useState<{ managerId: string; managerName: string; healthScore: number } | null>(null)

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
            <div className="grid grid-cols-5 gap-3">
                <TotalCard
                    label="Средний Health Score"
                    value={totals.avgHealthScore}
                    color={totals.avgHealthScore >= 70 ? '#059669' : totals.avgHealthScore >= 45 ? '#d97706' : '#dc2626'}
                />
                <TotalCard
                    label="В critical"
                    value={totals.criticalManagers}
                    color={totals.criticalManagers > 0 ? '#dc2626' : '#94A3B8'}
                />
                <TotalCard
                    label="Улучшается"
                    value={totals.improvingManagers}
                    color={totals.improvingManagers > 0 ? '#059669' : '#94A3B8'}
                />
                <TotalCard
                    label="Ухудшается"
                    value={totals.decliningManagers}
                    color={totals.decliningManagers > 0 ? '#dc2626' : '#94A3B8'}
                />
                <TotalCard
                    label="Устойч. снижение"
                    value={totals.sustainedDeclineManagers}
                    color={totals.sustainedDeclineManagers > 0 ? '#dc2626' : '#94A3B8'}
                />
            </div>
            <div className="grid grid-cols-2 gap-3">
                <TotalCard
                    label="Срочное внимание"
                    value={totals.urgentIntervention}
                    color={totals.urgentIntervention > 0 ? '#dc2626' : '#94A3B8'}
                />
                <TotalCard
                    label="Повышенное внимание"
                    value={totals.highIntervention}
                    color={totals.highIntervention > 0 ? '#ea580c' : '#94A3B8'}
                />
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

            {/* Intervention Queue */}
            {interventionQueue.length > 0 && (
                <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border-b border-red-200">
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                        <span className="text-[13px] font-semibold text-red-700">
                            Требуют внимания ({interventionQueue.length})
                        </span>
                    </div>
                    <div className="divide-y divide-[#f3f4f6]">
                        {interventionQueue.map(m => (
                            <InterventionRow
                                key={m.managerId}
                                manager={m}
                                onClick={() => router.push(`/tasks?assigneeId=${m.managerId}`)}
                                onAction={() => setInterventionManager({ managerId: m.managerId, managerName: m.managerName, healthScore: m.healthScore })}
                            />
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

            {/* Intervention action modal */}
            {interventionManager && (
                <InterventionActionModal
                    managerId={interventionManager.managerId}
                    managerName={interventionManager.managerName}
                    healthScore={interventionManager.healthScore}
                    onClose={() => setInterventionManager(null)}
                    onDone={() => { setInterventionManager(null); router.refresh() }}
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
                        <HealthBadge
                            score={manager.healthScore}
                            level={manager.healthLevel}
                            breakdown={manager.healthBreakdown}
                            trend={manager.healthTrend}
                            previousScore={manager.previousHealthScore}
                            declineStreak={manager.declineStreak}
                        />
                        {manager.sustainedDecline && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-600">
                                Снижается
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

// ─── Intervention Row ───────────────────────────────────────

const INTERVENTION_BADGE: Record<'urgent' | 'high', { label: string; bg: string; text: string }> = {
    urgent: { label: 'Срочно', bg: 'bg-red-100', text: 'text-red-600' },
    high: { label: 'Внимание', bg: 'bg-orange-100', text: 'text-orange-600' },
}

function InterventionRow({ manager: m, onClick, onAction }: {
    manager: ManagerStats
    onClick: () => void
    onAction: () => void
}) {
    const initials = m.managerName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    const badge = INTERVENTION_BADGE[m.interventionPriority as 'urgent' | 'high']
    const visibleReasons = m.interventionReasons.slice(0, 3)
    const hiddenCount = m.interventionReasons.length - visibleReasons.length
    const lastAction = m.lastInterventionAction

    return (
        <div className="group/irow">
            <div
                onClick={onClick}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#f9fafb] transition-colors cursor-pointer"
            >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold shrink-0 ${
                    m.interventionPriority === 'urgent' ? 'bg-red-600' : 'bg-orange-500'
                }`}>
                    {initials}
                </div>
                <div className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-[#111827] truncate">{m.managerName}</span>
                        {badge && (
                            <span className={`shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${badge.bg} ${badge.text}`}>
                                {badge.label}
                            </span>
                        )}
                        <HealthBadge
                            score={m.healthScore}
                            level={m.healthLevel}
                            breakdown={m.healthBreakdown}
                            trend={m.healthTrend}
                            previousScore={m.previousHealthScore}
                            declineStreak={m.declineStreak}
                        />
                    </div>
                    {/* Reason pills */}
                    {m.interventionReasons.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-1">
                            {visibleReasons.map(reason => {
                                const rc = INTERVENTION_REASON_COLORS[reason]
                                return (
                                    <span key={reason} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${rc.bg} ${rc.text}`}>
                                        {INTERVENTION_REASON_LABELS[reason]}
                                    </span>
                                )
                            })}
                            {hiddenCount > 0 && (
                                <div className="relative group/reasons">
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 cursor-default">
                                        +{hiddenCount}
                                    </span>
                                    <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/reasons:block">
                                        <div className="bg-[#1e293b] text-white rounded-lg px-3 py-2 text-[11px] whitespace-nowrap shadow-lg">
                                            {m.interventionReasons.map(r => (
                                                <div key={r} className="py-0.5">{INTERVENTION_REASON_LABELS[r]}</div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                            {/* Last action + outcome indicator */}
                            {lastAction && (
                                <>
                                    <div className="relative group/lastact">
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200">
                                            ✓ {INTERVENTION_ACTION_LABELS[lastAction.action as InterventionAction] ?? lastAction.action}
                                        </span>
                                        <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/lastact:block">
                                            <div className="bg-[#1e293b] text-white rounded-lg px-3 py-2 text-[11px] whitespace-nowrap shadow-lg">
                                                <div className="font-semibold mb-0.5">Последнее действие</div>
                                                <div>{INTERVENTION_ACTION_LABELS[lastAction.action as InterventionAction] ?? lastAction.action}</div>
                                                {lastAction.comment && (
                                                    <div className="text-gray-300 mt-0.5">«{lastAction.comment}»</div>
                                                )}
                                                {lastAction.scoreAtAction !== null && (
                                                    <div className="text-gray-400 mt-0.5">
                                                        Health при действии: {lastAction.scoreAtAction}
                                                        {lastAction.outcome && ` → сейчас: ${m.healthScore} (${m.healthScore - lastAction.scoreAtAction >= 0 ? '+' : ''}${m.healthScore - lastAction.scoreAtAction})`}
                                                    </div>
                                                )}
                                                <div className="text-gray-400 mt-0.5">
                                                    {new Date(lastAction.timestamp).toLocaleString('ru-RU', {
                                                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    {lastAction.outcome && (() => {
                                        const oc = INTERVENTION_OUTCOME_COLORS[lastAction.outcome as InterventionOutcome]
                                        return (
                                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${oc?.bg ?? 'bg-gray-100'} ${oc?.text ?? 'text-gray-500'}`}>
                                                {INTERVENTION_OUTCOME_LABELS[lastAction.outcome as InterventionOutcome] ?? lastAction.outcome}
                                            </span>
                                        )
                                    })()}
                                </>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {m.overdue > 0 && <StatPill value={m.overdue} label="просроч" color="#dc2626" />}
                    {m.escalated > 0 && <StatPill value={m.escalated} label="эскал." color="#dc2626" />}
                    {m.highRiskTasks > 0 && <StatPill value={m.highRiskTasks} label="риск" color="#dc2626" />}
                </div>
                {/* Action button */}
                <button
                    onClick={(e) => { e.stopPropagation(); onAction() }}
                    className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-[#2AABEE] border border-[#2AABEE]/30 hover:bg-blue-50 transition-colors opacity-0 group-hover/irow:opacity-100"
                >
                    Отметить
                </button>
                <ChevronRight className="w-4 h-4 text-[#d1d5db] shrink-0" />
            </div>
        </div>
    )
}

// ─── Health Badge ───────────────────────────────────────────

const HEALTH_COLORS: Record<HealthLevel, { bg: string; text: string; border: string }> = {
    healthy: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
    warning: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
    critical: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
}

const BREAKDOWN_LABELS: Record<keyof HealthScoreBreakdown, string> = {
    overdue: 'Просрочки',
    escalated: 'Эскалации',
    lateResponses: 'Медленные ответы',
    reopened: 'Повторные',
    fastClosed: 'Быстрые закрытия',
    highRisk: 'Риск',
    overload: 'Перегрузка',
}

const TREND_DISPLAY: Record<HealthTrend, { symbol: string; color: string }> = {
    improving: { symbol: '▲', color: 'text-green-500' },
    declining: { symbol: '▼', color: 'text-red-500' },
    stable: { symbol: '●', color: 'text-gray-400' },
}

function HealthBadge({ score, level, breakdown, trend, previousScore, declineStreak }: {
    score: number
    level: HealthLevel
    breakdown: HealthScoreBreakdown
    trend: HealthTrend
    previousScore: number | null
    declineStreak: number
}) {
    const colors = HEALTH_COLORS[level]
    const trendInfo = TREND_DISPLAY[trend]
    const penalties = Object.entries(breakdown)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({ label: BREAKDOWN_LABELS[k as keyof HealthScoreBreakdown], value: v }))

    return (
        <div className="relative group/health">
            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${colors.bg} ${colors.border}`}>
                <Heart className={`w-3 h-3 ${colors.text}`} />
                <span className={`text-[11px] font-bold ${colors.text}`}>{score}</span>
                <span className={`text-[10px] font-bold ${trendInfo.color}`}>{trendInfo.symbol}</span>
            </div>
            {/* Tooltip */}
            <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/health:block">
                <div className="bg-[#1e293b] text-white rounded-lg px-3 py-2 text-[11px] whitespace-nowrap shadow-lg">
                    <div className="font-semibold mb-1">Health Score: {score}/100</div>
                    {previousScore !== null && (
                        <div className="flex justify-between gap-4">
                            <span className="text-gray-300">Предыдущий</span>
                            <span className="text-gray-200 font-medium">{previousScore}</span>
                        </div>
                    )}
                    {declineStreak > 0 && (
                        <div className="flex justify-between gap-4">
                            <span className="text-gray-300">Серия снижений</span>
                            <span className="text-red-300 font-medium">{declineStreak}x</span>
                        </div>
                    )}
                    {penalties.length > 0 && <div className="border-t border-gray-600 my-1" />}
                    {penalties.map(p => (
                        <div key={p.label} className="flex justify-between gap-4">
                            <span className="text-gray-300">{p.label}</span>
                            <span className="text-red-300 font-medium">−{p.value}</span>
                        </div>
                    ))}
                </div>
            </div>
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
