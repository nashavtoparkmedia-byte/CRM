"use client"

import { useState } from "react"
import {
    Save, RotateCcw, AlertCircle, CheckCircle2, Loader2,
    Plus, Trash2, ArrowUp, ArrowDown, ChevronDown, Info,
} from "lucide-react"
import TelephonyTabs from "../_components/TelephonyTabs"

interface CriterionConfig {
    key: string
    label: string
    description: string
    scaleMax: number
    weight: number
    isActive: boolean
    order: number
}

interface OptionConfig {
    key: string
    label: string
    isActive: boolean
    order: number
}

interface ConfigShape {
    id: string
    enabled: boolean
    model: string
    systemPrompt: string
    criteria: CriterionConfig[]
    outcomeOptions: OptionConfig[]
    sentimentOptions: OptionConfig[]
    nextActionOptions: OptionConfig[]
    updatedAt: string | Date
}

const MODEL_OPTIONS = [
    { value: 'gpt-4o',         label: 'GPT-4o — рекомендовано' },
    { value: 'gpt-4-turbo',    label: 'GPT-4 Turbo — стабильный fallback' },
    { value: 'gpt-4o-mini',    label: 'GPT-4o mini — дешевле при большом потоке' },
]

type AiTabKey = 'criteria' | 'options' | 'advanced'

// Quick transliteration helper for auto-generating tech key from Russian label.
const TRANSLIT_MAP: Record<string, string> = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
    'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
    'х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
}
function slugify(s: string): string {
    return s.toLowerCase().trim()
        .split('').map(ch => TRANSLIT_MAP[ch] ?? ch).join('')
        .replace(/[^a-z0-9_а-яё]+/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 64) || 'item'
}

