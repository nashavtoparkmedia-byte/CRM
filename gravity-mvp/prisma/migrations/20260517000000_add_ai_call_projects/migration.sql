-- AI-call scenarios are grouped into projects (e.g. lead qualification,
-- churn winback, NPS survey). One scenario belongs to at most one project.
-- projectId on AiCallScenario is nullable so existing rows survive the
-- migration; the application backfills them to the default project on
-- first list read.

-- CreateTable
CREATE TABLE "AiCallProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCallProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCallProject_name_key" ON "AiCallProject"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AiCallProject_slug_key" ON "AiCallProject"("slug");

-- AlterTable
ALTER TABLE "AiCallScenario" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "AiCallScenario_projectId_isActive_idx" ON "AiCallScenario"("projectId", "isActive");

-- AddForeignKey
ALTER TABLE "AiCallScenario" ADD CONSTRAINT "AiCallScenario_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "AiCallProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default projects (idempotent — uses fixed ids so re-applying is safe).
INSERT INTO "AiCallProject" ("id", "name", "slug", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
    ('proj_lead_qual',      'Квалификация лида',  'lead-qualification', 'Холодные/тёплые звонки лидам для квалификации перед передачей менеджеру.', true, 10, NOW(), NOW()),
    ('proj_churn_winback',  'Работа с оттоком',   'churn-winback',      'Возврат уходящих или давно неактивных водителей.',                          true, 20, NOW(), NOW()),
    ('proj_nps_survey',     'Опрос качества',     'nps-survey',         'Сбор обратной связи и оценок качества обслуживания у активных водителей.',  true, 30, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- Move the auto-seeded default scenario into the "Квалификация лида" project.
UPDATE "AiCallScenario"
SET "projectId" = 'proj_lead_qual'
WHERE "projectId" IS NULL
  AND "name" = 'Квалификация водителя (по умолчанию)';
