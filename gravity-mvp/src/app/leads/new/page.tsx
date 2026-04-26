'use client'

/**
 * /leads/new — унифицированная витрина новых лидов всех источников.
 *
 * Это **read-only** dashboard, а не место работы. Оператор работает с
 * лидами в /messages (куда они автоматически попадают через
 * LeadIntake-сервис). Здесь — KPI + полный журнал входящих + диплинки
 * на Chat / Task / диалог в источнике.
 *
 * Дизайн: Tailwind + shadcn/ui. Без кастомного CSS — соответствует
 * остальной CRM (Telegram-подобный flat-стиль, см. CLAUDE.md → Design
 * System).
 *
 * Pipeline (как лид попадает сюда):
 *   avito-worker создаёт avito_responses
 *     → LeadIntake (auto / catchup-sync) создаёт Contact + Chat + Message
 *     → /api/leads/new возвращает строку с заполненными crm_*_id
 *     → Эта страница рендерит её с ссылками на Chat / Task
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Phone, MessageSquare, ExternalLink, RefreshCw, Megaphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  LEAD_SOURCES,
  LEAD_STATUS_LABEL_RU,
  type InboxLead,
  type LeadInboxMetrics,
  type LeadInboxStatus,
  type LeadSource,
} from '@/lib/leads/types'

type SourceFilter = 'all' | LeadSource
type StatusFilter = 'all' | LeadInboxStatus

// Цветовые классы Tailwind для бейджа источника. Совпадает с
// LEAD_SOURCES.badgeColor по смыслу, но через готовые tw-классы для
// контраста текст/фон.
const SOURCE_BADGE_CLASS: Record<LeadSource, string> = {
  avito: 'bg-green-100 text-green-800 border-green-200',
  site: 'bg-sky-100 text-sky-800 border-sky-200',
  whatsapp: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  telegram: 'bg-blue-100 text-blue-800 border-blue-200',
  phone: 'bg-slate-100 text-slate-700 border-slate-200',
}

const STATUS_BADGE_CLASS: Record<LeadInboxStatus, string> = {
  new: 'bg-amber-100 text-amber-800 border-amber-200',
  in_progress: 'bg-blue-100 text-blue-800 border-blue-200',
  processed: 'bg-slate-100 text-slate-600 border-slate-200',
}

function fmt(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function truncate(s: string | null, n: number): string {
  if (!s) return '—'
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

export default function LeadsInboxPage() {
  const [leads, setLeads] = useState<InboxLead[]>([])
  const [metrics, setMetrics] = useState<LeadInboxMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  async function load() {
    try {
      const [leadsRes, metricsRes] = await Promise.all([
        fetch('/api/leads/new', { cache: 'no-store' }),
        fetch('/api/leads/new/metrics', { cache: 'no-store' }),
      ])
      const leadsJson = await leadsRes.json()
      const metricsJson = await metricsRes.json()
      if (!leadsRes.ok) throw new Error(leadsJson.error ?? 'leads load error')
      if (!metricsRes.ok)
        throw new Error(metricsJson.error ?? 'metrics load error')
      setLeads(leadsJson.leads ?? [])
      setMetrics(metricsJson)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 5-сек polling — то же поведение что было на /avito
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  // Ручная пометка лида обработанным. Сейчас это «временный» путь —
  // потом, когда прикрутим задачи, статус будет меняться автоматически
  // когда оператор закроет связанный Task. А пока — напрямую тут, для
  // лидов без телефона (которые не дойдут до auto-processing) или для
  // ручной чистки inbox.
  const [actingId, setActingId] = useState<string | null>(null)
  async function markProcessed(lead: InboxLead) {
    if (lead.source !== 'avito') {
      // Для других источников endpoint mark-processed появится позже.
      return
    }
    setActingId(lead.id)
    try {
      const res = await fetch(
        `/api/avito/responses/${lead.sourceId}/mark-processed`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'mark-processed failed')
      // Оптимистичное обновление: сразу проставляем processedAt и status
      // в локальном state, чтобы UI не ждал следующего polling-тика.
      setLeads((prev) =>
        prev.map((l) =>
          l.id === lead.id
            ? {
                ...l,
                status: 'processed',
                sourceStatus: 'обработан',
                processedAt: json.processedAt ?? new Date().toISOString(),
              }
            : l,
        ),
      )
    } catch (e) {
      alert(`Не удалось обработать лид: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setActingId(null)
    }
  }

  // Catchup-sync — кнопка для оператора: «догнать» все исторические лиды,
  // которые ещё не привязаны к Chat (полезно при первом включении или
  // если webhook от Avito-worker не настроен).
  async function runSync() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch('/api/leads/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'sync failed')
      setSyncMsg(
        `Обработано: ${json.processed}, телефонов догружено: ${json.phoneUpdated}, ошибок: ${json.errors?.length ?? 0}`,
      )
      await load()
    } catch (e) {
      setSyncMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  // Применяем фильтры на клиенте — список не больше 200-500 строк,
  // overhead копеечный, проще чем серверный roundtrip на каждый клик.
  const filtered = useMemo(() => {
    return leads.filter((l) => {
      if (sourceFilter !== 'all' && l.source !== sourceFilter) return false
      if (statusFilter !== 'all' && l.status !== statusFilter) return false
      return true
    })
  }, [leads, sourceFilter, statusFilter])

  // Счётчики для чипсов источников — строятся из текущих leads без
  // учёта statusFilter, чтобы операторам было видно сколько всего
  // лидов в каждом источнике.
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = { all: leads.length }
    for (const s of LEAD_SOURCES) counts[s.key] = 0
    for (const l of leads) counts[l.source] = (counts[l.source] ?? 0) + 1
    return counts
  }, [leads])

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Новые лиды
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Точка сборки лидов всех источников. Оператор работает с
            ними в разделе{' '}
            <Link href="/messages" className="text-primary hover:underline">
              Чаты
            </Link>
            .
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Быстрый переход в управление источниками. Пока единственный
              подключённый канал — Avito; при добавлении сайта/whatsapp
              сюда логично положить dropdown «Источники → …». */}
          <Button asChild variant="outline" size="sm" title="Управление профилями Avito-скрапера">
            <Link href="/settings/integrations/avito">
              <Megaphone className="mr-2 h-4 w-4" />
              Профили Avito
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runSync}
            disabled={syncing}
            title="Проверить, что все отклики Avito появились в Чатах. Если что-то потерялось из-за выключенного робота-сборщика или сетевого сбоя — поднять сейчас. Безопасно нажимать сколько угодно раз — дублей не будет."
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`}
            />
            {syncing ? 'Сверяем…' : 'Сверка с Avito'}
          </Button>
        </div>
      </div>

      {syncMsg && (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          {syncMsg}
        </div>
      )}

      {/* ── KPI плашка ──────────────────────────────────────────────── */}
      {metrics && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard
            label="Сегодня"
            value={metrics.today.total}
            sub={
              metrics.today.bySource.avito > 0
                ? `Avito: ${metrics.today.bySource.avito}`
                : 'нет лидов'
            }
          />
          <KpiCard label="Вчера" value={metrics.yesterday.total} />
          <KpiCard
            label="7 дней"
            value={metrics.last7Days.total}
            sub="всего за неделю"
          />
          <KpiCard
            label="Не обработано"
            value={metrics.unprocessed}
            sub={
              metrics.withoutPhone > 0
                ? `${metrics.withoutPhone} без телефона`
                : 'все с телефонами'
            }
            warning={metrics.unprocessed > 0}
          />
        </div>
      )}

      {/* ── Чипсы источников ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <SourceChip
          label="Все"
          active={sourceFilter === 'all'}
          count={sourceCounts.all ?? 0}
          onClick={() => setSourceFilter('all')}
        />
        {LEAD_SOURCES.map((s) => (
          <SourceChip
            key={s.key}
            label={s.label}
            active={sourceFilter === s.key}
            count={sourceCounts[s.key] ?? 0}
            onClick={() => setSourceFilter(s.key)}
            disabled={(sourceCounts[s.key] ?? 0) === 0}
          />
        ))}

        <span className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          Статус:
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">Все</option>
            <option value="new">Новые</option>
            <option value="in_progress">В работе</option>
            <option value="processed">Обработаны</option>
          </select>
        </span>
      </div>

      {/* ── Таблица лидов ───────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Источник</th>
                <th className="px-4 py-2 text-left font-medium">Имя</th>
                <th className="px-4 py-2 text-left font-medium">Телефон</th>
                <th className="px-4 py-2 text-left font-medium">Превью</th>
                <th className="px-4 py-2 text-left font-medium">Статус</th>
                <th className="px-4 py-2 text-left font-medium">Получен</th>
                <th className="px-4 py-2 text-left font-medium">Перешёл в</th>
              </tr>
            </thead>
            <tbody>
              {loading && leads.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    Загрузка…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-4 py-4 text-destructive">
                    Ошибка: {error}
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && !error && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    {leads.length === 0
                      ? 'Лидов пока нет. Когда появится новый отклик, он окажется тут и автоматически уйдёт в Чаты.'
                      : 'Нет лидов под текущие фильтры.'}
                  </td>
                </tr>
              )}
              {filtered.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  acting={actingId === lead.id}
                  onMarkProcessed={markProcessed}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Под-компоненты
// ───────────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  warning,
}: {
  label: string
  value: number
  sub?: string
  warning?: boolean
}) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold ${warning && value > 0 ? 'text-amber-600' : 'text-foreground'}`}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      )}
    </Card>
  )
}

