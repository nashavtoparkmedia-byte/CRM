'use client'

// ═══════════════════════════════════════════════════════════════════
// List Cell Renderers — single source of truth for rendering
// any list column for any scenario.
//
// A renderer is { getValue(task), render(value, task, ctx) }.
// Column's source.kind selects a default value extractor, but a
// renderer may override it (e.g. offerAllowed uses a DTO field).
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from './types'
import type { ListColumnDef } from './list-schema'
import { getScenario, getStage, getScenarioFields, type ScenarioFieldDef } from './scenario-config'
import { verdictColor, verdictLabel, type OfferVerdict } from './offer-rules'

export interface RenderContext {
    scenarioId: string | null
    density: 'compact' | 'standard' | 'comfortable'
    mode: 'operational' | 'control' | 'table'
}

export interface FieldRenderer {
    getValue: (task: TaskDTO) => unknown
    render: (value: unknown, task: TaskDTO, ctx: RenderContext) => React.ReactNode
}

// ─── Default value extractors per source.kind ────────────────────────

function extractValue(task: TaskDTO, col: ListColumnDef): unknown {
    const src = col.source
    switch (src.kind) {
        case 'task':
            return (task as unknown as Record<string, unknown>)[src.field]
        case 'driver':
            if (src.field === 'fullName') return task.driverName
            if (src.field === 'phone')    return task.driverPhone
            return null
        case 'scenarioData': {
            // preview array holds fields flattened; we use task DTO fallback paths
            const preview = task.scenarioFieldsPreview ?? []
            const hit = preview.find(p => p.fieldId === src.fieldId)
            return hit ? hit.value : null
        }
        case 'derived':
            return (task as unknown as Record<string, unknown>)[src.id] ?? null
        case 'computed':
            return null  // computed renderers override getValue
    }
}

// ─── Common cell wrappers ────────────────────────────────────────────

function EmptyCell() {
    return <span className="text-[#CBD5E1]">—</span>
}

function TextCell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return <span className={`text-[13px] text-[#0F172A] truncate ${className}`}>{children}</span>
}

function MutedCell({ children }: { children: React.ReactNode }) {
    return <span className="text-[12px] text-[#64748B] truncate">{children}</span>
}

function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return (
        <span className={`inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium whitespace-nowrap ${className}`}>
            {children}
        </span>
    )
}

// ─── Enum option lookups ─────────────────────────────────────────────

function findEnumOption(scenarioId: string | null, fieldId: string, value: unknown): { value: string; label: string } | null {
    if (!scenarioId) return null
    const field = getScenarioFields(scenarioId).find(f => f.id === fieldId) as ScenarioFieldDef | undefined
    if (!field?.enumOptions) return null
    return field.enumOptions.find(o => o.value === String(value)) ?? null
}

function renderEnumValue(fieldId: string, value: unknown, ctx: RenderContext): React.ReactNode {
    if (value === null || value === undefined || value === '') return <EmptyCell />
    const opt = findEnumOption(ctx.scenarioId, fieldId, value)
    const label = opt?.label ?? String(value)
    return <TextCell>{label}</TextCell>
}

// ─── Date helpers ────────────────────────────────────────────────────

/**
 * Valid if parseable AND not a sentinel/epoch-like value.
 * Rejects dates before 2010 (epoch 0, stale seeds, etc.) and after 2200.
 */
const MIN_VALID_YEAR = 2010
const MAX_VALID_YEAR = 2200

function isValidDate(iso: string | null | undefined): boolean {
    if (!iso) return false
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return false
    const y = d.getFullYear()
    return y >= MIN_VALID_YEAR && y <= MAX_VALID_YEAR
}

