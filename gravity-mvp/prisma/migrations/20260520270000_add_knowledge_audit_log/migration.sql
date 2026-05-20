-- AI Knowledge Core — PR2.5.1 governance audit log.
--
-- Аддитивная миграция: добавляет новую таблицу AiKnowledgeAuditLog
-- (JSON snapshots before/after) + enum AiKnowledgeAuditAction.
--
-- isVerified/verifiedBy/verifiedAt в AiKnowledgeItem уже включены
-- в PR1 (pre-emptive — чтобы не делать второй ALTER здесь).
--
-- Нулевое влияние на текущий pipeline.

-- ─── Enum ─────────────────────────────────────────────────────────

CREATE TYPE "AiKnowledgeAuditAction" AS ENUM (
    'created',
    'manual_created',
    'edited',
    'archived',
    'restored',
    'verified',
    'unverified',
    'superseded',
    'conflict_resolved',
    'source_added'
);

-- ─── AiKnowledgeAuditLog ─────────────────────────────────────────
-- Lightweight audit trail с JSON snapshots. itemId — soft reference
-- (без FK), чтобы будущий physical delete item'а не каскадировал в
-- audit history.

CREATE TABLE "AiKnowledgeAuditLog" (
    "id"         TEXT NOT NULL,
    "itemId"     TEXT,
    "actor"      TEXT,
    "action"     "AiKnowledgeAuditAction" NOT NULL,
    "beforeJson" JSONB,
    "afterJson"  JSONB,
    "metadata"   JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiKnowledgeAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiKnowledgeAuditLog_itemId_createdAt_idx"
    ON "AiKnowledgeAuditLog"("itemId", "createdAt" DESC);

CREATE INDEX "AiKnowledgeAuditLog_action_createdAt_idx"
    ON "AiKnowledgeAuditLog"("action", "createdAt" DESC);
