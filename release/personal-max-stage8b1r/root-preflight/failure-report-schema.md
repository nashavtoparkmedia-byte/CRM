# Production read-only preflight failure report

The production read-only preflight has two mutually distinct result paths. A completed probe, including a classified incomplete result, uses `/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json`. An unexpected post-bootstrap probe failure uses `/var/tmp/personal-max-stage8b1r-production-readonly-preflight.failure.<actual-script-sha256>.json`.

The failure path is derived only from the fixed prefix and the checksum-verified script SHA-256. The bootstrap refuses an existing path, a symlink, an unexpected type, a changed success path, or a checksum mismatch before metadata probes begin. Neither result path is overwritten or automatically deleted.

## Trust bootstrap output

Trust-bootstrap failures do not create JSON. They print exactly one bounded line from this set:

- `ROOT_REQUIRED`
- `CHECKSUM_BINDING_REQUIRED`
- `MANDATORY_BINARY_MISSING: <binary>`
- `SCRIPT_OR_RELEASE_UNREADABLE`
- `CHECKSUM_MISMATCH`
- `RESULT_PATH_UNSAFE`
- `FAILURE_REPORT_PATH_UNSAFE`
- `HANDOFF_GROUP_MISSING: codexbot`

These checks occur before Docker or PostgreSQL metadata collection.

## Failure JSON contract

Every unexpected failure after bootstrap is mapped to a bounded phase, command class, and error classification. The JSON contains:

- schema and mode: `schemaVersion=1`, `mode=READ_ONLY_PRODUCTION_PREFLIGHT_FAILURE`;
- UTC generation time and the actual checksum-bound script SHA-256;
- `phase`, `safeCommandClass`, `safeErrorClassification`, original `exitCode`, and source line;
- the fixed success-result path and booleans showing whether a final or temporary result existed;
- booleans showing whether Docker metadata or the PostgreSQL session had begun;
- explicit negative mutation and disclosure fields;
- `recommendedNextAction=CODEX_REVIEW_FAILURE_REPORT`.

The report never contains `BASH_COMMAND`, command arguments, SQL, raw stderr, container environment data, secret values, message contents, or Chromium profile contents.

Allowed phases are `bootstrap_complete`, `docker_server_metadata`, `project_container_discovery_before`, `production_service_snapshot_before`, `volume_snapshot_before`, `filesystem_snapshot_before`, `host_metadata`, `service_inventory`, `scraper_discovery`, `scraper_process_metadata`, `postgres_discovery`, `postgres_catalog_session`, `migration_ledger`, `raw_table_catalog`, `activity_catalog`, `image_inventory`, `disk_budget`, `backup_metadata`, `project_container_discovery_after`, `production_service_snapshot_after`, `volume_snapshot_after`, `immutability_comparison`, `report_render`, `report_handoff`, and `completed`.

Allowed command classes are `docker_ps`, `docker_inspect`, `docker_top`, `docker_info`, `docker_image_inspect`, `docker_volume_ls`, `postgres_discovery`, `psql_catalog`, `jq_render`, `filesystem_stat`, `report_handoff`, and `unknown`.

## Handoff contract

The temporary failure report is a root-owned regular file with mode `0600`. The final transition is an atomic no-clobber move. The final report must be a non-symlink regular file with the same device/inode identity, owner `root`, group `codexbot`, and mode `0640`. The script verifies that `codexbot` can read but cannot write it and that world permissions are absent.

After a successful handoff the script prints `PREFLIGHT_FAILED`, phase, safe command class, original exit code, report path, report SHA-256, owner, group, mode, and Codex access fields. It then exits with the original nonzero status. No additional diagnostic command is required.

## Expected incomplete facts

Optional backup-directory absence, accepted-image absence, a stopped scraper, absent migration ledger or raw journal table, bounded `docker top` unavailability, unproven listener ownership or backup mechanism, and intentionally skipped full-table scans are classified in the normal success-path report. They do not invoke the ERR handler. The normal report is handed off first, then the script prints `MANDATORY_FACTS_INCOMPLETE` and exits `83` when the gate is incomplete.

The PostgreSQL wrapper classifies each bounded read-only query as success, unavailable, timeout, permission denied, or malformed output. Empty numeric output is rejected before arithmetic. The session retains `default_transaction_read_only=on`, a 5000 ms statement timeout, a 1000 ms lock timeout, `psql --no-psqlrc`, and no DDL, DML, migrations, or full-table scans.

## Isolated verification

`test-failure-diagnostics.sh` sources the same checksum-bound diagnostics helper and injects 15 non-production failures. It does not invoke Docker or PostgreSQL. The matrix verifies exit preservation, phase and class mapping, valid JSON, mode/owner/group simulation, success-result absence, temporary cleanup, bounded content, no-silent-failure output, and deterministic no-clobber rerun behavior.
