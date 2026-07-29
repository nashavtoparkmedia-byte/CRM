# Disposable migration proof contract

The accepted gateway image is the migration source. The probe must not use `/opt/crm` as source and must never pass a production database URL to a migration process.

The accepted gateway image contains 53 migration directories. The restored ledger must begin at 46 finished and zero failed migrations. One accepted legacy ledger entry, `20260717000000_add_driver_telegram_submitted_phone`, is already applied but is not a directory in the accepted image; this is why the successful ledger count is 54 rather than the directory count. Before `prisma migrate deploy`, the repository-to-ledger set difference must be exactly:

1. `20260726162043_add_max_raw_transport_journal`
2. `20260726190658_add_max_route_registry`
3. `20260726205437_add_max_inbound_normalization`
4. `20260726215715_add_max_per_chat_outbound_actor`
5. `20260726225737_add_max_dispatch_ledger`
6. `20260727053744_add_max_provider_confirmation_matcher`
7. `20260727141925_add_max_shadow_semantic_comparison`
8. `20260727154647_add_max_capture_ingress`

The migration command stops on the first error. Success requires 54 finished migrations, zero failed or rolled-back migrations, the exact eight names above as the only newly finished rows, bounded duration metadata for every newly applied migration, `MaxRawTransportEvent`, its nullable `captureEnvelopeId` column, and both account-scoped capture indexes. Production migration is always false.

The repository closure audit binds `gravity-mvp/prisma/schema.prisma` plus all 53 migration SQL files in `migration-closure-sha256.txt`. Both legacy columns have zero occurrences in the schema and repository migrations, while the restored ledger contains the separately applied migration above under the accepted contract that it added only nullable `DriverTelegram.submittedPhone` (`TEXT`) and `DriverTelegram.submittedPhoneAt` (`TIMESTAMP(3)`). The exact expected mode is therefore `LEGACY_TWO_COLUMN_DRIFT_EXPECTED`; empty diff is forbidden.

The checksum-bound semantic parser accepts comments, whitespace, reversed column order, one or two `ALTER TABLE` statements, and a bounded transaction wrapper only when they describe exactly those two nullable additions to the exact table with no defaults, constraints, indexes, other tables, columns, operations, or data statements. It never uses full-string equality. Rejection reports contain only counts, booleans, parser status, expected mode, final classification, and a SHA-256 of a sanitized semantic model. Raw diff text, SQL, URLs, credentials, environment values, and business data are not retained. Success records `prismaDiffEmpty=false` and `prismaDiffStatus=MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT`.

Post-migration verification is an ordered fail-closed state machine, not one aggregate assertion. Finished and failed ledger queries, the 54/0 assertion, the complete-name query, applied-set build and comparison, duration query and JSON validation, table/column/index/unique-key queries and assertions, Prisma diff execution, and the accepted-legacy diff gate each have distinct check IDs and classifications. The accepted failure report SHA-256 `0203c1287fc2415367e10852fb83bb8001f558f2484c8e6cafe14d86c7d3dd67` proves that operations through Prisma diff execution completed and that the first failing operation was the subsequent legacy-diff gate (`posix_shell`, exit `1`); it does not prove migration deploy, ledger, schema, or Prisma diff execution failure. Future reports preserve the first check ID, substep, command/executable category, command-started state, attempt count, elapsed seconds, original exit, and primary classification without retaining raw SQL, diff text, stderr, URLs, credentials, environment values, or business data.

Every one of the eight SQL files is bound to an exact SHA-256 before execution. A targeted destructive gate rejects destructive DDL/DML while allowing only the known replacement of `MaxOutboundCommandReservation_transition_fields_check` in the exactly bound dispatch-ledger migration. This is a fail-closed release proof, not authorization to migrate production.
