/**
 * Incident-export helpers — построение текстовых пакетов для саппорта.
 *
 * Используется в `GET /api/avito/accounts/[id]/context-export`. Возвращает
 * пару готовых-к-вставке промтов:
 *   - claudePrompt — для нового чата с Claude Code (project-context primer
 *     + компактный snapshot аккаунта + 12 событий + Task usage tail)
 *   - gptPrompt    — для нового чата с ChatGPT (incident packet с
 *     развёрнутым ACCOUNT STATE + 30 событий + ANALYSIS REQUEST)
 *
 * Оба прогоняются через maskPhones() — телефоны в activity_log
 * (события `phone_revealed`) маскируются как «+7 958 *** ** 86».
 *
 * ВНИМАНИЕ — статические блоки (INCIDENT_SYSTEM_CONTEXT,
 * INCIDENT_ANALYSIS_REQUEST, CLAUDE_CONTEXT_HEADER, CLAUDE_TASK_USAGE)
 * скопированы 1:1 из Box 1 спека UX2/UX3. Менять только при
 * соответствующем обновлении спека — мускульная память операторов и
 * downstream tooling зависит от точной формулировки.
 */

// ─── Типы ──────────────────────────────────────────────────────────────

// Подмножество avito_accounts полей, нужных для построения промтов.
// Используем snake_case как в Prisma — без дополнительной перетусовки.
export type AvitoAccountSnapshot = {
  id: number
  name: string
  status: string
  retry_required: boolean | null
  auto_paused_at: Date | null
  auto_pause_reason: string | null
  last_collect_responses_at: Date | null
  last_collect_page_kind: string | null
  last_collect_duration_ms: number | null
  last_collect_new_count: number | null
  last_collect_refreshed_count: number | null
  last_collect_phone_success_count: number | null
  last_collect_phone_failed_count: number | null
  collect_fail_count_24h: number | null
  ip_blocked_count_24h: number | null
  login_required_count_24h: number | null
  responses_poll_interval_sec: number | null
}

export type ActivityRow = {
  created_at: Date
  action: string
  details_json: unknown
}

// ─── Health computation ────────────────────────────────────────────────

// Mirrors UI computeAccountHealth(). Дублируется здесь чтобы не тащить
// зависимость от UI-типов в server-only код.
export function computeHealth(
  a: AvitoAccountSnapshot,
): 'healthy' | 'degraded' | 'auto-paused' {
  if (a.auto_paused_at) return 'auto-paused'
  if (
    a.retry_required ||
    (a.collect_fail_count_24h ?? 0) > 0 ||
    (a.ip_blocked_count_24h ?? 0) > 0 ||
    (a.login_required_count_24h ?? 0) > 0
  ) {
    return 'degraded'
  }
  return 'healthy'
}

// ─── Шаблонные блоки (точные тексты из Box 1 UX2/UX3 спека) ───────────

const INCIDENT_SYSTEM_CONTEXT = `SYSTEM CONTEXT

Project:
Avito Leads MVP

Purpose:
Система автоматически собирает отклики из Avito Messenger по нескольким аккаунтам, обогащает диалоги, пытается раскрывать телефон и показывает результаты оператору через UI.

Core pipeline:

* worker tick-loop планирует collect_responses jobs
* handler открывает Avito Messenger
* unread dialogs парсятся и сохраняются в responses
* новые responses проходят enrichment
* выполняется phone reveal
* результаты видны оператору в UI

Health states:
healthy
degraded
auto-paused

Existing safeguards:

* fleet-safe scheduling
* jitter
* concurrency cap
* cooldown / extended cooldown
* auto-pause protection
* backup / restore scripts
* slow job warning

Constraints:

* один worker процесс
* последовательный pipeline
* без cron
* без scheduler framework
* без event bus
* без новых сервисов
* без heavy stealth plugins

Alert heuristics:

* retryRequired=true means account needs operator attention
* autoPausedAt != null means scheduler is skipping the account
* ipBlockedCount24h > 0 means access restriction was observed
* loginRequiredCount24h > 0 means session instability was observed
* collectFailCount24h > 0 means recent non-success outcomes occurred
* lastCollectDurationMs > 60000 means slow collect territory
* schedulerStale=true means scheduler may be stuck or worker may be down

Operator actions available:

* pause account
* resume account
* manual collect responses
* adjust polling interval
* view responses
* acknowledge errors`

const INCIDENT_ANALYSIS_REQUEST = `ANALYSIS REQUEST

1. Проанализируй проблему по этому аккаунту.
2. Назови вероятную причину.
3. Оцени срочность.
4. Скажи, что проверить вручную.
5. Дай минимальный промт для Claude Code на исправление.
6. Не предлагай новую архитектуру, новые сервисы, scheduler framework, cron, event bus или heavy stealth frameworks.
7. If there is no real problem and the account looks healthy, explicitly say that no fix is required.`

