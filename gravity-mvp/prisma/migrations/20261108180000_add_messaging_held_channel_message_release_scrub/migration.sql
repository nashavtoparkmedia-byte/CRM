-- Messaging held store: a released row carries no content (R-21 A2).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery; production deployment remains a separate reviewed operation.
-- It adds one CHECK to the Messaging-owned "HeldChannelMessage" table and
-- names, changes or removes no other object and no row.
--
-- Once a held event is released, the visible "Message" is its only copy, so
-- the held row keeps only its key, its release stamp and the compared ids:
-- content is empty and metadata is '{}'. The database pins the rule, so a
-- release that forgot to scrub, or a later write that restored text to a
-- released row, is refused. The table is new and unreleased everywhere this
-- migration can be applied, so the constraint has no rows to validate against.

BEGIN;

ALTER TABLE "HeldChannelMessage" ADD CONSTRAINT "HeldChannelMessage_released_scrubbed_check"
    CHECK ("releasedAt" IS NULL OR ("content" = '' AND "metadata" = '{}'::jsonb));

COMMIT;
