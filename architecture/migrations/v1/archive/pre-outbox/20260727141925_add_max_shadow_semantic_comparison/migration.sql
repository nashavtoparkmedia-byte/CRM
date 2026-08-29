-- Stage 7: offline/shadow semantic comparison and deterministic replay.
-- Additive and dormant: no runtime listener, browser, provider, CRM projection,
-- Route Registry mutation, or production enablement is introduced here.

CREATE TABLE "MaxShadowComparisonRun" (
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "legacyAdapterVersion" TEXT NOT NULL,
    "newNormalizerVersion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "sourceFromJournalSequence" BIGINT,
    "sourceToJournalSequence" BIGINT,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "expectedDifferenceCount" INTEGER NOT NULL DEFAULT 0,
    "regressionCount" INTEGER NOT NULL DEFAULT 0,
    "legacyOnlyCount" INTEGER NOT NULL DEFAULT 0,
    "newOnlyCount" INTEGER NOT NULL DEFAULT 0,
    "unsupportedCount" INTEGER NOT NULL DEFAULT 0,
    "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaxShadowComparisonRun_pkey" PRIMARY KEY ("runId"),
    CONSTRAINT "MaxShadowComparisonRun_identity_check" CHECK (
        char_length("runId") BETWEEN 1 AND 256
        AND "runId" = btrim("runId") AND "runId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId") AND "accountId" !~ '[[:cntrl:]]'
        AND char_length("comparisonVersion") BETWEEN 1 AND 128
        AND "comparisonVersion" = btrim("comparisonVersion")
        AND char_length("legacyAdapterVersion") BETWEEN 1 AND 128
        AND "legacyAdapterVersion" = btrim("legacyAdapterVersion")
        AND char_length("newNormalizerVersion") BETWEEN 1 AND 128
        AND "newNormalizerVersion" = btrim("newNormalizerVersion")
    ),
    CONSTRAINT "MaxShadowComparisonRun_state_check" CHECK (
        "state" IN ('running', 'completed', 'failed', 'cancelled')
        AND (("state" = 'running' AND "completedAt" IS NULL)
            OR ("state" <> 'running' AND "completedAt" IS NOT NULL))
    ),
    CONSTRAINT "MaxShadowComparisonRun_range_check" CHECK (
        ("sourceFromJournalSequence" IS NULL OR "sourceFromJournalSequence" >= 0)
        AND ("sourceToJournalSequence" IS NULL OR "sourceToJournalSequence" >= 0)
        AND ("sourceFromJournalSequence" IS NULL OR "sourceToJournalSequence" IS NULL
            OR "sourceToJournalSequence" >= "sourceFromJournalSequence")
    ),
    CONSTRAINT "MaxShadowComparisonRun_counter_check" CHECK (
        "processedCount" >= 0 AND "matchedCount" >= 0
        AND "expectedDifferenceCount" >= 0 AND "regressionCount" >= 0
        AND "legacyOnlyCount" >= 0 AND "newOnlyCount" >= 0
        AND "unsupportedCount" >= 0 AND "quarantinedCount" >= 0
        AND "processedCount" = "matchedCount" + "expectedDifferenceCount"
            + "regressionCount" + "legacyOnlyCount" + "newOnlyCount"
            + "unsupportedCount" + "quarantinedCount"
    )
);