const CLAUDE_CONTEXT_HEADER = `PROJECT CONTEXT — Avito Leads MVP

System purpose:

Система автоматически собирает отклики из Avito Messenger по нескольким аккаунтам,
обогащает диалоги, пытается раскрывать телефон и показывает результаты оператору через UI.

Technology stack:

* Node.js worker
* NestJS API
* PostgreSQL database
* Playwright browser automation
* Next.js web interface

Runtime model:

* один worker процесс
* sequential job pipeline
* tick-based scheduler
* in-memory scheduling state
* no distributed components

Core pipeline:

1. scheduler tick проверяет аккаунты
2. collect_responses job enqueue
3. CollectResponsesHandler запускает браузер
4. открывается Avito Messenger
5. unread dialogs парсятся
6. responses сохраняются или обновляются
7. enrichment выполняется
8. phone reveal выполняется
9. результаты отображаются оператору

Account health model:

States:
healthy
degraded
auto-paused

retryRequired:

* может быть true после failure
* должен автоматически сбрасываться после успешного collect

Safety mechanisms:

* fleet-safe scheduling
* per-account jitter
* concurrency cap
* cooldown / extended cooldown
* auto-pause protection
* rate limit on enqueue
* backup / restore scripts
* slow job detection

Operational constraints (strict):

Do NOT introduce:

* new services
* cron jobs
* scheduler frameworks
* message queues
* event bus
* background orchestration
* heavy stealth plugins
* parallel pipelines
* distributed systems
* new infrastructure components

Allowed changes:

* localized handler fixes
* retry logic adjustments
* scheduler tuning
* observability improvements
* small database fields
* UI changes
* bug fixes

Design principle:

Prefer minimal targeted fixes.
Do not redesign architecture.
Do not introduce new subsystems unless explicitly requested.

Expected response behavior:

When analyzing a problem:

1. identify root cause
2. propose minimal fix
3. avoid architectural redesign
4. maintain system stability
5. preserve backward compatibility

After implementing changes:
Stop.
Do not automatically continue to next steps.

If the system state is healthy, do not propose changes.

Alert heuristics:

* retryRequired=true means account needs operator attention
* autoPausedAt != null means scheduler is skipping the account
* ipBlockedCount24h > 0 means access restriction was observed
* loginRequiredCount24h > 0 means session instability was observed
* collectFailCount24h > 0 means recent non-success outcomes occurred
* lastCollectDurationMs > 60000 means slow collect territory
* schedulerStale=true means scheduler may be stuck or worker may be down`

const CLAUDE_TASK_USAGE = `Task usage:

Use this context as the project baseline.

When a bug or request is provided after this context:

* identify root cause
* propose a minimal fix
* preserve architecture
* avoid redesign
* stop after the requested change`

// ─── Скаляр-форматтер ──────────────────────────────────────────────────
// Spec: null/undefined → 'null' (em-dash был неоднозначен для LLM как
// типографский символ). Date → ISO. Иначе String().
function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

// ─── Сборка SYSTEM STATUS / ACCOUNT STATE ─────────────────────────────

const SCHEDULER_STALE_MS = 30 * 60 * 1000

function buildSystemStatusBlock(
  acc: AvitoAccountSnapshot,
  health: string,
): string {
  // schedulerStale=true ⇔ есть предыдущий успешный collect, но он
  // старше 30 минут. Брэнд-нью аккаунт (last_collect_responses_at=null)
  // не считается stale: «никогда не запускался» != «запускался и встал».
  const schedulerStale =
    acc.last_collect_responses_at != null &&
    Date.now() - acc.last_collect_responses_at.getTime() > SCHEDULER_STALE_MS
  return [
    'SYSTEM STATUS',
    '',
    `accountHealth: ${health}`,
    `recentFailures: ${acc.collect_fail_count_24h ?? 0}`,
    `ipBlocksLast24h: ${acc.ip_blocked_count_24h ?? 0}`,
    `loginRequiredLast24h: ${acc.login_required_count_24h ?? 0}`,
    `schedulerRunning: ${!schedulerStale}`,
    `schedulerStale: ${schedulerStale}`,
  ].join('\n')
}

function buildAccountStateBlock(
  acc: AvitoAccountSnapshot,
  health: string,
): string {
  return [
    'ACCOUNT STATE',
    '',
    `accountId: ${acc.id}`,
    `name: ${fmt(acc.name)}`,
    `status: ${fmt(acc.status)}`,
    `health: ${health}`,
    '',
    `retryRequired: ${acc.retry_required ? 'true' : 'false'}`,
    `autoPausedAt: ${fmt(acc.auto_paused_at)}`,
    `autoPauseReason: ${fmt(acc.auto_pause_reason)}`,
    '',
    `lastCollectResponsesAt: ${fmt(acc.last_collect_responses_at)}`,
    `lastCollectPageKind: ${fmt(acc.last_collect_page_kind)}`,
    `lastCollectDurationMs: ${fmt(acc.last_collect_duration_ms)}`,
    '',
    `lastCollectNewCount: ${fmt(acc.last_collect_new_count)}`,
    `lastCollectRefreshedCount: ${fmt(acc.last_collect_refreshed_count)}`,
    `lastCollectPhoneSuccessCount: ${fmt(acc.last_collect_phone_success_count)}`,
    `lastCollectPhoneFailedCount: ${fmt(acc.last_collect_phone_failed_count)}`,
    '',
    `collectFailCount24h: ${fmt(acc.collect_fail_count_24h)}`,
    `ipBlockedCount24h: ${fmt(acc.ip_blocked_count_24h)}`,
    `loginRequiredCount24h: ${fmt(acc.login_required_count_24h)}`,
    '',
    `responsesPollIntervalSec: ${fmt(acc.responses_poll_interval_sec)}`,
  ].join('\n')
}

