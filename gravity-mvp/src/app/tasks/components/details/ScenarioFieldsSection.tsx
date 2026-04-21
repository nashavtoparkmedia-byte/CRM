'use client'

import { useState } from 'react'
import { getScenarioFields } from '@/lib/tasks/scenario-config'
import type { ScenarioFieldDef } from '@/lib/tasks/scenario-config'
import type { TaskDTO } from '@/lib/tasks/types'
import { updateTaskScenarioField, resetTaskScenarioField } from '@/app/tasks/actions'
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'

interface Props {
    task: TaskDTO
    onFieldUpdated?: () => void
}

const SOURCE_BADGES: Record<string, { label: string; className: string }> = {
    auto: { label: '[API Яндекс]', className: 'bg-gray-100 text-gray-500' },
    manual: { label: '[Вручную]', className: 'bg-blue-50 text-blue-600' },
    derived: { label: '[Рассчитано]', className: 'bg-purple-50 text-purple-600' },
}

// Поля, которые показываются в шапке (Уровень 1) — не дублируются в свёрнутом блоке
const HEADER_FIELD_IDS = new Set([
    'isInOtherFleet', 'yandexActive', 'yandexTripsCount',
    'isSelfEmployed', 'inactiveDays', 'monthOfChurn',
])

export default function ScenarioFieldsSection({ task, onFieldUpdated }: Props) {
    const [expanded, setExpanded] = useState(false)

    if (!task.scenario) return null

    const allFields = getScenarioFields(task.scenario).filter(f => f.showInCard)
    if (allFields.length === 0) return null

    const scenarioData = parseScenarioData(task)

    // Служебные поля — всё, что не в шапке
    const serviceFields = allFields.filter(f => !HEADER_FIELD_IDS.has(f.id))
    // Сколько полей заполнено (для подсказки у заголовка)
    const filled = serviceFields.filter(f => {
        const entry = scenarioData[f.id]
        return entry && entry.value !== null && entry.value !== undefined
    }).length

    return (
        <div className="border border-[#E4ECFC] rounded-xl overflow-hidden">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-3 py-2 bg-[#F8FAFF] hover:bg-[#F1F5FD] transition-colors"
            >
                <div className="flex items-center gap-2">
                    {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                    <span className="text-[13px] font-semibold text-[#0F172A]">Контекст кейса</span>
                    <span className="text-[11px] text-[#64748B]">{filled} из {serviceFields.length} заполнено</span>
                </div>
            </button>

            {expanded && (
                <div className="bg-white px-3 py-2 space-y-1.5 border-t border-[#E4ECFC]">
                    {serviceFields.map(field => {
                        const entry = scenarioData[field.id]
                        return (
                            <ScenarioFieldRow
                                key={field.id}
                                field={field}
                                value={entry?.value ?? null}
                                source={entry?.source ?? field.source}
                                updatedAt={entry?.updatedAt}
                                taskId={task.id}
                                onUpdated={onFieldUpdated}
                            />
                        )
                    })}
                </div>
            )}
        </div>
    )
}

// ─── Field Row ────────────────────────────────────────────────────

function ScenarioFieldRow({
    field,
    value,
    source,
    updatedAt,
    taskId,
    onUpdated,
}: {
    field: ScenarioFieldDef
    value: unknown
    source: string
    updatedAt?: string
    taskId: string
    onUpdated?: () => void
}) {
    const [editing, setEditing] = useState(false)
    const [saving, setSaving] = useState(false)
    const sourceBadge = SOURCE_BADGES[source] ?? SOURCE_BADGES.auto
    // Manual override, если данные системы отличаются от текущего source
    const isManualOverride = source === 'manual' && field.source !== 'manual'

    const handleSave = async (newValue: unknown) => {
        setSaving(true)
        try {
            await updateTaskScenarioField(taskId, field.id, newValue)
            onUpdated?.()
        } catch (err) {
            console.error('Failed to update scenario field:', err)
        } finally {
            setSaving(false)
            setEditing(false)
        }
    }

    const handleReset = async () => {
        setSaving(true)
        try {
            await resetTaskScenarioField(taskId, field.id)
            onUpdated?.()
        } catch (err) {
            console.error('Failed to reset field:', err)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="flex items-center justify-between py-1 min-h-[28px] gap-2">
            <div className="flex items-center gap-2 min-w-0 shrink-0">
                <span className="text-[12px] text-[#64748B]">{field.label}</span>
                <span className={`text-[10px] px-1 rounded shrink-0 ${sourceBadge.className}`}>
                    {sourceBadge.label}
                </span>
                {isManualOverride && (
                    <span className="text-[10px] text-blue-500" title="Переопределено вручную">✎</span>
                )}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
                {editing ? (
                    <InlineEditor field={field} value={value} onSave={handleSave} onCancel={() => setEditing(false)} saving={saving} />
                ) : (
                    <>
                        <span className="text-[13px] font-medium text-[#0F172A] truncate">
                            {formatFieldValue(field, value)}
                        </span>
                        <button
                            onClick={() => setEditing(true)}
                            disabled={saving}
                            className="text-[11px] text-blue-500 hover:text-blue-700 transition-colors shrink-0"
                        >
                            {value !== null && value !== undefined ? 'изм.' : 'указать'}
                        </button>
                        {isManualOverride && (
                            <button
                                onClick={handleReset}
                                disabled={saving}
                                className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
                                title="Сбросить к авто-значению"
                            >
                                <RotateCcw size={11} />
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

// ─── Inline Editor ────────────────────────────────────────────────

function InlineEditor({
    field,
    value,
    onSave,
    onCancel,
    saving,
}: {
    field: ScenarioFieldDef
    value: unknown
    onSave: (v: unknown) => void
    onCancel: () => void
    saving: boolean
}) {
    const initialText = value !== null && value !== undefined ? String(value) : ''
    const [localVal, setLocalVal] = useState(initialText)

    if (field.type === 'boolean') {
        return (
            <div className="flex items-center gap-1">
                <button
                    onClick={() => onSave(true)}
                    disabled={saving}
                    className="text-[12px] px-2 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100"
                >
                    Да
                </button>
                <button
                    onClick={() => onSave(false)}
                    disabled={saving}
                    className="text-[12px] px-2 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                >
                    Нет
                </button>
                <button onClick={onCancel} className="text-[11px] text-gray-400 ml-1">✕</button>
            </div>
        )
    }

    if (field.type === 'enum' && field.enumOptions) {
        return (
            <div className="flex items-center gap-1">
                <select
                    defaultValue={(value as string) ?? ''}
                    onChange={(e) => e.target.value && onSave(e.target.value)}
                    disabled={saving}
                    className="text-[12px] bg-white border border-gray-200 rounded px-1.5 py-0.5 outline-none"
                >
                    <option value="">—</option>
                    {field.enumOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <button onClick={onCancel} className="text-[11px] text-gray-400 ml-1">✕</button>
            </div>
        )
    }

    if (field.type === 'string' || field.type === 'date') {
        return (
            <div className="flex items-center gap-1">
                <input
                    type={field.type === 'date' ? 'date' : 'text'}
                    value={localVal}
                    onChange={(e) => setLocalVal(e.target.value)}
                    disabled={saving}
                    className="text-[12px] bg-white border border-gray-200 rounded px-1.5 py-0.5 w-[120px] outline-none"
                />
                <button onClick={() => onSave(localVal)} disabled={saving} className="text-[11px] text-blue-500">✓</button>
                <button onClick={onCancel} className="text-[11px] text-gray-400">✕</button>
            </div>
        )
    }

    if (field.type === 'number') {
        return (
            <div className="flex items-center gap-1">
                <input
                    type="number"
                    value={localVal}
                    onChange={(e) => setLocalVal(e.target.value)}
                    disabled={saving}
                    className="text-[12px] bg-white border border-gray-200 rounded px-1.5 py-0.5 w-[70px] outline-none"
                />
                <button onClick={() => onSave(localVal === '' ? null : Number(localVal))} disabled={saving} className="text-[11px] text-blue-500">✓</button>
                <button onClick={onCancel} className="text-[11px] text-gray-400">✕</button>
            </div>
        )
    }

    return null
}

// ─── Helpers ──────────────────────────────────────────────────────

export function parseScenarioData(task: TaskDTO): Record<string, { value: unknown; source: string; updatedAt?: string }> {
    const data: Record<string, { value: unknown; source: string; updatedAt?: string }> = {}

    const full = (task as any).scenarioDataFull
    if (full && typeof full === 'object') {
        for (const [key, entry] of Object.entries(full)) {
            const e = entry as { value: unknown; source: string; updatedAt?: string }
            data[key] = { value: e.value, source: e.source, updatedAt: e.updatedAt }
        }
        return data
    }

    if (task.scenarioFieldsPreview) {
        for (const f of task.scenarioFieldsPreview) {
            data[f.fieldId] = { value: f.value, source: 'auto' }
        }
    }
    return data
}

export function formatFieldValue(field: ScenarioFieldDef, value: unknown): string {
    if (value === null || value === undefined) return '—'
    if (field.type === 'boolean') return value ? 'Да' : 'Нет'
    if (field.type === 'enum') {
        const opt = field.enumOptions?.find(o => o.value === value)
        return opt?.label ?? String(value)
    }
    if (field.type === 'date' && typeof value === 'string') {
        return new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
    }
    return String(value)
}