CREATE TABLE "MaxShadowComparisonResult" (
    "resultId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceObservationId" TEXT NOT NULL,
    "sourceJournalSequence" BIGINT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "legacyStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "legacySemanticSha256" TEXT NOT NULL,
    "newSemanticSha256" TEXT NOT NULL,
    "diffCount" INTEGER NOT NULL,
    "highestSeverity" TEXT NOT NULL,
    "issueCode" TEXT,
    "safeSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaxShadowComparisonResult_pkey" PRIMARY KEY ("resultId"),
    CONSTRAINT "MaxShadowComparisonResult_identity_check" CHECK (
        char_length("resultId") BETWEEN 1 AND 256
        AND "resultId" = btrim("resultId") AND "resultId" !~ '[[:cntrl:]]'
        AND char_length("runId") BETWEEN 1 AND 256
        AND "runId" = btrim("runId") AND "runId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId") AND "accountId" !~ '[[:cntrl:]]'
        AND char_length("sourceObservationId") BETWEEN 1 AND 256
        AND "sourceObservationId" = btrim("sourceObservationId")
        AND "sourceJournalSequence" >= 0
        AND char_length("comparisonVersion") BETWEEN 1 AND 128
        AND "comparisonVersion" = btrim("comparisonVersion")
    ),
    CONSTRAINT "MaxShadowComparisonResult_semantic_check" CHECK (
        "classification" IN ('matched', 'expected_difference', 'regression',
            'legacy_only', 'new_only', 'unsupported', 'quarantined')
        AND "legacyStatus" IN ('normalized', 'unsupported', 'quarantined', 'absent')
        AND "newStatus" IN ('normalized', 'unsupported', 'quarantined', 'absent')
        AND "legacySemanticSha256" ~ '^[0-9a-f]{64}$'
        AND "newSemanticSha256" ~ '^[0-9a-f]{64}$'
        AND "diffCount" >= 0 AND "diffCount" <= 4096
        AND "highestSeverity" IN ('none', 'info', 'warning', 'error', 'critical')
        AND (("diffCount" = 0 AND "highestSeverity" = 'none')
            OR ("diffCount" > 0 AND "highestSeverity" <> 'none'))
        AND ("issueCode" IS NULL OR "issueCode" ~ '^[A-Z0-9_]{1,128}$')
        AND ("safeSummary" IS NULL OR (char_length("safeSummary") BETWEEN 1 AND 512
            AND "safeSummary" !~ '[[:cntrl:]]'))
    )
);

CREATE TABLE "MaxShadowSemanticDiff" (
    "diffId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "diffOrdinal" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "differenceKind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "legacyValueType" TEXT NOT NULL,
    "newValueType" TEXT NOT NULL,
    "legacyValueHash" TEXT,
    "newValueHash" TEXT,
    "safeMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaxShadowSemanticDiff_pkey" PRIMARY KEY ("diffId"),
    CONSTRAINT "MaxShadowSemanticDiff_identity_check" CHECK (
        char_length("diffId") BETWEEN 1 AND 256
        AND "diffId" = btrim("diffId") AND "diffId" !~ '[[:cntrl:]]'
        AND char_length("resultId") BETWEEN 1 AND 256
        AND "resultId" = btrim("resultId") AND "resultId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId") AND "accountId" !~ '[[:cntrl:]]'
        AND "diffOrdinal" >= 0 AND "diffOrdinal" < 4096
        AND char_length("path") BETWEEN 1 AND 512
        AND "path" LIKE '$%' AND "path" !~ '[[:cntrl:]]'
    ),
    CONSTRAINT "MaxShadowSemanticDiff_policy_check" CHECK (
        "differenceKind" IN ('missing_event', 'extra_event', 'kind_mismatch',
            'direction_mismatch', 'origin_mismatch', 'identifier_mismatch',
            'timestamp_mismatch', 'text_hash_mismatch', 'caption_hash_mismatch',
            'attachment_count_mismatch', 'attachment_identity_mismatch',
            'media_kind_mismatch', 'reply_target_mismatch',
            'reaction_target_mismatch', 'receipt_semantic_mismatch',
            'route_evidence_mismatch', 'classification_mismatch')
        AND "severity" IN ('info', 'warning', 'error', 'critical')
        AND "legacyValueType" IN ('missing', 'null', 'string', 'number', 'boolean', 'array', 'object')
        AND "newValueType" IN ('missing', 'null', 'string', 'number', 'boolean', 'array', 'object')
        AND ("legacyValueHash" IS NULL OR "legacyValueHash" ~ '^[0-9a-f]{64}$')
        AND ("newValueHash" IS NULL OR "newValueHash" ~ '^[0-9a-f]{64}$')
        AND jsonb_typeof("safeMetadata") = 'object'
        AND pg_column_size("safeMetadata") <= 8192
    )
);

