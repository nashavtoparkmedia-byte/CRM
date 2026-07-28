# Production backup failure report

Trust-bootstrap failures print one bounded reason and exit before Docker or PostgreSQL access. They include root/checksum/package readability, mandatory binary, backup-parent, existing-output, existing-failure-report, and handoff-group failures.

After the checksum-verified diagnostics helper is sourced, every unexpected failure is mapped to a bounded phase, safe command class, classification, exit code, and source line. The failure JSON is created through a mode `0600` temporary file and an atomic no-clobber move, then handed off as owner `root`, group `codexbot`, mode `0640`. Codexbot readability and non-writability are verified.

The bounded `migration_ledger_validation` phase uses command class `migration_ledger_read` and classification `MIGRATION_LEDGER_UNREADABLE`. An unreadable ledger, malformed counts, or a mismatch with the accepted source report fails before `pg_dump` starts.

The JSON records only safe booleans about backup progress and explicitly records no Docker mutation, DDL, DML, migration, restart, deploy, browser, MAX, provider action, secret printing, raw command, raw SQL, or raw stderr. It never contains database names, environment values, file contents, command arguments, SQL, message data, or Chromium data.

Existing success, backup, or failure paths are never overwritten. A partial root-only backup directory is intentionally preserved for forensic review if failure occurs after directory creation.
