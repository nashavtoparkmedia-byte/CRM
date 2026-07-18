'use client'

import { useMemo, useState } from 'react'
import {
    AlertCircle,
    ArrowDown,
    CheckCircle2,
    GitBranch,
    Plus,
    Save,
    Trash2,
} from 'lucide-react'
import {
    createPreviewScenario,
    nextScenarioVersion,
    STEP_TYPE_LABELS,
    validatePreviewScenario,
    type PreviewScenario,
    type PreviewScenarioStep,
    type PreviewStepType,
} from '@/lib/ai-call/scenario-preview'
import type { PreviewProject } from '@/lib/ai-call/product-preview'

interface Props {
    project: PreviewProject
    scenario: PreviewScenario
    onChange: (scenario: PreviewScenario) => void
}

const STEP_TYPES = Object.keys(STEP_TYPE_LABELS) as PreviewStepType[]

function defaultStep(type: PreviewStepType, index: number): PreviewScenarioStep {
    return {
        id: `step-${index}`,
        type,
        title: STEP_TYPE_LABELS[type],
        content: '',
        ...(type === 'condition'
            ? {
                branches: [
                    { label: 'Да', targetStepId: '' },
                    { label: 'Нет', targetStepId: '' },
                ],
            }
            : {}),
    }
}

