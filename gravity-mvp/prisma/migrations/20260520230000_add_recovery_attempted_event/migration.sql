-- PR #61 — Conversation Recovery Layer v1.
--
-- Adds `recovery_attempted` to "AiCallEventType". Emitted by the bridge
-- when a short deterministic recovery prompt fires (garbage cluster /
-- silence-after-greeting / ambiguous-short). Payload carries trigger,
-- action, phrase_head, attempt_n.
--
-- ALTER TYPE ... ADD VALUE cannot run in a transaction with other DDL,
-- so this migration carries this single operation. Idempotent via
-- IF NOT EXISTS.

ALTER TYPE "AiCallEventType" ADD VALUE IF NOT EXISTS 'recovery_attempted';
