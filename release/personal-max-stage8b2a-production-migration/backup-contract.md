# Fresh backup contract

The accepted Stage 8B1S backup remains immutable evidence, but it is not the immediate rollback artifact. The future root action creates a new no-clobber timestamp directory under `/var/backups`, a custom `pg_dump` with `--no-owner --no-acl`, a structural `pg_restore --list`, and a root-only archive of the tracked production configuration and `.env.production`. Files remain `root:root:0600`; only sanitized metadata is handed to `codexbot` as `0640`.

The fresh backup reaches status `VALIDATED` only after the dump and config SHA-256 values, positive dump byte count, positive structural object count, archive listing, ownership, modes, and no-clobber finalization pass. Every later failure report carries those sanitized values and the status, while never containing config contents or credentials. A failed migration preserves both accepted and fresh backups.
