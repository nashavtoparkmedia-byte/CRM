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

An empty Prisma schema diff is impossible for this accepted backup/image pair. The ledger-only legacy migration above added only nullable `DriverTelegram.submittedPhone` and `DriverTelegram.submittedPhoneAt` columns, while its directory and fields are intentionally absent from the accepted image. The bounded diff gate therefore requires exactly the SQL that adds those two columns and rejects every additional statement. The success report must record `prismaDiffEmpty=false` and `prismaDiffStatus=ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS`; raw diff text and data values are never included in the report.

Every one of the eight SQL files is bound to an exact SHA-256 before execution. A targeted destructive gate rejects destructive DDL/DML while allowing only the known replacement of `MaxOutboundCommandReservation_transition_fields_check` in the exactly bound dispatch-ledger migration. This is a fail-closed release proof, not authorization to migrate production.