export function ScenarioPreviewPanel({ project, scenario, onChange }: Props) {
    const [showAdd, setShowAdd] = useState(false)
    const [savedMessage, setSavedMessage] = useState<string | null>(null)
    const validation = useMemo(() => validatePreviewScenario(scenario), [scenario])

    function patchScenario(patch: Partial<PreviewScenario>) {
        onChange({ ...scenario, ...patch })
        setSavedMessage(null)
    }

    function updateStep(index: number, patch: Partial<PreviewScenarioStep>) {
        patchScenario({
            steps: scenario.steps.map((step, stepIndex) =>
                stepIndex === index ? { ...step, ...patch } : step,
            ),
        })
    }

    function addStep(type: PreviewStepType) {
        patchScenario({ steps: [...scenario.steps, defaultStep(type, scenario.steps.length + 1)] })
        setShowAdd(false)
    }

    function removeStep(index: number) {
        patchScenario({ steps: scenario.steps.filter((_, stepIndex) => stepIndex !== index) })
    }

    function saveVersion() {
        if (!validation.ok) {
            setSavedMessage('Исправьте ошибки структуры перед сохранением версии.')
            return
        }
        onChange(nextScenarioVersion(scenario))
        setSavedMessage(`Версия ${scenario.version + 1} сохранена локально`)
    }

    return (
        <section className="space-y-4">
            <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-[#64748B]">{project.name}</p>
                        <div className="mt-1 flex items-center gap-2">
                            <h2 className="text-[17px] font-semibold">Редактор сценария</h2>
                            <span className="rounded-full bg-[#F1F5FD] px-2 py-0.5 text-xs text-[#64748B]">Версия {scenario.version}</span>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                onChange(createPreviewScenario(project.type, scenario.version + 1))
                                setSavedMessage('Создан новый локальный сценарий')
                            }}
                            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#E4ECFC] px-4 text-sm font-semibold hover:bg-[#F1F5FD]"
                        >
                            <Plus className="h-4 w-4" />
                            Новый сценарий
                        </button>
                        <button
                            type="button"
                            onClick={() => patchScenario({ isActive: !scenario.isActive })}
                            className={`min-h-11 rounded-lg border px-4 text-sm font-semibold ${
                                scenario.isActive
                                    ? 'border-[#BBF7D0] bg-[#ECFDF5] text-[#047857]'
                                    : 'border-[#E4ECFC] text-[#64748B]'
                            }`}
                        >
                            {scenario.isActive ? 'Активен' : 'Неактивен'}
                        </button>
                        <button
                            type="button"
                            onClick={saveVersion}
                            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#2AABEE] px-4 text-sm font-semibold text-white hover:bg-[#1E96D4]"
                        >
                            <Save className="h-4 w-4" />
                            Сохранить новую версию
                        </button>
                    </div>
                </div>

                {savedMessage && (
                    <div className={`mt-4 rounded-lg px-3 py-2 text-sm ${
                        validation.ok ? 'bg-[#ECFDF5] text-[#047857]' : 'bg-[#FEF2F2] text-[#B91C1C]'
                    }`}>
                        {savedMessage}
                    </div>
                )}

                <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <label className="block">
                        <span className="text-[13px] font-medium">Название</span>
                        <input
                            value={scenario.name}
                            onChange={(event) => patchScenario({ name: event.target.value })}
                            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[13px] font-medium">Итог результата</span>
                        <input
                            value={scenario.resultLabel}
                            onChange={(event) => patchScenario({ resultLabel: event.target.value })}
                            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block md:col-span-2">
                        <span className="text-[13px] font-medium">Цель</span>
                        <textarea
                            value={scenario.goal}
                            onChange={(event) => patchScenario({ goal: event.target.value })}
                            rows={2}
                            className="mt-1 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block md:col-span-2">
                        <span className="text-[13px] font-medium">Вступление</span>
                        <textarea
                            value={scenario.introduction}
                            onChange={(event) => patchScenario({ introduction: event.target.value })}
                            rows={2}
                            className="mt-1 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[13px] font-medium">Обязательные поля</span>
                        <input
                            value={scenario.requiredFields.join(', ')}
                            onChange={(event) => patchScenario({
                                requiredFields: event.target.value.split(',').map((value) => value.trim()).filter(Boolean),
                            })}
                            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[13px] font-medium">Qualification score preview</span>
                        <input
                            type="number"
                            min={0}
                            max={100}
                            value={scenario.qualificationScore}
                            onChange={(event) => patchScenario({ qualificationScore: Number(event.target.value) })}
                            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[13px] font-medium">Условия завершения</span>
                        <textarea
                            value={scenario.stopConditions}
                            onChange={(event) => patchScenario({ stopConditions: event.target.value })}
                            rows={3}
                            className="mt-1 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[13px] font-medium">Условия передачи менеджеру</span>
                        <textarea
                            value={scenario.transferConditions}
                            onChange={(event) => patchScenario({ transferConditions: event.target.value })}
                            rows={3}
                            className="mt-1 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 outline-none focus:border-[#2AABEE]"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[13px] font-medium">Повторить вопрос, раз</span>
                        <select
                            value={scenario.retryLimit}
                            onChange={(event) => patchScenario({ retryLimit: Number(event.target.value) })}
                            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] bg-white px-3 outline-none focus:border-[#2AABEE]"
                        >
                            {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                    </label>
                </div>
            </div>

            <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-[17px] font-semibold">Последовательность шагов</h3>
                        <p className="mt-1 text-sm text-[#64748B]">Стрелки и ветви показывают итоговую структуру сценария.</p>
                    </div>
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setShowAdd((value) => !value)}
                            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#E4ECFC] px-3 text-sm font-semibold hover:bg-[#F1F5FD]"
                        >
                            <Plus className="h-4 w-4" />
                            Добавить шаг
                        </button>
                        {showAdd && (
                            <div className="absolute right-0 top-12 z-20 w-56 rounded-xl border border-[#E4ECFC] bg-white p-1">
                                {STEP_TYPES.map((type) => (
                                    <button
                                        key={type}
                                        type="button"
                                        onClick={() => addStep(type)}
                                        className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-[#F1F5FD]"
                                    >
                                        {STEP_TYPE_LABELS[type]}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="mt-5 space-y-2">
                    {scenario.steps.map((step, index) => (
                        <div key={`${step.id}-${index}`}>
                            <article className="rounded-xl border border-[#E4ECFC] p-4">
                                <div className="flex items-start gap-3">
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#E8F5FD] text-sm font-semibold text-[#2AABEE]">
                                        {index + 1}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                                            <select
                                                value={step.type}
                                                onChange={(event) => {
                                                    const type = event.target.value as PreviewStepType
                                                    updateStep(index, {
                                                        type,
                                                        ...(type === 'condition' && !(step.branches?.length)
                                                            ? { branches: defaultStep('condition', index + 1).branches }
                                                            : {}),
                                                    })
                                                }}
                                                className="h-11 rounded-lg border border-[#E4ECFC] bg-white px-3 text-sm outline-none focus:border-[#2AABEE]"
                                            >
                                                {STEP_TYPES.map((type) => (
                                                    <option key={type} value={type}>{STEP_TYPE_LABELS[type]}</option>
                                                ))}
                                            </select>
                                            <input
                                                value={step.title}
                                                onChange={(event) => updateStep(index, { title: event.target.value })}
                                                aria-label={`Название шага ${index + 1}`}
                                                className="h-11 rounded-lg border border-[#E4ECFC] px-3 font-medium outline-none focus:border-[#2AABEE]"
                                            />
                                        </div>
                                        <textarea
                                            value={step.content}
                                            onChange={(event) => updateStep(index, { content: event.target.value })}
                                            aria-label={`Содержание шага ${index + 1}`}
                                            rows={2}
                                            className="mt-3 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 text-sm outline-none focus:border-[#2AABEE]"
                                        />

                                        {step.type === 'condition' ? (
                                            <div className="mt-3 space-y-2 rounded-lg bg-[#F8FAFE] p-3">
                                                {(step.branches ?? []).map((branch, branchIndex) => (
                                                    <div key={branchIndex} className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                                                        <input
                                                            value={branch.label}
                                                            onChange={(event) => updateStep(index, {
                                                                branches: (step.branches ?? []).map((item, itemIndex) =>
                                                                    itemIndex === branchIndex ? { ...item, label: event.target.value } : item,
                                                                ),
                                                            })}
                                                            aria-label={`Условие ветки ${branchIndex + 1}`}
                                                            placeholder="Условие"
                                                            className="h-11 rounded-lg border border-[#E4ECFC] px-3 text-sm outline-none focus:border-[#2AABEE]"
                                                        />
                                                        <select
                                                            value={branch.targetStepId}
                                                            onChange={(event) => updateStep(index, {
                                                                branches: (step.branches ?? []).map((item, itemIndex) =>
                                                                    itemIndex === branchIndex ? { ...item, targetStepId: event.target.value } : item,
                                                                ),
                                                            })}
                                                            aria-label={`Переход ветки ${branchIndex + 1}`}
                                                            className="h-11 rounded-lg border border-[#E4ECFC] bg-white px-3 text-sm outline-none focus:border-[#2AABEE]"
                                                        >
                                                            <option value="">Выберите следующий шаг</option>
                                                            {scenario.steps.filter((item) => item.id !== step.id).map((item) => (
                                                                <option key={item.id} value={item.id}>{item.title}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : !['stop', 'transfer'].includes(step.type) ? (
                                            <label className="mt-3 block text-[13px] font-medium text-[#64748B]">
                                                Следующий шаг
                                                <select
                                                    value={step.nextStepId ?? ''}
                                                    onChange={(event) => updateStep(index, { nextStepId: event.target.value })}
                                                    className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] bg-white px-3 text-sm text-[#0F172A] outline-none focus:border-[#2AABEE]"
                                                >
                                                    <option value="">Переход не выбран</option>
                                                    {scenario.steps.filter((item) => item.id !== step.id).map((item) => (
                                                        <option key={item.id} value={item.id}>{item.title}</option>
                                                    ))}
                                                </select>
                                            </label>
                                        ) : null}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => removeStep(index)}
                                        aria-label={`Удалить шаг ${index + 1}`}
                                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#FEF2F2] hover:text-[#DC2626]"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            </article>
                            {index < scenario.steps.length - 1 && (
                                <ArrowDown className="mx-auto my-1 h-5 w-5 text-[#94A3B8]" />
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <div className={`rounded-xl border p-5 ${
                validation.ok ? 'border-[#BBF7D0] bg-[#F0FDF4]' : 'border-[#FECACA] bg-[#FEF2F2]'
            }`}>
                <div className="flex items-start gap-3">
                    {validation.ok
                        ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#059669]" />
                        : <AlertCircle className="mt-0.5 h-5 w-5 text-[#DC2626]" />}
                    <div>
                        <h3 className="font-semibold">
                            {validation.ok ? 'Структура готова к mock-проверке' : 'Сценарий требует исправлений'}
                        </h3>
                        <p className="mt-1 text-sm text-[#64748B]">
                            Достижимых шагов: {validation.reachableStepIds.length} из {scenario.steps.length}.
                        </p>
                        {validation.errors.length > 0 && (
                            <ul className="mt-3 space-y-1 text-sm text-[#B91C1C]">
                                {validation.errors.map((error) => <li key={error}>• {error}</li>)}
                            </ul>
                        )}
                        {validation.warnings.length > 0 && (
                            <ul className="mt-3 space-y-1 text-sm text-[#A16207]">
                                {validation.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                            </ul>
                        )}
                    </div>
                </div>
                <details className="mt-4 rounded-lg border border-black/5 bg-white/70 p-3">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
                        <GitBranch className="h-4 w-4" />
                        Техническая структура
                    </summary>
                    <div className="mt-3 space-y-1 text-xs text-[#64748B]">
                        {scenario.steps.map((step) => (
                            <div key={step.id}>
                                {step.title} → {step.type === 'condition'
                                    ? (step.branches ?? []).map((branch) => `${branch.label}: ${branch.targetStepId || 'не выбран'}`).join(' · ')
                                    : step.nextStepId || STEP_TYPE_LABELS[step.type]}
                            </div>
                        ))}
                    </div>
                </details>
            </div>
        </section>
    )
}
