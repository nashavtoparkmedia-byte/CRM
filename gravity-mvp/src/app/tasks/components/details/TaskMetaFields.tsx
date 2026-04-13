'use client'

import { Zap, Tag, ChevronRight, Clock, AlertTriangle } from 'lucide-react'
import type { TaskDTO, TaskStatus } from '@/lib/tasks/types'

interface TaskMetaFieldsProps {
    task: TaskDTO
    scenario: string
    isOverdue: boolean
    scenarios: { id: string; label: string }[]
    availableEvents: { id: string; label: string }[]
    statusLabels: Record<string, string>
    onUpdateScenario: (value: string) => void
    onUpdateType: (value: string) => void
    onUpdateStatus: (value: TaskStatus) => void
    onUpdateDueAt: (value: string | null) => void
}

function MetaField({
    label,
    icon,
    children,
}: {
    label: string
    icon: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-section-label">
                {icon}
                {label}
            </span>
            {children}
        </div>
    )
}

export default function TaskMetaFields({
    task,
    scenario,
    isOverdue,
    scenarios,
    availableEvents,
    statusLabels,
    onUpdateScenario,
    onUpdateType,
    onUpdateStatus,
    onUpdateDueAt,
}: TaskMetaFieldsProps) {
    return (
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <MetaField label="Сценарий" icon={<Zap className="w-3.5 h-3.5 text-purple-500" />}>
                <select
                    value={scenario}
                    onChange={(e) => onUpdateScenario(e.target.value)}
                    className="bg-transparent border border-transparent hover:border-gray-200 outline-none rounded text-primary-value py-0.5 cursor-pointer -ml-1 transition-colors w-full whitespace-normal line-clamp-2"
                >
                    {scenarios.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                    )) || <option value="contact">Контакт</option>}
                </select>
            </MetaField>

            <MetaField label="Событие" icon={<Tag className="w-3.5 h-3.5 text-blue-500" />}>
                <select
                    value={task.type}
                    onChange={(e) => onUpdateType(e.target.value)}
                    className="bg-transparent outline-none border border-transparent hover:border-gray-200 rounded py-0.5 cursor-pointer -ml-1 transition-colors w-full whitespace-normal line-clamp-2 text-primary-value"
                >
                    {availableEvents.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                    )) || <option value={task.type}>{task.type}</option>}
                </select>
            </MetaField>

            <MetaField label="Статус" icon={<ChevronRight className="w-3.5 h-3.5" />}>
                <div className="flex items-center gap-1 -ml-1">
                    {isOverdue && <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />}
                    <select
                        value={task.status}
                        onChange={(e) => onUpdateStatus(e.target.value as TaskStatus)}
                        className="bg-transparent border border-transparent hover:border-gray-200 outline-none rounded py-0.5 cursor-pointer -ml-1 transition-colors text-primary-value"
                    >
                        {Object.entries(statusLabels).map(([val, lbl]) => (
                            <option key={val} value={val}>{lbl}</option>
                        ))}
                    </select>
                </div>
            </MetaField>

            <MetaField label="Срок" icon={<Clock className={`w-3.5 h-3.5 ${isOverdue ? 'text-red-500' : ''}`} />}>
                <div className="relative cursor-pointer">
                    <span className={`text-primary-value ${isOverdue ? '!text-[#DC2626]' : !task.dueAt ? 'bg-yellow-50 border-yellow-200 !text-yellow-800' : ''}`}>
                        {task.dueAt ? new Date(task.dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + new Date(task.dueAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}
                    </span>
                    {!['done', 'cancelled', 'archived'].includes(task.status) && (
                        <input
                            type="datetime-local"
                            value={task.dueAt ? new Date(new Date(task.dueAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                            onClick={(e) => (e.target as any).showPicker()}
                            onChange={(e) => {
                                const val = e.target.value;
                                if (val && new Date(val).getTime() < Date.now()) {
                                    alert('Нельзя установить срок в прошлом');
                                    return;
                                }
                                onUpdateDueAt(val ? new Date(val).toISOString() : null)
                            }}
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        />
                    )}
                </div>
            </MetaField>
        </div>
    )
}
