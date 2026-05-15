/**
 * CRM webhook helper (worker-side).
 *
 * Two responsibilities:
 *   1. enqueueCrmEvent — write the envelope to crm_outbox_events,
 *      then attempt one fire-and-forget delivery. Always returns
 *      void; never throws. The collect pipeline must NOT depend on
 *      CRM availability.
 *   2. attemptDelivery  — single HTTP POST with 3s AbortController
 *      timeout, structured-log result, mutates the outbox row.
 *      Used both by enqueueCrmEvent (first try) and by the retry
 *      tick in JobPollerService (subsequent tries).
 *
 * Settings live in app_settings k/v table:
 *   - crm_webhook_url
 *   - crm_token
 *   - crm_notify_lead_created   ('true'|'false', default true)
 *   - crm_notify_lead_phone     ('true'|'false', default true)
 *   - crm_notify_lead_processed ('true'|'false', default true)
 *   - crm_notify_account_paused ('true'|'false', default true)
 *   - crm_notify_account_degraded ('true'|'false', default true)
 *   - crm_pull_enabled          ('true'|'false', default true)
 */
import { eq } from 'drizzle-orm';
import {
  appSettings,
  crmOutboxEvents,
  CRM_OUTBOX_MAX_RETRIES,
  type Database,
} from '@avito/db';
import type { Logger } from '@nestjs/common';
import type { AnyCrmEnvelope, CrmEventType } from './crm-dto';

export const CRM_WEBHOOK_TIMEOUT_MS = 3_000;

export type CrmSettings = {
  webhookUrl: string | null;
  token: string | null;
  notifyLeadCreated: boolean;
  notifyLeadPhone: boolean;
  notifyLeadProcessed: boolean;
  notifyAccountPaused: boolean;
  notifyAccountDegraded: boolean;
  pullEnabled: boolean;
};

export async function readCrmSettings(db: Database): Promise<CrmSettings> {
  try {
    const rows = await db.select().from(appSettings);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const parseBool = (k: string, def: boolean): boolean => {
      const v = map.get(k);
      if (v === undefined) return def;
      return v === 'true';
    };
    // ENV fallback — Box 2 (bundle with CRM) ships with these set so
    // the integration works "out of the box" without operator UI input.
    // DB value (set via UI) wins if present; ENV is the default.
    const envUrl = (process.env.CRM_WEBHOOK_URL_DEFAULT ?? '').trim();
    const envToken = (process.env.CRM_TOKEN_DEFAULT ?? '').trim();
    const dbUrl = (map.get('crm_webhook_url') ?? '').trim();
    const dbToken = (map.get('crm_token') ?? '').trim();
    const webhookUrl = (dbUrl || envUrl) || null;
    const token = (dbToken || envToken) || null;
    return {
      webhookUrl,
      token,
      notifyLeadCreated: parseBool('crm_notify_lead_created', true),
      notifyLeadPhone: parseBool('crm_notify_lead_phone', true),
      notifyLeadProcessed: parseBool('crm_notify_lead_processed', true),
      notifyAccountPaused: parseBool('crm_notify_account_paused', true),
      notifyAccountDegraded: parseBool('crm_notify_account_degraded', true),
      pullEnabled: parseBool('crm_pull_enabled', true),
    };
  } catch {
    return {
      webhookUrl: null,
      token: null,
      notifyLeadCreated: false,
      notifyLeadPhone: false,
      notifyLeadProcessed: false,
      notifyAccountPaused: false,
      notifyAccountDegraded: false,
      pullEnabled: false,
    };
  }
}

/**
 * Should the worker attempt to deliver this event_type at all,
 * given current settings? Used to short-circuit before writing to
 * the outbox — disabled events should not pile up there.
 */
export function isEventEnabled(
  settings: CrmSettings,
  eventType: CrmEventType,
): boolean {
  if (!settings.webhookUrl) return false;
  switch (eventType) {
    case 'lead.created':
      return settings.notifyLeadCreated;
    case 'lead.phone_revealed':
      return settings.notifyLeadPhone;
    case 'lead.processed':
      return settings.notifyLeadProcessed;
    case 'account.auto_paused':
      return settings.notifyAccountPaused;
    case 'account.degraded':
      return settings.notifyAccountDegraded;
    case 'ping':
      return true;
  }
}

