-- AI Knowledge Core — PR3.1 retrieval policy + usage trace extensions.
--
-- Аддитивная миграция. Нулевое влияние на текущий pipeline ответа —
-- все новые колонки nullable / с default'ами. Retrieval активируется
-- отдельно через env (AI_KNOWLEDGE_SHADOW_MODE /
-- AI_KNOWLEDGE_RUNTIME_ENABLED) в PR3.4.

-- ─── AiRetrievalPolicy (singleton) ───────────────────────────────

CREATE TABLE "AiRetrievalPolicy" (
    "id"                         TEXT NOT NULL,
    "minConfidenceForReply"      DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "sensitiveConfidenceMargin"  DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "minSourceCountForReply"     INTEGER NOT NULL DEFAULT 1,
    "verifiedScoreBoost"         DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "excludeArchived"            BOOLEAN NOT NULL DEFAULT true,
    "excludeSuperseded"          BOOLEAN NOT NULL DEFAULT true,
    "excludeDraft"               BOOLEAN NOT NULL DEFAULT true,
    "conflictEscalates"          BOOLEAN NOT NULL DEFAULT true,
    "maxStaleDays"               INTEGER,
    "rerankEnabled"              BOOLEAN NOT NULL DEFAULT true,
    "rerankTopN"                 INTEGER NOT NULL DEFAULT 5,
    "prefilterTopN"              INTEGER NOT NULL DEFAULT 20,
    "shadowMode"                 BOOLEAN NOT NULL DEFAULT true,
    "runtimeEnabled"             BOOLEAN NOT NULL DEFAULT false,
    "policyVersion"              TEXT NOT NULL DEFAULT 'v1',
    "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                  TIMESTAMP(3) NOT NULL,
    "updatedBy"                  TEXT,

    CONSTRAINT "AiRetrievalPolicy_pkey" PRIMARY KEY ("id")
);

-- Bootstrap singleton row.
INSERT INTO "AiRetrievalPolicy" (id, "updatedAt") VALUES ('singleton', NOW());

-- ─── AiKnowledgeUsageLog extensions ──────────────────────────────

ALTER TABLE "AiKnowledgeUsageLog"
    ADD COLUMN "policyDecision"   TEXT,
    ADD COLUMN "shadowMode"       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "escalationReason" TEXT;

CREATE INDEX "AiKnowledgeUsageLog_shadowMode_usedAt_idx"
    ON "AiKnowledgeUsageLog"("shadowMode", "usedAt" DESC);

-- ─── AiDecisionLog extensions ────────────────────────────────────

ALTER TABLE "AiDecisionLog"
    ADD COLUMN "retrievalMode"            TEXT,
    ADD COLUMN "retrievalDecision"        TEXT,
    ADD COLUMN "escalationReason"         TEXT,
    ADD COLUMN "knowledgeRuntimeVersion"  TEXT,
    ADD COLUMN "shadowRetrievalSummary"   JSONB;

CREATE INDEX "AiDecisionLog_retrievalMode_createdAt_idx"
    ON "AiDecisionLog"("retrievalMode", "createdAt" DESC);