export default function TelephonyAiClient({
    initialConfig,
    defaultPrompt,
    canEdit,
}: {
    initialConfig: ConfigShape
    defaultPrompt: string
    canEdit: boolean
}) {
    const [tab, setTab] = useState<AiTabKey>('criteria')
    const [enabled, setEnabled] = useState(initialConfig.enabled)
    const [model, setModel] = useState(initialConfig.model)
    const [systemPrompt, setSystemPrompt] = useState(initialConfig.systemPrompt)
    const [criteria, setCriteria] = useState<CriterionConfig[]>(initialConfig.criteria ?? [])
    const [outcomeOptions, setOutcomeOptions] = useState<OptionConfig[]>(initialConfig.outcomeOptions ?? [])
    const [sentimentOptions, setSentimentOptions] = useState<OptionConfig[]>(initialConfig.sentimentOptions ?? [])
    const [nextActionOptions, setNextActionOptions] = useState<OptionConfig[]>(initialConfig.nextActionOptions ?? [])
    const [saving, setSaving] = useState(false)
    const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

    const dirty =
        enabled !== initialConfig.enabled ||
        model !== initialConfig.model ||
        systemPrompt !== initialConfig.systemPrompt ||
        JSON.stringify(criteria) !== JSON.stringify(initialConfig.criteria ?? []) ||
        JSON.stringify(outcomeOptions) !== JSON.stringify(initialConfig.outcomeOptions ?? []) ||
        JSON.stringify(sentimentOptions) !== JSON.stringify(initialConfig.sentimentOptions ?? []) ||
        JSON.stringify(nextActionOptions) !== JSON.stringify(initialConfig.nextActionOptions ?? [])

    async function handleSave() {
        if (!canEdit) return
        setSaving(true)
        setStatus(null)
        try {
            const res = await fetch('/api/settings/telephony-ai', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled, model, systemPrompt,
                    criteria, outcomeOptions, sentimentOptions, nextActionOptions,
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.error ?? `status ${res.status}`)
            }
            setStatus({ kind: 'ok', message: 'Сохранено' })
            setTimeout(() => setStatus(null), 2500)
        } catch (err: any) {
            setStatus({ kind: 'error', message: err.message ?? 'ошибка сохранения' })
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <TelephonyTabs active="ai" />

            <div className="flex items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-[4px] py-2.5">
                <div className="flex min-w-0 flex-col">
                    <div className={`text-[14px] font-semibold ${enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                        {enabled ? '✓ AI-анализ включён' : '✗ AI-анализ выключен'}
                    </div>
                    <div className="text-[12px] text-muted-foreground truncate">
                        Модель: <span className="font-mono text-foreground">{model}</span>
                    </div>
                </div>
                <Toggle checked={enabled} onChange={setEnabled} disabled={!canEdit} />
            </div>

            {!canEdit && (
                <div className="flex items-center gap-[2px] rounded-md border border-border bg-surface px-3 py-[2px] text-[13px] text-muted-foreground">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Только Администратор или Руководитель может редактировать настройки.
                </div>
            )}

            {/* AI sub-tabs (criteria / options / advanced) — within the
                "AI-анализ" tab from TelephonyTabs above. */}
            <div className="flex gap-1 border-b border-border">
                {([
                    { key: 'criteria', label: 'Критерии оценки' },
                    { key: 'options',  label: 'Справочники' },
                    { key: 'advanced', label: 'Дополнительно' },
                ] as { key: AiTabKey; label: string }[]).map(t => (
                    <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        className={[
                            'px-3 py-[2px] text-[14px] font-medium border-b-2 transition-colors',
                            tab === t.key
                                ? 'border-primary text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        ].join(' ')}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === 'criteria' && (
                <CriteriaEditor criteria={criteria} setCriteria={setCriteria} canEdit={canEdit} />
            )}

            {tab === 'options' && (
                <div className="flex flex-col gap-6">
                    <OptionsEditor
                        title="Итог звонка"
                        hint="Чем закончился разговор. AI выберет один вариант из этого списка."
                        addLabel="Добавить итог"
                        options={outcomeOptions}
                        setOptions={setOutcomeOptions}
                        canEdit={canEdit}
                    />
                    <OptionsEditor
                        title="Настроение клиента"
                        hint="Каким был водитель в разговоре."
                        addLabel="Добавить настроение"
                        options={sentimentOptions}
                        setOptions={setSentimentOptions}
                        canEdit={canEdit}
                    />
                    <OptionsEditor
                        title="Следующее действие"
                        hint="Что менеджер должен сделать после звонка. Дата заполняется AI отдельно."
                        addLabel="Добавить действие"
                        options={nextActionOptions}
                        setOptions={setNextActionOptions}
                        canEdit={canEdit}
                    />
                </div>
            )}

            {tab === 'advanced' && (
                <AdvancedTab
                    model={model} setModel={setModel}
                    systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt}
                    defaultPrompt={defaultPrompt}
                    canEdit={canEdit}
                />
            )}

            <footer className="sticky bottom-[4px] z-10 flex items-center justify-between rounded-md border border-border bg-card px-[4px] py-3 shadow-sm">
                <div className="text-[12px] text-muted-foreground">
                    {status?.kind === 'ok' && (
                        <span className="inline-flex items-center gap-1 text-emerald-600">
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
                    {!status && (
                        <>Сохранено: {new Date(initialConfig.updatedAt).toLocaleString('ru-RU')}</>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canEdit || !dirty || saving}
                    className="inline-flex h-11 items-center gap-[2px] rounded-md bg-primary px-5 text-[15px] font-semibold text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {saving ? <Loader2 className="h-[4px] w-[4px] animate-spin" /> : <Save className="h-[4px] w-[4px]" />}
                    Сохранить
                </button>
            </footer>
        </div>
    )
}

// ── Criteria editor (card layout) ────────────────────────────────────────

function CriteriaEditor({
    criteria, setCriteria, canEdit,
}: {
    criteria: CriterionConfig[]
    setCriteria: (v: CriterionConfig[]) => void
    canEdit: boolean
}) {
    function update(i: number, patch: Partial<CriterionConfig>) {
        setCriteria(criteria.map((c, idx) => idx === i ? { ...c, ...patch } : c))
    }
    function remove(i: number) {
        if (!confirm(`Удалить критерий «${criteria[i].label}»?`)) return
        setCriteria(criteria.filter((_, idx) => idx !== i).map((c, idx) => ({ ...c, order: idx + 1 })))
    }
    function move(i: number, dir: -1 | 1) {
        const j = i + dir
        if (j < 0 || j >= criteria.length) return
        const next = [...criteria]
        ;[next[i], next[j]] = [next[j], next[i]]
        setCriteria(next.map((c, idx) => ({ ...c, order: idx + 1 })))
    }
    function add() {
        const newCriterion: CriterionConfig = {
            key: `criterion_${Date.now().toString(36)}`,
            label: 'Новый критерий',
            description: '',
            scaleMax: 10,
            weight: 1,
            isActive: true,
            order: criteria.length + 1,
        }
        setCriteria([...criteria, newCriterion])
    }

    return (
        <section className="flex flex-col gap-[4px]">
            <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-[4px]">
                <div className="flex items-start gap-[2px] text-[13px] text-muted-foreground">
                    <Info className="h-[4px] w-[4px] shrink-0 mt-0.5 text-primary" />
                    <div>
                        AI поставит каждому критерию балл от 1 до выбранной шкалы (обычно 1–10).
                        Чем выше «важность критерия», тем сильнее он влияет на общую оценку звонка.
                        Выключите ненужные критерии переключателем — они не пойдут в анализ.
                    </div>
                </div>
                {canEdit && (
                    <button
                        onClick={add}
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-dark transition-colors"
                    >
                        <Plus className="h-[4px] w-[4px]" />
                        Добавить критерий
                    </button>
                )}
            </div>

            {criteria.length === 0 && (
                <div className="rounded-md border border-dashed border-border bg-surface p-[8px] text-center text-[13px] text-muted-foreground">
                    Критериев нет. Добавьте хотя бы один, иначе AI не сможет оценить звонок.
                </div>
            )}

            <div className="flex flex-col gap-3">
                {criteria.map((c, i) => (
                    <CriterionCard
                        key={i}
                        index={i}
                        total={criteria.length}
                        criterion={c}
                        canEdit={canEdit}
                        onUpdate={(patch) => update(i, patch)}
                        onMoveUp={() => move(i, -1)}
                        onMoveDown={() => move(i, 1)}
                        onRemove={() => remove(i)}
                    />
                ))}
            </div>
        </section>
    )
}

function CriterionCard({
    index, total, criterion, canEdit,
    onUpdate, onMoveUp, onMoveDown, onRemove,
}: {
    index: number
    total: number
    criterion: CriterionConfig
    canEdit: boolean
    onUpdate: (patch: Partial<CriterionConfig>) => void
    onMoveUp: () => void
    onMoveDown: () => void
    onRemove: () => void
}) {
    const [showAdvanced, setShowAdvanced] = useState(false)

    return (
        <div className={`flex flex-col gap-3 rounded-md border bg-card p-[4px] transition-opacity ${criterion.isActive ? 'border-border' : 'border-dashed border-border opacity-60'}`}>
            {/* Header: name + activation */}
            <div className="flex items-center gap-3">
                <span className="flex h-[8px] w-[8px] shrink-0 items-center justify-center rounded-full bg-primary/10 text-[13px] font-bold text-primary">
                    {index + 1}
                </span>
                <input
                    disabled={!canEdit}
                    value={criterion.label}
                    onChange={(e) => onUpdate({
                        label: e.target.value,
                        // Auto-update key only if user hasn't manually customised it
                        // (key still matches the slug of the previous label).
                        key: slugify(criterion.label) === criterion.key ? slugify(e.target.value) : criterion.key,
                    })}
                    placeholder="Название критерия"
                    className="h-10 flex-1 rounded-md border border-border bg-background px-3 text-[15px] font-medium outline-none focus:border-primary disabled:opacity-60"
                />
                <label className="flex items-center gap-[2px] text-[12px] text-muted-foreground whitespace-nowrap">
                    <span>{criterion.isActive ? 'Активен' : 'Выключен'}</span>
                    <Toggle checked={criterion.isActive} onChange={(v) => onUpdate({ isActive: v })} disabled={!canEdit} />
                </label>
            </div>

            {/* Description */}
            <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-muted-foreground">
                    Что именно проверяем
                </label>
                <textarea
                    disabled={!canEdit}
                    value={criterion.description}
                    onChange={(e) => onUpdate({ description: e.target.value })}
                    placeholder="Опишите, на что AI должен обращать внимание в этом критерии"
                    rows={2}
                    className="min-h-[60px] w-full rounded-md border border-border bg-background px-3 py-[2px] text-[13.5px] leading-[1.5] outline-none focus:border-primary disabled:opacity-60 resize-y"
                />
            </div>

            {/* Weight as pill switcher + action buttons. Three preset weights
                cover 90% of cases (low / normal / high); for power users a
                custom number lives under «Дополнительно». */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <WeightPills
                    weight={criterion.weight}
                    onChange={(w) => onUpdate({ weight: w })}
                    disabled={!canEdit}
                />

                <div className="flex items-center gap-1">
                    <button
                        disabled={!canEdit || index === 0}
                        onClick={onMoveUp}
                        className="h-9 px-2.5 inline-flex items-center justify-center gap-1 rounded-md border border-border text-[12px] text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="Переместить выше"
                    >
                        <ArrowUp className="h-3.5 w-3.5" />
                        Выше
                    </button>
                    <button
                        disabled={!canEdit || index === total - 1}
                        onClick={onMoveDown}
                        className="h-9 px-2.5 inline-flex items-center justify-center gap-1 rounded-md border border-border text-[12px] text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="Переместить ниже"
                    >
                        <ArrowDown className="h-3.5 w-3.5" />
                        Ниже
                    </button>
                    <button
                        disabled={!canEdit}
                        onClick={onRemove}
                        className="h-9 px-2.5 inline-flex items-center justify-center gap-1 rounded-md border border-border text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="Удалить критерий"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        Удалить
                    </button>
                </div>
            </div>

            {/* Advanced — scale, custom weight, technical key */}
            <button
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                className="inline-flex items-center gap-1.5 self-start text-[11px] text-muted-foreground hover:text-foreground"
            >
                <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                Дополнительно
            </button>
            {showAdvanced && (
                <div className="flex flex-col gap-[2px] rounded-md bg-surface px-3 py-3 text-[12px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-3">
                        <label className="inline-flex items-center gap-[2px] whitespace-nowrap">
                            Шкала оценок — от 1 до
                            <input
                                disabled={!canEdit}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={criterion.scaleMax}
                                onChange={(e) => {
                                    const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
                                    onUpdate({ scaleMax: Number.isFinite(n) && n >= 2 ? Math.min(n, 100) : 10 })
                                }}
                                className="h-[8px] w-[16px] rounded border border-border bg-background px-[2px] text-center text-[13px] font-semibold text-foreground outline-none focus:border-primary disabled:opacity-60"
                            />
                        </label>
                        <label className="inline-flex items-center gap-[2px] whitespace-nowrap">
                            Произвольный вес
                            <input
                                disabled={!canEdit}
                                type="text"
                                inputMode="decimal"
                                value={criterion.weight}
                                onChange={(e) => {
                                    const raw = e.target.value.replace(',', '.').replace(/[^\d.]/g, '')
                                    const n = parseFloat(raw)
                                    onUpdate({ weight: Number.isFinite(n) ? n : 0 })
                                }}
                                className="h-[8px] w-20 rounded border border-border bg-background px-[2px] text-center text-[13px] font-semibold text-foreground outline-none focus:border-primary disabled:opacity-60"
                                title="0.5 / 1.0 / 1.5 покрывают 99% случаев. Здесь — для тонкой настройки."
                            />
                        </label>
                    </div>
                    <label className="inline-flex items-center gap-[2px] whitespace-nowrap">
                        Технический ключ
                        <input
                            disabled={!canEdit}
                            value={criterion.key}
                            onChange={(e) => onUpdate({ key: e.target.value.trim() })}
                            className="h-7 flex-1 rounded border border-border bg-background px-[2px] font-mono text-[11px] text-foreground outline-none focus:border-primary disabled:opacity-60"
                        />
                    </label>
                </div>
            )}
        </div>
    )
}

// ── Weight pill switcher (Низкая 0.5 / Обычная 1.0 / Высокая 1.5) ────────

function WeightPills({
    weight, onChange, disabled,
}: {
    weight: number
    onChange: (w: number) => void
    disabled?: boolean
}) {
    const presets: { value: number; label: string; hint: string }[] = [
        { value: 0.5, label: 'Низкая',  hint: 'Меньше влияет на общую оценку' },
        { value: 1.0, label: 'Обычная', hint: 'Стандартный вес' },
        { value: 1.5, label: 'Высокая', hint: 'Сильнее влияет на общую оценку' },
    ]
    // Match by tolerance — weights stored as float can wobble.
    const activeIdx = presets.findIndex(p => Math.abs(p.value - weight) < 0.05)
    const isCustom = activeIdx === -1

    return (
        <div className="flex items-center gap-[2px]">
            <span className="text-[12px] text-muted-foreground whitespace-nowrap">Важность:</span>
            <div className="inline-flex rounded-md border border-border bg-background p-0.5">
                {presets.map((p, i) => {
                    const active = i === activeIdx
                    return (
                        <button
                            key={p.value}
                            disabled={disabled}
                            onClick={() => onChange(p.value)}
                            title={p.hint}
                            className={[
                                'h-7 px-3 rounded text-[12px] font-medium transition-colors',
                                active
                                    ? 'bg-primary text-white shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-surface',
                                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                            ].join(' ')}
                        >
                            {p.label}
                        </button>
                    )
                })}
                {isCustom && (
                    <span className="inline-flex h-7 items-center px-3 rounded bg-surface text-[12px] font-mono font-semibold text-foreground">
                        {weight}
                    </span>
                )}
            </div>
        </div>
    )
}

// ── Options editor (cards) ───────────────────────────────────────────────

function OptionsEditor({
    title, hint, addLabel, options, setOptions, canEdit,
}: {
    title: string
    hint: string
    addLabel: string
    options: OptionConfig[]
    setOptions: (v: OptionConfig[]) => void
    canEdit: boolean
}) {
    function update(i: number, patch: Partial<OptionConfig>) {
        setOptions(options.map((o, idx) => idx === i ? { ...o, ...patch } : o))
    }
    function remove(i: number) {
        if (!confirm(`Удалить «${options[i].label}»?`)) return
        setOptions(options.filter((_, idx) => idx !== i).map((o, idx) => ({ ...o, order: idx + 1 })))
    }
    function move(i: number, dir: -1 | 1) {
        const j = i + dir
        if (j < 0 || j >= options.length) return
        const next = [...options]
        ;[next[i], next[j]] = [next[j], next[i]]
        setOptions(next.map((o, idx) => ({ ...o, order: idx + 1 })))
    }
    function add() {
        setOptions([...options, {
            key: `option_${Date.now().toString(36)}`,
            label: 'Новый вариант',
            isActive: true,
            order: options.length + 1,
        }])
    }

    return (
        <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-[4px]">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="text-[15px] font-semibold text-foreground">{title}</div>
                    <div className="text-[13px] text-muted-foreground">{hint}</div>
                </div>
                {canEdit && (
                    <button
                        onClick={add}
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-dark transition-colors"
                    >
                        <Plus className="h-[4px] w-[4px]" />
                        {addLabel}
                    </button>
                )}
            </div>
            <div className="flex flex-col gap-[2px]">
                {options.length === 0 && (
                    <div className="rounded-md border border-dashed border-border bg-surface p-[4px] text-center text-[13px] text-muted-foreground">
                        Список пуст.
                    </div>
                )}
                {options.map((o, i) => (
                    <OptionRow
                        key={i}
                        index={i}
                        total={options.length}
                        option={o}
                        canEdit={canEdit}
                        onUpdate={(patch) => update(i, patch)}
                        onMoveUp={() => move(i, -1)}
                        onMoveDown={() => move(i, 1)}
                        onRemove={() => remove(i)}
                    />
                ))}
            </div>
        </section>
    )
}

function OptionRow({
    index, total, option, canEdit, onUpdate, onMoveUp, onMoveDown, onRemove,
}: {
    index: number
    total: number
    option: OptionConfig
    canEdit: boolean
    onUpdate: (patch: Partial<OptionConfig>) => void
    onMoveUp: () => void
    onMoveDown: () => void
    onRemove: () => void
}) {
    return (
        <div className={`flex items-center gap-[2px] rounded-md border bg-background p-2.5 ${option.isActive ? 'border-border' : 'border-dashed border-border opacity-60'}`}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-bold text-primary">
                {index + 1}
            </span>
            <input
                disabled={!canEdit}
                value={option.label}
                onChange={(e) => onUpdate({
                    label: e.target.value,
                    key: slugify(option.label) === option.key ? slugify(e.target.value) : option.key,
                })}
                placeholder="Название варианта"
                className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-[14px] outline-none focus:border-primary disabled:opacity-60"
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>{option.isActive ? 'Вкл' : 'Выкл'}</span>
                <Toggle checked={option.isActive} onChange={(v) => onUpdate({ isActive: v })} disabled={!canEdit} />
            </label>
            <button
                disabled={!canEdit || index === 0}
                onClick={onMoveUp}
                className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Выше"
            >
                <ArrowUp className="h-[4px] w-[4px]" />
            </button>
            <button
                disabled={!canEdit || index === total - 1}
                onClick={onMoveDown}
                className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Ниже"
            >
                <ArrowDown className="h-[4px] w-[4px]" />
            </button>
            <button
                disabled={!canEdit}
                onClick={onRemove}
                className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Удалить"
            >
                <Trash2 className="h-[4px] w-[4px]" />
            </button>
        </div>
    )
}

// ── Advanced tab (model + legacy prompt) ─────────────────────────────────

function AdvancedTab({
    model, setModel, systemPrompt, setSystemPrompt, defaultPrompt, canEdit,
}: {
    model: string
    setModel: (v: string) => void
    systemPrompt: string
    setSystemPrompt: (v: string) => void
    defaultPrompt: string
    canEdit: boolean
}) {
    const [showPrompt, setShowPrompt] = useState(false)
    return (
        <div className="flex flex-col gap-[4px]">
            <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-5">
                <label className="text-[14px] font-semibold text-foreground" htmlFor="model">
                    Модель OpenAI
                </label>
                <select
                    id="model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={!canEdit}
                    className="h-11 rounded-md border border-border bg-background px-3 text-[14px] outline-none focus:border-primary disabled:opacity-60"
                >
                    {!MODEL_OPTIONS.some(o => o.value === model) && (
                        <option value={model}>{model} (custom)</option>
                    )}
                    {MODEL_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <p className="text-[12px] text-muted-foreground">
                    GPT-4o рекомендован: достаточно глубоко рассуждает, чтобы пройти по 10 критериям, и быстро отвечает.
                    Mini подходит, если звонков много и нужно сэкономить.
                </p>
            </section>

            <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-5">
                <div className="flex items-start gap-[2px] text-[13px] text-muted-foreground">
                    <Info className="h-[4px] w-[4px] shrink-0 mt-0.5 text-primary" />
                    <div>
                        Системный промт для AI <strong>автоматически собирается</strong> из критериев и справочников.
                        Эта текстовая форма ниже используется только если на вкладке «Критерии оценки» <em>нет ни одного</em>
                        активного критерия — как запасной вариант. В обычной работе её трогать не нужно.
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => setShowPrompt(v => !v)}
                    className="inline-flex items-center gap-1.5 self-start rounded-md border border-border bg-background px-3 py-[2px] text-[12px] text-muted-foreground hover:bg-surface hover:text-foreground transition-colors"
                >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showPrompt ? 'rotate-180' : ''}`} />
                    {showPrompt ? 'Скрыть запасной промт' : 'Показать запасной промт (для опытных)'}
                </button>

                {showPrompt && (
                    <>
                        <div className="flex items-center justify-end">
                            {canEdit && (
                                <button
                                    type="button"
                                    onClick={() => setSystemPrompt(defaultPrompt)}
                                    className="inline-flex items-center gap-1 rounded-md px-[2px] py-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-surface"
                                >
                                    <RotateCcw className="h-3 w-3" />
                                    Сбросить к шаблону
                                </button>
                            )}
                        </div>
                        <textarea
                            value={systemPrompt}
                            onChange={(e) => setSystemPrompt(e.target.value)}
                            disabled={!canEdit}
                            rows={12}
                            className="min-h-[260px] w-full rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-[1.5] outline-none focus:border-primary disabled:opacity-60"
                        />
                    </>
                )}
            </section>
        </div>
    )
}

// ── Toggle ───────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => !disabled && onChange(!checked)}
            disabled={disabled}
            className={[
                'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors',
                checked ? 'bg-primary' : 'bg-border',
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            ].join(' ')}
        >
            <span
                className={[
                    'inline-block h-5 w-5 transform rounded-full bg-white transition-transform',
                    checked ? 'translate-x-5' : 'translate-x-0.5',
                ].join(' ')}
            />
        </button>
    )
}
