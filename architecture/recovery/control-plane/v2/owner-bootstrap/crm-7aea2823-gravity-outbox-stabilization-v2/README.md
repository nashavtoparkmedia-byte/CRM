# YOKO CRM activation health-stabilization bootstrap

This directory is the reviewable source and sealed evidence for the one-time
successor for the finite `crm-af9646f5-gravity-outbox-v1` Runtime V2 profile.
Runtime `2.0.0-8` successfully recovered the inherited rollback intent,
resealed the exact corrected candidate, and preserved the already-applied
outbox migration. Its immediate, one-shot application health gate failed
closed and the exact predecessor was automatically restored. Runtime `2.0.0-8`
did not retain the individual failed predicate. The bounded diagnosis is based
on the gate timing plus production observation that persisted messaging
sessions become ready roughly 27–31 seconds after a recreate; if that diagnosis
is wrong, the successor's unchanged strict predicates still fail closed.

The bootstrap installs a deterministic successor package for the existing
YOKO Privileged Runtime V2. It does not deploy CRM, touch PostgreSQL, restart a
service, or invoke any activation profile. The installed profile has five
zero-argument operations: `database-status`, `release-preflight`,
`database-migrate`, `release-activate`, and `rollback`. `config-activate`
remains disabled.

Runtime `2.0.0-9` keeps ABI `2.0.0`, preserves the same five operations, and
binds the exact valid 15-record audit, backup, applied migration ledger,
current predecessor container/config identity, corrected source commit
`7aea2823…`, and corrected target image `baf442f8…`. It permits only that
rolled-back state to enter a retry. The target health predicates remain strict,
but are evaluated within a bounded 90-second stabilization window and must
succeed twice consecutively. A failed window still triggers the existing
automatic rollback. No second production database mutation is authorized.

The sealed bundle and its final digest are generated only after the package,
installer, rollback, and negative tests pass. See `human-manifest.md` and
`manifest.json` for the exact installed identity and operating constraints.
