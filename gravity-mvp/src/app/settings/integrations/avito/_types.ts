export type AccountStatus =
  | 'new'
  | 'auth_pending'
  | 'active'
  | 'reauth_required'
  | 'paused'
  | 'error';

export interface Account {
  id: number;
  name: string;
  loginPhone: string | null;
  notes: string | null;
  profilePath: string;
  status: AccountStatus;
  lastAuthAt: string | null;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  reauthRequiredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  // STEP B7 messenger polling surface.
  responsesPollIntervalSec: number | null;
  lastCollectResponsesAt: string | null;
  // Auto-reply template. null = auto-reply disabled for this account.
  autoReplyText: string | null;
  // OBS1/OBS2/OBS3 — health signals + protection state. These are the
  // fields the fleet-health UI reads to render the health badge /
  // filter and to surface retry + auto-pause status to the operator.
  retryRequired?: boolean;
  collectFailCount24h?: number;
  ipBlockedCount24h?: number;
  loginRequiredCount24h?: number;
  autoPausedAt?: string | null;
  autoPauseReason?: string | null;
  // UX1 — last-cycle surface fields shown in the popover. All are
  // optional because the worker only fills them after the first
  // successful collect; a fresh account has them as null.
  lastCollectPageKind?: string | null;
  lastCollectDurationMs?: number | null;
  lastCollectPhoneSuccessCount?: number | null;
  lastCollectPhoneFailedCount?: number | null;
}

// OBS3 — derived bucket shown in the Health column and the filter bar.
// Computed client-side from Account fields — no server field.
export type AccountHealth = 'healthy' | 'degraded' | 'auto-paused';

export function computeAccountHealth(a: Account): AccountHealth {
  if (a.autoPausedAt) return 'auto-paused';
  if (
    a.retryRequired ||
    (a.collectFailCount24h ?? 0) > 0 ||
    (a.ipBlockedCount24h ?? 0) > 0 ||
    (a.loginRequiredCount24h ?? 0) > 0
  ) {
    return 'degraded';
  }
  return 'healthy';
}

// UX1 — plain-Russian explanation of WHY the account is in its
// current state. One short sentence per condition. Priority order
// matches the spec:
//   1. auto-paused   (system pulled it out of rotation)
//   2. retryRequired (last scan asked for a re-check)
//   3. ipBlocked     (recent IP-level restriction)
//   4. loginRequired (session died / Avito wants re-login)
//   5. collectFail   (generic collect errors)
//   6. otherwise     → running fine
// Exported as a pure function so the table cell, the popover, and any
// future surface (email / activity log row) all show the same string.
export function accountReason(a: Account): string {
  if (a.autoPausedAt) return 'Аккаунт временно остановлен системой';
  if (a.retryRequired) return 'Требуется повторная проверка';
  if ((a.ipBlockedCount24h ?? 0) > 0) return 'Сайт ограничил доступ по IP';
  if ((a.loginRequiredCount24h ?? 0) > 0) return 'Требуется повторный вход';
  if ((a.collectFailCount24h ?? 0) > 0) return 'Зафиксированы ошибки сбора';
  return 'Работает нормально';
}

// UX1 — plain-Russian next-step the operator can take. Same priority
// order as accountReason() so the two columns always line up one to
// one. 'Ничего' is the literal spec wording for the healthy case.
export function accountAction(a: Account): string {
  if (a.autoPausedAt) return "Проверить аккаунт и нажать «Снять авто-паузу»";
  if (a.retryRequired) return "Нажать «Обновить статус»";
  if ((a.ipBlockedCount24h ?? 0) > 0) return 'Сменить сеть или IP и повторить';
  if ((a.loginRequiredCount24h ?? 0) > 0) return 'Открыть профиль и войти заново';
  if ((a.collectFailCount24h ?? 0) > 0) return 'Подождать и проверить позже';
  return 'Ничего';
}

// Attention-indicator — three-level "does this row need my eyes".
// Derived purely from fields already on the Account row; no new
// backend state, no new endpoints. The mapping is:
//   auto-paused  → critical          (system pulled it out of rotation)
//   any warning  → needs-attention   (retry/fail/ip/login or degraded)
//   everything 0 → ok                (quiet row)
export type AttentionLevel = 'ok' | 'needs-attention' | 'critical';

// The spec lists the predicate as a big OR. Written out literally so
// the rule matches the spec line-for-line and any future tweak
// (adding a new signal) has an obvious insertion point.
export function computeNeedsAttention(a: Account): boolean {
  const h = computeAccountHealth(a);
  return (
    h !== 'healthy' ||
    a.retryRequired === true ||
    (a.collectFailCount24h ?? 0) > 0 ||
    (a.ipBlockedCount24h ?? 0) > 0 ||
    (a.loginRequiredCount24h ?? 0) > 0
  );
}

export function computeAttention(a: Account): AttentionLevel {
  if (computeAccountHealth(a) === 'auto-paused') return 'critical';
  if (computeNeedsAttention(a)) return 'needs-attention';
  return 'ok';
}

export type ResponseStatus =
  | 'new'
  | 'phone_pending'
  | 'phone_received'
  | 'phone_failed'
  | 'ready_for_manager'
  | 'duplicate';

export interface Response {
  id: number;
  accountId: number;
  externalId: string;
  externalIdSource: string;
  chatHref: string | null;
  chatUrl: string | null;
  candidateName: string | null;
  vacancyTitle: string | null;
  preview: string | null;
  phone: string | null;
  receivedAt: string | null;
  detectedAt: string;
  isUnreadDetected: boolean;
  status: ResponseStatus;
  rawDataJson: unknown;
  phoneRevealedAt: string | null;
  phoneRevealFailureReason: string | null;
  processedAt: string | null;
  processedBy: string | null;
  autoReplySentAt: string | null;
  autoReplyStatus: string | null;
  autoReplyError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLogEntry {
  id: number;
  entityType: string;
  entityId: string | null;
  action: string;
  detailsJson: unknown;
  createdAt: string;
}

export interface EnqueueJobResponse {
  jobId: number;
  type: string;
  status: string;
}

export interface GlobalSettings {
  responsesPollDefaultSec: number | null;
  autoReplyText: string | null;
  // Telegram notifications. The raw bot token is never returned —
  // the UI sees only a masked representation + a boolean "is set?"
  // and re-sends the raw value only if the operator edits it.
  telegramBotTokenMasked: string | null;
  telegramBotTokenSet: boolean;
  telegramChatId: string | null;
  notifyNewResponse: boolean;
  notifyAutoPause: boolean;
  notifyAccountDegraded: boolean;
  // CRM integration. Same masking pattern as the TG token.
  crmWebhookUrl: string | null;
  crmTokenMasked: string | null;
  crmTokenSet: boolean;
  crmNotifyLeadCreated: boolean;
  crmNotifyLeadPhone: boolean;
  crmNotifyLeadProcessed: boolean;
  crmNotifyAccountPaused: boolean;
  crmNotifyAccountDegraded: boolean;
  crmPullEnabled: boolean;
}
