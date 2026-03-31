-- Block 3.5: AI Control Center
-- AiAgentMode enum
CREATE TYPE "AiAgentMode" AS ENUM ('off', 'suggest_only', 'auto_reply', 'operator_locked');

-- AiProviderType enum
CREATE TYPE "AiProviderType" AS ENUM ('anthropic', 'openai');

-- AiImportMode enum
CREATE TYPE "AiImportMode" AS ENUM ('from_connection_time', 'available_history', 'last_n_days');

-- AiImportStatus enum
CREATE TYPE "AiImportStatus" AS ENUM ('queued', 'running', 'completed', 'partial', 'failed');

-- AiAgentConfig (singleton)
CREATE TABLE "AiAgentConfig" (
    "id"                    TEXT NOT NULL DEFAULT 'singleton',
    "enabled"               BOOLEAN NOT NULL DEFAULT false,
    "mode"                  "AiAgentMode" NOT NULL DEFAULT 'off',
    "provider"              "AiProviderType" NOT NULL DEFAULT 'anthropic',
    "apiKeyEncrypted"       TEXT,
    "classificationModel"   TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
    "responseModel"         TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    "language"              TEXT NOT NULL DEFAULT 'ru',
    "confidenceThreshold"   DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "maxAutoRepliesPerChat" INTEGER NOT NULL DEFAULT 5,
    "activeChannels"        TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalationPolicy"      JSONB,
    "workingHours"          JSONB,
    "routingRules"          JSONB,
    "promptRole"            TEXT,
    "promptTone"            TEXT,
    "promptAllowed"         TEXT,
    "promptForbidden"       TEXT,
    "connectionStatus"      TEXT,
    "lastConnectionCheckAt" TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiAgentConfig_pkey" PRIMARY KEY ("id")
);

-- KnowledgeBaseEntry
CREATE TABLE "KnowledgeBaseEntry" (
    "id"              TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "category"        TEXT NOT NULL DEFAULT 'general',
    "sampleQuestions" JSONB NOT NULL DEFAULT '[]',
    "answer"          TEXT NOT NULL,
    "tags"            TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels"        TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "priority"        INTEGER NOT NULL DEFAULT 0,
    "lastReviewedAt"  TIMESTAMP(3),
    "updatedBy"       TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeBaseEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeBaseEntry_active_priority_idx" ON "KnowledgeBaseEntry"("active", "priority" DESC);
CREATE INDEX "KnowledgeBaseEntry_category_idx" ON "KnowledgeBaseEntry"("category");

-- AiDecisionLog
CREATE TABLE "AiDecisionLog" (
    "id"                   TEXT NOT NULL,
    "messageId"            TEXT,
    "chatId"               TEXT,
    "channel"              TEXT,
    "detectedIntent"       TEXT,
    "confidence"           DOUBLE PRECISION,
    "decision"             TEXT,
    "selectedModel"        TEXT,
    "usedKnowledgeEntries" JSONB,
    "generatedReply"       TEXT,
    "replySent"            BOOLEAN NOT NULL DEFAULT false,
    "escalated"            BOOLEAN NOT NULL DEFAULT false,
    "error"                TEXT,
    "reviewedByOperator"   BOOLEAN NOT NULL DEFAULT false,
    "operatorVerdict"      TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiDecisionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiDecisionLog_createdAt_idx" ON "AiDecisionLog"("createdAt" DESC);
CREATE INDEX "AiDecisionLog_channel_idx" ON "AiDecisionLog"("channel");
CREATE INDEX "AiDecisionLog_detectedIntent_idx" ON "AiDecisionLog"("detectedIntent");
CREATE INDEX "AiDecisionLog_decision_idx" ON "AiDecisionLog"("decision");

-- HistoryImportJob
CREATE TABLE "HistoryImportJob" (
    "id"                TEXT NOT NULL,
    "channels"          TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mode"              "AiImportMode" NOT NULL,
    "daysBack"          INTEGER,
    "status"            "AiImportStatus" NOT NULL DEFAULT 'queued',
    "resultType"        TEXT,
    "startedAt"         TIMESTAMP(3),
    "finishedAt"        TIMESTAMP(3),
    "chatsScanned"      INTEGER NOT NULL DEFAULT 0,
    "contactsFound"     INTEGER NOT NULL DEFAULT 0,
    "messagesImported"  INTEGER NOT NULL DEFAULT 0,
    "coveredPeriodFrom" TIMESTAMP(3),
    "coveredPeriodTo"   TIMESTAMP(3),
    "detailsJson"       JSONB,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HistoryImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HistoryImportJob_status_createdAt_idx" ON "HistoryImportJob"("status", "createdAt" DESC);
