-- Messaging-owned SendToContact request identity (SendToContact capability).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery; production deployment remains a separate reviewed operation.
-- It adds one new Messaging-owned table. One row binds a caller requestId to the
-- sha256 of its semantic payload, permanently: the capability only inserts a row
-- if absent and reads it, and has no update or delete path, so a requestId can
-- never be reopened for another payload. No existing object is named, changed
-- or removed. Nothing here stores a message, a conversation, a Contact, a
-- credential, a provider identifier or a transport; the one Message an intent
-- may admit is found by its derived clientMessageId, "stc:" + requestId.

BEGIN;

CREATE TABLE "MessagingSendIntent" (
    "requestId" VARCHAR(128) NOT NULL,
    "semanticPayloadSha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingSendIntent_pkey" PRIMARY KEY ("requestId"),
    CONSTRAINT "MessagingSendIntent_requestId_shape_check"
        CHECK ("requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT "MessagingSendIntent_semanticPayloadSha256_shape_check"
        CHECK ("semanticPayloadSha256" ~ '^[0-9a-f]{64}$')
);

COMMIT;
