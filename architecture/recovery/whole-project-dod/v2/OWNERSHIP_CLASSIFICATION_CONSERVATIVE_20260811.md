# Conservative read-only classification — 181 ownership records
Source: `architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_POST_LIFECYCLE_DEAD.json`; selection `ownership_classification == MAINTENANCE_MIGRATION_CAPABILITY_CANDIDATE`.
## Summary
- **CONTROLLED_MIGRATION**: 26
- **NARROW_MAINTENANCE_CAPABILITY**: 37
- **HISTORICAL_DEAD**: 18
- **BLOCKED_BUSINESS**: 100

No `OWNER_VALID` or `FOREIGN` decisions were inferred. Every selected site has null `source_context`; direct Prisma/raw operational writes require explicit owner-controlled maintenance or migration capability. `BLOCKED_BUSINESS` is fail-closed and means retirement/production reachability evidence is absent.

## CONTROLLED_MIGRATION
- `deploy/docker-compose.production.yml` (1 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L452 mixed-script-command:prisma db push
- `gravity-mvp/Dockerfile` (1 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L118 mixed-script-command:prisma migrate deploy
- `gravity-mvp/add_partial_index.sql` (1 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L1 sql-script
- `gravity-mvp/fix_channels.sql` (2 sites; lifecycle CLEANUP): L1 sql-script, L2 sql-script
- `gravity-mvp/scripts/add-scenario-field-settings-table.js` (2 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L7 $executeRawUnsafe, L23 $executeRawUnsafe
- `gravity-mvp/scripts/backfill-scenario-data.js` (1 sites; lifecycle UNREGISTERED): L166 $executeRaw
- `gravity-mvp/scripts/baseline-vps.sh` (1 sites; lifecycle CONTROLLED_MIGRATION): L18 mixed-script-command:prisma migrate resolve
- `gravity-mvp/scripts/migrate-contacts.ts` (12 sites; lifecycle CONTROLLED_MIGRATION): L180 create, L200 create, L209 update, L287 create, L355 create, L386 create, L511 create, L529 create, L537 update, L590 create, L629 update, L694 update
- `gravity-mvp/scripts/migrate-scenario-from-metadata.ts` (1 sites; lifecycle CONTROLLED_MIGRATION): L33 update
- `gravity-mvp/scripts/recover-wa-unified-from-legacy.js` (1 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L84 create
- `scripts/deploy.sh` (1 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L91 mixed-script-command:prisma migrate deploy
- `scripts/migrate-data-apply.sh` (1 sites; lifecycle CONTROLLED_MIGRATION): L84 mixed-script-command:pg_restore
- `scripts/restore-pg.sh` (1 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L87 mixed-script-command:pg_restore

## NARROW_MAINTENANCE_CAPABILITY
- `gravity-mvp/run_45d_sync.js` (1 sites; lifecycle IMPORT): L108 upsert
- `gravity-mvp/scripts/backfill-call-statuses.js` (2 sites; lifecycle BACKFILL): L89 update, L126 update
- `gravity-mvp/scripts/backfill-contact-id.ts` (1 sites; lifecycle BACKFILL): L50 update
- `gravity-mvp/scripts/backfill-reachability.js` (1 sites; lifecycle BACKFILL): L77 update
- `gravity-mvp/scripts/backfill-trips.js` (2 sites; lifecycle BACKFILL): L131 updateMany, L146 upsert
- `gravity-mvp/scripts/backfill-trips.ts` (2 sites; lifecycle BACKFILL): L127 updateMany, L142 upsert
- `gravity-mvp/scripts/backfill_from_linked.js` (2 sites; lifecycle BACKFILL): L65 update, L71 update
- `gravity-mvp/scripts/backfill_null_names_from_sibling.js` (1 sites; lifecycle UNREGISTERED): L82 update
- `gravity-mvp/scripts/backfill_source_connection_pr7.js` (1 sites; lifecycle BACKFILL): L98 $executeRaw
- `gravity-mvp/scripts/backfill_source_connection_pr8.js` (1 sites; lifecycle BACKFILL): L118 $executeRaw
- `gravity-mvp/scripts/backfill_tg_last_inbound_at.js` (1 sites; lifecycle BACKFILL): L13 $executeRaw
- `gravity-mvp/scripts/backfill_tg_names.js` (2 sites; lifecycle BACKFILL): L122 update, L132 update
- `gravity-mvp/scripts/backfill_unread_count.js` (1 sites; lifecycle BACKFILL): L14 $executeRaw
- `gravity-mvp/scripts/import-churn-from-excel.js` (4 sites; lifecycle IMPORT): L104 deleteMany, L108 deleteMany, L140 create, L237 create
- `gravity-mvp/scripts/import-license-from-csv.ts` (1 sites; lifecycle IMPORT): L47 updateMany
- `gravity-mvp/scripts/reseed-telephony-config.js` (1 sites; lifecycle IMPORT): L45 upsert
- `gravity-mvp/scripts/seed-cells.ts` (5 sites; lifecycle IMPORT): L54 create, L104 upsert, L180 update, L289 create, L330 upsert
- `gravity-mvp/scripts/seed-team-overview-demo.js` (6 sites; lifecycle IMPORT): L36 upsert, L59 upsert, L110 create, L166 create, L185 $executeRawUnsafe, L234 $executeRawUnsafe
- `gravity-mvp/scripts/seed_ai_profiles.js` (1 sites; lifecycle IMPORT): L93 update
- `gravity-mvp/scripts/seed_knowledge_sections.js` (1 sites; lifecycle UNREGISTERED): L59 $executeRaw

## HISTORICAL_DEAD
- `gravity-mvp/scripts/backfill_max_names.js` (2 sites; lifecycle BACKFILL): L78 update, L88 update
- `gravity-mvp/scripts/backfill_tg_via_bot_api.js` (2 sites; lifecycle BACKFILL): L117 update, L127 update
- `gravity-mvp/scripts/backfill_wa_names.js` (2 sites; lifecycle BACKFILL): L64 update, L74 update
- `gravity-mvp/scripts/create_test_chat.js` (2 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L12 upsert, L32 create
- `gravity-mvp/scripts/inject_test_data.sql` (3 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L5 sql-script, L9 sql-script, L18 sql-script
- `gravity-mvp/scripts/temp_swap_driver_to_ahmetov.js` (7 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L21 deleteMany, L22 delete, L25 upsert, L37 updateMany, L47 updateMany, L54 deleteMany, L57 delete

## BLOCKED_BUSINESS
- `gravity-mvp/scripts/bulk_phantom_lid_cleanup.js` (5 sites; lifecycle CLEANUP): L102 update, L108 update, L116 updateMany, L129 update, L136 updateMany
- `gravity-mvp/scripts/clamp-wa-timestamps.js` (2 sites; lifecycle CLEANUP): L31 update, L47 update
- `gravity-mvp/scripts/cleanup-all-channels.js` (4 sites; lifecycle CLEANUP): L32 deleteMany, L50 update, L55 updateMany, L73 deleteMany
- `gravity-mvp/scripts/cleanup-demo.js` (2 sites; lifecycle CLEANUP): L6 deleteMany, L9 deleteMany
- `gravity-mvp/scripts/cleanup-group-chats.sql` (4 sites; lifecycle CLEANUP): L27 sql-script, L30 sql-script, L34 sql-script, L43 sql-script
- `gravity-mvp/scripts/cleanup-last-fake-ident.js` (1 sites; lifecycle CLEANUP): L11 update
- `gravity-mvp/scripts/cleanup-lid-fake-contacts.js` (9 sites; lifecycle CLEANUP): L86 delete, L90 update, L95 update, L96 delete, L98 update, L112 update, L122 update, L140 update, L146 update
- `gravity-mvp/scripts/cleanup-wa-junk.js` (8 sites; lifecycle CLEANUP): L33 deleteMany, L49 delete, L63 deleteMany, L76 delete, L88 updateMany, L108 deleteMany, L123 deleteMany, L126 deleteMany
- `gravity-mvp/scripts/cleanup_churn.js` (1 sites; lifecycle CLEANUP): L30 $executeRawUnsafe
- `gravity-mvp/scripts/cleanup_epoch_dates.js` (3 sites; lifecycle CLEANUP): L38 $executeRawUnsafe, L44 $executeRawUnsafe, L50 $executeRawUnsafe
- `gravity-mvp/scripts/cleanup_isakov_phantom.js` (3 sites; lifecycle CLEANUP): L25 update, L31 update, L37 update
- `gravity-mvp/scripts/cleanup_megrabyan_phantom.js` (6 sites; lifecycle CLEANUP): L34 updateMany, L47 update, L54 delete, L58 update, L65 update, L72 update
- `gravity-mvp/scripts/dedup-chats-and-attachments.js` (5 sites; lifecycle CLEANUP): L28 updateMany, L38 update, L41 delete, L86 update, L122 deleteMany
- `gravity-mvp/scripts/fix-call-messages.ts` (1 sites; lifecycle CLEANUP): L19 deleteMany
- `gravity-mvp/scripts/fix-last-order-dates.ts` (2 sites; lifecycle CLEANUP): L38 updateMany, L70 updateMany
- `gravity-mvp/scripts/fix_ai_intern.js` (1 sites; lifecycle CLEANUP): L11 update
- `gravity-mvp/scripts/fix_chat_lid_70945844415.js` (2 sites; lifecycle CLEANUP): L23 update, L30 update
- `gravity-mvp/scripts/fix_job.js` (1 sites; lifecycle CLEANUP): L6 $executeRawUnsafe
- `gravity-mvp/scripts/fix_lid_phone_duplicate.js` (6 sites; lifecycle CLEANUP): L29 updateMany, L36 delete, L41 update, L51 upsert, L56 updateMany, L57 delete
- `gravity-mvp/scripts/fix_name.js` (1 sites; lifecycle CLEANUP): L8 update
- `gravity-mvp/scripts/import-churn-from-excel.js` (1 sites; lifecycle UNREGISTERED): L340 createMany
- `gravity-mvp/scripts/merge-duplicate-wa-chats.js` (6 sites; lifecycle CLEANUP): L72 delete, L77 update, L88 updateMany, L100 update, L105 delete, L127 update
- `gravity-mvp/scripts/merge-tg-chats.ts` (2 sites; lifecycle CLEANUP): L110 updateMany, L114 delete
- `gravity-mvp/scripts/merge-wa-chats.ts` (3 sites; lifecycle CLEANUP): L81 update, L92 updateMany, L99 delete
- `gravity-mvp/scripts/seed-cells.ts` (3 sites; lifecycle UNREGISTERED): L32 upsert, L230 create, L259 create
- `gravity-mvp/scripts/seed-crm-users.ts` (1 sites; lifecycle UNREGISTERED): L25 create
- `gravity-mvp/scripts/seed-team-overview-demo.js` (2 sites; lifecycle UNREGISTERED): L194 $executeRawUnsafe, L215 $executeRawUnsafe
- `gravity-mvp/scripts/seed_ai_profiles.js` (1 sites; lifecycle UNREGISTERED): L79 create
- `gravity-mvp/scripts/set_park_names.js` (2 sites; lifecycle ONE_SHOT_PENDING_RETIREMENT): L8 updateMany, L14 updateMany
- `gravity-mvp/scripts/strip_max_aria_prefix.js` (2 sites; lifecycle CLEANUP): L21 update, L25 update
- `gravity-mvp/scripts/wipe-whatsapp-data.js` (5 sites; lifecycle CLEANUP): L33 deleteMany, L36 deleteMany, L39 deleteMany, L42 deleteMany, L45 deleteMany
- `gravity-mvp/wa-cleanup.ts` (4 sites; lifecycle CLEANUP): L10 update, L26 updateMany, L33 delete, L44 update
- `yandex-fleet-scraper/fix-accounts.ts` (1 sites; lifecycle CLEANUP): L5 updateMany
