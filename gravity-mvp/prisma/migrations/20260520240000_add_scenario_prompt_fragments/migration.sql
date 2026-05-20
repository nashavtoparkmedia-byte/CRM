-- PR #63 — Prompt Fragment Layer v1.
--
-- Adds `fragments` JSONB column to "AiCallScenario". When set, holds a
-- record mapping fragment slots (greeting / qualification_intro /
-- recovery / transfer_framing / objection_soft? / closing?) to
-- `{ id, version, text, hypothesis? }` rows. Bridge composes these
-- into the system prompt via tools/audio-bridge-day1/prompt-fragments.js.
--
-- NULL / missing → legacy monolithic prompt path (no opt-in). The bridge
-- falls back silently; existing scenarios continue to work unchanged.
--
-- Idempotent (IF NOT EXISTS), mirrors PR #57 / #59 / #62 migration shape.

ALTER TABLE "AiCallScenario"
    ADD COLUMN IF NOT EXISTS "fragments" JSONB;
