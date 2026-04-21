'use client'

import { getScenarioFields } from '@/lib/tasks/scenario-config'
import { useMemo } from 'react'

interface ScenarioFieldPreview {
    fieldId: string
    label: string
    type: 'boolean' | 'number' | 'string' | 'enum' | 'date'
    value: unknown
}

interface Props {
    field: ScenarioFieldPreview
    scenarioId?: string | null
}

export default function ScenarioFieldBadge({ field, scenarioId }: Props) {
    const rendered = useMemo(() => renderValue(field, scenarioId), [field, scenarioId])
    if (!rendered) return null

    const tone = toneFor(field, rendered.value)
    return (
        <span className={`inline-flex items-center h-[22px] px-1.5 rounded text-[12px] font-medium whitespace-nowrap shrink-0 ${tone}`}>
            {rendered.label}
        </span>
    )
}

function renderValue(
    field: ScenarioFieldPreview,
    scenarioId?: string | null,
): { label: string; value: unknown } | null {
    const { type, value } = field

    if (value === null || value === undefined) return null

    const fieldDefs = scenarioId ? getScenarioFields(scenarioId) : []
    const def = fieldDefs.find(f => f.id === field.fieldId)
    const shortLabel = def?.shortLabel ?? field.label

    switch (type) {
        case 'boolean':
            // boolean: if false, don't render at all
            if (!value) return null
            return { label: shortLabel, value }

        case 'number':
            return { label: `${shortLabel}: ${value}`, value }

        case 'string':
            if (!value) return null
            return { label: `${shortLabel}: ${value}`, value }

        case 'enum': {
            const opt = def?.enumOptions?.find(o => o.value === value)
            const optLabel = opt?.label ?? String(value)
            return { label: `${shortLabel}: ${optLabel}`, value }
        }

        case 'date':
            if (typeof value !== 'string') return null
            return {
                label: `${shortLabel}: ${new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`,
                value,
            }

        default:
            return null
    }
}

function toneFor(field: ScenarioFieldPreview, value: unknown): string {
    // "Катает в Яндекс" / "Другой парк": цвет по ответу
    if (field.fieldId === 'yandexActive' || field.fieldId === 'isInOtherFleet') {
        if (value === 'yes') return 'bg-emerald-50 text-emerald-700'
        if (value === 'no') return 'bg-red-50 text-red-700'
        return 'bg-gray-100 text-gray-500'
    }

    // СМЗ: Да — зелёный, Нет — нейтральный
    if (field.fieldId === 'isSelfEmployed') {
        if (value === 'yes') return 'bg-emerald-50 text-emerald-700'
        return 'bg-gray-100 text-gray-500'
    }

    // inactiveDays: градация
    if (field.fieldId === 'inactiveDays' && typeof value === 'number') {
        if (value >= 7) return 'bg-red-50 text-red-700'
        if (value >= 3) return 'bg-yellow-50 text-yellow-700'
        return 'bg-gray-100 text-gray-700'
    }

    // yandexTripsCount = 0 → красный
    if (field.fieldId === 'yandexTripsCount' && value === 0) {
        return 'bg-red-50 text-red-700'
    }

    // Месяц оттока — индиго
    if (field.fieldId === 'monthOfChurn') {
        return 'bg-indigo-50 text-indigo-700'
    }

    return 'bg-gray-100 text-gray-700'
}