function buildClaudeAccountSnapshot(
  acc: AvitoAccountSnapshot,
  health: string,
): string {
  return [
    `accountId: ${acc.id}`,
    `name: ${fmt(acc.name)}`,
    `status: ${fmt(acc.status)}`,
    `health: ${health}`,
    `retryRequired: ${acc.retry_required ? 'true' : 'false'}`,
    `autoPausedAt: ${fmt(acc.auto_paused_at)}`,
    `autoPauseReason: ${fmt(acc.auto_pause_reason)}`,
    `lastCollectResponsesAt: ${fmt(acc.last_collect_responses_at)}`,
    `lastCollectPageKind: ${fmt(acc.last_collect_page_kind)}`,
    `collectFailCount24h: ${fmt(acc.collect_fail_count_24h)}`,
    `ipBlockedCount24h: ${fmt(acc.ip_blocked_count_24h)}`,
    `loginRequiredCount24h: ${fmt(acc.login_required_count_24h)}`,
  ].join('\n')
}

// ─── RECENT EVENTS ─────────────────────────────────────────────────────

function renderEventPayload(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw !== 'object') return String(raw)
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v == null) continue
    if (typeof v === 'object') {
      parts.push(`${k}=${JSON.stringify(v)}`)
    } else {
      parts.push(`${k}=${String(v)}`)
    }
  }
  return parts.join(' ')
}

function buildRecentEventsBlock(events: ActivityRow[]): string {
  const header = 'RECENT EVENTS'
  if (events.length === 0) return `${header}\n\n(no events)`
  const lines = events.map((e) => {
    const ts = e.created_at.toISOString()
    const payload = renderEventPayload(e.details_json)
    const capped = payload.length > 200 ? payload.slice(0, 197) + '...' : payload
    return `${ts} | ${e.action} | ${capped}`
  })
  return [header, '', ...lines].join('\n')
}

function buildRecentEventsCompact(events: ActivityRow[]): string {
  if (events.length === 0) return '(no events)'
  return events
    .map((e) => {
      const ts = e.created_at.toISOString()
      const payload = renderEventPayload(e.details_json)
      const capped = payload.length > 120 ? payload.slice(0, 117) + '...' : payload
      return `${ts} | ${e.action} | ${capped}`
    })
    .join('\n')
}

// ─── Phone masking ─────────────────────────────────────────────────────
// Маскируем российские номера которые могут просочиться в activity_log
// (события phone_revealed часто содержат полный номер). Формат
// результата: «+7 958 *** ** 86».
const PHONE_RX =
  /(\+7|8)[\s\-]?\(?(\d{3})\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?(\d{2})/g

export function maskPhones(s: string): string {
  return s.replace(PHONE_RX, (_m, lead: string, area: string, last2: string) => {
    const prefix = lead === '+7' ? '+7' : '8'
    return `${prefix} ${area} *** ** ${last2}`
  })
}

// ─── Composition ───────────────────────────────────────────────────────

/**
 * Собрать оба промта (claudePrompt + gptPrompt) для одного аккаунта.
 * Один и тот же snapshot аккаунта и один и тот же event-tail используются
 * в обоих — никаких дублирующих DB-запросов.
 */
export function buildContextExport(
  acc: AvitoAccountSnapshot,
  events: ActivityRow[],
): { claudePrompt: string; gptPrompt: string } {
  const health = computeHealth(acc)
  const timestampLine = `Context generated at:\n${new Date().toISOString()}`
  const systemStatus = buildSystemStatusBlock(acc, health)

  // Claude prompt — обращается к Claude Code, который читает код
  // вместе с промтом. Поэтому короче и без спойлера-инцидента.
  const claudePrompt = maskPhones(
    [
      'Промт для Клода',
      timestampLine,
      CLAUDE_CONTEXT_HEADER,
      `Current account snapshot:\n\n${buildClaudeAccountSnapshot(acc, health)}`,
      systemStatus,
      `Recent events:\n${buildRecentEventsCompact(events.slice(0, 12))}`,
      CLAUDE_TASK_USAGE,
    ].join('\n\n'),
  )

  // GPT prompt — ChatGPT не видит код, поэтому даём максимально полный
  // контекст состояния и просим явный ANALYSIS REQUEST.
  const gptPrompt = maskPhones(
    [
      'Промт для GPT',
      timestampLine,
      INCIDENT_SYSTEM_CONTEXT,
      buildAccountStateBlock(acc, health),
      systemStatus,
      buildRecentEventsBlock(events),
      INCIDENT_ANALYSIS_REQUEST,
    ].join('\n\n'),
  )

  return { claudePrompt, gptPrompt }
}
