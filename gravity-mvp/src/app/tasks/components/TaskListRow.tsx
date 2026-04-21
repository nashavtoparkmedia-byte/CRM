'use client'

import type { TaskDTO } from '@/lib/tasks/types'
import ScenarioFieldBadge from './ScenarioFieldBadge'
import { getStage, getScenario } from '@/lib/tasks/scenario-config'
import { Bell, Zap, Clock } from 'lucide-react'

interface TaskListRowProps {
    task: TaskDTO
    isSelected: boolean
    onSelect: () => void
    hideScenarioTag?: boolean
}

export default function TaskListRow({ task, isSelected, onSelect, hideScenarioTag }: TaskListRowProps) {
    const accent = getPrimaryAccent(task)

    return (
        <div
            onClick={onSelect}
            className={`flex items-center w-full min-h-[48px] px-3 py-1.5 border-b border-[#E4ECFC] cursor-pointer transition-colors gap-2 ${
                isSelected ? 'bg-[#EEF2FF]' : 'bg-white hover:bg-[#F1F5FD]'
            }`}
        >
            {/* Priority stripe */}
            <div className={`w-1 h-8 rounded-full shrink-0 ${accent.stripeColor}`} />

            {/* Avatar */}
            <div className="w-7 h-7 shrink-0 bg-[#EEF2FF] text-[#2AABEE] rounded-full flex items-center justify-center font-bold text-[11px]">
                {task.driverName.charAt(0).toUpperCase()}
            </div>

            {/* ФИО */}
            <div className="shrink-0 min-w-0 max-w-[220px]">
                <span className="text-[14px] font-semibold text-[#0F172A] truncate leading-tight block">
                    {task.driverName}
                </span>
            </div>

            {/* Badges row — one line, no wrap */}
            <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
                {task.scenario && !hideScenarioTag && (
                    <CompactBadge color="indigo-strong">
                        {getScenarioLabel(task.scenario)}
                    </CompactBadge>
                )}
                {task.stage && (
                    <CompactBadge color="indigo">
                        {getStageLabel(task)}
                    </CompactBadge>
                )}
                <PriorityBadge priority={task.priority} />

                {task.scenarioFieldsPreview?.slice(0, 8).map(f => (
                    <ScenarioFieldBadge key={f.fieldId} field={f} scenarioId={task.scenario} />
                ))}

                {accent.signalBadges}
            </div>

            {/* Right: Next action / due */}
            <div className="shrink-0 text-right ml-2">
                {(task.nextActionAt || task.dueAt) && (
                    <span className={`text-[12px] font-medium whitespace-nowrap ${getDateColor(task.nextActionAt ?? task.dueAt!)}`}>
                        {formatRelativeDate(task.nextActionAt ?? task.dueAt!)}
                    </span>
                )}
            </div>
        </div>
    )
}

// ─── Small components ─────────────────────────────────────────────

function CompactBadge({ children, color }: { children: React.ReactNode; color: 'indigo' | 'indigo-strong' }) {
    const tone = color === 'indigo-strong'
        ? 'bg-indigo-100 text-indigo-700 font-semibold'
        : 'bg-indigo-50 text-indigo-700 font-medium'
    return (
        <span className={`inline-flex items-center h-[22px] px-2 rounded text-[12px] whitespace-nowrap shrink-0 ${tone}`}>
            {children}
        </span>
    )
}

const PRIORITY_COMPACT: Record<string, { label: string; className: string }> = {
    critical: { label: 'Критический', className: 'bg-red-100 text-red-700' },
    high:     { label: 'Высокий',      className: 'bg-orange-100 text-orange-700' },
    medium:   { label: 'Средний',      className: 'bg-blue-50 text-blue-700' },
    low:      { label: 'Низкий',       className: 'bg-gray-100 text-gray-600' },
}