CREATE TABLE "MaxShadowComparisonCursor" (
    "cursorId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "lastJournalSequence" BIGINT NOT NULL DEFAULT 0,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaxShadowComparisonCursor_pkey" PRIMARY KEY ("cursorId"),
    CONSTRAINT "MaxShadowComparisonCursor_value_check" CHECK (
        char_length("cursorId") BETWEEN 1 AND 256
        AND "cursorId" = btrim("cursorId") AND "cursorId" !~ '[[:cntrl:]]'
        AND char_length("runId") BETWEEN 1 AND 256
        AND "runId" = btrim("runId") AND "runId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId") AND "accountId" !~ '[[:cntrl:]]'
        AND char_length("comparisonVersion") BETWEEN 1 AND 128
        AND "comparisonVersion" = btrim("comparisonVersion")
        AND "lastJournalSequence" >= 0
        AND "optimisticVersion" >= 0
    )
);

CREATE UNIQUE INDEX "MaxShadowComparisonRun_account_run_version_key"
ON "MaxShadowComparisonRun"("accountId", "runId", "comparisonVersion");
CREATE INDEX "MaxShadowComparisonRun_account_version_state_idx"
ON "MaxShadowComparisonRun"("accountId", "comparisonVersion", "state", "startedAt");

CREATE UNIQUE INDEX "MaxShadowComparisonResult_run_source_version_key"
ON "MaxShadowComparisonResult"("runId", "sourceObservationId", "comparisonVersion");
CREATE UNIQUE INDEX "MaxShadowComparisonResult_account_result_key"
ON "MaxShadowComparisonResult"("accountId", "resultId");
CREATE INDEX "MaxShadowComparisonResult_account_sequence_idx"
ON "MaxShadowComparisonResult"("accountId", "sourceJournalSequence");
CREATE INDEX "MaxShadowComparisonResult_account_version_class_idx"
ON "MaxShadowComparisonResult"("accountId", "comparisonVersion", "classification", "sourceJournalSequence");
CREATE INDEX "MaxShadowComparisonResult_run_class_idx"
ON "MaxShadowComparisonResult"("runId", "classification");

CREATE UNIQUE INDEX "MaxShadowSemanticDiff_result_ordinal_key"
ON "MaxShadowSemanticDiff"("resultId", "diffOrdinal");
CREATE INDEX "MaxShadowSemanticDiff_account_severity_idx"
ON "MaxShadowSemanticDiff"("accountId", "severity", "createdAt");
CREATE INDEX "MaxShadowSemanticDiff_result_path_idx"
ON "MaxShadowSemanticDiff"("resultId", "path");
CREATE INDEX "MaxShadowSemanticDiff_kind_idx"
ON "MaxShadowSemanticDiff"("differenceKind");

CREATE UNIQUE INDEX "MaxShadowComparisonCursor_run_key"
ON "MaxShadowComparisonCursor"("runId");
CREATE UNIQUE INDEX "MaxShadowComparisonCursor_account_run_version_key"
ON "MaxShadowComparisonCursor"("accountId", "runId", "comparisonVersion");
CREATE INDEX "MaxShadowComparisonCursor_account_version_sequence_idx"
ON "MaxShadowComparisonCursor"("accountId", "comparisonVersion", "lastJournalSequence");