function formatRelativeDate(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = d.getTime() - now.getTime()
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays < -30) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' })
    if (diffDays < -1)  return `${Math.abs(diffDays)} дн. назад`
    if (diffDays < 0)   return 'Вчера'
    if (diffDays === 0) return 'Сегодня'
    if (diffDays === 1) return 'Завтра'
    if (diffDays < 8)   return `через ${diffDays} дн.`
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function dateColorClass(iso: string | null | undefined): string {
    if (!iso) return 'text-[#64748B]'
    const diffMs = new Date(iso).getTime() - Date.now()
    if (diffMs < 0) return 'text-[#DC2626] font-semibold'                          // red — overdue
    if (diffMs < 6 * 60 * 60 * 1000) return 'text-[#EA580C] font-semibold'         // orange — today/soon
    if (diffMs < 24 * 60 * 60 * 1000) return 'text-[#CA8A04]'                      // yellow — tomorrow
    return 'text-[#0F172A]'
}

// ─── Short action (title) label ──────────────────────────────────────

const ACTION_TYPE_SHORT: Record<string, string> = {
    check_docs: 'Проверить документы',
    call_back: 'Перезвонить',
    inactive_followup: 'Проверить реактивацию',
    payment_issue: 'Выплата',
    care: 'Контроль',
    other: 'Действие',
}

function getShortActionLabel(task: TaskDTO): string {
    if (task.status === 'waiting_reply') return 'Ждём ответ'
    if (task.status === 'snoozed') return 'Отложено'
    if (!task.isActive) return 'Закрыт'
    return ACTION_TYPE_SHORT[task.type] ?? (task.type || 'Действие')
}

// ─── Badge styles ────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
    todo:          'bg-[#F1F5F9] text-[#334155]',
    in_progress:   'bg-[#DBEAFE] text-[#1E40AF]',
    waiting_reply: 'bg-[#FEF3C7] text-[#92400E]',
    overdue:       'bg-[#FEE2E2] text-[#B91C1C]',
    snoozed:       'bg-[#F1F5F9] text-[#64748B]',
    done:          'bg-[#DCFCE7] text-[#166534]',
    cancelled:     'bg-[#F1F5F9] text-[#64748B]',
    archived:      'bg-[#F1F5F9] text-[#64748B]',
}
const STATUS_LABEL: Record<string, string> = {
    todo: 'В работу', in_progress: 'В работе', waiting_reply: 'Жду ответ',
    overdue: 'Просрочено', snoozed: 'Отложено', done: 'Готово',
    cancelled: 'Отменено', archived: 'В архиве',
}
const PRIORITY_STYLE: Record<string, string> = {
    critical: 'bg-[#FEE2E2] text-[#B91C1C]',
    high:     'bg-[#FED7AA] text-[#9A3412]',
    medium:   'bg-[#DBEAFE] text-[#1E40AF]',
    low:      'bg-[#F1F5F9] text-[#64748B]',
}
const PRIORITY_LABEL: Record<string, string> = {
    critical: 'Критический', high: 'Высокий', medium: 'Средний', low: 'Низкий',
}

// ─── Task type → channel labels ──────────────────────────────────────

const CHANNEL_LABEL: Record<string, string> = {
    check_docs: 'Документы',
    call_back: 'Звонок',
    inactive_followup: 'Связаться',
    payment_issue: 'Выплата',
    other: 'Другое',
    care: 'Забота',
}
const CONTACT_TYPE_LABEL: Record<string, string> = {
    called: 'Звонок',
    wrote: 'Сообщение',
    message_sent: 'Сообщение',
    contacted: 'Контакт',
}
const CONTACT_RESULT_LABEL: Record<string, string> = {
    answered: 'Дозвонились',
    no_answer: 'Не дозвон',
    busy: 'Занято',
    callback: 'Перезвонить',
    positive: 'Положительно',
    neutral: 'Нейтрально',
    negative: 'Отрицательно',
    message_sent: 'Отправлено',
    message_read: 'Прочитано',
    // Fallbacks when the inline action didn't carry a resultId — we show the type instead
    called: 'Звонок (без деталей)',
    wrote: 'Сообщение (без деталей)',
    contacted: 'Контакт',
}

// ─── Renderer registry ───────────────────────────────────────────────

