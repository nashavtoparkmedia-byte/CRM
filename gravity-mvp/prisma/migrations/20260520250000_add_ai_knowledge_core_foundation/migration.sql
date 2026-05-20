-- AI Knowledge Core — foundation (PR1).
--
-- Channel-agnostic extracted business memory + explainable retrieval.
-- Полностью аддитивная миграция: ни одной строки в существующих
-- таблицах не меняется. Текущий pipeline ответа продолжает работать
-- на KnowledgeBaseEntry без изменений.
--
-- Red lines: memory/project_ai_knowledge_core.md.

-- ─── Enums ────────────────────────────────────────────────────────

CREATE TYPE "AiKnowledgeStatus" AS ENUM (
    'active',
    'archived',
    'superseded',
    'draft',
    'needs_review'
);

CREATE TYPE "AiKnowledgeSafety" AS ENUM (
    'normal',
    'sensitive',
    'requires_human'
);

CREATE TYPE "AiKnowledgeSourceOrigin" AS ENUM (
    'chat_message',
    'voice_transcript',
    'manual_entry',
    'doc_section'
);

CREATE TYPE "AiKnowledgeRuntime" AS ENUM (
    'chat_reply',
    'voice_reply',
    'dev_simulate'
);

CREATE TYPE "AiExtractionStatus" AS ENUM (
    'queued',
    'running',
    'completed',
    'partial',
    'failed'
);

-- ─── AiKnowledgeSection ───────────────────────────────────────────

CREATE TABLE "AiKnowledgeSection" (
    "id"          TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "description" TEXT,
    "iconKey"     TEXT,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiKnowledgeSection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiKnowledgeSection_slug_key"
    ON "AiKnowledgeSection"("slug");

CREATE INDEX "AiKnowledgeSection_isActive_sortOrder_idx"
    ON "AiKnowledgeSection"("isActive", "sortOrder");

-- ─── AiKnowledgeItem ──────────────────────────────────────────────

CREATE TABLE "AiKnowledgeItem" (
    "id"                  TEXT NOT NULL,
    "sectionId"           TEXT NOT NULL,
    "title"               TEXT NOT NULL,
    "canonicalStatement"  TEXT NOT NULL,
    "tags"                TEXT[],
    "confidence"          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sourceCount"         INTEGER NOT NULL DEFAULT 0,
    "uniqueManagerCount"  INTEGER NOT NULL DEFAULT 0,
    "status"              "AiKnowledgeStatus" NOT NULL DEFAULT 'active',
    "isActive"            BOOLEAN NOT NULL DEFAULT true,
    "safetyLevel"         "AiKnowledgeSafety" NOT NULL DEFAULT 'normal',
    "supersededByItemId"  TEXT,
    "conflictGroupId"     TEXT,
    "isVerified"          BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy"          TEXT,
    "verifiedAt"          TIMESTAMP(3),
    "createdBy"           TEXT,
    "lastUsedAt"          TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiKnowledgeItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiKnowledgeItem_supersededByItemId_key"
    ON "AiKnowledgeItem"("supersededByItemId");

CREATE INDEX "AiKnowledgeItem_sectionId_status_isActive_idx"
    ON "AiKnowledgeItem"("sectionId", "status", "isActive");

CREATE INDEX "AiKnowledgeItem_conflictGroupId_idx"
    ON "AiKnowledgeItem"("conflictGroupId");

CREATE INDEX "AiKnowledgeItem_status_updatedAt_idx"
    ON "AiKnowledgeItem"("status", "updatedAt" DESC);

CREATE INDEX "AiKnowledgeItem_isVerified_idx"
    ON "AiKnowledgeItem"("isVerified");

ALTER TABLE "AiKnowledgeItem"
    ADD CONSTRAINT "AiKnowledgeItem_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "AiKnowledgeSection"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AiKnowledgeItem"
    ADD CONSTRAINT "AiKnowledgeItem_supersededByItemId_fkey"
    FOREIGN KEY ("supersededByItemId") REFERENCES "AiKnowledgeItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── AiKnowledgeSource ────────────────────────────────────────────

CREATE TABLE "AiKnowledgeSource" (
    "id"            TEXT NOT NULL,
    "itemId"        TEXT NOT NULL,
    "originType"    "AiKnowledgeSourceOrigin" NOT NULL DEFAULT 'chat_message',
    "messageId"     TEXT,
    "chatId"        TEXT,
    "channel"       "ChatChannel",
    "managerUserId" TEXT,
    "excerpt"       TEXT NOT NULL,
    "excerptHash"   TEXT NOT NULL,
    "confidence"    DOUBLE PRECISION NOT NULL,
    "occurredAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiKnowledgeSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiKnowledgeSource_itemId_excerptHash_key"
    ON "AiKnowledgeSource"("itemId", "excerptHash");

CREATE INDEX "AiKnowledgeSource_itemId_idx"
    ON "AiKnowledgeSource"("itemId");

CREATE INDEX "AiKnowledgeSource_messageId_idx"
    ON "AiKnowledgeSource"("messageId");

CREATE INDEX "AiKnowledgeSource_managerUserId_idx"
    ON "AiKnowledgeSource"("managerUserId");

ALTER TABLE "AiKnowledgeSource"
    ADD CONSTRAINT "AiKnowledgeSource_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "AiKnowledgeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── AiKnowledgeUsageLog ──────────────────────────────────────────

CREATE TABLE "AiKnowledgeUsageLog" (
    "id"             TEXT NOT NULL,
    "itemId"         TEXT NOT NULL,
    "runtimeContext" "AiKnowledgeRuntime" NOT NULL DEFAULT 'chat_reply',
    "decisionLogId"  TEXT,
    "messageId"      TEXT,
    "retrievalScore" DOUBLE PRECISION,
    "rerankScore"    DOUBLE PRECISION,
    "usedInReply"    BOOLEAN NOT NULL DEFAULT false,
    "usedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiKnowledgeUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiKnowledgeUsageLog_itemId_usedAt_idx"
    ON "AiKnowledgeUsageLog"("itemId", "usedAt" DESC);

CREATE INDEX "AiKnowledgeUsageLog_decisionLogId_idx"
    ON "AiKnowledgeUsageLog"("decisionLogId");

CREATE INDEX "AiKnowledgeUsageLog_usedAt_idx"
    ON "AiKnowledgeUsageLog"("usedAt" DESC);

ALTER TABLE "AiKnowledgeUsageLog"
    ADD CONSTRAINT "AiKnowledgeUsageLog_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "AiKnowledgeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── AiExtractionJob ──────────────────────────────────────────────

CREATE TABLE "AiExtractionJob" (
    "id"           TEXT NOT NULL,
    "status"       "AiExtractionStatus" NOT NULL DEFAULT 'queued',
    "sourceType"   "AiKnowledgeSourceOrigin" NOT NULL DEFAULT 'chat_message',
    "scope"        JSONB NOT NULL DEFAULT '{}',
    "progress"     JSONB,
    "startedAt"    TIMESTAMP(3),
    "finishedAt"   TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdBy"    TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiExtractionJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiExtractionJob_status_createdAt_idx"
    ON "AiExtractionJob"("status", "createdAt" DESC);
