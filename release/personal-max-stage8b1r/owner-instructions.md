# Root preflight owner instruction

The single approved root command for the production read-only preflight is checksum-bound:

`sudo env PERSONAL_MAX_PREFLIGHT_SCRIPT_SHA256=f5546c8974cfbb0247de992ea4a1d4c0a9029bea54537574a41bc2865e1df429 PERSONAL_MAX_PREFLIGHT_RESULT_PATH=/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1r/root-preflight/probe-readonly-production.sh`

The command refuses a checksum mismatch, a different result path, or an existing result path. It reads OS/kernel and filesystem metadata, Docker service/image/network/volume/process metadata without environment values, `/proc` UID/GID metadata, bounded backup-file metadata, and bounded PostgreSQL catalogs/statistics in a `default_transaction_read_only` session with statement and lock timeouts. It excludes exact raw-table counts, duplicate scans, exact NULL scans, `EXPLAIN ANALYZE`, DDL, DML and migrations.

The only persistent file it creates is the sanitized mode-`0600` JSON result at `/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json`; the script prints that path and its SHA-256. It may update filesystem atime according to mount policy, warm host/database caches, and create transient Docker exec process metadata for read-only `psql`. It does not pull images, create or restart containers, change production files or database data, launch a browser, contact MAX, perform provider actions or clean Docker objects. It exits non-zero for checksum/path violations, detected production drift, unsafe output validation, or incomplete mandatory facts.

The isolated executable probe is a separate later approval. Its exact single command, including both verified registry digests, is generated as `owner-isolated-probe-command.txt` in the successful Actions evidence artifact. Expected output is one JSON object proving internal-only execution, migration, actual hook, outage/restart recovery, zero provider/browser effects, production container-ID equality and cleanup. Do not combine the two scripts and do not run either automatically.

Before that separate approval, the root Docker client must already have read access to the two exact GHCR packages through an owner-approved authentication mechanism. The probe neither accepts nor prints registry credentials and fails closed if either digest pull is unauthorized. This authentication prerequisite is not deploy authorization; the probe exposes no public port and contains no production deploy command.
