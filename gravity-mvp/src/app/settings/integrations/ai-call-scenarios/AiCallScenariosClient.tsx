"use client"

import { useState } from 'react'
import {
    Sparkles, Save, AlertCircle, CheckCircle2, Loader2,
    Plus, Pencil, Trash2, X, GripVertical,
} from 'lucide-react'
import type { AiCallScenarioConfig, AiCallScenarioQuestion } from '@/lib/ai-call/types'

interface Props {
    initialScenarios: AiCallScenarioConfig[]
    canEdit: boolean
}

type EditorMode = { kind: 'closed' } | { kind: 'edit'; id: string } | { kind: 'create' }

export default function AiCallScenariosClient({ initialScenarios, canEdit }: Props) {
    const [scenarios, setScenarios] = useState<AiCallScenarioConfig[]>(initialScenarios)
    const [editor, setEditor] = useState<EditorMode>({ kind: 'closed' })

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <header className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                    <Sparkles className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">Сценарии ИИ-обзвона</h1>
                    <p className="text-[13px] text-muted-foreground">
                        Скрипты для голосового ассистента, который звонит лидам по кнопке «Звонок ИИ» из карточки.
                    </p>
                </div>
                {canEdit && editor.kind === 'closed' && (
                    <button
                        type="button"
                        onClick={() => setEditor({ kind: 'create' })}
                        className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-4 text-[15px] font-semibold text-white transition-colors hover:bg-primary-dark"
                    >
                        <Plus className="h-4 w-4" />
                        Создать
                    </button>
                )}
            </header>

            {!canEdit && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted-foreground">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Только Администратор / Руководитель может редактировать сценарии.
                </div>
            )}

            {editor.kind === 'create' && (
                <ScenarioEditor
                    initial={emptyScenario()}
                    onCancel={() => setEditor({ kind: 'closed' })}
                    onSaved={(s) => {
                        setScenarios([...scenarios, s])
                        setEditor({ kind: 'closed' })
                    }}
                    isNew
                />
            )}

            <div className="flex flex-col gap-3">
                {scenarios.length === 0 && editor.kind === 'closed' && (
                    <div className="rounded-md border border-border bg-surface p-6 text-center text-[14px] text-muted-foreground">
                        Сценариев пока нет
                    </div>
                )}

                {scenarios.map((s) =>
                    editor.kind === 'edit' && editor.id === s.id ? (
                        <ScenarioEditor
                            key={s.id}
                            initial={s}
                            onCancel={() => setEditor({ kind: 'closed' })}
                            onSaved={(updated) => {
                                setScenarios(scenarios.map((x) => (x.id === updated.id ? updated : x)))
                                setEditor({ kind: 'closed' })
                            }}
                            onDeleted={(id) => {
                                setScenarios(scenarios.filter((x) => x.id !== id))
                                setEditor({ kind: 'closed' })
                            }}
                        />
                    ) : (
                        <ScenarioCard
                            key={s.id}
                            scenario={s}
                            canEdit={canEdit}
                            onEdit={() => setEditor({ kind: 'edit', id: s.id })}
                        />
                    ),
                )}
            </div>
        </div>
    )
}

function ScenarioCard({
    scenario,
    canEdit,
    onEdit,
}: {
    scenario: AiCallScenarioConfig
    canEdit: boolean
    onEdit: () => void
}) {
    return (
        <button
            type="button"
            onClick={canEdit ? onEdit : undefined}
            disabled={!canEdit}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-5 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-80"
        >
            <div className="flex items-center justify-between">
                <div className="text-[17px] font-semibold text-foreground">{scenario.name}</div>
                {canEdit && (
                    <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                        <Pencil className="h-3 w-3" />
                        Редактировать
                    </span>
                )}
            </div>
            {scenario.description && (
                <div className="text-[13px] text-muted-foreground">{scenario.description}</div>
            )}
            <div className="mt-1 flex items-center gap-3 text-[12px] text-muted-foreground">
                <span>Вопросов: {scenario.questions.length}</span>
                {scenario.targetDurationSec && (
                    <span>· Цель: {Math.round(scenario.targetDurationSec / 60)} мин</span>
                )}
            </div>
        </button>
    )
}

