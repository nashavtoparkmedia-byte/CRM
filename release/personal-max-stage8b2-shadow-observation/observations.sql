\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5000ms';
SET LOCAL lock_timeout = '1000ms';
SET LOCAL idle_in_transaction_session_timeout = '10000ms';

WITH
parameters AS (
  SELECT to_timestamp(:start_epoch::bigint) AS window_start,
         to_timestamp(:end_epoch::bigint) AS window_end,
         GREATEST(1, :end_epoch::bigint - :start_epoch::bigint) AS duration_seconds
),
accounts(account_id) AS (
  SELECT unnest(string_to_array(:'account_csv', ','))
),
account_aliases AS (
  SELECT account_id, encode(sha256(convert_to(account_id, 'UTF8')), 'hex') AS account_alias
  FROM accounts
),
raw_window AS MATERIALIZED (
  SELECT a.account_alias, r."accountId", r."observationId", r."journalSequence",
         r."captureEnvelopeId", r."observedAt", r."persistedAt", r."replayAvailability"
  FROM account_aliases a
  CROSS JOIN parameters p
  CROSS JOIN LATERAL (
    SELECT e."accountId", e."observationId", e."journalSequence", e."captureEnvelopeId",
           e."observedAt", e."persistedAt", e."replayAvailability"
    FROM "MaxRawTransportEvent" e
    WHERE e."accountId" = a.account_id
      AND e."observedAt" >= p.window_start AND e."observedAt" < p.window_end
  ) r
),
normalization AS MATERIALIZED (
  SELECT r.account_alias, r."observationId", n."status", n."eventCount", n."startedAt", n."completedAt"
  FROM raw_window r
  LEFT JOIN LATERAL (
    SELECT x."status", x."eventCount", x."startedAt", x."completedAt"
    FROM "MaxInboundNormalizationResult" x
    WHERE x."accountId" = r."accountId" AND x."sourceObservationId" = r."observationId"
    ORDER BY x."createdAt" DESC LIMIT 1
  ) n ON true
),
comparisons AS MATERIALIZED (
  SELECT r.account_alias, r."observationId", c."classification", c."highestSeverity"
  FROM raw_window r
  LEFT JOIN LATERAL (
    SELECT x."classification", x."highestSeverity"
    FROM "MaxShadowComparisonResult" x
    WHERE x."accountId" = r."accountId" AND x."sourceJournalSequence" = r."journalSequence"
  ) c ON true
),
comparison_per_account AS (
  SELECT a.account_alias,
    count(c."classification")::bigint AS semantic_comparisons,
    count(*) FILTER (WHERE c."classification" = 'regression')::bigint AS semantic_regressions,
    count(*) FILTER (WHERE c."classification" = 'regression' AND c."highestSeverity" = 'critical')::bigint AS critical_regressions
  FROM account_aliases a
  LEFT JOIN comparisons c ON c.account_alias = a.account_alias
  GROUP BY a.account_alias
),
critical_diffs AS (
  SELECT a.account_alias,
         count(*) FILTER (WHERE d."severity" = 'critical')::bigint AS critical_diffs,
         count(*) FILTER (WHERE d."severity" = 'critical' AND d."differenceKind" IN ('identifier_mismatch','route_evidence_mismatch'))::bigint AS route_identity_critical
  FROM account_aliases a CROSS JOIN parameters p
  LEFT JOIN LATERAL (
    SELECT d."severity", d."differenceKind"
    FROM "MaxShadowSemanticDiff" d
    WHERE d."accountId" = a.account_id AND d."severity" = 'critical'
      AND d."createdAt" >= p.window_start AND d."createdAt" < p.window_end
  ) d ON true
  GROUP BY a.account_alias
),
route_conflicts AS (
  SELECT a.account_alias, count(c.conflict_marker)::bigint AS open_route_conflicts
  FROM account_aliases a
  LEFT JOIN LATERAL (
    SELECT 1 AS conflict_marker FROM "MaxRouteConflict" c
    WHERE c."accountId" = a.account_id AND c."status" = 'open'
  ) c ON true
  GROUP BY a.account_alias
),
per_account AS (
  SELECT a.account_alias,
    count(r."observationId")::bigint AS raw_journal_rows,
    round((count(r."observationId")::numeric / (SELECT duration_seconds FROM parameters)), 6) AS raw_journal_rows_per_second,
    (count(r."captureEnvelopeId") - count(DISTINCT r."captureEnvelopeId"))::bigint AS accidental_duplicate_envelopes,
    count(*) FILTER (WHERE r."replayAvailability" = 'quarantined')::bigint AS raw_quarantined,
    count(n."observationId") FILTER (WHERE n."status" IS NOT NULL)::bigint AS normalization_results,
    count(*) FILTER (WHERE n."status" = 'quarantined')::bigint AS normalization_quarantined,
    count(*) FILTER (WHERE n."status" = 'unsupported')::bigint AS normalization_unsupported,
    count(*) FILTER (WHERE r."observationId" IS NOT NULL AND n."status" IS NULL)::bigint AS unprocessed_rows,
    COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - (min(r."observedAt") FILTER (WHERE n."status" IS NULL)))), 0)::bigint AS oldest_unprocessed_seconds,
    COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."persistedAt" - r."observedAt")) * 1000), 0)::bigint AS journal_p50_ms,
    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."persistedAt" - r."observedAt")) * 1000), 0)::bigint AS journal_p95_ms,
    COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."persistedAt" - r."observedAt")) * 1000), 0)::bigint AS journal_p99_ms
  FROM account_aliases a
  LEFT JOIN raw_window r ON r.account_alias = a.account_alias
  LEFT JOIN normalization n ON n.account_alias = a.account_alias AND n."observationId" = r."observationId"
  GROUP BY a.account_alias
),
activity AS (
  SELECT count(*) FILTER (WHERE pid <> pg_backend_pid() AND state <> 'idle')::bigint AS active_sessions,
         count(*) FILTER (WHERE pid <> pg_backend_pid() AND xact_start IS NOT NULL AND clock_timestamp() - xact_start > interval '5 minutes')::bigint AS long_transactions
  FROM pg_stat_activity
),
lock_state AS (
  SELECT count(*) FILTER (WHERE NOT granted)::bigint AS waiting_locks FROM pg_locks
),
expected_migrations(migration_name) AS (
  VALUES
    ('20260726162043_add_max_raw_transport_journal'),
    ('20260726190658_add_max_route_registry'),
    ('20260726205437_add_max_inbound_normalization'),
    ('20260726215715_add_max_per_chat_outbound_actor'),
    ('20260726225737_add_max_dispatch_ledger'),
    ('20260727053744_add_max_provider_confirmation_matcher'),
    ('20260727141925_add_max_shadow_semantic_comparison'),
    ('20260727154647_add_max_capture_ingress')
),
migration_ledger_state AS (
  SELECT
    (SELECT count(*)::bigint FROM "_prisma_migrations") AS total,
    (SELECT count(*)::bigint FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished,
    (SELECT count(*)::bigint FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed,
    COALESCE((
      SELECT json_agg(e.migration_name ORDER BY e.migration_name)
      FROM expected_migrations e
      JOIN "_prisma_migrations" m ON m.migration_name = e.migration_name
      WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
    ), '[]'::json) AS applied_expected_migrations
),
raw_journal_constraint_state AS (
  SELECT
    COALESCE(array_agg(c.conname ORDER BY c.conname), ARRAY[]::text[]) AS names,
    count(*) = 3 AND bool_and(
      c.convalidated AND
      regexp_replace(pg_get_constraintdef(c.oid, true), '\s+', ' ', 'g') =
      CASE c.conname
        WHEN 'MaxRawTransportEvent_payloadSizeBytes_check' THEN
          'CHECK ("payloadSizeBytes" >= 0)'
        WHEN 'MaxRawTransportEvent_quarantineConsistency_check' THEN
          'CHECK ("replayAvailability" = ''available''::text AND "quarantineReason" IS NULL OR "replayAvailability" = ''quarantined''::text AND "quarantineReason" IS NOT NULL)'
        WHEN 'MaxRawTransportEvent_replayAvailability_check' THEN
          'CHECK ("replayAvailability" = ANY (ARRAY[''available''::text, ''quarantined''::text]))'
        ELSE ''
      END
    ) AS definitions_exact
  FROM pg_constraint c
  WHERE c.conrelid = '"MaxRawTransportEvent"'::regclass
    AND c.contype = 'c'
    AND c.conname IN (
      'MaxRawTransportEvent_payloadSizeBytes_check',
      'MaxRawTransportEvent_quarantineConsistency_check',
      'MaxRawTransportEvent_replayAvailability_check'
    )
),
append_only_state AS (
  SELECT
    count(*) = 1 AS trigger_present,
    count(*) = 1 AND bool_and(
      t.tgtype = 27
      AND t.tgenabled = 'O'
      AND t.tgqual IS NULL
      AND t.tgnargs = 0
      AND p.proname = 'max_raw_transport_event_append_only_guard'
      AND n.nspname = 'public'
      AND l.lanname = 'plpgsql'
      AND p.pronargs = 0
      AND p.prosecdef = false
      AND p.provolatile = 'v'
      AND regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g') =
        'BEGIN RAISE EXCEPTION ''MaxRawTransportEvent is append-only''; END;'
    ) AS contract_exact
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE t.tgrelid = '"MaxRawTransportEvent"'::regclass
    AND t.tgname = 'MaxRawTransportEvent_append_only'
    AND NOT t.tgisinternal
),
totals AS (
  SELECT COALESCE(sum(raw_journal_rows), 0)::bigint AS raw_journal_rows,
         round(COALESCE(sum(raw_journal_rows_per_second), 0), 6) AS raw_journal_rows_per_second
  FROM per_account
)
SELECT json_build_object(
  'schemaVersion', 2,
  'databaseSnapshotIdentity', pg_current_snapshot()::text,
  'window', json_build_object('startEpoch', :start_epoch::bigint, 'endEpoch', :end_epoch::bigint, 'seconds', (SELECT duration_seconds FROM parameters)),
  'accountCount', (SELECT count(*) FROM account_aliases),
  'accounts', COALESCE((SELECT json_agg(json_build_object(
    'alias', p.account_alias,
    'rawJournalRows', p.raw_journal_rows,
    'rawJournalRowsPerSecond', p.raw_journal_rows_per_second,
    'accidentalDuplicateEnvelopes', p.accidental_duplicate_envelopes,
    'rawQuarantined', p.raw_quarantined,
    'normalizationResults', p.normalization_results,
    'normalizationQuarantined', p.normalization_quarantined,
    'normalizationUnsupported', p.normalization_unsupported,
    'semanticComparisons', cp.semantic_comparisons,
    'semanticRegressions', cp.semantic_regressions,
    'criticalRegressions', cp.critical_regressions,
    'criticalDiffs', d.critical_diffs,
    'routeIdentityCritical', d.route_identity_critical,
    'openRouteConflicts', rc.open_route_conflicts,
    'unprocessedRows', p.unprocessed_rows,
    'oldestUnprocessedSeconds', p.oldest_unprocessed_seconds,
    'journalLatencyMs', json_build_object('p50', p.journal_p50_ms, 'p95', p.journal_p95_ms, 'p99', p.journal_p99_ms)
  ) ORDER BY p.account_alias) FROM per_account p JOIN comparison_per_account cp USING (account_alias) JOIN critical_diffs d USING (account_alias) JOIN route_conflicts rc USING (account_alias)), '[]'::json),
  'totals', json_build_object(
    'rawJournalRows', (SELECT raw_journal_rows FROM totals),
    'rawJournalRowsPerSecond', (SELECT raw_journal_rows_per_second FROM totals)
  ),
  'activity', (SELECT row_to_json(activity) FROM activity),
  'locks', (SELECT row_to_json(lock_state) FROM lock_state),
  'schemaState', json_build_object(
    'migrationLedger', (SELECT json_build_object(
      'total', total,
      'finished', finished,
      'failed', failed,
      'appliedExpectedMigrations', applied_expected_migrations
    ) FROM migration_ledger_state),
    'rawJournal', json_build_object(
      'relationKind', (SELECT c.relkind::text FROM pg_class c WHERE c.oid = '"MaxRawTransportEvent"'::regclass),
      'constraints', (SELECT names FROM raw_journal_constraint_state),
      'expectedConstraintDefinitionsExact', (SELECT definitions_exact FROM raw_journal_constraint_state),
      'appendOnlyTriggerPresent', (SELECT trigger_present FROM append_only_state),
      'appendOnlyContractExact', (SELECT contract_exact FROM append_only_state)
    )
  )
);
COMMIT;
