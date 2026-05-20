-- AI Knowledge Core — PR2.1 extraction snapshot fields.
--
-- Аддитивная миграция: добавляет настройки выбора модели экстрактора
-- (AiAgentConfig) + snapshot полей в AiExtractionJob для regression
-- analysis ("это ядро собрано моделью X промптом vN").
--
-- Нулевое влияние на текущий pipeline ответа. Все добавленные колонки
-- nullable / с default'ами.

-- ─── AiAgentConfig: пресет модели для extraction-pipeline ────────
-- extractionQualityTier маппится в Extractor:
--   'economy'  → Claude Haiku 4.5 / gpt-4o-mini
--   'balanced' → AiAgentConfig.classificationModel (default)
--   'quality'  → AiAgentConfig.responseModel
-- Default 'balanced' — provider-agnostic, дёшево, JSON-mode достаточно.

ALTER TABLE "AiAgentConfig"
    ADD COLUMN "extractionQualityTier" TEXT DEFAULT 'balanced',
    ADD COLUMN "extractionPromptVersion" TEXT;

-- ─── AiExtractionJob: snapshot модели/промпта/тира ───────────────
-- Пишется один раз при старте Extractor.run и больше не меняется.
-- Даёт ответ на "почему это ядро именно такое":
--   - какая модель его собрала
--   - какая версия промпта была активна
--   - какой preset выбрал админ
-- Все поля nullable: исторические jobs (если будут) останутся валидными.

ALTER TABLE "AiExtractionJob"
    ADD COLUMN "extractionProvider"      TEXT,
    ADD COLUMN "extractionModel"         TEXT,
    ADD COLUMN "extractionPromptVersion" TEXT,
    ADD COLUMN "extractionQualityTier"   TEXT;
