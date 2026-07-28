# Release gates

The following gates remain open and block a text canary:

- Independent acceptance of the parallel isolated probe result; mere file existence is not evidence acceptance.
- Authorized exact-eight migration, dormant gateway, and observation sequence.
- Authorized scraper runtime metadata probe and acceptance of UID/profile/browser/listener/recreation facts.
- Future immutable images built and accepted; both are currently `NOT_BUILT`.
- Separate authorization and execution of additive SessionOwner/shadow migrations.
- Real PostgreSQL concurrency validation for the new migrations in an isolated non-production database.
- Durable sender replay and idempotency stores replacing test-only memory stores.
- Production-like isolated synthetic sender validation and accepted metrics.
- Explicit Contact A, then Contact A+B, architecture approvals.

No deploy, migration, restart, metadata probe, browser action, MAX action, provider action, or canary was executed during preparation. Stage 8B2 and physical sender remain unstarted.
