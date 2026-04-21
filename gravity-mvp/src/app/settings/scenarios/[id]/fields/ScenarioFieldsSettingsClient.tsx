'use client'

import { useState, useTransition } from 'react'
import type { MergedFieldConfig } from '@/lib/tasks/scenario-settings-types'
import { MAX_LIST_PREVIEW_FIELDS } from '@/lib/tasks/scenario-settings-types'
import { updateScenarioFieldSetting, reorderScenarioField, getScenarioFieldsConfig } from '../../actions'
import { ArrowUp, ArrowDown } from 'lucide-react'

interface Props {
    scenarioId: string
    initialFields: MergedFieldConfig[]
}

const SOURCE_LABEL: Record<string, string> = {
    auto: '[API Яндекс]',
    manual: '[Вручную]',
    derived: '[Рассчитано]',
}

const SOURCE_CLASSNAME: Record<string, string> = {
    auto: 'bg-gray-100 text-gray-500',
    manual: 'bg-blue-50 text-blue-600',
    derived: 'bg-purple-50 text-purple-600',
}

export default function ScenarioFieldsSettingsClient({ scenarioId, initialFields }: Props) {
    const [fields, setFields] = useState<MergedFieldConfig[]>(initialFields)
    const [pending, startTransition] = useTransition()

    const showInListCount = fields.filter(f => f.showInList).length
    const overLimit = showInListCount > MAX_LIST_PREVIEW_FIELDS

    const refresh = async () => {
        const fresh = await getScenarioFieldsConfig(scenarioId)
        setFields(fresh)
    }

    const toggle = (fieldId: string, prop: keyof MergedFieldConfig, value: boolean) => {
        // Optimistic update
        setFields(prev => prev.map(f => f.id === fieldId ? { ...f, [prop]: value } : f))
        startTransition(async () => {
            await updateScenarioFieldSetting(scenarioId, fieldId, { [prop]: value } as any)
            await refresh()
        })
    }

    const move = (fieldId: string, direction: 'up' | 'down') => {
        const idx = fields.findIndex(f => f.id === fieldId)
        if (idx < 0) return
        const newIdx = direction === 'up' ? idx - 1 : idx + 1
        if (newIdx < 0 || newIdx >= fields.length) return

        // Swap optimistically
        const reordered = [...fields]
        const [moved] = reordered.splice(idx, 1)
        reordered.splice(newIdx, 0, moved)
        setFields(reordered.map((f, i) => ({ ...f, order: i })))

        startTransition(async () => {
            await Promise.all(reordered.map((f, i) =>
                reorderScenarioField(scenarioId, f.id, i)
            ))
            await refresh()
        })
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Warning about limit */}
            <div className={`flex items-center justify-between px-3 py-2 rounded-lg border text-[13px] ${
                overLimit
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-blue-50 border-blue-100 text-blue-700'
            }`}>
                <span>
                    <strong>Отображение в строке:</strong>{' '}
                    {showInListCount} из максимум {MAX_LIST_PREVIEW_FIELDS} полей
                </span>
                {overLimit && (
                    <span className="text-[12px]">
                        Лишние поля ({showInListCount - MAX_LIST_PREVIEW_FIELDS}) будут скрыты в строке списка
                    </span>
                )}
            </div>

            {/* Table */}
            <div className="border border-[#E4ECFC] rounded-xl overflow-hidden bg-white">
                <table className="w-full">
                    <thead className="bg-[#F8FAFF] border-b border-[#E4ECFC]">
                        <tr className="text-[12px] text-[#64748B]">
                            <th className="text-left font-semibold px-3 py-2 w-[40px]">№</th>
                            <th className="text-left font-semibold px-3 py-2">Поле</th>
                            <th className="text-left font-semibold px-3 py-2 w-[130px]">Источник</th>
                            <th className="text-center font-semibold px-3 py-2 w-[90px]">В списке</th>
                            <th className="text-center font-semibold px-3 py-2 w-[90px]">В карточке</th>
                            <th className="text-center font-semibold px-3 py-2 w-[80px]">Фильтр</th>
                            <th className="text-center font-semibold px-3 py-2 w-[90px]">Сортировка</th>
                            <th className="text-center font-semibold px-3 py-2 w-[100px]">Группировка</th>
                            <th className="text-center font-semibold px-3 py-2 w-[90px]">Порядок</th>
                        </tr>
                    </thead>
                    <tbody>
                        {fields.map((f, idx) => (
                            <tr key={f.id} className={`border-b border-[#F1F5FD] ${pending ? 'opacity-70' : ''}`}>
                                <td className="px-3 py-2 text-[12px] text-[#64748B]">{idx + 1}</td>
                                <td className="px-3 py-2">
                                    <div className="text-[14px] font-medium text-[#0F172A]">{f.label}</div>
                                    <div className="text-[11px] text-[#94A3B8] font-mono">{f.id} · {f.type}</div>
                                </td>
                                <td className="px-3 py-2">
                                    <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded ${SOURCE_CLASSNAME[f.source] ?? SOURCE_CLASSNAME.auto}`}>
                                        {SOURCE_LABEL[f.source] ?? f.source}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-center">
                                    <Toggle checked={f.showInList} onChange={v => toggle(f.id, 'showInList', v)} />
                                </td>
                                <td className="px-3 py-2 text-center">
                                    <Toggle checked={f.showInCard} onChange={v => toggle(f.id, 'showInCard', v)} />
                                </td>
                                <td className="px-3 py-2 text-center">
                                    <Toggle checked={f.filterable} onChange={v => toggle(f.id, 'filterable', v)} />
                                </td>
                                <td className="px-3 py-2 text-center">
                                    <Toggle checked={!!f.sortable} onChange={v => toggle(f.id, 'sortable', v)} />
                                </td>
                                <td className="px-3 py-2 text-center">
                                    <Toggle checked={!!f.groupable} onChange={v => toggle(f.id, 'groupable', v)} />
                                </td>
                                <td className="px-3 py-2">
                                    <div className="flex items-center justify-center gap-1">
                                        <button
                                            disabled={idx === 0 || pending}
                                            onClick={() => move(f.id, 'up')}
                                            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                                            title="Вверх"
                                        >
                                            <ArrowUp size={14} />
                                        </button>
                                        <button
                                            disabled={idx === fields.length - 1 || pending}
                                            onClick={() => move(f.id, 'down')}
                                            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                                            title="Вниз"
                                        >
                                            <ArrowDown size={14} />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="text-[12px] text-[#94A3B8]">
                Настройки применяются ко всем задачам сценария для всех пользователей. Изменения вступают в силу мгновенно.
            </p>
        </div>
    )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-[20px] w-[36px] rounded-full transition-colors ${
                checked ? 'bg-[#2AABEE]' : 'bg-gray-200'
            }`}
        >
            <span
                className={`absolute top-[2px] inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform ${
                    checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
                }`}
            />
        </button>
    )
}
