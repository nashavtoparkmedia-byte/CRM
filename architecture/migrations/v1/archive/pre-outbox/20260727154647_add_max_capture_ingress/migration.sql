-- Stage 8A: retry identity for a physical capture envelope. This migration is
-- additive and intentionally leaves historical Stage 1 observations nullable.

ALTER TABLE "MaxRawTransportEvent"
ADD COLUMN "captureEnvelopeId" TEXT;

CREATE INDEX "MaxRawTransportEvent_accountId_captureEnvelopeId_idx"
ON "MaxRawTransportEvent"("accountId", "captureEnvelopeId");

CREATE UNIQUE INDEX "MaxRawTransportEvent_accountId_captureEnvelopeId_key"
ON "MaxRawTransportEvent"("accountId", "captureEnvelopeId")
WHERE "captureEnvelopeId" IS NOT NULL;

-- Retry identity is deliberately account-scoped. payloadSha256, providerEventId,
-- frameId, transportSequence, timestamps, and content remain non-unique so two
-- byte-identical physical observations are retained as two journal rows.
