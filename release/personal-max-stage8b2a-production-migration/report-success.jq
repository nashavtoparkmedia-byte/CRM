.schemaVersion == 1 and .mode == "PRODUCTION_MIGRATION_EVIDENCE" and
.script.checksumBound == true and .image.digestBound == true and .freshBackup.structuralValidation == "PASS" and
.migration.before == {total:46,finished:46,failed:0} and .migration.after == {total:54,finished:54,failed:0} and
(.migration.appliedNames | length) == 8 and .migration.rawRows == 0 and .migration.prismaDiffEmpty == true and
.production.restartCountsUnchanged == true and .production.gitUnchanged == true and
.safety.deploy == false and .safety.restart == false and .safety.captureEnabled == false and .safety.gatewayStarted == false and
.safety.scraperChanged == false and .safety.destructiveRollback == false and .safety.secretsPrinted == false and
.safety.providerAction == false and .safety.maxContacted == false
