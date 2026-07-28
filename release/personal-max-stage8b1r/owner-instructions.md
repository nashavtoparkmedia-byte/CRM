# Root preflight owner instruction

The production-probe checksum `b154c731586dd34739dc611ebcfa8daffa75c2e7b14cb27dd8733b0d48e28063` is `OBSOLETE_DUE_TO_SILENT_INTERNAL_FAILURE` and MUST NOT be used. Its root run exited `1` with no stdout, no stderr, and no sanitized result, so the exact failed phase and command class were not recoverable. The older checksums `bacd74af185a371ca641ef8f262286c424e51bd3737dd81c1b7382ffb5fdc336` and `f5546c8974cfbb0247de992ea4a1d4c0a9029bea54537574a41bc2865e1df429` also remain obsolete.

The only approved root command for the production read-only preflight is checksum-bound:

`sudo env PERSONAL_MAX_PREFLIGHT_SCRIPT_SHA256=19f04bed9c25e4b015c60bf12a72f97830d33561baa2dd088a00b43fcf368136 PERSONAL_MAX_PREFLIGHT_RESULT_PATH=/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1r/root-preflight/probe-readonly-production.sh`

This command is the single owner action. Do not append `echo $?`, `stat`, `sha256sum`, `ls`, `cat`, tracing, or any other diagnostic command. The script itself prints complete metadata for a normal, incomplete, or unexpected-failure result.

Before probes, the script verifies root identity, the exact script checksum, the checksum-bound diagnostics helper, mandatory local binaries, release readability, the `codexbot` group, and both no-clobber report paths. These trust failures print one bounded line and do not create JSON. The success path is fixed at `/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json`; the commit-bound failure path is `/var/tmp/personal-max-stage8b1r-production-readonly-preflight.failure.19f04bed9c25e4b015c60bf12a72f97830d33561baa2dd088a00b43fcf368136.json`.

After bootstrap, an ERR trap records only the original exit code, bounded phase and command class, safe classification, source line, UTC time, script SHA, report-presence facts, and whether Docker or PostgreSQL collection had begun. It never records the raw command, arguments, SQL, raw stderr, environment values, secrets, message contents, or profile contents. An unexpected failure creates a sanitized `root:codexbot` mode `0640` failure report, prints its metadata, and exits with the original code.

Expected missing or unavailable facts are written to the normal sanitized report. The script hands that report to `codexbot`, prints its path, SHA-256, owner, group, mode, and access fields, then prints `MANDATORY_FACTS_INCOMPLETE` and exits `83` when the gate remains incomplete. A complete gate exits `0` after the same success metadata.

The command never invokes Docker Compose or renders the Compose file. Containers are discovered only through exact Docker Engine project/service labels and each selected ID is revalidated through narrow inspect projections excluding `.Config.Env`. It never reads `.env.production` or container environment values.

The command reads only bounded OS, filesystem, Docker, `/proc`, backup-file metadata, and PostgreSQL catalog/statistics facts. PostgreSQL queries run through `psql --no-psqlrc` with `default_transaction_read_only=on`, a 5000 ms statement timeout, and a 1000 ms lock timeout. Empty, timeout, permission, unavailable, and malformed results are classified before arithmetic. Exact raw-table counts, duplicate scans, exact NULL scans, `EXPLAIN ANALYZE`, DDL, DML, and migrations remain excluded.

Both report types use a root-owned mode `0600` temporary file followed by an atomic no-clobber handoff. The script verifies regular-file type, no symlink, inode identity, final `root:codexbot` ownership, mode `0640`, codexbot readability, codexbot non-writability, and no world access. Existing reports are never overwritten or deleted.

The script may update filesystem atime according to mount policy, warm host/database caches, and create transient Docker exec process metadata for bounded read-only `psql`. It does not pull or load images, create or restart containers, change production files or database data, launch a browser, contact MAX, perform provider actions, or clean Docker objects.

The isolated executable-image probe remains a separate later approval. Do not combine it with this production read-only preflight and do not run it automatically.
