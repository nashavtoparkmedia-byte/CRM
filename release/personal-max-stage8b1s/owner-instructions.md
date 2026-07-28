# Stage 8B1S owner handoff

The production backup package is prepared but has not been executed. Post-expansion verification classified the root storage as `CASE_A_FULLY_EXPANDED`: the kernel observes an 80 GiB block device, the root partition and ext4 filesystem are expanded, and 22,103,773,184 bytes were free at the verification boundary. No filesystem root action is required.

After explicit architect approval, run exactly one root command:

```bash
PERSONAL_MAX_BACKUP_SCRIPT_SHA256='586ec575978bc8d059cef7b1b6a472d733c22fb4baa73738151b00e76f2ca930' /bin/bash '/opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1s/root-backup/create-production-backup.sh'
```

Do not add `sudo` inside the command, change the checksum, pre-create the backup directory, delete an existing success/failure report, or rerun over an existing backup. The command still requires separate architect authorization. The script requires root, validates its own SHA-256 and the earlier root report SHA-256, refuses existing outputs/symlinks, discovers exactly one running PostgreSQL service using exact Docker labels, validates the migration ledger through a bounded read-only query, and never invokes Docker Compose.

Success creates root-only backup files under `/var/backups/personal-max-stage8b1s-production-backup/` and a sanitized `root:codexbot` mode `0640` report at `/var/tmp/personal-max-stage8b1s-production-backup.json`. Failure after bootstrap creates a checksum-bound sanitized failure report. Neither result path is overwritten.

`pg_restore --list` is structural validation only. `FULL_RESTORE_PROOF` remains `PENDING_ISOLATED_ROOT_PROBE`; no isolated image/restore probe is authorized by this package.
