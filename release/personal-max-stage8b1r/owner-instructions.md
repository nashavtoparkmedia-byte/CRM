# Root preflight owner instruction

The previous production-probe checksum `f5546c8974cfbb0247de992ea4a1d4c0a9029bea54537574a41bc2865e1df429` is obsolete and MUST NOT be used. Any owner command bound to that checksum is invalid.

The only approved root command for the production read-only preflight is checksum-bound:

`sudo env PERSONAL_MAX_PREFLIGHT_SCRIPT_SHA256=bacd74af185a371ca641ef8f262286c424e51bd3737dd81c1b7382ffb5fdc336 PERSONAL_MAX_PREFLIGHT_RESULT_PATH=/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1r/root-preflight/probe-readonly-production.sh`

The command refuses a checksum mismatch, a different result path, or an existing result path. It reads OS/kernel and filesystem metadata, Docker service/image/network/volume/process metadata without environment values, `/proc` UID/GID metadata, bounded backup-file metadata, and bounded PostgreSQL catalogs/statistics in a `default_transaction_read_only` session with statement and lock timeouts. It excludes exact raw-table counts, duplicate scans, exact NULL scans, `EXPLAIN ANALYZE`, DDL, DML and migrations.

The temporary report remains root-owned mode `0600` while JSON is formed and validated. Before an atomic no-clobber move, the script changes only that temporary file to group `codexbot` and mode `0640`. It then verifies that the final path is a non-symlink regular file owned by `root:codexbot`, readable but not writable by `codexbot`, and inaccessible to the world. The final sanitized report is `/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json`; successful output contains its path, SHA-256, owner, group, mode, and the two Codex readability fields.

The script may update filesystem atime according to mount policy, warm host/database caches, and create transient Docker exec process metadata for read-only `psql`. It does not pull images, create or restart containers, change production files or database data, launch a browser, contact MAX, perform provider actions or clean Docker objects. It exits non-zero for checksum/path violations, a missing `codexbot` group, unsafe handoff permissions, a result-path race, detected production drift, unsafe output validation, or incomplete mandatory facts. No second owner command is required to hand the report to Codex.

The isolated executable probe is a separate later approval. Its exact single command, including both verified registry digests, is generated as `owner-isolated-probe-command.txt` in the successful Actions evidence artifact. Expected output is one JSON object proving internal-only execution, migration, actual hook, outage/restart recovery, zero provider/browser effects, production container-ID equality and cleanup. Do not combine the two scripts and do not run either automatically.

Before that separate approval, the root Docker client must already have read access to the two exact GHCR packages through an owner-approved authentication mechanism. The probe neither accepts nor prints registry credentials and fails closed if either digest pull is unauthorized. This authentication prerequisite is not deploy authorization; the probe exposes no public port and contains no production deploy command.
