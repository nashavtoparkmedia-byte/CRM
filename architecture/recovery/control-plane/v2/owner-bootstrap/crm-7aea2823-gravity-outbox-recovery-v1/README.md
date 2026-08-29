# YOKO CRM activation rollback-recovery bootstrap

This directory is the reviewable source and sealed evidence for the one-time
successor for the finite `crm-af9646f5-gravity-outbox-v1` Runtime V2 profile
after the exact outbox migration succeeded but candidate health failed and
Runtime `2.0.0-7` could not close its already-restored predecessor state.

The bootstrap installs a deterministic successor package for the existing
YOKO Privileged Runtime V2. It does not deploy CRM, touch PostgreSQL, restart a
service, or invoke any activation profile. The installed profile has five
zero-argument operations: `database-status`, `release-preflight`,
`database-migrate`, `release-activate`, and `rollback`. `config-activate`
remains disabled.

Runtime `2.0.0-8` keeps ABI `2.0.0`, preserves the same five operations, and
binds the exact v7 audit, backup, applied migration ledger, current predecessor
container/config identity, and corrected source commit `7aea2823…`. It first
closes the durable rollback intent, then reseals that exact candidate without
running the already-applied migration again.

The sealed bundle and its final digest are generated only after the package,
installer, rollback, and negative tests pass. See `human-manifest.md` and
`manifest.json` for the exact installed identity and operating constraints.
