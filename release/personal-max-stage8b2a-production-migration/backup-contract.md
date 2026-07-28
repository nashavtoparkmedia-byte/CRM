# Fresh backup contract

The accepted Stage 8B1S backup remains immutable evidence, but it is not the immediate rollback artifact. The future root action creates a new no-clobber timestamp directory under `/var/backups`, a custom `pg_dump` with `--no-owner --no-acl`, a structural `pg_restore --list`, and a root-only archive of the tracked production configuration and `.env.production`. Files remain `root:root:0600`; only sanitized metadata is handed to `codexbot` as `0640`. A failed migration preserves both backups.