ALTER TABLE "MaxShadowComparisonResult"
ADD CONSTRAINT "MaxShadowComparisonResult_account_run_version_fkey"
FOREIGN KEY ("accountId", "runId", "comparisonVersion")
REFERENCES "MaxShadowComparisonRun"("accountId", "runId", "comparisonVersion")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxShadowComparisonResult"
ADD CONSTRAINT "MaxShadowComparisonResult_account_source_fkey"
FOREIGN KEY ("accountId", "sourceObservationId")
REFERENCES "MaxRawTransportEvent"("accountId", "observationId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxShadowSemanticDiff"
ADD CONSTRAINT "MaxShadowSemanticDiff_account_result_fkey"
FOREIGN KEY ("accountId", "resultId")
REFERENCES "MaxShadowComparisonResult"("accountId", "resultId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxShadowComparisonCursor"
ADD CONSTRAINT "MaxShadowComparisonCursor_account_run_version_fkey"
FOREIGN KEY ("accountId", "runId", "comparisonVersion")
REFERENCES "MaxShadowComparisonRun"("accountId", "runId", "comparisonVersion")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Result and diff rows are immutable for every role. There is deliberately no
-- custom GUC, role name, or caller-controlled bypass.
CREATE FUNCTION "max_shadow_comparison_result_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxShadowComparisonResult is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxShadowComparisonResult_append_only"
BEFORE UPDATE OR DELETE ON "MaxShadowComparisonResult"
FOR EACH ROW EXECUTE FUNCTION "max_shadow_comparison_result_append_only_guard"();

CREATE FUNCTION "max_shadow_semantic_diff_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxShadowSemanticDiff is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxShadowSemanticDiff_append_only"
BEFORE UPDATE OR DELETE ON "MaxShadowSemanticDiff"
FOR EACH ROW EXECUTE FUNCTION "max_shadow_semantic_diff_append_only_guard"();

-- Run identity and versions cannot drift. Counter mutations are accepted only
-- when every counter equals the currently visible immutable Result aggregate.
-- This keeps direct/caller-controlled counter changes from manufacturing
-- readiness and remains safe under PostgreSQL row-lock serialization.
CREATE FUNCTION "max_shadow_comparison_run_guard"()
RETURNS trigger AS $$
DECLARE
    actual_processed INTEGER;
    actual_matched INTEGER;
    actual_expected INTEGER;
    actual_regression INTEGER;
    actual_legacy_only INTEGER;
    actual_new_only INTEGER;
    actual_unsupported INTEGER;
    actual_quarantined INTEGER;
BEGIN
    IF NEW."runId" IS DISTINCT FROM OLD."runId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."comparisonVersion" IS DISTINCT FROM OLD."comparisonVersion"
       OR NEW."legacyAdapterVersion" IS DISTINCT FROM OLD."legacyAdapterVersion"
       OR NEW."newNormalizerVersion" IS DISTINCT FROM OLD."newNormalizerVersion"
       OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxShadowComparisonRun immutable identity mutation rejected';
    END IF;
    IF OLD."state" <> 'running' THEN
        RAISE EXCEPTION 'MaxShadowComparisonRun terminal state is immutable';
    END IF;
    SELECT count(*)::INTEGER,
           count(*) FILTER (WHERE "classification" = 'matched')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'expected_difference')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'regression')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'legacy_only')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'new_only')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'unsupported')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'quarantined')::INTEGER
    INTO actual_processed, actual_matched, actual_expected, actual_regression,
         actual_legacy_only, actual_new_only, actual_unsupported, actual_quarantined
    FROM "MaxShadowComparisonResult"
    WHERE "runId" = OLD."runId" AND "accountId" = OLD."accountId"
      AND "comparisonVersion" = OLD."comparisonVersion";
    IF NEW."processedCount" <> actual_processed
       OR NEW."matchedCount" <> actual_matched
       OR NEW."expectedDifferenceCount" <> actual_expected
       OR NEW."regressionCount" <> actual_regression
       OR NEW."legacyOnlyCount" <> actual_legacy_only
       OR NEW."newOnlyCount" <> actual_new_only
       OR NEW."unsupportedCount" <> actual_unsupported
       OR NEW."quarantinedCount" <> actual_quarantined THEN
        RAISE EXCEPTION 'MaxShadowComparisonRun counters must equal immutable Result aggregates';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxShadowComparisonRun_controlled_update"
BEFORE UPDATE ON "MaxShadowComparisonRun"
FOR EACH ROW EXECUTE FUNCTION "max_shadow_comparison_run_guard"();

CREATE FUNCTION "max_shadow_comparison_cursor_monotonic_guard"()
RETURNS trigger AS $$
BEGIN
    IF NEW."cursorId" IS DISTINCT FROM OLD."cursorId"
       OR NEW."runId" IS DISTINCT FROM OLD."runId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."comparisonVersion" IS DISTINCT FROM OLD."comparisonVersion"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxShadowComparisonCursor immutable scope mutation rejected';
    END IF;
    IF NEW."optimisticVersion" <> OLD."optimisticVersion" + 1 THEN
        RAISE EXCEPTION 'MaxShadowComparisonCursor optimistic version must advance once';
    END IF;
    IF NEW."lastJournalSequence" < OLD."lastJournalSequence" THEN
        RAISE EXCEPTION 'MaxShadowComparisonCursor regression rejected';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxShadowComparisonCursor_monotonic"
BEFORE UPDATE ON "MaxShadowComparisonCursor"
FOR EACH ROW EXECUTE FUNCTION "max_shadow_comparison_cursor_monotonic_guard"();

-- Rollback requires a separately approved retention-aware additive migration.