function ScenarioEditor({
    initial,
    onCancel,
    onSaved,
    onDeleted,
    isNew = false,
}: {
    initial: AiCallScenarioConfig
    onCancel: () => void
    onSaved: (s: AiCallScenarioConfig) => void
    onDeleted?: (id: string) => void
    isNew?: boolean
}) {
    const [name, setName] = useState(initial.name)
    const [description, setDescription] = useState(initial.description ?? '')
    const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt)
    const [questions, setQuestions] = useState<AiCallScenarioQuestion[]>(initial.questions)
    const [targetDurationSec, setTargetDurationSec] = useState<number | undefined>(initial.targetDurationSec)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

    async function handleSave() {
        if (!name.trim()) {
            setStatus({ kind: 'error', message: 'Имя сценария обязательно' })
            return
        }
        if (!systemPrompt.trim()) {
            setStatus({ kind: 'error', message: 'Системный промт обязателен' })
            return
        }
        setSaving(true)
        setStatus(null)
        try {
            const url = isNew
                ? '/api/settings/ai-call-scenarios'
                : `/api/settings/ai-call-scenarios/${initial.id}`
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description, systemPrompt, questions, targetDurationSec }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.error ?? `status ${res.status}`)
            }
            const data = await res.json()
            onSaved(data.scenario)
        } catch (err: any) {
            setStatus({ kind: 'error', message: err.message ?? 'ошибка сохранения' })
        } finally {
            setSaving(false)
        }
    }

    async function handleDelete() {
        if (!onDeleted) return
        if (!confirm(`Удалить сценарий «${name}»?`)) return
        setDeleting(true)
        try {
            const res = await fetch(`/api/settings/ai-call-scenarios/${initial.id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`status ${res.status}`)
            onDeleted(initial.id)
        } catch (err: any) {
            setStatus({ kind: 'error', message: err.message ?? 'ошибка удаления' })
            setDeleting(false)
        }
    }

    function addQuestion() {
        setQuestions([...questions, { text: '' }])
    }

    function updateQuestion(idx: number, patch: Partial<AiCallScenarioQuestion>) {
        setQuestions(questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)))
    }

    function removeQuestion(idx: number) {
        setQuestions(questions.filter((_, i) => i !== idx))
    }

    return (
        <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
            <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold text-foreground">
                    {isNew ? 'Новый сценарий' : 'Редактирование сценария'}
                </h2>
                <button
                    type="button"
                    onClick={onCancel}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
                    aria-label="Отмена"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            <section className="flex flex-col gap-2">
                <label className="text-[13px] font-medium text-muted-foreground" htmlFor="scen-name">
                    Название
                </label>
                <input
                    id="scen-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="например, Квалификация водителя"
                    className="h-11 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none transition-colors focus:border-primary"
                />
            </section>

            <section className="flex flex-col gap-2">
                <label className="text-[13px] font-medium text-muted-foreground" htmlFor="scen-desc">
                    Описание (опционально)
                </label>
                <input
                    id="scen-desc"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="когда использовать этот сценарий"
                    className="h-11 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none transition-colors focus:border-primary"
                />
            </section>

            <section className="flex flex-col gap-2">
                <label className="text-[13px] font-medium text-muted-foreground" htmlFor="scen-duration">
                    Целевая длительность звонка (секунд)
                </label>
                <input
                    id="scen-duration"
                    type="number"
                    min={30}
                    max={600}
                    step={30}
                    value={targetDurationSec ?? ''}
                    onChange={(e) => setTargetDurationSec(e.target.value ? Number(e.target.value) : undefined)}
                    placeholder="120"
                    className="h-11 w-32 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none transition-colors focus:border-primary"
                />
                <p className="text-[12px] text-muted-foreground">
                    Подсказка для модели по темпу — реальная длительность зависит от диалога.
                </p>
            </section>

            <section className="flex flex-col gap-2">
                <label className="text-[13px] font-medium text-muted-foreground" htmlFor="scen-prompt">
                    Системный промт
                </label>
                <textarea
                    id="scen-prompt"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={14}
                    className="min-h-[280px] w-full rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-[1.5] text-foreground outline-none transition-colors focus:border-primary"
                />
                <p className="text-[12px] text-muted-foreground">
                    Описывает роль ассистента, тон, обработку возражений. Сохраняется без сжатия — будет полностью в каждом запросе к LLM.
                </p>
            </section>

            <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <label className="text-[13px] font-medium text-muted-foreground">
                        Вопросы по порядку
                    </label>
                    <button
                        type="button"
                        onClick={addQuestion}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-primary hover:bg-surface"
                    >
                        <Plus className="h-3 w-3" />
                        Добавить
                    </button>
                </div>
                {questions.length === 0 && (
                    <div className="rounded-md border border-dashed border-border bg-surface px-3 py-4 text-center text-[13px] text-muted-foreground">
                        Пока вопросов нет. Сценарий может работать только по системному промту, но обычно проще задать 3–5 чётких вопросов.
                    </div>
                )}
                {questions.map((q, idx) => (
                    <div key={idx} className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
                        <div className="flex h-11 w-7 items-center justify-center text-muted-foreground">
                            <GripVertical className="h-4 w-4" />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                            <input
                                type="text"
                                value={q.text}
                                onChange={(e) => updateQuestion(idx, { text: e.target.value })}
                                placeholder={`Вопрос ${idx + 1}`}
                                className="h-9 rounded-md border border-transparent bg-transparent px-2 text-[15px] text-foreground outline-none focus:border-border"
                            />
                            <input
                                type="text"
                                value={(q.intentKeywords ?? []).join(', ')}
                                onChange={(e) =>
                                    updateQuestion(idx, {
                                        intentKeywords: e.target.value
                                            .split(',')
                                            .map((s) => s.trim())
                                            .filter(Boolean),
                                    })
                                }
                                placeholder="ключевые слова ответа через запятую (опционально)"
                                className="h-8 rounded-md border border-transparent bg-transparent px-2 text-[12px] text-muted-foreground outline-none focus:border-border"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={() => removeQuestion(idx)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-destructive"
                            aria-label="Удалить вопрос"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    </div>
                ))}
            </section>

            <footer className="sticky bottom-4 z-10 flex items-center justify-between rounded-md border border-border bg-card px-4 py-3 shadow-sm">
                <div className="text-[12px] text-muted-foreground">
                    {status?.kind === 'ok' && (
                        <span className="inline-flex items-center gap-1 text-accent">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {status.message}
                        </span>
                    )}
                    {status?.kind === 'error' && (
                        <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {status.message}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {!isNew && onDeleted && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting}
                            className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-background px-4 text-[15px] font-medium text-destructive transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            Удалить
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onCancel}
                        className="inline-flex h-11 items-center rounded-md border border-border bg-background px-4 text-[15px] font-medium text-foreground transition-colors hover:bg-surface"
                    >
                        Отмена
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-[15px] font-semibold text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Сохранить
                    </button>
                </div>
            </footer>
        </div>
    )
}

function emptyScenario(): AiCallScenarioConfig {
    return {
        id: '',
        name: '',
        description: '',
        systemPrompt: '',
        questions: [],
        targetDurationSec: 120,
    }
}
