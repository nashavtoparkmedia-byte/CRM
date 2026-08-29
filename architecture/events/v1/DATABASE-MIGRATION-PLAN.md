# Domain outbox database migration plan

Migration identity:
`gravity-mvp/prisma/migrations/20260809140000_add_domain_outbox/migration.sql`

The migration is EXPAND-only. It creates one enum, one table, a unique event
identity index and two bounded publisher/query indexes. It does not alter,
rename or remove an existing object.

Required activation sequence:

1. Execute this exact migration against an isolated PostgreSQL preview
   database and regenerate the Prisma client in an isolated build namespace.
2. Run the atomicity, idempotency, retry, stale-claim, poison and protected
   Calling tests against that preview.
3. Capture the production database identity and migration ledger through the
   permanent operator.
4. Take and verify a recoverable database backup.
5. Apply only the checksummed EXPAND migration.
6. Deploy compatible code with the outbox publisher enabled.
7. Verify recording persistence, pending-to-published movement, Redis enqueue,
   dead-letter count, application health and existing call flows.
8. Roll back the application automatically on regression. The additive table
   remains in place and is safe for the prior application to ignore.

The CONTRACT phase is intentionally absent. No old table or code path is
removed by the database migration. Dropping the outbox table or enum is not an
automatic rollback and is not authorized.

No preview PostgreSQL service or production database was available/mutated in
CRM-ARCH-005. Source-level preview tests and Prisma schema/diff validation pass,
but production activation remains closed until steps 1-4 are proven.
