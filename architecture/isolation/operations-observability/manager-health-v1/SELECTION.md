# CRM-ARCH-007R manager-health repository selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `61f0afc9c22590d3344dfbcea6c5f4a580459a7d`

Source commit: `8aeccb755b3fad942a69a23799f76f7a480f4d4f`

Selected the Architecture Lead's accepted D3 relocation of the complete
`health_snapshots` and `health_score_history` repository boundary from the
Work-owned manager-health utility to Operations Observability. The slice
includes the four-statement compatibility DDL state machine, two fixed reads,
one atomic snapshot upsert and one best-effort history append.

Analytics Reporting retains score, trend, decline-streak and history Map
orchestration. Work Management retains the pure manager-health configuration,
calculation functions and data shapes. Operations Observability exposes only
four fixed versioned operations; no request accepts SQL, table names, arbitrary
predicates, ordering, pagination, transaction handles or unbounded history
windows.

The six planned write retirements are:

- `arch_880b7dfae43971c822502b90` — snapshot-table DDL;
- `arch_3251166f174bce021d52ecef` — decline-streak column DDL;
- `arch_10ee9720cfdccbead6e5ce70` — history-table DDL;
- `arch_c03fd6c4c21c0595bbc73678` — history-index DDL;
- `arch_4115f2efad420d474a99e256` — atomic snapshot upsert;
- `arch_9379c33dd717fc04b6f50ea3` — best-effort history append.

The already accepted `analytics_reporting -> operations_observability.public`
dependency is reused, so this slice adds no effective edge. The active module
amendment yields 970 scanned files, 16 contexts, 106 dependency relationships
and zero cycles. Strict enforcement records 1,408 findings and matching
exceptions: exactly the six planned fingerprints retired, no finding was added
and no shared registry entry changed. Registry regeneration is deterministic
and all 118 cumulative architecture tests/checks pass.

This is a source-only gate. Policy and registry source files changed as part of
enforcement activation, but no database, repository runtime, service,
deployment, production or secret-bearing path was touched. Final `SHA256SUMS`
covers the evidence, source and control files and passes in full.
