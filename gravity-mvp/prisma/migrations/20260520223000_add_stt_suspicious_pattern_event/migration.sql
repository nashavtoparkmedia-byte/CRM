-- PR #60 — STT Garbage Filter Layer v1.
--
-- Extends "AiCallEventType" with one new value: `stt_suspicious_pattern`.
-- Emitted by the bridge when an STT final matches a known garbage
-- pattern (subtitle_credits, non_russian_garbage) — see
-- tools/audio-bridge-day1/stt-garbage.js and
-- docs/research/stt-garbage-patterns.md.
--
-- ALTER TYPE ... ADD VALUE cannot run in a transaction with other DDL
-- in Postgres, so this migration carries this single operation. Future
-- enum additions follow the same one-per-migration pattern.
--
-- IF NOT EXISTS guard makes the migration idempotent across dev boxes
-- where the value may have been added ad-hoc.

ALTER TYPE "AiCallEventType" ADD VALUE IF NOT EXISTS 'stt_suspicious_pattern';
