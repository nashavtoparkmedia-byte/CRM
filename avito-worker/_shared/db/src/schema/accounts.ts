import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { ACCOUNT_STATUSES } from '@avito/shared';

export const accountStatusEnum = pgEnum('account_status', ACCOUNT_STATUSES);

export const accounts = pgTable('avito_accounts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  loginPhone: text('login_phone'),
  notes: text('notes'),
  profilePath: text('profile_path').notNull(),
  status: accountStatusEnum('status').notNull().default('new'),
  lastAuthAt: timestamp('last_auth_at', { withTimezone: true }),
  lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  reauthRequiredAt: timestamp('reauth_required_at', { withTimezone: true }),
  lastError: text('last_error'),
  stableId: text('stable_id'),
  stableIdSource: text('stable_id_source'),
  stableIdUpdatedAt: timestamp('stable_id_updated_at', { withTimezone: true }),
  retryRequired: boolean('retry_required').notNull().default(false),
  lastScanPageKind: text('last_scan_page_kind'),
  lastScanReason: text('last_scan_reason'),
  lastScanNextAction: text('last_scan_next_action'),
  lastManualRetryAt: timestamp('last_manual_retry_at', { withTimezone: true }),
  lastManualRetryJobId: integer('last_manual_retry_job_id'),
  lastManualRetryOutcome: text('last_manual_retry_outcome'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  attentionSeverity: text('attention_severity'),
  operatorNote: text('operator_note'),
  // STEP B1 — messenger polling (Variant A: auto-reveal on collection).
  // NULL = use env default RESPONSES_POLL_INTERVAL_SEC. Operator can
  // override per-account via UI (PATCH /accounts/:id).
  responsesPollIntervalSec: integer('responses_poll_interval_sec'),
  lastCollectResponsesAt: timestamp('last_collect_responses_at', {
    withTimezone: true,
  }),
  // Plain text auto-reply. NULL = no auto-reply for this account.
  // Sent exactly ONCE per response (unique by account_id+external_id
  // idempotency + responses.auto_reply_sent_at marker). Only after a
  // successful phone reveal on that dialog.
  autoReplyText: text('auto_reply_text'),
  // OBS1 — last-known collect-cycle surface. Updated on every
  // successful collect_responses_done. Not historical metrics — just
  // the most recent cycle's facts so operator can spot-check health
  // without opening activity_log / worker log.
  lastCollectPageKind: text('last_collect_page_kind'),
  lastCollectDurationMs: integer('last_collect_duration_ms'),
  lastCollectNewCount: integer('last_collect_new_count'),
  lastCollectRefreshedCount: integer('last_collect_refreshed_count'),
  lastCollectPhoneSuccessCount: integer('last_collect_phone_success_count'),
  lastCollectPhoneFailedCount: integer('last_collect_phone_failed_count'),
  // OBS1 — rolling 24h counters with simple reset-on-stale semantics.
  // No separate events table: handler reads the count + *_updated_at
  // pair and either increments or resets based on whether the
  // timestamp is older than 24h. NOT NULL with default 0 so freshly
  // added accounts start clean.
  collectFailCount24h: integer('collect_fail_count_24h').notNull().default(0),
  ipBlockedCount24h: integer('ip_blocked_count_24h').notNull().default(0),
  loginRequiredCount24h: integer('login_required_count_24h').notNull().default(0),
  collectFailCountUpdatedAt: timestamp('collect_fail_count_updated_at', {
    withTimezone: true,
  }),
  ipBlockedCountUpdatedAt: timestamp('ip_blocked_count_updated_at', {
    withTimezone: true,
  }),
  loginRequiredCountUpdatedAt: timestamp('login_required_count_updated_at', {
    withTimezone: true,
  }),
  // OBS2 — fleet protection. System-driven "temporary pause" distinct
  // from operator-driven `status='paused'`. When set, the scheduler
  // skips this account entirely. Cleared manually via PATCH.
  autoPausedAt: timestamp('auto_paused_at', { withTimezone: true }),
  autoPauseReason: text('auto_pause_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
