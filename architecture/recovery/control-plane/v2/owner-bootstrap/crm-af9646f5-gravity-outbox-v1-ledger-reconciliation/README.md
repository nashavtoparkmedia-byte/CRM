# YOKO CRM activation ledger-reconciliation bootstrap

This directory is the reviewable source and sealed evidence for the one-time
successor for the finite `crm-af9646f5-gravity-outbox-v1` Runtime V2
activation profile after the live database gate exposed an omitted historical
ledger baseline.

The bootstrap installs a deterministic successor package for the existing
YOKO Privileged Runtime V2. It does not deploy CRM, touch PostgreSQL, restart a
service, or invoke any activation profile. The installed profile has five
zero-argument operations: `database-status`, `release-preflight`,
`database-migrate`, `release-activate`, and `rollback`. `config-activate`
remains disabled.

Runtime `2.0.0-7` keeps ABI `2.0.0` and binds the complete existing
pre-outbox production ledger by exact normalized digest. It does not accept a
dynamic ledger or authorize any migration other than the already reviewed
outbox target.

The sealed bundle and its final digest are generated only after the package,
installer, rollback, and negative tests pass. See `human-manifest.md` and
`manifest.json` for the exact installed identity and operating constraints.
