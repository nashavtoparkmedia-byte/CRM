-- Migration: add_ai_status
-- Блок 1: AiStatus для трекинга обработки входящих сообщений AI агентом

CREATE TYPE "AiStatus" AS ENUM ('pending', 'processing', 'done', 'skipped', 'failed');

ALTER TABLE "Message" ADD COLUMN "aiStatus" "AiStatus";

CREATE INDEX "Message_aiStatus_idx" ON "Message"("aiStatus");
