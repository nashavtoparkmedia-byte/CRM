-- Conversation Intelligence Layer v1 (PR #59)
--
-- Adds `AiCallEvent` table — append-only timeline of signal-bearing
-- moments per AI-call. Design: docs/design/conversation-intelligence-layer.md
--
-- v1 enum carries only the 4 events the first emission PR ships. Future
-- PRs extend via `ALTER TYPE "AiCallEventType" ADD VALUE ...` (a separate
-- migration per add — Postgres requires it).
--
-- Idempotency pattern mirrors 20260520213000_add_ai_outcome_layer.

-- ── AiCallEventType enum (v1) ─────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "AiCallEventType" AS ENUM (
        'greeting_started',
        'first_real_user_speech',
        'silence_strike',
        'call_completed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── AiCallEvent table ─────────────────────────────────────────────
-- callId    FK to Call (CASCADE on delete — events live with the call)
-- type      enum (above)
-- occurredAt wall-clock timestamp of emission (bridge or server)
-- seq       monotonic per-call ordinal for stable ordering across
--           same-millisecond emissions
-- payload   per-type structured payload (validated in code)
--
-- Indexes:
--   (callId, seq)             — primary access pattern: timeline for
--                               one call, ordered.
--   (type, occurredAt DESC)   — secondary: aggregations across calls
--                               by event type (funnel queries).
CREATE TABLE IF NOT EXISTS "AiCallEvent" (
    "id"         TEXT PRIMARY KEY,
    "callId"     TEXT NOT NULL,
    "type"       "AiCallEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq"        INTEGER NOT NULL,
    "payload"    JSONB,
    CONSTRAINT "AiCallEvent_callId_fkey"
        FOREIGN KEY ("callId") REFERENCES "Call"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AiCallEvent_callId_seq_idx"
    ON "AiCallEvent"("callId", "seq");

CREATE INDEX IF NOT EXISTS "AiCallEvent_type_occurredAt_idx"
    ON "AiCallEvent"("type", "occurredAt" DESC);
