-- PR #62 — Greeting Optimization Layer v1.
--
-- Adds `greetingVariants` JSONB column to "AiCallScenario". Holds an
-- array of `{ id, text, label? }` rows the bridge selects from via a
-- deterministic hash on callUuid. See tools/audio-bridge-day1/
-- greeting-variants.js for the picker contract.
--
-- NULL / missing → legacy LLM-generated greeting path (no opt-in).
-- The bridge falls back silently; existing scenarios continue to work
-- unchanged.
--
-- Idempotent (IF NOT EXISTS), mirrors PR #57 / PR #59 migration shape.

ALTER TABLE "AiCallScenario"
    ADD COLUMN IF NOT EXISTS "greetingVariants" JSONB;
