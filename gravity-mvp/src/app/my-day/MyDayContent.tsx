'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
    Clock, AlertTriangle, CheckCircle, Plus,
    Phone, MessageSquare, ChevronDown, ChevronUp,
} from 'lucide-react'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import type { DailySummary, DailyTask } from './actions'

interface MyDayContentProps {
    summary: DailySummary
}

export default function MyDayContent({ summary }: MyDayContentProps) {
    const router = useRouter()
    const { today, overdue, active, metrics } = summary

    return (
        <div className="space-y-5">
            {/* Metrics row */}
            <div className="grid grid-cols-4 gap-3">
                <MetricCard
                    label="Всего активных"
                    value={metrics.total}
                    color="#4f46e5"
                />
                <MetricCard
                    label="Просрочено"
                    value={metrics.overdue}
                    color={metrics.overdue > 0 ? '#dc2626' : '#94A3B8'}
                />
                <MetricCard
                    label="Закрыто сегодня"
                    value={metrics.closedToday}
                    color="#059669"
                />
                <MetricCard
                    label="Создано сегодня"
                    value={metrics.createdToday}
                    color="#2563eb"
                />
            </div>

            {/* Overdue block */}
            {overdue.length > 0 && (
                <TaskBlock
                    title="Просроченные"
                    icon={<AlertTriangle className="w-4 h-4 text-red-500" />}
                    tasks={overdue}
                    accentColor="red"
                    defaultExpanded
                    onTaskClick={(id) => router.push(`/tasks?taskId=${id}`)}
                />
            )}

            {/* Today block */}
            <TaskBlock
                title="Сегодня"
                icon={<Clock className="w-4 h-4 text-blue-500" />}
                tasks={today}
                accentColor="blue"
                defaultExpanded
                emptyMessage="Нет задач на сегодня"
                onTaskClick={(id) => router.push(`/tasks?taskId=${id}`)}
            />

            {/* Active block */}
            <TaskBlock
                title="В работе"
                icon={<CheckCircle className="w-4 h-4 text-indigo-500" />}
                tasks={active}
                accentColor="indigo"
                defaultExpanded={active.length <= 10}
                emptyMessage="Нет активных задач"
                onTaskClick={(id) => router.push(`/tasks?taskId=${id}`)}
            />
        </div>
    )
}

// ─── Metric Card ─────────────────────────────────────────────

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="bg-white rounded-xl border border-[#e5e7eb] px-4 py-3">
            <div className="text-[28px] font-bold leading-none" style={{ color }}>
                {value}
            </div>
            <div className="text-[12px] text-[#64748B] font-medium mt-1.5">{label}</div>
        </div>
    )
}

// ─── Task Block ──────────────────────────────────────────────

interface TaskBlockProps {
    title: string
    icon: React.ReactNode
    tasks: DailyTask[]
    accentColor: 'red' | 'blue' | 'indigo'
    defaultExpanded?: boolean
    emptyMessage?: string
    onTaskClick: (id: string) => void
}

function TaskBlock({ title, icon, tasks, accentColor, defaultExpanded = true, emptyMessage, onTaskClick }: TaskBlockProps) {
    const [expanded, setExpanded] = useState(defaultExpanded)

    const borderColor = {
        red: 'border-l-red-500',
        blue: 'border-l-blue-500',
        indigo: 'border-l-indigo-500',
    }[accentColor]

    return (
        <div className="bg-white rounded-xl border border-[#e5e7eb] overflow-hidden">
            {/* Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[#f9fafb] transition-colors"
            >
                {icon}
                <span className="text-[15px] font-semibold text-[#111827]">{title}</span>
                <span className="text-[13px] text-[#94A3B8] font-medium ml-1">({tasks.length})</span>
                <div className="ml-auto">
                    {expanded ? (
                        <ChevronUp className="w-4 h-4 text-[#94A3B8]" />
                    ) : (
                        <ChevronDown className="w-4 h-4 text-[#94A3B8]" />
                    )}
                </div>
            </button>

            {/* Task list */}
            {expanded && (
                <div className="border-t border-[#f3f4f6]">
                    {tasks.length === 0 ? (
                        <div className="px-4 py-6 text-center text-[13px] text-[#94A3B8]">
                            {emptyMessage || 'Нет задач'}
                        </div>
                    ) : (
                        <div className="divide-y divide-[#f3f4f6]">
                            {tasks.map(task => (
                                <TaskRow
                                    key={task.id}
                                    task={task}
                                    borderColor={borderColor}
                                    onClick={() => onTaskClick(task.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

// ─── Task Row ────────────────────────────────────────────────

function TaskRow({ task, borderColor, onClick }: { task: DailyTask; borderColor: string; onClick: () => void }) {
    const router = useRouter()
    const scenarioLabel = task.scenario ? getScenario(task.scenario)?.label : null
    const stageLabel = task.scenario && task.stage ? getStage(task.scenario, task.stage)?.label : null

    const formatTime = (iso: string | null) => {
        if (!iso) return null
        const d = new Date(iso)
        return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    }

    const formatDate = (iso: string | null) => {
        if (!iso) return null
        const d = new Date(iso)
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    }

    const handleCall = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (task.driverPhone) window.open(`tel:${task.driverPhone}`, '_self')
    }

    const handleWrite = (e: React.MouseEvent) => {
        e.stopPropagation()
        router.push(`/messages?msg=new&phone=${task.driverPhone}&driver=${task.driverId}`)
    }

    return (
        <div
            onClick={onClick}
            className={`group flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-[#f9fafb] transition-colors border-l-[3px] ${borderColor}`}
        >
            {/* Priority indicator */}
            {task.priority === 'high' && (
                <AlertTriangle className="w-3.5 h-3.5 text-orange-500 shrink-0" />
            )}

            {/* Main content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-[#111827] truncate">{task.driverName}</span>
                    {scenarioLabel && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-600">
                            {scenarioLabel}
                            {stageLabel && <> · {stageLabel}</>}
                        </span>
                    )}
                    {task.isSlaBreached && (
                        <span className="shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-600">
                            SLA
                        </span>
                    )}
                </div>
                <div className="text-[12px] text-[#64748B] truncate mt-0.5">{task.title}</div>
            </div>

            {/* Time */}
            <div className="shrink-0 text-right">
                {task.dueAt && (
                    <div className={`text-[12px] font-medium ${task.isOverdue ? 'text-red-600' : 'text-[#64748B]'}`}>
                        {task.isOverdue ? formatDate(task.dueAt) : formatTime(task.dueAt)}
                    </div>
                )}
                {task.attempts > 0 && (
                    <div className="text-[10px] text-[#94A3B8]">
                        {task.attempts} касаний
                    </div>
                )}
            </div>

            {/* Quick actions (on hover) */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {task.driverPhone && (
                    <button
                        onClick={handleCall}
                        className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#e5e7eb] transition-colors"
                        title="Позвонить"
                    >
                        <Phone className="w-3.5 h-3.5 text-[#6b7280]" />
                    </button>
                )}
                <button
                    onClick={handleWrite}
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#e5e7eb] transition-colors"
                    title="Написать"
                >
                    <MessageSquare className="w-3.5 h-3.5 text-[#6b7280]" />
                </button>
            </div>
        </div>
    )
}