/** Truncate noisy errors so the DB column doesn't bloat. */
export function truncErr(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * Write the envelope to the outbox and immediately try one delivery.
 * Returns the outbox row id. Never throws.
 *
 * The first-attempt delivery is fire-and-forget from the caller's
 * perspective: this function awaits it only so the row reflects the
 * latest sent_status before returning.
 */
export async function enqueueCrmEvent(
  db: Database,
  logger: Logger,
  settings: CrmSettings,
  envelope: AnyCrmEnvelope,
): Promise<number | null> {
  if (!isEventEnabled(settings, envelope.event)) {
    return null;
  }
  if (!settings.webhookUrl || !settings.token) {
    return null;
  }
  let outboxId: number;
  try {
    const [row] = await db
      .insert(crmOutboxEvents)
      .values({
        eventId: envelope.event_id,
        eventType: envelope.event,
        payload: envelope as unknown as Record<string, unknown>,
        sentStatus: 'pending',
        retryCount: 0,
      })
      .returning({ id: crmOutboxEvents.id });
    outboxId = row.id;
  } catch (err) {
    // event_id collision (idempotent re-enqueue) or other DB issue —
    // we log and bail; the existing row (if any) will be picked up
    // by the retry tick.
    logger.warn(
      `crm.outbox insert failed event=${envelope.event} ` +
        `event_id=${envelope.event_id}: ${
          err instanceof Error ? truncErr(err.message) : String(err)
        }`,
    );
    return null;
  }
  // Fire one delivery attempt synchronously from the caller's
  // perspective, but with the strict 3s cap so the collect pipeline
  // never stalls more than that on a CRM hiccup.
  await attemptDelivery(db, logger, outboxId, settings, envelope);
  return outboxId;
}

/**
 * Send one POST to CRM webhook. Updates the outbox row in-place.
 *
 * Outcomes:
 *   - 2xx                              → sent_status='ok', sent_at=now()
 *   - non-2xx / network error / abort  → sent_status='failed' (or
 *                                        'permanent_failed' if cap hit),
 *                                        retry_count++, next_retry_at +=
 *                                        backoff
 *
 * Backoff: 1m → 5m → 15m (caps at retry_count=3 → permanent_failed).
 */
export async function attemptDelivery(
  db: Database,
  logger: Logger,
  outboxId: number,
  settings: CrmSettings,
  envelope: AnyCrmEnvelope,
): Promise<void> {
  if (!settings.webhookUrl || !settings.token) return;
  const startedAt = Date.now();
  let statusCode = 0;
  let lastError: string | null = null;
  try {
    const res = await fetch(settings.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.token}`,
        'x-event-id': envelope.event_id,
        'x-event-type': envelope.event,
        'x-source': 'avito',
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(CRM_WEBHOOK_TIMEOUT_MS),
    });
    statusCode = res.status;
    if (!res.ok) {
      lastError = `http_${res.status}`;
    }
  } catch (err) {
    lastError =
      err instanceof Error
        ? `${err.name}:${truncErr(err.message, 200)}`
        : String(err);
  }
  const latencyMs = Date.now() - startedAt;

  // Read the current retry_count so we can decide to escalate to
  // permanent_failed and compute next_retry_at.
  const [row] = await db
    .select({ retryCount: crmOutboxEvents.retryCount })
    .from(crmOutboxEvents)
    .where(eq(crmOutboxEvents.id, outboxId));
  const prevRetries = row?.retryCount ?? 0;

  if (lastError === null) {
    // success
    await db
      .update(crmOutboxEvents)
      .set({
        sentStatus: 'ok',
        sentAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      })
      .where(eq(crmOutboxEvents.id, outboxId));
    logger.log(
      `crm.deliver ok event_id=${envelope.event_id} ` +
        `event=${envelope.event} status=${statusCode} ` +
        `retry=${prevRetries} latency_ms=${latencyMs}`,
    );
    return;
  }

  // failure
  const newRetryCount = prevRetries + 1;
  const isPermanent = newRetryCount >= CRM_OUTBOX_MAX_RETRIES;
  const nextRetryAt = isPermanent
    ? null
    : new Date(Date.now() + retryDelayMs(newRetryCount));
  await db
    .update(crmOutboxEvents)
    .set({
      sentStatus: isPermanent ? 'permanent_failed' : 'failed',
      retryCount: newRetryCount,
      lastError: truncErr(lastError),
      nextRetryAt,
    })
    .where(eq(crmOutboxEvents.id, outboxId));
  logger.warn(
    `crm.deliver fail event_id=${envelope.event_id} ` +
      `event=${envelope.event} status=${statusCode} ` +
      `retry=${newRetryCount}/${CRM_OUTBOX_MAX_RETRIES} ` +
      `latency_ms=${latencyMs} error=${truncErr(lastError, 100)} ` +
      `terminal=${isPermanent}`,
  );
}

/** 1m, 5m, 15m. Linear-ish, no jitter — single CRM endpoint, no need. */
function retryDelayMs(attemptNumber: number): number {
  if (attemptNumber === 1) return 60_000;
  if (attemptNumber === 2) return 5 * 60_000;
  return 15 * 60_000;
}
