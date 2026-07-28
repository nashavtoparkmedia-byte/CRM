# Stage 8B1S owner handoff

The production backup package is prepared but has not been executed. Storage remains below the 12.5 GB gate, so the owner action is conditional on expanding the filesystem to at least 79,906,196,736 bytes total (practical target: 80,000,000,000 bytes) and confirming at least 12,500,000,000 bytes free.

After that prerequisite and explicit architect approval, run exactly one root command:

```bash
PERSONAL_MAX_BACKUP_SCRIPT_SHA256='84afa57ae20f2b0e09f1f275e38b9aea74da9fdc6de4570a26663e45cff98f60' /bin/bash '/opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1s/root-backup/create-production-backup.sh'
```

Do not add `sudo` inside the command, change the checksum, pre-create the backup directory, delete an existing success/failure report, or rerun over an existing backup. The script requires root, validates its own SHA-256 and the earlier root report SHA-256, refuses existing outputs/symlinks, discovers exactly one running PostgreSQL service using exact Docker labels, and never invokes Docker Compose.

Success creates root-only backup files under `/var/backups/personal-max-stage8b1s-production-backup/` and a sanitized `root:codexbot` mode `0640` report at `/var/tmp/personal-max-stage8b1s-production-backup.json`. Failure after bootstrap creates a checksum-bound sanitized failure report. Neither result path is overwritten.

`pg_restore --list` is structural validation only. `FULL_RESTORE_PROOF` remains `PENDING_ISOLATED_ROOT_PROBE`; no isolated image/restore probe is authorized by this package.