const RENDERERS: Record<string, FieldRenderer> = {
    // Block 1: Идентификация
    fullName: {
        getValue: t => t.driverName,
        render: v => <span className="text-[14px] font-semibold text-[#0F172A] truncate">{String(v ?? '')}</span>,
    },
    licenseNumber: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'licenseNumber')?.value ?? null,
        render: v => v ? <MutedCell>{String(v)}</MutedCell> : <EmptyCell />,
    },
    phone: {
        getValue: t => t.driverPhone,
        render: v => v ? <MutedCell>{String(v)}</MutedCell> : <EmptyCell />,
    },
    project: {
        getValue: () => null,
        render: () => <EmptyCell />,
    },
    assignee: {
        getValue: t => t.assignee?.name ?? null,
        render: v => v ? <TextCell>{String(v)}</TextCell> : <EmptyCell />,
    },

    // Block 2: Управление кейсом
    stage: {
        getValue: t => t.stage,
        render: (v, t) => {
            if (!v || !t.scenario) return <EmptyCell />
            const stage = getStage(t.scenario, String(v))
            return <Badge className="bg-[#EEF2FF] text-[#4338CA]">{stage?.label ?? String(v)}</Badge>
        },
    },
    status: {
        getValue: t => t.status,
        render: v => {
            const key = String(v ?? '')
            return <Badge className={STATUS_STYLE[key] ?? 'bg-[#F1F5F9] text-[#334155]'}>{STATUS_LABEL[key] ?? key}</Badge>
        },
    },
    priority: {
        getValue: t => t.priority,
        render: v => {
            const key = String(v ?? '')
            return <Badge className={PRIORITY_STYLE[key] ?? ''}>{PRIORITY_LABEL[key] ?? key}</Badge>
        },
    },

    // Block 3: Контекст водителя
    yandexActive: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'yandexActive')?.value ?? null,
        render: (v, _t, ctx) => renderEnumValue('yandexActive', v, ctx),
    },
    externalParkName: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'externalParkName')?.value ?? null,
        render: v => v ? <TextCell>{String(v)}</TextCell> : <EmptyCell />,
    },
    isSelfEmployed: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'isSelfEmployed')?.value ?? null,
        render: (v, _t, ctx) => renderEnumValue('isSelfEmployed', v, ctx),
    },
    yandexTripsCount: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'yandexTripsCount')?.value ?? null,
        render: v => (v === null || v === undefined) ? <EmptyCell /> : <TextCell className="font-medium">{String(v)}</TextCell>,
    },
    inactiveDays: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'inactiveDays')?.value ?? null,
        render: v => {
            if (v === null || v === undefined) return <EmptyCell />
            const n = Number(v)
            const cls = n >= 14 ? 'text-[#DC2626] font-semibold' : n >= 7 ? 'text-[#CA8A04]' : 'text-[#0F172A]'
            return <TextCell className={cls}>{n}</TextCell>
        },
    },
    churnReason: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'churnReason')?.value ?? null,
        render: (v, _t, ctx) => renderEnumValue('churnReason', v, ctx),
    },

    // Block 4: Последний контакт
    lastContactAt: {
        getValue: t => t.lastContactAt,
        render: v => isValidDate(v as string | null) ? <MutedCell>{formatRelativeDate(String(v))}</MutedCell> : <EmptyCell />,
    },
    lastContactType: {
        getValue: t => t.lastContactType,
        render: v => {
            if (!v) return <EmptyCell />
            const label = CONTACT_TYPE_LABEL[String(v)] ?? String(v)
            return <TextCell>{label}</TextCell>
        },
    },
    lastContactResult: {
        getValue: t => t.lastContactResult,
        render: v => {
            if (!v) return <EmptyCell />
            const label = CONTACT_RESULT_LABEL[String(v)] ?? String(v)
            return <TextCell>{label}</TextCell>
        },
    },
    lastContactBy: {
        getValue: t => t.lastContactBy,
        render: v => v ? <MutedCell>{String(v)}</MutedCell> : <EmptyCell />,
    },

    // Block 5: Следующее действие
    nextActionTitle: {
        // Short label derived from task.status + task.type; full task.title in tooltip.
        getValue: t => getShortActionLabel(t),
        render: (v, t) => {
            const short = String(v ?? '')
            if (!short) return <EmptyCell />
            const tooltip = t.title && t.title !== short ? t.title : undefined
            return <span className="text-[13px] text-[#0F172A] truncate" title={tooltip}>{short}</span>
        },
    },
    nextActionChannel: {
        getValue: t => t.type,
        render: v => {
            if (!v) return <EmptyCell />
            return <TextCell>{CHANNEL_LABEL[String(v)] ?? String(v)}</TextCell>
        },
    },
    nextActionAt: {
        getValue: t => t.nextActionAt,
        render: v => {
            if (!isValidDate(v as string | null)) return <EmptyCell />
            return <span className={`text-[13px] whitespace-nowrap ${dateColorClass(String(v))}`}>{formatRelativeDate(String(v))}</span>
        },
    },
    mandatoryContact: {
        getValue: () => null,
        render: () => <EmptyCell />,
    },
    isOverdue: {
        getValue: t => {
            const at = t.nextActionAt ? new Date(t.nextActionAt).getTime() : null
            return t.status === 'overdue' || (at !== null && at < Date.now())
        },
        render: v => v
            ? <Badge className="bg-[#FEE2E2] text-[#B91C1C]">Да</Badge>
            : <MutedCell>нет</MutedCell>,
    },

    // Block 6: Управление возвратом
    offerType: {
        getValue: t => t.scenarioFieldsPreview?.find(p => p.fieldId === 'offerType')?.value ?? null,
        render: v => v ? <TextCell>{String(v)}</TextCell> : <EmptyCell />,
    },
    offerAllowed: {
        getValue: t => t.offerAllowed?.verdict ?? null,
        render: (v, t) => {
            if (!v || !t.offerAllowed) return <EmptyCell />
            const verdict = v as OfferVerdict
            const c = verdictColor(verdict)
            return (
                <span
                    title={t.offerAllowed.reason}
                    className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded text-[12px] font-semibold ${c.bg} ${c.text}`}
                >
                    <span className={`w-[8px] h-[8px] rounded-full ${c.dot}`} />
                    {verdictLabel(verdict)}
                    {t.offerAllowed.isOverridden && <span className="text-[10px] opacity-70">(вручную)</span>}
                </span>
            )
        },
    },
    offerReason: {
        getValue: t => t.offerAllowed?.reason ?? null,
        render: v => v ? <MutedCell>{String(v)}</MutedCell> : <EmptyCell />,
    },
    returnResult: {
        getValue: t => t.closedReason,
        render: (v, t) => {
            if (!v || !t.scenario) return <EmptyCell />
            const scenario = getScenario(t.scenario)
            const opt = scenario?.closedReasons.find(r => r.value === String(v))
            return <TextCell>{opt?.label ?? String(v)}</TextCell>
        },
    },
    closedAt: {
        getValue: t => t.resolvedAt,
        render: v => isValidDate(v as string | null) ? <MutedCell>{formatRelativeDate(String(v))}</MutedCell> : <EmptyCell />,
    },
}

// ─── Public API ──────────────────────────────────────────────────────

export function getRenderer(columnId: string): FieldRenderer | undefined {
    return RENDERERS[columnId]
}

export function getValue(task: TaskDTO, col: ListColumnDef): unknown {
    const r = RENDERERS[col.id]
    if (r) return r.getValue(task)
    return extractValue(task, col)
}

export function renderCell(
    task: TaskDTO,
    col: ListColumnDef,
    ctx: RenderContext,
): React.ReactNode {
    const r = RENDERERS[col.id]
    if (r) return r.render(r.getValue(task), task, ctx)
    const value = extractValue(task, col)
    return value === null || value === undefined || value === ''
        ? <EmptyCell />
        : <TextCell>{String(value)}</TextCell>
}
