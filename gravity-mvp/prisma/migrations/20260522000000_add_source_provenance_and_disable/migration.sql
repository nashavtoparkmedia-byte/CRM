-- PR7.1: Knowledge Source provenance + soft-disable
--
-- Goal: дать ядру explainable "из какого аккаунта пришло знание"
-- и safe soft-disable знаний с конкретного source (PR7.7).
--
-- Backward-compat: все существующие AiKnowledgeSource получают
-- connectionId=NULL (legacy, до PR7), isActive=true (всё что было
-- — активное по умолчанию).
--
-- Provenance — polymorphic, без FK: discriminator уже есть через
-- `channel` (WA / TG / MAX / voice). Это сохраняет explainability
-- history даже после удаления connection'а.

ALTER TABLE "AiKnowledgeSource"
    ADD COLUMN "connectionId" TEXT NULL,
    ADD COLUMN "isActive"     BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "AiKnowledgeSource_connectionId_isActive_idx"
    ON "AiKnowledgeSource"("connectionId", "isActive");

-- New audit-action values для PR7.7 / PR7.8 events.
ALTER TYPE "AiKnowledgeAuditAction" ADD VALUE 'source_disabled';
ALTER TYPE "AiKnowledgeAuditAction" ADD VALUE 'core_reset';
