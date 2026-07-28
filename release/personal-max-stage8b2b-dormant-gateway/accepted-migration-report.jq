.schemaVersion == 1 and .mode == "PRODUCTION_MIGRATION_EVIDENCE" and
.script == {sha256:$expectedMigrationScriptSha,checksumBound:true} and
.image == {ref:$expectedImage,digestBound:true} and
.bindings == {isolatedReportSha256:$isolated,acceptedBackupReportSha256:"f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566"} and
.databaseBinding.source == "postgres-container-env" and
.databaseBinding.projectLabel == "crm" and .databaseBinding.serviceLabel == "postgres" and
.databaseBinding.envKeys == ["POSTGRES_USER","POSTGRES_PASSWORD","POSTGRES_DB"] and
.databaseBinding.urlHost == "postgres" and .databaseBinding.urlPort == 5432 and .databaseBinding.urlSchema == "public" and
.databaseBinding.inspectMode == "0600" and .databaseBinding.envMode == "0600" and
(.databaseBinding.networkName|type) == "string" and (.databaseBinding.networkName|length) > 0 and
.databaseBinding.networkProjectLabel == "crm" and .databaseBinding.networkComposeLabel == "internal" and
.databaseBinding.alias == "postgres" and .databaseBinding.runnerNetworkCount == 1 and
.databaseBinding.containerIdentityStable == true and .databaseBinding.credentialsPrinted == false and
.databaseBinding.credentialsInArguments == false and
(.databaseBinding|keys|sort)==(["source","projectLabel","serviceLabel","envKeys","urlHost","urlPort","urlSchema","inspectMode","envMode","networkName","networkProjectLabel","networkComposeLabel","alias","runnerNetworkCount","containerIdentityStable","credentialsPrinted","credentialsInArguments"]|sort) and
.freshBackup.status == "VALIDATED" and .freshBackup.structuralValidation == "PASS" and
(.freshBackup.directory|test("^/var/backups/personal-max-stage8b2a-pre-migration-[0-9]{8}T[0-9]{6}Z$")) and
(.freshBackup.dumpSha256|test("^[0-9a-f]{64}$")) and (.freshBackup.configArchiveSha256|test("^[0-9a-f]{64}$")) and
.freshBackup.dumpBytes > 0 and .freshBackup.objectCount > 0 and
(.freshBackup|keys|sort)==(["directory","dumpSha256","dumpBytes","objectCount","configArchiveSha256","status","structuralValidation"]|sort) and
.migration.before == {total:46,finished:46,failed:0} and
.migration.after == {total:54,finished:54,failed:0} and
(.migration.appliedNames | sort) == (["20260726162043_add_max_raw_transport_journal","20260726190658_add_max_route_registry","20260726205437_add_max_inbound_normalization","20260726215715_add_max_per_chat_outbound_actor","20260726225737_add_max_dispatch_ledger","20260727053744_add_max_provider_confirmation_matcher","20260727141925_add_max_shadow_semantic_comparison","20260727154647_add_max_capture_ingress"] | sort) and
.migration.acceptedLedgerOnlyMigrations == ["20260717000000_add_driver_telegram_submitted_phone"] and
.migration.rawRows == 0 and .migration.prismaDiffEmpty == false and
.migration.prismaDiffStatus == "ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS" and .migration.prismaDiffRawSqlIncluded == false and
.schema == {rawJournalConstraints:["MaxRawTransportEvent_payloadSizeBytes_check","MaxRawTransportEvent_quarantineConsistency_check","MaxRawTransportEvent_replayAvailability_check"],appendOnlyTrigger:"MaxRawTransportEvent_append_only",appendOnlyFunction:"max_raw_transport_event_append_only_guard"} and
.runners.migration == {name:"personal-max-stage8b2a-migration-runner",cleanupState:"ABSENT_AFTER_SUCCESS"} and
.runners.prismaDiff == {name:"personal-max-stage8b2a-prisma-diff-runner",cleanupState:"ABSENT_AFTER_SUCCESS"} and
.runners.allOwnedRunnersAbsent == true and .production.restartCountsUnchanged == true and .production.gitUnchanged == true and
.production.containerHashAfter == .production.containerHashBefore and (.production.containerHashBefore|test("^[0-9a-f]{64}$")) and
.storage.rollbackReserveBytes == 5368709120 and .storage.freeBytesAfter >= .storage.rollbackReserveBytes and
.safety == {deploy:false,restart:false,captureEnabled:false,gatewayStarted:false,scraperChanged:false,destructiveRollback:false,secretsPrinted:false,providerAction:false,maxContacted:false}
