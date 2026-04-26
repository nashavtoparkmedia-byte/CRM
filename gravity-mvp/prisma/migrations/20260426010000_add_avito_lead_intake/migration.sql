-- Migration: add_avito_lead_intake
-- Унификация раздела /leads/new — общий inbox для всех источников лидов.
--
-- 1. Расширяем enum'ы канала и источника телефона новым значением 'avito'
-- 2. Делаем Task.driverId nullable — Avito-лиды не привязаны к водителям
-- 3. Добавляем колонки crm_chat_id / crm_contact_id / crm_task_id в
--    avito_responses — связь источниковой строки с CRM-сущностями.
--    Эти поля заполняет LeadIntake-сервис и читает витрина /leads/new.

-- 1.1. Channel канала: добавляем 'avito'
ALTER TYPE "ChatChannel" ADD VALUE IF NOT EXISTS 'avito';

-- 1.2. Источник телефона контакта: добавляем 'avito'
ALTER TYPE "ContactPhoneSource" ADD VALUE IF NOT EXISTS 'avito';

-- 2. Task.driverId: NOT NULL → NULL.
--    Лиды-источники не имеют водителя. Существующие данные не трогаем
--    (все строки уже имеют driverId), но новые задачи для лидов смогут
--    создаваться с null. UI задач (TaskDetailsPane / InboxClient) должен
--    проверять driverId на null перед рендером ссылок на /drivers/:id.
ALTER TABLE "tasks" ALTER COLUMN "driverId" DROP NOT NULL;

-- 3. Колонки связей в avito_responses
ALTER TABLE "avito_responses"
  ADD COLUMN IF NOT EXISTS "crm_contact_id" TEXT,
  ADD COLUMN IF NOT EXISTS "crm_chat_id" TEXT,
  ADD COLUMN IF NOT EXISTS "crm_task_id" TEXT;

-- Индексы — частые запросы на витрине /leads/new фильтруют по наличию
-- crm_chat_id (для catchup-sync) и сортируют по detected_at.
CREATE INDEX IF NOT EXISTS "avito_responses_crm_chat_id_idx"
  ON "avito_responses" ("crm_chat_id");
CREATE INDEX IF NOT EXISTS "avito_responses_crm_contact_id_idx"
  ON "avito_responses" ("crm_contact_id");
