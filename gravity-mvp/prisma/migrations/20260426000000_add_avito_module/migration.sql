-- Восстановленная миграция (drift от prisma db push): весь модуль
-- avito_* (абсорбированный standalone-сервис) существовал в БД без
-- создающей миграции; 20260426010000_add_avito_lead_intake падала при
-- replay на ALTER TABLE "avito_responses". DDL сгенерирован из текущей
-- схемы (prisma migrate diff --from-empty); crm_*-колонки уже включены —
-- последующие ADD COLUMN IF NOT EXISTS в 20260426010000 проходят no-op.

-- CreateEnum
CREATE TYPE "avito_account_status" AS ENUM ('new', 'auth_pending', 'active', 'reauth_required', 'paused', 'error');

-- CreateEnum
CREATE TYPE "avito_job_status" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "avito_job_type" AS ENUM ('scan_account', 'fetch_phone', 'open_login_window', 'check_session', 'collect_responses');

-- CreateEnum
CREATE TYPE "avito_phone_reveal_attempt_status" AS ENUM ('started', 'success', 'technical_error_before_click', 'technical_error_after_click', 'technical_error_unknown_state', 'no_phone_found', 'blocked', 'ui_changed');

-- CreateEnum
CREATE TYPE "avito_response_status" AS ENUM ('new', 'phone_pending', 'phone_received', 'phone_failed', 'ready_for_manager', 'duplicate');

-- CreateTable
CREATE TABLE "avito_accounts" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "login_phone" TEXT,
    "notes" TEXT,
    "profile_path" TEXT NOT NULL,
    "status" "avito_account_status" NOT NULL DEFAULT 'new',
    "last_auth_at" TIMESTAMPTZ(6),
    "last_scan_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "reauth_required_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stable_id" TEXT,
    "stable_id_source" TEXT,
    "stable_id_updated_at" TIMESTAMPTZ(6),
    "retry_required" BOOLEAN NOT NULL DEFAULT false,
    "last_scan_page_kind" TEXT,
    "last_scan_reason" TEXT,
    "last_scan_next_action" TEXT,
    "last_manual_retry_at" TIMESTAMPTZ(6),
    "last_manual_retry_job_id" INTEGER,
    "last_manual_retry_outcome" TEXT,
    "acknowledged_at" TIMESTAMPTZ(6),
    "attention_severity" TEXT,
    "operator_note" TEXT,
    "responses_poll_interval_sec" INTEGER,
    "last_collect_responses_at" TIMESTAMPTZ(6),
    "auto_reply_text" TEXT,
    "last_collect_page_kind" TEXT,
    "last_collect_duration_ms" INTEGER,
    "last_collect_new_count" INTEGER,
    "last_collect_refreshed_count" INTEGER,
    "last_collect_phone_success_count" INTEGER,
    "last_collect_phone_failed_count" INTEGER,
    "collect_fail_count_24h" INTEGER NOT NULL DEFAULT 0,
    "ip_blocked_count_24h" INTEGER NOT NULL DEFAULT 0,
    "login_required_count_24h" INTEGER NOT NULL DEFAULT 0,
    "collect_fail_count_updated_at" TIMESTAMPTZ(6),
    "ip_blocked_count_updated_at" TIMESTAMPTZ(6),
    "login_required_count_updated_at" TIMESTAMPTZ(6),
    "auto_paused_at" TIMESTAMPTZ(6),
    "auto_pause_reason" TEXT,

    CONSTRAINT "avito_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_responses" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_id_source" TEXT NOT NULL,
    "chat_href" TEXT,
    "chat_url" TEXT,
    "candidate_name" TEXT,
    "vacancy_title" TEXT,
    "phone" TEXT,
    "received_at" TIMESTAMPTZ(6),
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_unread_detected" BOOLEAN NOT NULL DEFAULT false,
    "status" "avito_response_status" NOT NULL DEFAULT 'new',
    "raw_data_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preview" TEXT,
    "phone_revealed_at" TIMESTAMPTZ(6),
    "phone_reveal_failure_reason" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "processed_by" TEXT,
    "auto_reply_sent_at" TIMESTAMPTZ(6),
    "auto_reply_status" TEXT,
    "auto_reply_error" TEXT,
    "telegram_message_id" INTEGER,
    "crm_contact_id" TEXT,
    "crm_chat_id" TEXT,
    "crm_task_id" TEXT,

    CONSTRAINT "avito_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_jobs" (
    "id" SERIAL NOT NULL,
    "type" "avito_job_type" NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "status" "avito_job_status" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avito_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_activity_log" (
    "id" SERIAL NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "action" TEXT NOT NULL,
    "details_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avito_activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_phone_reveal_attempts" (
    "id" SERIAL NOT NULL,
    "response_id" INTEGER NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status" "avito_phone_reveal_attempt_status" NOT NULL,
    "clicked_reveal" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "screenshot_path" TEXT,
    "html_snapshot_path" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avito_phone_reveal_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_account_snapshot" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "captured_at" TIMESTAMP(6) NOT NULL,
    "page_kind" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "next_action" TEXT NOT NULL,
    "items_count" INTEGER,
    "account_name" TEXT NOT NULL DEFAULT '',
    "profile_type" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "avito_account_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avito_app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "avito_auth_users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "avito_auth_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_auth_sessions" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,

    CONSTRAINT "avito_auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avito_crm_outbox_events" (
    "id" SERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sent_status" TEXT NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "next_retry_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avito_crm_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "avito_responses_crm_chat_id_idx" ON "avito_responses"("crm_chat_id");

-- CreateIndex
CREATE INDEX "avito_responses_crm_contact_id_idx" ON "avito_responses"("crm_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_avito_responses_account_external" ON "avito_responses"("account_id", "external_id");

-- CreateIndex
CREATE INDEX "idx_avito_jobs_status_run_at" ON "avito_jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "idx_avito_activity_created_at" ON "avito_activity_log"("created_at");

-- CreateIndex
CREATE INDEX "idx_avito_activity_entity" ON "avito_activity_log"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_avito_phone_reveal_response_attempt" ON "avito_phone_reveal_attempts"("response_id", "attempt_no");

-- CreateIndex
CREATE INDEX "idx_avito_snapshot_account_captured" ON "avito_account_snapshot"("account_id", "captured_at");

-- CreateIndex
CREATE INDEX "avito_auth_sessions_expires_at_idx" ON "avito_auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "avito_crm_outbox_events_event_id_key" ON "avito_crm_outbox_events"("event_id");

-- CreateIndex
CREATE INDEX "avito_crm_outbox_events_created_at_idx" ON "avito_crm_outbox_events"("created_at");

-- CreateIndex
CREATE INDEX "avito_crm_outbox_events_sent_status_next_retry_at_idx" ON "avito_crm_outbox_events"("sent_status", "next_retry_at");

-- AddForeignKey
ALTER TABLE "avito_responses" ADD CONSTRAINT "avito_responses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "avito_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "avito_phone_reveal_attempts" ADD CONSTRAINT "avito_phone_reveal_attempts_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "avito_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
