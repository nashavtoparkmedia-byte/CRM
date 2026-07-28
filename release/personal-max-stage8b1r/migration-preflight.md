# Production migration preflight

No production migration is permitted in Stage 8B1R. The checksum-bound root probe uses a bounded, read-only PostgreSQL session and supplies the Prisma ledger, `MaxRawTransportEvent` presence, catalog row estimate, relation/table/index sizes, statistics, index and constraint names, locks, activity and timeout facts without printing credentials. Exact row counts, duplicate scans and exact NULL scans are deliberately not executed because they can become unbounded full-table work.

## Empty or new raw-event table

The expected fast path is the complete additive 53-migration chain on a database without `MaxRawTransportEvent`. Rehearsal must use the exact gateway image by digest and a disposable database. The gateway never auto-migrates. Stage 8B2 must verify all 53 ledger rows finished before enabling any flag.

## Existing populated raw-event table

Before approval, use catalog estimates and `pg_total_relation_size` to size the maintenance window, confirm that column `captureEnvelopeId`, index `MaxRawTransportEvent_accountId_captureEnvelopeId_idx`, unique partial index `MaxRawTransportEvent_accountId_captureEnvelopeId_key`, and conflicting constraint names do not already exist, and select a low-traffic migration window. Exact duplicate and NULL prechecks require a separately approved, bounded maintenance-window query plan. Use an owner-approved non-zero session `lock_timeout` and bounded session `statement_timeout`; do not blindly retry a lock timeout.

The nullable column without a default is metadata-only on supported PostgreSQL, but `ALTER TABLE` still needs a brief ACCESS EXCLUSIVE lock. Both ordinary `CREATE INDEX` operations are non-concurrent and scan the table; they can block or be blocked by writers. If the lock cannot be obtained or the measured table makes the scan unsafe, stop, preserve the backup and plan an architect-approved concurrent-index follow-up rather than editing the accepted migration or retrying automatically.

Before migration approval, a maintenance-window precheck must verify no duplicate non-null `(accountId, captureEnvelopeId)` pairs before the unique partial index. The metadata probe reports this as `NOT_EXECUTED`; it must never infer zero duplicates from statistics. The rollback keeps the additive schema and indexes, disables feature flags, preserves the spool and restores legacy processing; it does not run a destructive down migration.

Required remaining production facts: running PostgreSQL version, migration ledger totals/failures, raw-table presence/estimate/bytes, conflicting index and constraint names, exact duplicate and critical-NULL precheck results from an approved window, lock/statement timeouts, backup verification and an approved window.