function SourceChip({
  label,
  count,
  active,
  disabled,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-foreground hover:bg-muted'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-1.5 text-xs ${
          active ? 'bg-white/20' : 'bg-muted text-muted-foreground'
        }`}
      >
        {count}
      </span>
    </button>
  )
}

function LeadRow({
  lead,
  acting,
  onMarkProcessed,
}: {
  lead: InboxLead
  acting: boolean
  onMarkProcessed: (lead: InboxLead) => void
}) {
  // Бейдж статуса кликабельный только пока лид НЕ обработан и
  // источник поддерживает action (сейчас только Avito; для будущих
  // источников добавим аналогичные endpoint'ы).
  const canMark = lead.status !== 'processed' && lead.source === 'avito'
  return (
    <tr className="border-t border-border hover:bg-muted/30">
      {/* Источник */}
      <td className="px-4 py-3">
        <Badge
          variant="outline"
          className={`border ${SOURCE_BADGE_CLASS[lead.source] ?? ''}`}
        >
          {LEAD_SOURCES.find((s) => s.key === lead.source)?.label ?? lead.source}
        </Badge>
        {lead.sourceMeta.accountName ? (
          <div className="mt-1 text-xs text-muted-foreground">
            {String(lead.sourceMeta.accountName)}
          </div>
        ) : null}
      </td>
      {/* Имя */}
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">{lead.name ?? '—'}</div>
        {lead.sourceMeta.vacancyTitle ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {truncate(String(lead.sourceMeta.vacancyTitle), 50)}
          </div>
        ) : null}
      </td>
      {/* Телефон */}
      <td className="px-4 py-3">
        {lead.phone ? (
          <a
            href={`tel:${lead.phone}`}
            className="inline-flex items-center gap-1.5 font-mono text-sm text-primary hover:underline"
          >
            <Phone className="h-3.5 w-3.5" />
            {lead.phone}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      {/* Превью */}
      <td
        className="max-w-[280px] truncate px-4 py-3 text-muted-foreground"
        title={lead.preview ?? ''}
      >
        {truncate(lead.preview, 60)}
      </td>
      {/* Статус: кликабельный бейдж до обработки (клик = пометить
          обработанным). Под бейджем для processed — timestamp нажатия
          «Обработан», для остальных — источниковый статус мелким серым. */}
      <td className="px-4 py-3">
        {canMark ? (
          <button
            type="button"
            disabled={acting}
            onClick={() => onMarkProcessed(lead)}
            title="Кликни чтобы пометить «Обработан»"
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed ${STATUS_BADGE_CLASS[lead.status]}`}
          >
            {acting ? '…' : LEAD_STATUS_LABEL_RU[lead.status]}
          </button>
        ) : (
          <Badge
            variant="outline"
            className={`border ${STATUS_BADGE_CLASS[lead.status]}`}
          >
            {LEAD_STATUS_LABEL_RU[lead.status]}
          </Badge>
        )}
        {lead.status === 'processed' && lead.processedAt ? (
          <div
            className="mt-1 text-xs text-muted-foreground"
            title={`Обработан ${new Date(lead.processedAt).toLocaleString('ru-RU')}`}
          >
            ✓ {fmt(lead.processedAt)}
          </div>
        ) : lead.sourceStatus ? (
          <div className="mt-1 text-xs text-muted-foreground">
            {lead.sourceStatus}
          </div>
        ) : null}
      </td>
      {/* Получен */}
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {fmt(lead.receivedAt)}
      </td>
      {/* Куда перешёл */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {lead.crm.chatId ? (
            <Link
              href={`/messages?chatId=${lead.crm.chatId}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary hover:bg-muted"
              title="Открыть чат"
            >
              <MessageSquare className="h-3 w-3" />
              Чат
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {lead.crm.taskId && (
            <Link
              href={`/tasks?taskId=${lead.crm.taskId}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary hover:bg-muted"
              title="Открыть задачу"
            >
              ✓ Задача
            </Link>
          )}
          {lead.sourceRefUrl && (
            <a
              href={lead.sourceRefUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-muted-foreground hover:bg-muted"
              title="Открыть в источнике"
            >
              <ExternalLink className="h-3 w-3" />
              {LEAD_SOURCES.find((s) => s.key === lead.source)?.label}
            </a>
          )}
        </div>
      </td>
    </tr>
  )
}