function PriorityBadge({ priority }: { priority: string }) {
    const cfg = PRIORITY_COMPACT[priority]
    if (!cfg) return null
    return (
        <span className={`inline-flex items-center h-[22px] px-2 rounded text-[12px] font-semibold whitespace-nowrap shrink-0 ${cfg.className}`}>
            Приоритет: {cfg.label}
        </span>
    )
}

// ─── Helpers ──────────────────────────────────────────────────────

function getStageLabel(task: TaskDTO): string {
    if (!task.scenario || !task.stage) return ''
    const stageConfig = getStage(task.scenario, task.stage)
    return stageConfig?.label ?? task.stage.replace(/_/g, ' ')
}

function getScenarioLabel(scenarioId: string): string {
    return getScenario(scenarioId)?.label ?? scenarioId
}

interface AccentResult {
    stripeColor: string
    signalBadges: React.ReactNode
}

function getPrimaryAccent(task: TaskDTO): AccentResult {
    const badges: React.ReactNode[] = []

    let stripeColor: string
    switch (task.priority) {
        case 'critical': stripeColor = 'bg-red-500'; break
        case 'high':     stripeColor = 'bg-orange-400'; break
        case 'medium':   stripeColor = 'bg-blue-300'; break
        case 'low':      stripeColor = 'bg-gray-300'; break
        default:         stripeColor = 'bg-gray-300'
    }

    const now = Date.now()
    const slaBreached = task.slaDeadline && new Date(task.slaDeadline).getTime() < now
    const slaSoon = task.slaDeadline && !slaBreached && new Date(task.slaDeadline).getTime() < now + 2 * 60 * 60 * 1000
    const isOverdue = task.status === 'overdue'

    if (slaBreached) {
        stripeColor = 'bg-red-500'
        badges.push(
            <span key="sla" className="inline-flex items-center h-[20px] px-1.5 rounded bg-red-100 text-[11px] text-red-700 font-semibold shrink-0">
                <Clock size={11} className="mr-0.5" /> SLA
            </span>
        )
    } else if (slaSoon) {
        if (task.priority !== 'critical') stripeColor = 'bg-yellow-500'
        const remaining = task.slaDeadline ? formatTimeRemaining(task.slaDeadline) : ''
        badges.push(
            <span key="sla-warn" className="inline-flex items-center h-[20px] px-1.5 rounded bg-yellow-100 text-[11px] text-yellow-700 font-semibold shrink-0">
                <Clock size={11} className="mr-0.5" /> {remaining}
            </span>
        )
    } else if (isOverdue && task.priority !== 'critical' && task.priority !== 'high') {
        stripeColor = 'bg-red-400'
    }

    if (task.hasNewReply) {
        badges.push(
            <span key="new" className="inline-flex items-center h-[20px] px-1.5 rounded bg-blue-100 text-[11px] text-blue-700 font-semibold animate-pulse shrink-0">
                <Bell size={11} className="mr-0.5" /> NEW
            </span>
        )
    }
    if (task.isEscalated) {
        badges.push(
            <span key="esc" className="inline-flex items-center h-[20px] px-1.5 rounded bg-red-50 text-[11px] text-red-600 font-semibold shrink-0">
                <Zap size={11} />
            </span>
        )
    }

    return { stripeColor, signalBadges: badges.length > 0 ? <>{badges}</> : null }
}

function formatRelativeDate(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = d.getTime() - now.getTime()
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays < -1) return `${Math.abs(diffDays)} дн. назад`
    if (diffDays < 0) return 'Вчера'
    if (diffDays === 0) return 'Сегодня'
    if (diffDays === 1) return 'Завтра'
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function formatTimeRemaining(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now()
    if (diffMs <= 0) return 'SLA'
    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / 60000)
    if (hours > 0) return `${hours}ч ${mins}м`
    return `${mins}м`
}

function getDateColor(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now()
    if (diffMs < 0) return 'text-red-600'
    if (diffMs < 2 * 60 * 60 * 1000) return 'text-yellow-600'
    return 'text-[#64748B]'
}
