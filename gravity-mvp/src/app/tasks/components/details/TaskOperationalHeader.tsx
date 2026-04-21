'use client'

import { useState, useRef, useEffect } from 'react'
import type { TaskDTO } from '@/lib/tasks/types'
import { getScenario, getStage, getScenarioFields } from '@/lib/tasks/scenario-config'
import type { ScenarioFieldDef } from '@/lib/tasks/scenario-config'
import { parseScenarioData, formatFieldValue } from './ScenarioFieldsSection'
import { updateTaskScenarioField, resetTaskScenarioField } from '@/app/tasks/actions'
import { Clock, Pencil, RotateCcw, Check, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

interface Props {
    task: TaskDTO
}

const PRIORITY_LABELS: Record<string, { label: string; className: string }> = {
    critical: { label: 'Критический', className: 'bg-red-100 text-red-700' },
    high:     { label: 'Высокий',      className: 'bg-orange-100 text-orange-700' },
    medium:   { label: 'Средний',      className: 'bg-blue-50 text-blue-700' },
    low:      { label: 'Низкий',       className: 'bg-gray-100 text-gray-600' },
}

const STATUS_LABELS: Record<string, string> = {
    todo: 'Активна',
    in_progress: 'В работе',
    waiting_reply: 'Ждём ответа',
    overdue: 'Просрочена',
    snoozed: 'Отложена',
    done: 'Закрыта',
    cancelled: 'Отменена',
    archived: 'Архив',
}

// Ключевые поля шапки (в одну строку)
const HEADER_FIELD_IDS = ['isInOtherFleet', 'yandexActive', 'yandexTripsCount', 'isSelfEmployed', 'inactiveDays', 'monthOfChurn']

export default function TaskOperationalHeader({ task }: Props) {
    if (!task.scenario) return null

    const scenario = getScenario(task.scenario)
    const stage = task.stage ? getStage(task.scenario, task.stage) : null
    const priority = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS.medium
    const scenarioData = parseScenarioData(task)
    const fieldDefs = getScenarioFields(task.scenario)

    const slaRemaining = task.slaDeadline ? formatTimeRemaining(task.slaDeadline) : null
    const slaColor = task.slaDeadline ? getSlaColor(task.slaDeadline) : 'text-gray-500'

    return (
        <div className="bg-white border border-[#E4ECFC] rounded-xl p-3 space-y-2">
            {/* Row 1: Status chips + SLA */}
            <div className="flex items-center flex-wrap gap-1.5">
                {scenario && (
                    <span className="inline-flex items-center h-[22px] px-2 rounded bg-indigo-100 text-indigo-700 text-[12px] font-semibold">
                        {scenario.label}
                    </span>
                )}
                {stage && (
                    <span className="inline-flex items-center h-[22px] px-2 rounded bg-indigo-50 text-indigo-700 text-[12px] font-medium">
                        {stage.label}
                    </span>
                )}
                <span className={`inline-flex items-center h-[22px] px-2 rounded text-[12px] font-semibold ${priority.className}`}>
                    Приоритет: {priority.label}
                </span>
                {task.status && (
                    <span className="inline-flex items-center h-[22px] px-2 rounded bg-gray-100 text-gray-600 text-[12px] font-medium">
                        {STATUS_LABELS[task.status] ?? task.status}
                    </span>
                )}
                {slaRemaining && (
                    <span className={`inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium gap-1 ${slaColor} bg-gray-50`}>
                        <Clock size={11} />
                        SLA: {slaRemaining}
                    </span>
                )}
            </div>

            {/* Row 2: Preview fields — редактируемые */}
            <div className="flex items-center flex-wrap gap-1.5 text-[12px]">
                {HEADER_FIELD_IDS.map(fid => {
                    const def = fieldDefs.find(d => d.id === fid)
                    if (!def) return null
                    const entry = scenarioData[fid]
                    return (
                        <EditableFieldBadge
                            key={fid}
                            taskId={task.id}
                            field={def}
                            value={entry?.value ?? null}
                            source={entry?.source ?? null}
                        />
                    )
                })}
            </div>

            {/* Row 3: Operational summary */}
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-[12px] text-[#64748B] pt-1 border-t border-[#F1F5FD]">
                {task.lastContactAt && (
                    <span>
                        Последний контакт: <span className="text-[#0F172A] font-medium">{formatRelativeTime(task.lastContactAt)}</span>
                        {task.lastContactResult && <span className="text-gray-400"> · {task.lastContactResult}</span>}
                    </span>
                )}
                {task.nextActionAt && (
                    <span>
                        Следующее действие: <span className={`font-medium ${getDateColor(task.nextActionAt)}`}>{formatRelativeDate(task.nextActionAt)}</span>
                    </span>
                )}
                {scenarioData.churnReason?.value && (
                    <span>
                        Причина: <span className="text-[#0F172A] font-medium">
                            {getChurnReasonLabel(fieldDefs, scenarioData.churnReason.value)}
                        </span>
                    </span>
                )}
            </div>
        </div>
    )
}

// ─── Editable badge ──────────────────────────────────────────────

function EditableFieldBadge({
    taskId, field, value, source,
}: {
    taskId: string
    field: ScenarioFieldDef
    value: unknown
    source: string | null
}) {
    const [editing, setEditing] = useState(false)
    const [saving, setSaving] = useState(false)
    const qc = useQueryClient()

    const hasValue = value !== null && value !== undefined
    const isManualOverride = source === 'manual'

    const invalidateTask = () => {
        qc.invalidateQueries({ queryKey: ['task-detail', taskId] })
        qc.invalidateQueries({ queryKey: ['tasks'] })
    }

    const handleSave = async (newValue: unknown) => {
        setSaving(true)
        try {
            await updateTaskScenarioField(taskId, field.id, newValue)
            invalidateTask()
        } catch (err) {
            console.error('Failed to update field:', err)
        } finally {
            setSaving(false)
            setEditing(false)
        }
    }

    const handleReset = async () => {
        setSaving(true)
        try {
            await resetTaskScenarioField(taskId, field.id)
            invalidateTask()
        } catch (err) {
            console.error('Failed to reset field:', err)
        } finally {
            setSaving(false)
        }
    }

    if (editing) {
        return (
            <InlineEditor
                field={field}
                value={value}
                onSave={handleSave}
                onCancel={() => setEditing(false)}
                saving={saving}
            />
        )
    }

    const shortLabel = field.shortLabel ?? field.label
    const tone = toneFor(field.id, value)

    return (
        <span className={`inline-flex items-center h-[22px] pl-2 pr-1 rounded gap-1 font-medium group ${tone}`}>
            <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 hover:opacity-75"
                title={`${field.label}${source ? ` · source: ${source}` : ''}${isManualOverride ? ' (ручной ввод)' : ''}`}
            >
                <span>
                    {shortLabel}: {hasValue ? formatFieldValue(field, value) : <span className="italic opacity-60">указать</span>}
                </span>
                {isManualOverride && <span className="text-[9px] opacity-60">✎</span>}
            </button>
            <button
                onClick={() => setEditing(true)}
                className="opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity ml-0.5"
                title="Изменить"
                disabled={saving}
            >
                <Pencil size={10} />
            </button>
            {isManualOverride && field.source !== 'manual' && (
                <button
                    onClick={handleReset}
                    className="opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity"
                    title="Сбросить к авто-значению"
                    disabled={saving}
                >
                    <RotateCcw size={10} />
                </button>
            )}
        </span>
    )
}

// ─── Inline editor (compact) ──────────────────────────────────────

function InlineEditor({
    field, value, onSave, onCancel, saving,
}: {
    field: ScenarioFieldDef
    value: unknown
    onSave: (v: unknown) => void
    onCancel: () => void
    saving: boolean
}) {
    const [localVal, setLocalVal] = useState(value !== null && value !== undefined ? String(value) : '')
    const containerRef = useRef<HTMLSpanElement>(null)

    // Close on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onCancel()
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [onCancel])

    return (
        <span ref={containerRef} className="inline-flex items-center gap-1 bg-white border border-blue-400 rounded px-1.5 py-0.5 text-[12px]">
            <span className="text-[11px] text-gray-500 shrink-0">{field.shortLabel ?? field.label}:</span>

            {field.type === 'enum' && field.enumOptions ? (
                <select
                    autoFocus
                    defaultValue={(value as string) ?? ''}
                    onChange={(e) => e.target.value && onSave(e.target.value)}
                    disabled={saving}
                    className="text-[12px] bg-white outline-none"
                >
                    <option value="">—</option>
                    {field.enumOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
            ) : field.type === 'boolean' ? (
                <>
                    <button onClick={() => onSave(true)} disabled={saving} className="text-[11px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100">Да</button>
                    <button onClick={() => onSave(false)} disabled={saving} className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200">Нет</button>
                </>
            ) : field.type === 'number' ? (
                <>
                    <input
                        autoFocus
                        type="number"
                        value={localVal}
                        onChange={(e) => setLocalVal(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') onSave(localVal === '' ? null : Number(localVal))
                            if (e.key === 'Escape') onCancel()
                        }}
                        disabled={saving}
                        className="text-[12px] bg-white border border-gray-200 rounded px-1 w-[70px] outline-none"
                    />
                    <button onClick={() => onSave(localVal === '' ? null : Number(localVal))} disabled={saving} className="text-blue-500 hover:text-blue-700">
                        <Check size={12} />
                    </button>
                </>
            ) : (
                <>
                    <input
                        autoFocus
                        type={field.type === 'date' ? 'date' : 'text'}
                        value={localVal}
                        onChange={(e) => setLocalVal(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') onSave(localVal)
                            if (e.key === 'Escape') onCancel()
                        }}
                        disabled={saving}
                        className="text-[12px] bg-white border border-gray-200 rounded px-1 w-[110px] outline-none"
                    />
                    <button onClick={() => onSave(localVal)} disabled={saving} className="text-blue-500 hover:text-blue-700">
                        <Check size={12} />
                    </button>
                </>
            )}
            <button onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600">
                <X size={12} />
            </button>
        </span>
    )
}

// ─── Helpers ──────────────────────────────────────────────────────

function getChurnReasonLabel(defs: ReturnType<typeof getScenarioFields>, value: unknown): string {
    const def = defs.find(d => d.id === 'churnReason')
    const opt = def?.enumOptions?.find(o => o.value === value)
    return opt?.label ?? String(value)
}

function toneFor(fieldId: string, value: unknown): string {
    if (fieldId === 'yandexActive' || fieldId === 'isInOtherFleet') {
        if (value === 'yes') return 'bg-emerald-50 text-emerald-700'
        if (value === 'no') return 'bg-red-50 text-red-700'
        return 'bg-gray-100 text-gray-500'
    }
    if (fieldId === 'isSelfEmployed') {
        if (value === 'yes') return 'bg-emerald-50 text-emerald-700'
        return 'bg-gray-100 text-gray-500'
    }
    if (fieldId === 'inactiveDays' && typeof value === 'number') {
        if (value >= 7) return 'bg-red-50 text-red-700'
        if (value >= 3) return 'bg-yellow-50 text-yellow-700'
        return 'bg-gray-100 text-gray-700'
    }
    if (fieldId === 'yandexTripsCount' && value === 0) return 'bg-red-50 text-red-700'
    if (fieldId === 'monthOfChurn') return 'bg-indigo-50 text-indigo-700'
    return 'bg-gray-100 text-gray-700'
}

function formatRelativeDate(iso: string): string {
    const d = new Date(iso)
    const diffMs = d.getTime() - Date.now()
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays < -1) return `${Math.abs(diffDays)} дн. назад`
    if (diffDays < 0) return 'Вчера'
    if (diffDays === 0) return 'Сегодня'
    if (diffDays === 1) return 'Завтра'
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function formatRelativeTime(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diffMs / 60000)
    if (mins < 60) return `${mins}м назад`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}ч назад`
    const days = Math.floor(hours / 24)
    return `${days}д назад`
}

function formatTimeRemaining(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now()
    if (diffMs <= 0) return 'Просрочен'
    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / 60000)
    if (hours > 24) return `${Math.floor(hours / 24)}д ${hours % 24}ч`
    if (hours > 0) return `${hours}ч ${mins}м`
    return `${mins}м`
}

function getSlaColor(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now()
    if (diffMs <= 0) return 'text-red-600'
    if (diffMs < 2 * 60 * 60 * 1000) return 'text-yellow-600'
    return 'text-green-600'
}

function getDateColor(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now()
    if (diffMs < 0) return 'text-red-600'
    if (diffMs < 2 * 60 * 60 * 1000) return 'text-yellow-600'
    return 'text-[#0F172A]'
}
