# Production migration preflight

No production connection or migration is permitted in Stage 8B1R. The read-only root metadata probe supplies the actual Prisma ledger count, `MaxRawTransportEvent` presence, row count and total relation size without printing credentials.

## Empty or new raw-event table

The expected fast path is the complete additive 53-migration chain on a database without `MaxRawTransportEvent`. Rehearsal must use the exact gateway image by digest and a disposable database. The gateway never auto-migrates. Stage 8B2 must verify all 53 ledger rows finished before enabling any flag.

## Existing populated raw-event table

Before approval, record exact row count and `pg_total_relation_size`, confirm that column `captureEnvelopeId` and indexes `MaxRawTransportEvent_accountId_captureEnvelopeId_idx` and `MaxRawTransportEvent_accountId_captureEnvelopeId_key` do not already exist, and select a low-traffic migration window. Use an owner-approved non-zero `lock_timeout` and bounded `statement_timeout`; do not blindly retry a lock timeout.

The nullable column without a default is metadata-only on supported PostgreSQL, but `ALTER TABLE` still needs a brief ACCESS EXCLUSIVE lock. Both ordinary `CREATE INDEX` operations are non-concurrent and scan the table; they can block or be blocked by writers. If the lock cannot be obtained or the measured table makes the scan unsafe, stop, preserve the backup and plan an architect-approved concurrent-index follow-up rather than editing the accepted migration or retrying automatically.

Preflight must also verify no duplicate non-null `(accountId, captureEnvelopeId)` pairs before the unique partial index. The rollback keeps the additive schema and indexes, disables feature flags, preserves the spool and restores legacy processing; it does not run a destructive down migration.

Required remaining production facts: running PostgreSQL version, migration ledger totals/failures, raw-table presence/rows/bytes, conflicting index names, duplicate precheck result, lock/statement timeouts, backup verification and approved window.
