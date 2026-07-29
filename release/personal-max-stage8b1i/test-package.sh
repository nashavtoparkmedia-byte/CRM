#!/usr/bin/env bash
# Static/non-root contract suite. It never executes the root probe or Docker.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly BOUNDED="$SCRIPT_DIR/bounded-operations.sh"
readonly OUTPUT_HELPERS="$SCRIPT_DIR/probe-output-helpers.sh"
readonly RESTORE_VERIFICATION="$SCRIPT_DIR/restore-verification.sh"
readonly POSTGRES_STARTUP="$SCRIPT_DIR/postgres-startup.sh"
readonly MIGRATION_PREFLIGHT="$SCRIPT_DIR/migration-preflight.sh"
readonly RESIDUAL_CLEANUP="$SCRIPT_DIR/residual-cleanup.sh"
readonly MIGRATION_SQL_GATE="$SCRIPT_DIR/migration-sql-gate.sh"
readonly MIGRATION_SQL_BINDINGS="$SCRIPT_DIR/migration-sql-bindings.txt"
readonly PRISMA_LEGACY_DIFF_GATE="$SCRIPT_DIR/prisma-legacy-diff-gate.sh"
readonly PRISMA_DIFF_SEMANTIC_PARSER="$SCRIPT_DIR/prisma-diff-semantic-parser.py"
readonly PRISMA_DIFF_CLOSURE_AUDIT="$SCRIPT_DIR/prisma-diff-closure-audit.json"
readonly MIGRATION_CLOSURE_SHA256="$SCRIPT_DIR/migration-closure-sha256.txt"
readonly FAULTS="$SCRIPT_DIR/test-bounded-faults.sh"
readonly OUTPUT_HANDOFF="$SCRIPT_DIR/test-output-handoff.sh"
readonly OUTPUT_COLLISIONS="$SCRIPT_DIR/test-output-target-collisions.sh"
readonly RESTORE_TESTS="$SCRIPT_DIR/test-restore-verification.sh"
readonly LEDGER_TESTS="$SCRIPT_DIR/test-ledger-verification.sh"
readonly POSTGRES_STARTUP_TESTS="$SCRIPT_DIR/test-postgres-startup.sh"
readonly MIGRATION_PREFLIGHT_TESTS="$SCRIPT_DIR/test-migration-preflight.sh"
readonly POSTGRES_NETWORK_ALIAS_TESTS="$SCRIPT_DIR/test-postgres-network-alias.sh"
readonly MIGRATION_VERIFICATION_TESTS="$SCRIPT_DIR/test-migration-verification.sh"
readonly FAILURE_HANDOFF_TESTS="$SCRIPT_DIR/test-failure-handoff.sh"
readonly REMAINING_TAIL_TESTS="$SCRIPT_DIR/test-remaining-tail-contract.sh"
readonly PRISMA_DIFF_SEMANTIC_TESTS="$SCRIPT_DIR/test-prisma-diff-semantics.sh"
readonly PRISMA_PARSER_FAILURE_TESTS="$SCRIPT_DIR/test-prisma-parser-failures.sh"
readonly SCRAPER_DEFAULT_OFF_TESTS="$SCRIPT_DIR/test-scraper-default-off.js"
readonly REAL_PRISMA_FAILURE_FORENSIC="$SCRIPT_DIR/real-prisma-diff-parse-failure-forensic.json"
readonly SCRAPER_DEFAULT_OFF_FORENSIC="$SCRIPT_DIR/scraper-default-off-failure-forensic.json"
readonly SCRAPER_HARNESS="$SCRIPT_DIR/synthetic-scraper-harness.js"
readonly CLIENT_HARNESS="$SCRIPT_DIR/gateway-client-harness.js"
readonly BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly BACKUP_SHA='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.2c54907799dabee4c92eca40ebfd8176a8b8f4f61c70ed65f38a542cd0ea4b6e.json'
readonly FAILURE_REPORT_SHA='20ed0d543ef36aaa97518968118cc0b7befa5a49ab764f99a76c82ed7107151c'
readonly ALIAS_FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.1772cc2b99934c7c81c4832c29d60abfecbc21d1f3b250bcd437d77a377d22ed.json'
readonly ALIAS_FAILURE_REPORT_SHA='b53706d5e89786cb572c8389d25cfa80a883c3d57fd40b9c083804ceff1f7524'
readonly VERIFICATION_FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3.json'
readonly VERIFICATION_FAILURE_REPORT_SHA='0203c1287fc2415367e10852fb83bb8001f558f2484c8e6cafe14d86c7d3dd67'
readonly VERIFICATION_FAILED_SCRIPT_SHA='6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3'
readonly VERIFICATION_FAILED_SOURCE_COMMIT='d62c990d74d1b99f455ab24e95d9f8a225bf9d40'
readonly REAL_PRISMA_FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.089a6a2e433ab7ffcfa5eeff5ac04f3499b67d749158e72efd1c697d6161a580.json'
readonly REAL_PRISMA_FAILURE_REPORT_SHA='92b2e8bac1a540824b595fcc6b1ad9714524ebfaf77d8f4a08511a551d6fd020'
readonly SCRAPER_DEFAULT_OFF_FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.e36ad6b2436dd827e33c8a996e22ebbd40e45ffb5e1cc1430f75195d9f9f791f.json'
readonly SCRAPER_DEFAULT_OFF_FAILURE_REPORT_SHA='93d75f31f61bed37e7bcfb9cc8164007fc46732c536643d11c6bebcbc9bf6598'
readonly ARCHITECTURE='/opt/codex-work/releases/personal-max-transport-architecture-20260726T132916Z'
readonly SHELLCHECK_BIN=${1:-shellcheck}
readonly NODE_BIN=${NODE_BIN:-node}
readonly REPOSITORY_MIGRATIONS="$SCRIPT_DIR/../../gravity-mvp/prisma/migrations"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-package.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PACKAGE_PASS_COUNT=0
PACKAGE_SKIP_COUNT=0

pass() { PACKAGE_PASS_COUNT=$((PACKAGE_PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }
require_fixed() { grep -F -- "$2" "$1" >/dev/null; }
refuse_pattern() { ! grep -Eq -- "$2" "$1"; }

[[ $(id -u) -ne 0 ]]
[[ -f $BACKUP_REPORT && ! -L $BACKUP_REPORT && $(sha256sum -- "$BACKUP_REPORT" | awk '{print $1}') == "$BACKUP_SHA" ]]
jq -e '.mode=="PRODUCTION_BACKUP_METADATA" and .dump.structuralValidation=="PASS" and .dump.bytes>0 and .dump.objectCount==581 and .restore.FULL_RESTORE_PROOF=="PENDING_ISOLATED_ROOT_PROBE"' "$BACKUP_REPORT" >/dev/null
pass backup_acceptance
[[ $(stat -Lc '%U:%G:%a' "$BACKUP_REPORT") == root:codexbot:640 && -r $BACKUP_REPORT && ! -w $BACKUP_REPORT ]]
pass backup_permission_contract
[[ -f $FAILURE_REPORT && ! -L $FAILURE_REPORT && -r $FAILURE_REPORT && ! -w $FAILURE_REPORT ]]
[[ $(stat -Lc '%U:%G:%a' "$FAILURE_REPORT") == root:codexbot:640 ]]
[[ $(sha256sum -- "$FAILURE_REPORT" | awk '{print $1}') == "$FAILURE_REPORT_SHA" ]]
jq -e '.schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF_FAILURE" and
  .script.sha256=="2c54907799dabee4c92eca40ebfd8176a8b8f4f61c70ed65f38a542cd0ea4b6e" and
  .script.checksumBound==true and .phase=="migration_preflight" and
  .safeCommandClass=="disposable_migration" and .classification=="DISPOSABLE_DOCKER_FAILED" and
  .checkId=="NONE" and .exitCode==2 and .sourceLine==626 and
  .postgresStartup.status=="READY" and .postgresStartup.lastOperation=="server_version_query" and
  .postgresStartup.containerState=="running" and .postgresStartup.containerExitCode==0 and
  .postgresStartup.healthStatus=="none" and .postgresStartup.readinessAttempts==2 and
  .postgresStartup.readinessTransientCount==1 and .postgresStartup.readinessLastExit==0 and
  .postgresStartup.versionQueryAttempts==2 and .postgresStartup.versionTransientCount==1 and
  .postgresStartup.versionLastExit==0 and .postgresStartup.versionMatched==true and
  .postgresStartup.expectedVersionNum==160014 and .postgresStartup.observedVersionNum==160014 and
  .postgresStartup.observedMajor==16 and .postgresStartup.observedMinor==14 and .postgresStartup.observedPatch==0 and
  .postgresStartup.versionClassification=="POSTGRES_VERSION_MATCHED" and
  .postgresStartup.versionOutputCategory=="CANONICAL_NUMERIC" and
  .ledgerDiagnostics.ledgerNameCount==46 and .ledgerDiagnostics.ledgerUniqueCount==46 and
  .ledgerDiagnostics.ledgerDuplicateCount==0 and .ledgerDiagnostics.ledgerUnsafeNameCount==0 and
  .ledgerDiagnostics.repositoryToLedgerCount==8 and .ledgerDiagnostics.ledgerToRepositoryCount==1 and
  .images.acceptedImagesRetained==true and .cleanup.completed==true and
  .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and .cleanup.volumesRemaining==0 and
  .cleanup.tempFilesRemaining==0 and .productionImmutability.productionDatabaseConnections==0 and
  ([.diagnostics.rawCommandCaptured,.diagnostics.rawSqlCaptured,.diagnostics.rawStderrCaptured,
    .diagnostics.environmentValuesCaptured,.diagnostics.credentialsCaptured,.diagnostics.messageDataCaptured,
    .diagnostics.providerPayloadCaptured]|all(.==false)) and
  ([.safety.productionDDL,.safety.productionDML,.safety.productionMigration,.safety.restart,.safety.deploy,
    .safety.browserLaunched,.safety.maxContacted,.safety.providerAction,.safety.productionNetworkAttached,
    .safety.productionVolumeMounted,.safety.profileMounted]|all(.==false)) and
  .productionImmutability.observedProductionHead=="e6a0a833fbb756216b058bfe326f9f9c77c4cc6d" and
  .productionImmutability.observedProductionStatusV2RawSha256=="2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b"' "$FAILURE_REPORT" >/dev/null
pass failure_report_acceptance
[[ -f $ALIAS_FAILURE_REPORT && ! -L $ALIAS_FAILURE_REPORT && -r $ALIAS_FAILURE_REPORT && ! -w $ALIAS_FAILURE_REPORT ]]
[[ $(stat -Lc '%U:%G:%a' "$ALIAS_FAILURE_REPORT") == root:codexbot:640 ]]
[[ $(sha256sum -- "$ALIAS_FAILURE_REPORT" | awk '{print $1}') == "$ALIAS_FAILURE_REPORT_SHA" ]]
jq -e '.schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF_FAILURE" and
  .script.sha256=="1772cc2b99934c7c81c4832c29d60abfecbc21d1f3b250bcd437d77a377d22ed" and
  .phase=="migration_preflight" and .safeCommandClass=="disposable_migration" and
  .classification=="MIGRATION_NETWORK_ALIAS_MISMATCH" and .checkId=="MIGRATION_POSTGRES_ALIAS_CHECK" and
  .exitCode==65 and .sourceLine==264 and .migrationPreflight.substep=="postgres_alias_validation" and
  .migrationPreflight.commandStarted==false and .migrationPreflight.attemptCount==0 and
  .migrationPreflight.elapsedSeconds==0 and .migrationPreflight.originalExitCode==65 and
  .migrationPreflight.containerStateCategory=="running" and
  .migrationPreflight.primaryClassification=="MIGRATION_NETWORK_ALIAS_MISMATCH" and
  .cleanup.completed==true and .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
  .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.observedProductionHead=="e6a0a833fbb756216b058bfe326f9f9c77c4cc6d" and
  .productionImmutability.observedProductionStatusV2RawSha256=="2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b"' \
  "$ALIAS_FAILURE_REPORT" >/dev/null
pass postgres_alias_failure_report_acceptance
[[ -f $VERIFICATION_FAILURE_REPORT && ! -L $VERIFICATION_FAILURE_REPORT && \
  -r $VERIFICATION_FAILURE_REPORT && ! -w $VERIFICATION_FAILURE_REPORT ]]
[[ $(stat -Lc '%U:%G:%a:%s' "$VERIFICATION_FAILURE_REPORT") == root:codexbot:640:5519 ]]
[[ $(sha256sum -- "$VERIFICATION_FAILURE_REPORT" | awk '{print $1}') == "$VERIFICATION_FAILURE_REPORT_SHA" ]]
jq -e --arg scriptSha "$VERIFICATION_FAILED_SCRIPT_SHA" '
  .schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF_FAILURE" and
  .script.sha256==$scriptSha and .script.checksumBound==true and
  .phase=="migration_verification" and .safeCommandClass=="disposable_migration" and
  .classification=="PRISMA_DIFF_FAILED" and .checkId=="MIGRATION_PRISMA_DIFF_CHECK" and
  .exitCode==1 and .sourceLine==165 and
  .migrationPreflight.checkId=="MIGRATION_PRISMA_DIFF_CHECK" and
  .migrationPreflight.substep=="prisma_diff" and .migrationPreflight.runnerRole=="prisma_diff" and
  .migrationPreflight.commandCategory=="internal_validator" and
  .migrationPreflight.executableCategory=="posix_shell" and
  .migrationPreflight.commandStarted==true and .migrationPreflight.attemptCount==1 and
  .migrationPreflight.elapsedSeconds==0 and .migrationPreflight.originalExitCode==1 and
  .migrationPreflight.containerStateCategory=="not_observed" and
  .migrationPreflight.primaryClassification=="PRISMA_DIFF_FAILED" and
  .cleanup.completed==true and .cleanup.errorClassification=="NONE" and
  .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
  .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.acceptedProductionHead==.productionImmutability.observedProductionHead and
  .productionImmutability.acceptedProductionStatusV2RawSha256==.productionImmutability.observedProductionStatusV2RawSha256 and
  ([.diagnostics.rawCommandCaptured,.diagnostics.rawSqlCaptured,.diagnostics.rawStderrCaptured,
    .diagnostics.environmentValuesCaptured,.diagnostics.credentialsCaptured,
    .diagnostics.messageDataCaptured,.diagnostics.providerPayloadCaptured,
    .safety.productionDDL,.safety.productionDML,.safety.productionMigration,.safety.restart,
    .safety.deploy,.safety.browserLaunched,.safety.maxContacted,.safety.providerAction,
    .safety.productionNetworkAttached,.safety.productionVolumeMounted,.safety.profileMounted] | all(.==false))' \
  "$VERIFICATION_FAILURE_REPORT" >/dev/null
bound_script_sha=$(git -C "$SCRIPT_DIR" show \
  "$VERIFICATION_FAILED_SOURCE_COMMIT:release/personal-max-stage8b1i/isolated-release-probe.sh" | sha256sum | awk '{print $1}')
bound_helper_line=$(git -C "$SCRIPT_DIR" show \
  "$VERIFICATION_FAILED_SOURCE_COMMIT:release/personal-max-stage8b1i/migration-preflight.sh" | sed -n '165p')
bound_top_level=$(git -C "$SCRIPT_DIR" show \
  "$VERIFICATION_FAILED_SOURCE_COMMIT:release/personal-max-stage8b1i/isolated-release-probe.sh" | sed -n '741,743p')
[[ $bound_script_sha == "$VERIFICATION_FAILED_SCRIPT_SHA" &&
  $bound_helper_line == *'pm_migration_record_failure "${PROBE_ERROR_CLASSIFICATION:-$__pm_failure_class}" "$__pm_status" not_observed'* &&
  $bound_top_level == *'pm_migration_run_bounded MIGRATION_PRISMA_DIFF_CHECK prisma_diff prisma_diff internal_validator posix_shell'* &&
  $bound_top_level == *'sh "$PACKAGE_ROOT/prisma-legacy-diff-gate.sh" "$TMP/prisma-diff.log" >/dev/null'* ]]
pass verification_failure_report_acceptance
[[ -f $REAL_PRISMA_FAILURE_REPORT && ! -L $REAL_PRISMA_FAILURE_REPORT && \
  -r $REAL_PRISMA_FAILURE_REPORT && ! -w $REAL_PRISMA_FAILURE_REPORT ]]
[[ $(stat -Lc '%U:%G:%a' "$REAL_PRISMA_FAILURE_REPORT") == root:codexbot:640 ]]
[[ $(sha256sum -- "$REAL_PRISMA_FAILURE_REPORT" | awk '{print $1}') == "$REAL_PRISMA_FAILURE_REPORT_SHA" ]]
jq -e '.script.sha256=="089a6a2e433ab7ffcfa5eeff5ac04f3499b67d749158e72efd1c697d6161a580" and
  .phase=="migration_verification" and .classification=="MIGRATION_PRISMA_DIFF_PARSE_FAILED" and
  .checkId=="MIGRATION_PRISMA_DIFF_GATE_CHECK" and .exitCode==65 and .sourceLine==297 and
  .migrationPreflight.substep=="prisma_diff_gate" and .migrationPreflight.originalExitCode==65 and
  .migrationPreflight.commandCategory=="internal_validator" and
  .migrationPreflight.executableCategory=="posix_shell" and
  .prismaDiffEvidence.factsObserved==true and .prismaDiffEvidence.rawByteCount==139 and
  .prismaDiffEvidence.nonCommentStatementCount==1 and .prismaDiffEvidence.alterTableCount==0 and
  .prismaDiffEvidence.affectedTableCount==1 and .prismaDiffEvidence.expectedTablePresent==false and
  .prismaDiffEvidence.unexpectedTablePresent==true and .prismaDiffEvidence.unexpectedOperationPresent==true and
  .prismaDiffEvidence.parserResult=="PARSE_FAILED" and
  .prismaDiffEvidence.finalGateClassification=="MIGRATION_PRISMA_DIFF_PARSE_FAILED" and
  .prismaDiffEvidence.rawDiffRetained==false and .prismaDiffEvidence.rawSqlCaptured==false and
  .cleanup.completed==true and .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
  .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.observedProductionHead=="e6a0a833fbb756216b058bfe326f9f9c77c4cc6d" and
  .productionImmutability.observedProductionStatusV2RawSha256=="2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b"' \
  "$REAL_PRISMA_FAILURE_REPORT" >/dev/null
jq -e '.evidenceAssessment.classification=="B" and
  .evidenceAssessment.classificationName=="REAL_DIFF_PARSE_BOUNDARY_PROVEN_CAUSE_INSUFFICIENT" and
  .evidenceAssessment.exactParserFailureCodeProven==false and
  .sourceAudit.contradictoryOversizeContractProven==true and
  .sourceAudit.theseSourceDefectsAreNotAssertedAsTheExactFailedRunCause==true and
  .safety.rawDiffRecovered==false and .safety.rootProbeRepeated==false' \
  "$REAL_PRISMA_FAILURE_FORENSIC" >/dev/null
pass real_prisma_failure_report_acceptance
[[ -f $SCRAPER_DEFAULT_OFF_FAILURE_REPORT && ! -L $SCRAPER_DEFAULT_OFF_FAILURE_REPORT && \
  -r $SCRAPER_DEFAULT_OFF_FAILURE_REPORT && ! -w $SCRAPER_DEFAULT_OFF_FAILURE_REPORT ]]
[[ $(stat -Lc '%U:%G:%a' "$SCRAPER_DEFAULT_OFF_FAILURE_REPORT") == root:codexbot:640 ]]
[[ $(sha256sum -- "$SCRAPER_DEFAULT_OFF_FAILURE_REPORT" | awk '{print $1}') == "$SCRAPER_DEFAULT_OFF_FAILURE_REPORT_SHA" ]]
jq -e '.schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF_FAILURE" and
  .script.sha256=="e36ad6b2436dd827e33c8a996e22ebbd40e45ffb5e1cc1430f75195d9f9f791f" and
  .script.checksumBound==true and .phase=="scraper_default_off" and
  .safeCommandClass=="synthetic_harness" and .classification=="SCRAPER_DEFAULT_OFF_FAILED" and
  .checkId=="NONE" and .exitCode==1 and .sourceLine==838 and
  .cleanup.completed==true and .cleanup.errorClassification=="NONE" and
  .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
  .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.acceptedProductionHead==.productionImmutability.observedProductionHead and
  .productionImmutability.acceptedProductionStatusV2RawSha256==.productionImmutability.observedProductionStatusV2RawSha256 and
  ([.diagnostics.rawCommandCaptured,.diagnostics.rawSqlCaptured,.diagnostics.rawStderrCaptured,
    .diagnostics.environmentValuesCaptured,.diagnostics.credentialsCaptured,.diagnostics.messageDataCaptured,
    .diagnostics.providerPayloadCaptured,.safety.productionDDL,.safety.productionDML,
    .safety.productionMigration,.safety.restart,.safety.deploy,.safety.browserLaunched,
    .safety.maxContacted,.safety.providerAction,.safety.productionNetworkAttached,
    .safety.productionVolumeMounted,.safety.profileMounted] | all(.==false))' \
  "$SCRAPER_DEFAULT_OFF_FAILURE_REPORT" >/dev/null
jq -e '.schemaVersion==1 and .incident=="SCRAPER_DEFAULT_OFF_INVOCATION_CONTRACT_FAILURE" and
  .failedAttempt.failureReportSha256=="93d75f31f61bed37e7bcfb9cc8164007fc46732c536643d11c6bebcbc9bf6598" and
  .failedAttempt.sourceLine==838 and .failedAttempt.exitCode==1 and
  .evidenceAssessment.classification=="A" and
  .evidenceAssessment.classificationName=="SCRAPER_DEFAULT_OFF_MODE_BINDING_DEFECT_PROVEN" and
  .sourceMap.implicitSelectedMode=="capture-and-drain" and .sourceMap.requiredSelectedMode=="default-off" and
  .sourceMap.firstFailedHarnessOperation=="active adapter enabled assertion" and
  .executableReplay.oldHarnessSourceExecuted==true and .executableReplay.realTransportInterceptorExecuted==true and
  .executableReplay.exitCode==1 and .executableReplay.errorCode=="ERR_ASSERTION" and
  .repairContract.defaultOffModeExplicit==true and .repairContract.implicitHarnessModeRemoved==true and
  .repairContract.rootProbeRerun==false and .safety.productionMutation==false and
  .safety.historicalResidualTouched==false and .safety.textCanaryTouched==false' \
  "$SCRAPER_DEFAULT_OFF_FORENSIC" >/dev/null
pass scraper_default_off_failure_acceptance
free=$(df -B1 -P /var/lib/docker | awk 'NR==2{print $4}')
[[ $free =~ ^[0-9]+$ && $((free - 2172240240)) -ge 12500000000 && $((free - 2172240240 - 5368709120)) -ge 0 ]]
pass post_backup_storage_gate

bash -n "$PROBE" "$DIAGNOSTICS" "$BOUNDED" "$OUTPUT_HELPERS" "$RESTORE_VERIFICATION" "$POSTGRES_STARTUP" "$MIGRATION_PREFLIGHT" "$RESIDUAL_CLEANUP" \
  "$FAULTS" "$OUTPUT_HANDOFF" "$OUTPUT_COLLISIONS" "$RESTORE_TESTS" "$LEDGER_TESTS" \
  "$POSTGRES_STARTUP_TESTS" "$MIGRATION_PREFLIGHT_TESTS" "$POSTGRES_NETWORK_ALIAS_TESTS" \
  "$MIGRATION_VERIFICATION_TESTS" "$FAILURE_HANDOFF_TESTS" "$REMAINING_TAIL_TESTS" \
  "$PRISMA_DIFF_SEMANTIC_TESTS" "$PRISMA_PARSER_FAILURE_TESTS" "$SCRIPT_DIR/test-package.sh"
sh -n "$MIGRATION_SQL_GATE"
sh -n "$PRISMA_LEGACY_DIFF_GATE"
pass bash_syntax
python3 -c 'compile(open(__import__("sys").argv[1], encoding="utf-8").read(), __import__("sys").argv[1], "exec")' \
  "$PRISMA_DIFF_SEMANTIC_PARSER"
pass python_syntax
"$NODE_BIN" --check "$SCRAPER_HARNESS"
"$NODE_BIN" --check "$CLIENT_HARNESS"
"$NODE_BIN" --check "$SCRAPER_DEFAULT_OFF_TESTS"
pass node_syntax
while IFS= read -r -d '' json_path; do
  jq -e . "$json_path" >/dev/null
done < <(find "$SCRIPT_DIR" -maxdepth 1 -type f -name '*.json' -print0)
pass json_validation
if command -v "$SHELLCHECK_BIN" >/dev/null 2>&1; then
  "$SHELLCHECK_BIN" -x -S warning "$PROBE" "$DIAGNOSTICS" "$BOUNDED" "$OUTPUT_HELPERS" "$RESTORE_VERIFICATION" "$POSTGRES_STARTUP" "$MIGRATION_PREFLIGHT" "$RESIDUAL_CLEANUP" \
    "$MIGRATION_SQL_GATE" "$PRISMA_LEGACY_DIFF_GATE" "$FAULTS" "$OUTPUT_HANDOFF" "$OUTPUT_COLLISIONS" \
    "$RESTORE_TESTS" "$LEDGER_TESTS" "$POSTGRES_STARTUP_TESTS" "$MIGRATION_PREFLIGHT_TESTS" \
    "$POSTGRES_NETWORK_ALIAS_TESTS" "$MIGRATION_VERIFICATION_TESTS" "$FAILURE_HANDOFF_TESTS" \
    "$REMAINING_TAIL_TESTS" "$PRISMA_DIFF_SEMANTIC_TESTS" "$PRISMA_PARSER_FAILURE_TESTS" "$SCRIPT_DIR/test-package.sh"
  pass shellcheck
else
  PACKAGE_SKIP_COUNT=$((PACKAGE_SKIP_COUNT + 1))
  printf 'shellcheck=SKIP_NOT_INSTALLED\n'
fi
for evidence in 'pm_run_bounded()' 'pm_capture_bounded()' 'pm_write_bounded()' \
  '"$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${seconds}s"'; do require_fixed "$BOUNDED" "$evidence"; done
pass timeout_wrapper_contract
require_fixed "$PROBE" 'docker_metadata 60 METADATA_TIMEOUT'
require_fixed "$BOUNDED" '900s docker pull'
require_fixed "$PROBE" 'backup_validation 120 RESTORE_LIST_TIMEOUT'
require_fixed "$PROBE" 'backup_validation 1200 FULL_RESTORE_TIMEOUT'
require_fixed "$MIGRATION_PREFLIGHT" '"${__pm_seconds}s" docker start -a'
require_fixed "$PROBE" '600 PRISMA_DIFF_TIMEOUT MIGRATION_PRISMA_DIFF_EXECUTION_FAILED'
require_fixed "$PROBE" 'synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT'
pass long_operation_timeout_guards
require_fixed "$BOUNDED" 'pm_poll_until()'
require_fixed "$PROBE" 'pm_poll_until 180 240 E2E_VERIFICATION_FAILED'
require_fixed "$PROBE" 'pm_poll_until 30 60 GATEWAY_DORMANT_READINESS_FAILED'
require_fixed "$PROBE" 'pm_poll_until 60 90 "$failure_class" gateway_active_health'
pass polling_deadline_guards
for evidence in POSTGRES_CONTAINER_START_CHECK POSTGRES_READINESS_CHECK \
  POSTGRES_SERVER_VERSION_QUERY_CHECK POSTGRES_SERVER_VERSION_MATCH_CHECK \
  POSTGRES_CONTAINER_START_FAILED POSTGRES_CONTAINER_EXITED_DURING_STARTUP \
  POSTGRES_READINESS_TIMEOUT POSTGRES_READINESS_COMMAND_FAILED \
  POSTGRES_VERSION_QUERY_FAILED POSTGRES_VERSION_OUTPUT_MALFORMED POSTGRES_VERSION_MISMATCH \
  POSTGRES_VERSION_MATCHED; do
  require_fixed "$POSTGRES_STARTUP" "$evidence"
done
require_fixed "$POSTGRES_STARTUP" '1 | 2)'
require_fixed "$POSTGRES_STARTUP" 'PROBE_ERROR_CLASSIFICATION=NONE'
require_fixed "$POSTGRES_STARTUP" 'Raw logs, command output, environment values, credentials, and SQL results'
require_fixed "$PROBE" 'pm_postgres_wait_readiness 90 120'
require_fixed "$POSTGRES_STARTUP" "-c 'SHOW server_version_num'"
refuse_pattern "$POSTGRES_STARTUP" "-c 'SHOW server_version'"
require_fixed "$PROBE" 'pm_postgres_wait_version server_version_num "$POSTGRES_VERSION_NUM" 30 60'
require_fixed "$PROBE" 'readonly POSTGRES_VERSION_NUM=160014'
require_fixed "$PROBE" 'server_version="${POSTGRES_OBSERVED_VERSION_MAJOR}.${POSTGRES_OBSERVED_VERSION_MINOR}"'
pass postgres_startup_state_machine
require_fixed "$PROBE" 'CLEANUP_GLOBAL_DEADLINE=$((SECONDS + 300))'
for evidence in CONTAINER_REMOVAL_TIMEOUT NETWORK_REMOVAL_TIMEOUT VOLUME_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT CLEANUP_GLOBAL_DEADLINE_EXCEEDED; do
  rg -F "$evidence" "$PROBE" "$BOUNDED" >/dev/null
done
pass cleanup_deadline_guards
for evidence in GATEWAY_PULL_TIMEOUT SCRAPER_PULL_TIMEOUT REGISTRY_AUTHENTICATION_DENIED REGISTRY_MANIFEST_NOT_FOUND REGISTRY_DIGEST_MISMATCH REGISTRY_ACCESS_UNAVAILABLE; do
  require_fixed "$BOUNDED" "$evidence"
done
pass registry_failure_classifications
for evidence in FREE_BYTES_AFTER_GATEWAY_PULL FREE_BYTES_AFTER_SCRAPER_PULL POST_PULL_DISK_GATE_FAILED FINAL_DISK_GATE_FAILED; do require_fixed "$PROBE" "$evidence"; done
require_fixed "$PROBE" 'IMAGE_EXPANSION_REQUIRED_BYTES=0'
require_fixed "$PROBE" 'GATEWAY_PREEXISTING_BEFORE_PULL == true && $SCRAPER_PREEXISTING_BEFORE_PULL == true'
pass disk_gate_contract
require_fixed "$PROBE" 'pm_validate_success_report "$TMP_REPORT"'
require_fixed "$BOUNDED" 'SUCCESS_REPORT_MALFORMED'
pass success_report_validation
require_fixed "$BOUNDED" 'SUCCESS_REPORT_SAFETY_VIOLATION'
require_fixed "$BOUNDED" '.safety.productionDDL'
pass safety_field_validation
fault_output=$("$FAULTS")
[[ $fault_output == *'FAULT_TEST_COUNT=20'* && $fault_output == *'ERR_TRAP_BOUNDARY=VERIFIED'* && \
  $fault_output == *'ROOT_PROBE_EXECUTED=NO'* && $fault_output == *'DOCKER_EXECUTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$fault_output") -eq 20 ]]
pass no_silent_failure_matrix
handoff_output=$("$OUTPUT_HANDOFF")
[[ $handoff_output == *'OLD_FIXTURE=FAIL_AS_EXPECTED'* && $handoff_output == *'FIXED_IMPLEMENTATION=PASS'* && \
  $handoff_output == *'EXECUTABLE_TEST_COUNT=36'* && $handoff_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $handoff_output == *'DOCKER_EXECUTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$handoff_output") -eq 37 ]]
require_fixed "$BOUNDED" 'local -n __pm_out_ref="$__pm_target_name"'
require_fixed "$BOUNDED" 'local -n __pm_assignment_ref="$__pm_assignment_target"'
require_fixed "$BOUNDED" '^[a-zA-Z_][a-zA-Z0-9_]*$'
require_fixed "$BOUNDED" 'OUTPUT_TARGET_SCOPE_COLLISION'
refuse_pattern "$PROBE" '(^|[[:space:]])eval([[:space:]]|$)'
refuse_pattern "$PROBE" 'pm_capture_bounded[[:space:]]+__pm_'
refuse_pattern "$OUTPUT_HELPERS" 'pm_capture_bounded[[:space:]]+__pm_'
require_fixed "$OUTPUT_HELPERS" 'pm_capture_bounded_internal'
pass output_handoff_regression
collision_output=$("$OUTPUT_COLLISIONS")
[[ $collision_output == *'OUTPUT_TARGET_COLLISION_TEST_COUNT=30'* && \
  $collision_output == *'DYNAMIC_SCOPE_COLLISION_PROVEN=YES'* && \
  $collision_output == *'STATIC_SOURCE_AUDIT=PASS'* && \
  $collision_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $collision_output == *'DOCKER_EXECUTED=NO'* && $collision_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$collision_output") -eq 31 ]]
pass output_target_collision_regression
restore_output=$("$RESTORE_TESTS")
[[ $restore_output == *'RESTORE_REGRESSION_TEST_COUNT=25'* && \
  $restore_output == *'OLD_FAILURE=REPRODUCED'* && $restore_output == *'FIXED_PATH=PASS'* && \
  $restore_output == *'ROOT_PROBE_EXECUTED=NO'* && $restore_output == *'DOCKER_EXECUTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$restore_output") -eq 26 ]]
pass restore_verification_regression
ledger_output=$("$LEDGER_TESTS")
[[ $ledger_output == *'LEDGER_REGRESSION_TEST_COUNT=22'* && \
  $ledger_output == *'OLD_LEDGER_FAILURE=REPRODUCED'* && \
  $ledger_output == *'CORRECTED_HISTORICAL_FIXTURE=PASS'* && \
  $ledger_output == *'ROOT_PROBE_EXECUTED=NO'* && $ledger_output == *'DOCKER_EXECUTED=NO'* && \
  $ledger_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$ledger_output") -eq 23 ]]
pass ledger_verification_regression
postgres_startup_output=$("$POSTGRES_STARTUP_TESTS")
[[ $postgres_startup_output == *'POSTGRES_STARTUP_TEST_COUNT=34'* && \
  $postgres_startup_output == *'PREVIOUS_FAILURE=REPRODUCED'* && \
  $postgres_startup_output == *'CORRECTED_FIXTURE=PASS'* && \
  $postgres_startup_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $postgres_startup_output == *'DOCKER_EXECUTED=NO'* && \
  $postgres_startup_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$postgres_startup_output") -eq 35 ]]
pass postgres_startup_regression

migration_preflight_output=$("$MIGRATION_PREFLIGHT_TESTS")
[[ $migration_preflight_output == *'MIGRATION_PREFLIGHT_TEST_COUNT=26'* && \
  $migration_preflight_output == *'OLD_EXIT_2_REPRODUCED=YES'* && \
  $migration_preflight_output == *'CORRECTED_PERMISSION_FIXTURE=PASS'* && \
  $migration_preflight_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $migration_preflight_output == *'DOCKER_EXECUTED=NO'* && \
  $migration_preflight_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$migration_preflight_output") -eq 27 ]]
pass migration_preflight_regression

postgres_alias_output=$("$POSTGRES_NETWORK_ALIAS_TESTS")
[[ $postgres_alias_output == *'POSTGRES_NETWORK_ALIAS_TEST_COUNT=28'* && \
  $postgres_alias_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $postgres_alias_output == *'DOCKER_EXECUTED=NO'* && \
  $postgres_alias_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$postgres_alias_output") -eq 28 ]]
pass postgres_network_alias_regression

migration_verification_output=$("$MIGRATION_VERIFICATION_TESTS")
[[ $migration_verification_output == *'MIGRATION_VERIFICATION_TEST_COUNT=14'* && \
  $migration_verification_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $migration_verification_output == *'DOCKER_EXECUTED=NO'* && \
  $migration_verification_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$migration_verification_output") -eq 14 ]]
pass migration_verification_regression

failure_handoff_output=$("$FAILURE_HANDOFF_TESTS")
[[ $failure_handoff_output == *'FAILURE_HANDOFF_TEST_COUNT=29'* && \
  $failure_handoff_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $failure_handoff_output == *'DOCKER_EXECUTED=NO'* && \
  $failure_handoff_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$failure_handoff_output") -eq 29 ]]
pass failure_handoff_regression

remaining_tail_output=$("$REMAINING_TAIL_TESTS")
[[ $remaining_tail_output == *'REMAINING_TAIL_TEST_COUNT=29'* && \
  $remaining_tail_output == *'REQUIRED_REGRESSION_CASES_COVERED=19'* && \
  $remaining_tail_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $remaining_tail_output == *'DOCKER_EXECUTED=NO'* && \
  $remaining_tail_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$remaining_tail_output") -eq 29 ]]
pass remaining_tail_regression

scraper_default_off_output=$("$NODE_BIN" "$SCRAPER_DEFAULT_OFF_TESTS")
[[ $scraper_default_off_output == *'SCRAPER_DEFAULT_OFF_TEST_COUNT=30'* && \
  $scraper_default_off_output == *'ACTUAL_HARNESS_EXECUTED=YES'* && \
  $scraper_default_off_output == *'ACTUAL_TRANSPORT_INTERCEPTOR_EXECUTED=YES'* && \
  $scraper_default_off_output == *'DOCKER_EXECUTED=NO'* && \
  $scraper_default_off_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$scraper_default_off_output") -eq 30 ]]
pass scraper_default_off_regression

prisma_diff_semantic_output=$("$PRISMA_DIFF_SEMANTIC_TESTS")
[[ $prisma_diff_semantic_output == *'PRISMA_DIFF_SEMANTIC_TEST_COUNT=36'* ]]
[[ $(grep -c '^PASS ' <<<"$prisma_diff_semantic_output") -eq 36 ]]
pass prisma_diff_semantic_regression

prisma_parser_failure_output=$($PRISMA_PARSER_FAILURE_TESTS)
[[ $prisma_parser_failure_output == *'PRISMA_PARSER_FAILURE_TEST_COUNT=25'* ]]
[[ $(grep -c '^PASS ' <<<"$prisma_parser_failure_output") -eq 25 ]]
pass prisma_parser_failure_regression

required_regression_cases=$((14 + 25 + 19 + 30))
[[ $required_regression_cases -eq 88 ]]
pass required_regression_case_matrix

migration_gate_output=$(sh "$MIGRATION_SQL_GATE" "$REPOSITORY_MIGRATIONS" "$MIGRATION_SQL_BINDINGS")
[[ $migration_gate_output == MIGRATION_SQL_GATE=PASS && $(wc -l <"$MIGRATION_SQL_BINDINGS") -eq 8 ]]
pass exact_migration_sql_binding
mkdir -p "$TEST_TMP/migrations"
cp -a "$REPOSITORY_MIGRATIONS/." "$TEST_TMP/migrations/"
printf '\nDROP TABLE "forbidden";\n' >>"$TEST_TMP/migrations/20260726162043_add_max_raw_transport_journal/migration.sql"
mutated_sha=$(sha256sum -- "$TEST_TMP/migrations/20260726162043_add_max_raw_transport_journal/migration.sql" | awk '{print $1}')
awk -v replacement="$mutated_sha" 'NR==1{$1=replacement} {print $1 "  " $2}' "$MIGRATION_SQL_BINDINGS" >"$TEST_TMP/mutated-bindings.txt"
set +e
sh "$MIGRATION_SQL_GATE" "$TEST_TMP/migrations" "$TEST_TMP/mutated-bindings.txt" >/dev/null 2>&1
mutation_gate_status=$?
set -e
[[ $mutation_gate_status -eq 67 ]]
pass destructive_migration_refusal
printf '%s\n' '-- AlterTable' \
  'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT,' \
  'ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);' >"$TEST_TMP/accepted-prisma-diff.sql"
prisma_gate_output=$(sh "$PRISMA_LEGACY_DIFF_GATE" "$TEST_TMP/accepted-prisma-diff.sql" "$TEST_TMP/accepted-prisma-diff.json")
[[ $prisma_gate_output == PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT ]]
jq -e '.finalGateClassification=="MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT" and
  .expectedSemanticMode=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and .rawSqlCaptured==false' \
  "$TEST_TMP/accepted-prisma-diff.json" >/dev/null
pass accepted_legacy_prisma_diff
cp "$TEST_TMP/accepted-prisma-diff.sql" "$TEST_TMP/rejected-prisma-diff.sql"
printf '%s\n' 'ALTER TABLE "DriverTelegram" ADD COLUMN "unexpected" TEXT;' >>"$TEST_TMP/rejected-prisma-diff.sql"
set +e
sh "$PRISMA_LEGACY_DIFF_GATE" "$TEST_TMP/rejected-prisma-diff.sql" "$TEST_TMP/rejected-prisma-diff.json" >/dev/null 2>&1
prisma_gate_status=$?
set -e
[[ $prisma_gate_status -eq 65 ]]
jq -e '.finalGateClassification=="MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN" and
  .unexpectedColumnPresent==true and .rawDiffRetained==false' "$TEST_TMP/rejected-prisma-diff.json" >/dev/null
pass unexpected_prisma_diff_refused
require_fixed "$PROBE" '[[ $PM_SCRIPT_SHA256 == "$1" ]]'
require_fixed "$PROBE" 'sha256sum -c SHA256SUMS'
pass checksum_binding
for binding in \
  "failure-diagnostics.sh:FAILURE_DIAGNOSTICS_SHA256:7d0704f522236c999ef185418633b049f0d39444e3df6aae76bc8a6a359cba8c" \
  "bounded-operations.sh:BOUNDED_OPERATIONS_SHA256:bc02fe1cb9c3ce04f4a259cc288c120356e7085c7b2a99cc3efbcfd8ad9cd00b" \
  "probe-output-helpers.sh:PROBE_OUTPUT_HELPERS_SHA256:64f4a885a1f109130059f9466712d5b9088cfe9154ad580903694b17403eeed7" \
  "restore-verification.sh:RESTORE_VERIFICATION_SHA256:996721573f9b243598c2380497e44a8aafd2800330500256ddc53c2ef6779547" \
  "postgres-startup.sh:POSTGRES_STARTUP_SHA256:54276af4a969b0003c907e249e1fdef04d2b8da6c101cc898aecc6d5685b56e3" \
  "migration-preflight.sh:MIGRATION_PREFLIGHT_SHA256:71ac68dde88da402179fce82f970b4820b7b696a98886a9135fb410d54d89735" \
  "migration-sql-gate.sh:MIGRATION_SQL_GATE_SHA256:9faf24f9aacbd48c27d5e8cff8b0bfdcc92570a9d314232969fd684d70539bda" \
  "migration-sql-bindings.txt:MIGRATION_SQL_BINDINGS_SHA256:9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f" \
  "prisma-legacy-diff-gate.sh:PRISMA_LEGACY_DIFF_GATE_SHA256:d9867613380ffdba7af070e916ea782721810fe4268bf1c064b59a5de2cb27b0" \
  "prisma-diff-semantic-parser.py:PRISMA_DIFF_SEMANTIC_PARSER_SHA256:87024a3151d183292b1c94cd5c681470bd023eda4b57fc56cce255747edf4890" \
  "synthetic-scraper-harness.js:SYNTHETIC_SCRAPER_HARNESS_SHA256:e8ceaccbfd51d8dd91cf5d84f43716f4decd349ac19c4db529bb17ee4cc75af9" \
  "gateway-client-harness.js:GATEWAY_CLIENT_HARNESS_SHA256:f1f8c3f5a60a0cf45f44904d8f708f760d02b6553c3b86d05e1ecbbd8cd25428"; do
  IFS=: read -r artifact constant digest <<<"$binding"
  require_fixed "$PROBE" "readonly $constant='$digest'"
  require_fixed "$PROBE" "bootstrap_verify_runtime_artifact $artifact \"\$$constant\""
done
[[ $(rg -c '^bootstrap_verify_runtime_artifact ' "$PROBE") -eq 12 ]]
require_fixed "$PROBE" 'bootstrap_verify_runtime_path SHA256SUMS'
refuse_pattern "$PROBE" 'SHA256SUMS_SHA256|EXPECTED_SHA256SUMS'
last_anchor_line=$(grep -nF 'bootstrap_verify_runtime_artifact gateway-client-harness.js' "$PROBE" | cut -d: -f1)
first_source_line=$(grep -nF 'source "$PACKAGE_ROOT/failure-diagnostics.sh"' "$PROBE" | cut -d: -f1)
[[ $last_anchor_line -lt $first_source_line ]]
require_fixed "$OUTPUT_HANDOFF" 'paired_runtime_artifact_substitution_refused'
pass transitive_runtime_artifact_binding
require_fixed "$PROBE" "$BACKUP_SHA"
require_fixed "$PROBE" 'sha_of observed_sha "$DUMP_PATH"'
require_fixed "$PROBE" '[[ $observed_sha == "$DUMP_SHA256" ]]'
pass backup_sha_binding
jq -e '.images.gateway.digest=="sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de" and .images.scraper.digest=="sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768" and .images.postgresql.digest=="sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"' "$SCRIPT_DIR/accepted-images.json" >/dev/null
pass image_digest_binding
require_fixed "$PROBE" "readonly POSTGRES_VERSION='16.14'"
jq -e '.images.postgresql.requiredServerVersion=="16.14" and .images.postgresql.requiredServerVersionNum==160014' "$SCRIPT_DIR/accepted-images.json" >/dev/null
pass postgresql_16_14_binding

refuse_pattern "$PROBE" 'crm_internal|--network[=[:space:]]+host'
pass production_network_refusal
refuse_pattern "$PROBE" 'crm_postgres_data|crm_max_user_data|crm_[A-Za-z0-9_-]+:/[A-Za-z]'
pass production_volume_refusal
refuse_pattern "$PROBE" '/app/user_data|/app/userData|CHROMIUM_PROFILE|MAX_PROFILE'
pass profile_mount_refusal
refuse_pattern "$PROBE" '(^|[[:space:]])(-p|--publish)([=[:space:]]|$)|--publish-all'
pass public_port_refusal
require_fixed "$PROBE" 'PREFIX="personal-max-stage8b1i-$RUN_ID"'
require_fixed "$PROBE" 'docker ps -aq --no-trunc --filter "name=^/${name}$"'
require_fixed "$PROBE" 'docker network inspect "$NETWORK"'
pass name_collision_guards
require_fixed "$OUTPUT_HELPERS" '--filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$__pm_run_id"'
require_fixed "$PROBE" 'cleanup_docker_objects'
pass label_scoped_cleanup
refuse_pattern "$PROBE" 'docker[[:space:]]+(system[[:space:]]+)?prune|docker[[:space:]]+image[[:space:]]+prune'
pass no_global_prune
refuse_pattern "$PROBE" 'docker([ -])compose|compose[[:space:]]+-f'
pass no_docker_compose
refuse_pattern "$PROBE" '\.env\.production'
pass no_env_production_read
require_fixed "$PROBE" 'productionDatabaseConnections:0'
refuse_pattern "$PROBE" 'docker[[:space:]]+exec[[:space:]]+[^ ]*(crm-postgres|postgres_id)|postgresql://[^ ]*@crm-postgres'
pass no_production_db_connection

for evidence in 'pg_restore --list' 'pg_restore --exit-on-error --no-owner --no-acl' 'FULL_RESTORE_PROOF:"PASS"'; do require_fixed "$PROBE" "$evidence"; done
for evidence in 'pm_restore_assert_uint_equal "$ledger_before_finished" 46' \
  'pm_restore_assert_uint_positive "$catalog_tables"' 'RESTORE_REQUIRED_USERS_RELATION_CHECK' \
  'SELECT count(*) FROM "users"'; do require_fixed "$RESTORE_VERIFICATION" "$evidence"; done
pass disposable_restore_contract
for migration in 20260726162043_add_max_raw_transport_journal 20260726190658_add_max_route_registry \
  20260726205437_add_max_inbound_normalization 20260726215715_add_max_per_chat_outbound_actor \
  20260726225737_add_max_dispatch_ledger 20260727053744_add_max_provider_confirmation_matcher \
  20260727141925_add_max_shadow_semantic_comparison 20260727154647_add_max_capture_ingress; do
  require_fixed "$PROBE" "$migration"
done
require_fixed "$PROBE" 'test "$ledger_after_finished" -eq 54'
require_fixed "$PROBE" 'prisma migrate diff'
require_fixed "$PROBE" 'prisma_diff_empty=false'
require_fixed "$PROBE" 'prisma_diff_status=MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT'
require_fixed "$PROBE" 'acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"]'
require_fixed "$BOUNDED" '.migration.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"]'
pass exact_eight_migration_contract
for evidence in gateway-missing-hmac gateway-invalid-config gateway-dormant authenticatedIngress requestSizeLimit; do require_fixed "$PROBE" "$evidence"; done
for evidence in missingAuthDenied invalidAuthDenied wrongAccountDenied idempotentRetry; do require_fixed "$CLIENT_HARNESS" "$evidence"; done
pass gateway_executable_contract
for evidence in createLiveCaptureAdapterFromEnvironment TransportInterceptor selectedHarnessMode createAttemptInstrumentation \
  frameHandled timerAttemptCount networkAttemptCount databaseAttemptCount activeAdapterFactoryCalled lostBeforeSpoolCount; do
  require_fixed "$SCRAPER_HARNESS" "$evidence"
done
for evidence in SCRAPER_DEFAULT_OFF_RUN_CHECK SCRAPER_DEFAULT_OFF_RESULT_CHECK SPOOL_INITIALIZATION_CHECK \
  SCRAPER_DEFAULT_OFF_MODE_MISSING SCRAPER_DEFAULT_OFF_MODE_MISMATCH SCRAPER_DEFAULT_OFF_HARNESS_EXITED \
  SCRAPER_DEFAULT_OFF_OUTPUT_MISSING SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED SCRAPER_DEFAULT_OFF_ENABLED_UNEXPECTED \
  SCRAPER_DEFAULT_OFF_SPOOL_CREATED SCRAPER_DEFAULT_OFF_PENDING_UNEXPECTED SCRAPER_DEFAULT_OFF_TIMER_ACTIVITY \
  SCRAPER_DEFAULT_OFF_NETWORK_ACTIVITY SCRAPER_DEFAULT_OFF_DATABASE_ACTIVITY \
  SCRAPER_DEFAULT_OFF_ACTIVE_FACTORY_CALLED SCRAPER_DEFAULT_OFF_DRAIN_CREATED SPOOL_INITIALIZATION_FAILED; do
  rg -F "$evidence" "$BOUNDED" "$DIAGNOSTICS" "$SCRIPT_DIR/report-schema.json" >/dev/null
done
jq -e '(.allOf[1].then.required|index("scraperOperation")) and
  (.allOf[1].then.properties.scraperOperation.required|index("primaryClassification")) and
  .allOf[1].then.properties.scraperOperation.properties.rawStderrCaptured.const==false and
  .allOf[1].then.properties.scraperOperation.properties.environmentValuesCaptured.const==false and
  .allOf[1].then.properties.scraperOperation.properties.credentialsCaptured.const==false' \
  "$SCRIPT_DIR/report-schema.json" >/dev/null
pass scraper_synthetic_contract
for evidence in 'STAGE8B1I_FRAME_COUNT=500' 'STAGE8B1I_IDENTICAL_COUNT=100' retry-only gatewayOutage databaseOutage spoolRecovery 'physical_frames -eq 1000' 'critical_regressions -eq 0'; do require_fixed "$PROBE" "$evidence"; done
pass end_to_end_contract

require_fixed "$PROBE" "trap 'on_error \$LINENO' ERR"
require_fixed "$PROBE" 'trap on_exit EXIT'
require_fixed "$DIAGNOSTICS" 'rawCommandCaptured:false'
require_fixed "$DIAGNOSTICS" 'credentialsCaptured:false'
require_fixed "$DIAGNOSTICS" 'checkId:$checkId'
for evidence in RESTORE_LEDGER_COUNT_MISMATCH RESTORE_LEDGER_DUPLICATE_NAME RESTORE_LEDGER_UNSAFE_NAME \
  RESTORE_LEDGER_EXPECTED_SET_MISMATCH RESTORE_REQUIRED_RELATION_MISSING RESTORE_CATALOG_INTEGRITY_FAILED \
  RESTORE_REPRESENTATIVE_CHECK_FAILED RESTORE_QUERY_FAILED DISPOSABLE_CONTAINER_UNAVAILABLE \
  OUTPUT_TARGET_SCOPE_COLLISION; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in POSTGRES_CONTAINER_START_FAILED POSTGRES_CONTAINER_EXITED_DURING_STARTUP \
  POSTGRES_READINESS_TIMEOUT POSTGRES_READINESS_COMMAND_FAILED POSTGRES_VERSION_QUERY_FAILED \
  POSTGRES_VERSION_OUTPUT_MALFORMED POSTGRES_VERSION_MISMATCH POSTGRES_CONTAINER_START_CHECK POSTGRES_READINESS_CHECK \
  POSTGRES_SERVER_VERSION_QUERY_CHECK POSTGRES_SERVER_VERSION_MATCH_CHECK; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in 'postgresStartup:{status:$postgresStatus' 'rawLogsCaptured:false' \
  'environmentValuesCaptured:false' 'credentialsCaptured:false' 'commandArgumentsCaptured:false'; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in 'migrationPreflight:{checkId:$migrationCheckId' 'databaseUrlCaptured:false' \
  'businessDataCaptured:false' MIGRATION_SQL_GATE_EXIT_2 MIGRATION_PRISMA_EXIT_1 MIGRATION_PRISMA_EXIT_2 \
  MIGRATION_RUNTIME_FILE_UNREADABLE MIGRATION_POST_VERIFICATION_FAILED MIGRATION_POSTGRES_INSPECT_FAILED \
  MIGRATION_POSTGRES_NETWORK_MISSING MIGRATION_POSTGRES_UNEXPECTED_NETWORK MIGRATION_POSTGRES_ALIAS_ARRAY_MISSING \
  MIGRATION_POSTGRES_ALIAS_MISSING MIGRATION_POSTGRES_ALIAS_MISMATCH MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED \
  'postgresNetworkAlias:{factsObserved:$postgresNetworkFactsObserved' 'rawInspectCaptured:false'; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in MIGRATION_SQL_RUNNER_START_CHECK MIGRATION_PRISMA_DEPLOY_CHECK \
  MIGRATION_RUNTIME_BINDING_CHECK MIGRATION_POST_LEDGER_CHECK MIGRATION_POST_SCHEMA_CHECK; do
  require_fixed "$MIGRATION_PREFLIGHT" "$evidence"
done
pass failure_diagnostics
for evidence in 'prismaDiffEvidence:{factsObserved:$prismaDiffFactsObserved' \
  'rawByteCount:$prismaDiffRawByteCount' 'sizeLimitBytes:$prismaDiffSizeLimitBytes' \
  'parserFailureStage:$prismaDiffParserFailureStage' 'parserFailureCode:$prismaDiffParserFailureCode' \
  'factsFileCreated:$prismaDiffFactsFileCreated' 'factsFileLoaded:$prismaDiffFactsFileLoaded' \
  'nonCommentStatementCount:$prismaDiffStatementCount' \
  'normalizedSemanticSha256:$prismaDiffSemanticSha256' \
  'expectedSemanticMode:$prismaDiffExpectedMode' 'finalGateClassification:$prismaDiffFinalClassification' \
  'rawDiffRetained:false' 'rawSqlCaptured:false' 'databaseUrlCaptured:false' \
  'credentialsCaptured:false' 'environmentValuesCaptured:false' 'businessDataCaptured:false'; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
jq -e '(.allOf[1].then.required|index("prismaDiffEvidence")) and
  (.allOf[1].then.properties.prismaDiffEvidence.required|index("normalizedSemanticSha256")) and
  (.allOf[1].then.properties.prismaDiffEvidence.required|index("parserFailureCode")) and
  .allOf[1].then.properties.prismaDiffEvidence.properties.sizeLimitBytes.const==4096 and
  .allOf[1].then.properties.prismaDiffEvidence.properties.rawByteCount.maximum==null and
  .allOf[1].then.properties.prismaDiffEvidence.properties.rawDiffRetained.const==false and
  .allOf[1].then.properties.prismaDiffEvidence.properties.rawSqlCaptured.const==false and
  .allOf[0].then.properties.migration.properties.prismaDiffEvidence.properties.expectedSemanticMode.const=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and
  .allOf[0].then.properties.migration.properties.prismaDiffEvidence.properties.finalGateClassification.const=="MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT"' \
  "$SCRIPT_DIR/report-schema.json" >/dev/null
pass prisma_diff_privacy_evidence_contract
for evidence in MIGRATION_POST_FINISHED_COUNT_QUERY_FAILED MIGRATION_POST_FAILED_COUNT_QUERY_FAILED \
  MIGRATION_POST_LEDGER_COUNT_MISMATCH MIGRATION_POST_LEDGER_NAMES_QUERY_FAILED \
  MIGRATION_POST_APPLIED_SET_FAILED MIGRATION_POST_APPLIED_SET_MISMATCH \
  MIGRATION_DURATION_QUERY_FAILED MIGRATION_DURATION_RESULT_MALFORMED \
  MIGRATION_SCHEMA_TABLE_QUERY_FAILED MIGRATION_SCHEMA_TABLE_MISSING \
  MIGRATION_SCHEMA_COLUMN_QUERY_FAILED MIGRATION_SCHEMA_COLUMN_MISSING \
  MIGRATION_SCHEMA_INDEX_QUERY_FAILED MIGRATION_SCHEMA_INDEX_MISSING \
  MIGRATION_SCHEMA_UNIQUE_KEY_QUERY_FAILED MIGRATION_SCHEMA_UNIQUE_KEY_MISSING \
  MIGRATION_PRISMA_DIFF_EXECUTION_FAILED MIGRATION_PRISMA_DIFF_REJECTED \
  MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED MIGRATION_PRISMA_DIFF_REQUIRED_EMPTY \
  MIGRATION_PRISMA_DIFF_PARSE_FAILED MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE \
  MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION \
  MIGRATION_PRISMA_DIFF_TYPE_MISMATCH MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING \
  MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT MIGRATION_PRISMA_DIFF_EMPTY_ACCEPTED; do
  require_fixed "$MIGRATION_PREFLIGHT" "$evidence"
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in MIGRATION_POST_FINISHED_COUNT_CHECK MIGRATION_POST_FAILED_COUNT_CHECK \
  MIGRATION_POST_LEDGER_COUNT_CHECK MIGRATION_POST_LEDGER_NAMES_CHECK \
  MIGRATION_POST_APPLIED_SET_BUILD_CHECK MIGRATION_POST_APPLIED_SET_COMPARE_CHECK \
  MIGRATION_DURATION_QUERY_CHECK MIGRATION_DURATION_RESULT_CHECK \
  MIGRATION_SCHEMA_TABLE_QUERY_CHECK MIGRATION_SCHEMA_TABLE_CHECK \
  MIGRATION_SCHEMA_COLUMN_QUERY_CHECK MIGRATION_SCHEMA_COLUMN_CHECK \
  MIGRATION_SCHEMA_INDEX_QUERY_CHECK MIGRATION_SCHEMA_INDEX_CHECK \
  MIGRATION_SCHEMA_UNIQUE_KEY_QUERY_CHECK MIGRATION_SCHEMA_UNIQUE_KEY_CHECK \
  MIGRATION_PRISMA_DIFF_EXECUTION_CHECK MIGRATION_PRISMA_DIFF_GATE_CHECK; do
  require_fixed "$MIGRATION_PREFLIGHT" "$evidence"
  require_fixed "$DIAGNOSTICS" "$evidence"
  require_fixed "$SCRIPT_DIR/report-schema.json" "$evidence"
done
jq -e '
  (.allOf[1].then.properties.checkId.enum|index("MIGRATION_POST_FINISHED_COUNT_CHECK")) and
  (.allOf[1].then.properties.checkId.enum|index("MIGRATION_PRISMA_DIFF_GATE_CHECK")) and
  .allOf[1].then.properties.migrationPreflight.properties.primaryClassification.pattern=="^(NONE|MIGRATION_[A-Z0-9_]+|PRISMA_DIFF_(TIMEOUT|FAILED))$"' \
  "$SCRIPT_DIR/report-schema.json" >/dev/null
pass migration_verification_state_contract

for evidence in '/var/tmp/personal-max-stage8b1i.fee32e594eba.NKiRfY' \
  '57d7cba75198c002de902d1ef569681eb14d89e594ca9488214cd99fb3ec4d38' \
  'origin failure report for the old script is absent' 'does not source or invoke `residual-cleanup.sh`' \
  'separate controlled privileged runner job'; do
  require_fixed "$SCRIPT_DIR/failed-run-residual-cleanup-contract.md" "$evidence"
done
refuse_pattern "$PROBE" 'RESIDUAL_CLEANUP_SHA256|bootstrap_verify_runtime_artifact residual-cleanup\.sh|source .*residual-cleanup\.sh|pm_cleanup_prior_residual'
require_fixed "$PROBE" 'This probe neither inspects nor removes it'
pass historical_residual_non_runtime_contract

[[ $(wc -l <"$MIGRATION_CLOSURE_SHA256") -eq 54 ]]
[[ $(sha256sum "$MIGRATION_CLOSURE_SHA256" | awk '{print $1}') == 2fa525ac333b5c4d27df64b1d94ac5fed21892ace168ca12dcab03af861443b6 ]]
(cd "$SCRIPT_DIR/../.." && sha256sum -c "$MIGRATION_CLOSURE_SHA256" >/dev/null)
jq -e '.schemaVersion==1 and .mode=="PRISMA_DIFF_REPOSITORY_CLOSURE_AUDIT" and
  .schema.sha256=="46ef6927d4f11c76a6712e6337d5935a055ab6b71da10a3647cfaf3b57a8e93b" and
  .schema.submittedPhoneOccurrences==0 and .schema.submittedPhoneAtOccurrences==0 and
  .migrationClosure.directoryCount==53 and .migrationClosure.sqlFileCount==53 and
  .migrationClosure.sha256LedgerEntryCount==54 and
  .migrationClosure.sha256LedgerSha256=="2fa525ac333b5c4d27df64b1d94ac5fed21892ace168ca12dcab03af861443b6" and
  .migrationClosure.submittedPhoneOccurrences==0 and .migrationClosure.submittedPhoneAtOccurrences==0 and
  .acceptedLedgerOnlyMigration.repositoryDirectoryPresent==false and
  .expectedSemanticResult=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and .evidenceClassification=="A" and
  .previousFailure.firstFailingOperationProven==true and .previousFailure.gateRejectionProven==true and
  .previousFailure.rawFailedRunDiffRetained==false and
  .previousFailure.actualFailedRunDiffSemanticCause=="PRISMA_DIFF_UNDERLYING_EVIDENCE_INSUFFICIENT" and
  .privacy.rawPrismaDiffIncluded==false and .privacy.rawSqlIncluded==false' \
  "$PRISMA_DIFF_CLOSURE_AUDIT" >/dev/null
pass prisma_diff_closure_audit

for evidence in personal_max_stage8b1i_surface_existing_report personal_max_stage8b1i_emit_unavailable \
  FAILURE_REPORT_UNAVAILABLE EXISTING_AFTER_PRIMARY_FAILURE; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in 'exec 9>/dev/tty' PM_FAILURE_HANDOFF_ATTEMPTED CLEANUP_ATTEMPTED \
  E2E_VERIFICATION_FAILED PRODUCTION_SNAPSHOT_MISMATCH SUCCESS_REPORT_RENDER_FAILED \
  SUCCESS_REPORT_HANDOFF_FAILED SUCCESS_TERMINAL_HANDOFF_FAILED; do
  require_fixed "$PROBE" "$evidence"
done
pass failure_handoff_tail_contracts

require_fixed "$DIAGNOSTICS" 'ISOLATED_PROBE_FAILED'
require_fixed "$PROBE" 'DIAGNOSTICS_LOADED=true'
require_fixed "$DIAGNOSTICS" 'personal_max_stage8b1i_cleanup_primary_temp'
diagnostics_source_line=$(grep -n 'source "$PACKAGE_ROOT/failure-diagnostics.sh"' "$PROBE" | cut -d: -f1)
bounded_source_line=$(grep -n 'source "$PACKAGE_ROOT/bounded-operations.sh"' "$PROBE" | cut -d: -f1)
[[ $diagnostics_source_line -lt $bounded_source_line ]]
pass no_silent_failure
require_fixed "$PROBE" 'chgrp codexbot "$TMP_REPORT"'
require_fixed "$PROBE" 'chmod 0640 "$TMP_REPORT"'
require_fixed "$PROBE" 'mv --no-clobber --no-target-directory'
pass report_permission_contract
for evidence in containerIdsHash serviceStatesHash restartCountsHash volumeInventoryHash networkInventoryHash productionGitHash migrationLedger; do require_fixed "$PROBE" "$evidence"; done
require_fixed "$PROBE" "jq -S 'del(.freeBytes)'"
pass production_immutability_contract
require_fixed "$PROBE" "readonly ACCEPTED_PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'"
require_fixed "$PROBE" "readonly ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'"
require_fixed "$PROBE" 'hash_raw_command git_status_hash filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED'
require_fixed "$PROBE" 'git -C /opt/crm status --porcelain=v2 --untracked-files=all'
require_fixed "$PROBE" 'pm_assert_production_git_baseline "$git_head" "$git_status_hash"'
require_fixed "$PROBE" 'productionStatusV2RawSha256:$productionStatusV2RawSha256'
refuse_pattern "$PROBE" 'hash_sorted_text[[:space:]]+git_status_hash'
snapshot_line=$(grep -nF 'production_snapshot "$TMP/production-before.json"' "$PROBE" | cut -d: -f1)
image_acquisition_line=$(grep -nF 'pm_enter_phase image_acquisition docker_pull' "$PROBE" | head -n1 | cut -d: -f1)
[[ $snapshot_line -lt $image_acquisition_line ]]
pass accepted_production_git_pre_gate

jq -e '.schemaVersion==1 and .incident=="RESTORE_LEDGER_NAMES_CHECK" and
  .failedAttempt.failureReportSha256=="9197be647171a35553189a0526a2d6e205442f15965f5ce0ae1c8a1934bd73bd" and
  .observedIntegrity.ledgerNameCount==46 and .observedIntegrity.ledgerUniqueCount==46 and
  .observedIntegrity.ledgerDuplicateCount==0 and .observedIntegrity.ledgerUnsafeNameCount==0 and
  .observedIntegrity.acceptedHistoricalNames==["0_init"] and
  .observedIntegrity.repositoryToLedgerCount==8 and .observedIntegrity.ledgerToRepositoryCount==1 and
  .acceptedEvidence.productionLedgerAttestationSha256=="3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3" and
  .repair.preparedScriptSha256=="2474859594be528910bd29c960ba2c37fe08d5f6bcccec67f596138d1bc3d3e0" and
  .repair.rootProbeRerun==false and .safety.productionMutationNow==false' \
  "$SCRIPT_DIR/ledger-failure-forensic.json" >/dev/null
jq -e '.schemaVersion==2 and .incident=="POSTGRES_OUTPUT_PARAMETER_DYNAMIC_SCOPE_COLLISION" and
  .failedAttempt.failureReportSha256=="48567af33cd50d6e8a5d996971b015ab98b753a32ab6811c9db6ff8fdfcd9bef" and
  .failedAttempt.sourceLine==563 and .failedAttempt.exitCode==65 and
  .failedAttempt.classification=="POSTGRES_VERSION_OUTPUT_MALFORMED" and
  .failedAttempt.checkId=="POSTGRES_SERVER_VERSION_MATCH_CHECK" and
  .failedAttempt.queryLastExit==0 and .failedAttempt.versionOutputCategory=="MALFORMED" and
  .sourceProof.callerLocal=="pm_result_postgres_version" and
  .sourceProof.childLocal=="pm_result_postgres_version" and
  .sourceProof.realChildCommandCapturedValue=="NOT_RECORDED_IN_SANITIZED_REPORT" and
  .sourceProof.minimalFixtureChildCapturedValue=="160014" and
  .sourceProof.callerObservedValue=="empty" and
  .sourceProof.exactCause=="CHILD_LOCAL_SHADOWED_CALLER_OUTPUT_TARGET" and
  .executableProof.classification=="DYNAMIC_SCOPE_COLLISION_PROVEN" and
  .systematicRepair.preparedScriptSha256=="2c54907799dabee4c92eca40ebfd8176a8b8f4f61c70ed65f38a542cd0ea4b6e" and
  .systematicRepair.functionsAudited==25 and .systematicRepair.remainingKnownCollisions==0 and
  .systematicRepair.outputTargetRegressionScenarios==30 and
  .systematicRepair.rootProbeRerun==false and .safety.dockerExecutionNow==false and
  .safety.productionDatabaseConnectedNow==false' \
  "$SCRIPT_DIR/postgres-startup-forensic.json" >/dev/null
jq -e '.schemaVersion==2 and .incident.dynamicScopeCollisionProven==true and
  .invariant.publicReservedPrefixRejected=="__pm_" and
  .invariant.helperInternalPrefix=="__pm_" and .invariant.evalAllowed==false and
  (.functions|length)==25 and .summary.confirmedCollisions==1 and
  .summary.latentCollisionCapableFunctions==3 and .summary.remainingKnownCollisions==0 and
  .summary.staticAudit=="PASS" and .summary.executableMatrix=="30/30 PASS" and
  .summary.preparedScriptSha256=="2c54907799dabee4c92eca40ebfd8176a8b8f4f61c70ed65f38a542cd0ea4b6e" and
  .verdict=="OUTPUT_PARAMETER_COLLISIONS_SYSTEMATICALLY_ELIMINATED"' \
  "$SCRIPT_DIR/out-parameter-audit.json" >/dev/null
jq -e '.schemaVersion==1 and .incident=="MIGRATION_PREFLIGHT_RUNTIME_MOUNT_PERMISSION_MISMATCH" and
  .evidenceClassification=="EXACT_MIGRATION_PREFLIGHT_DEFECT_PROVEN" and
  .failedAttempt.failureReportSha256=="20ed0d543ef36aaa97518968118cc0b7befa5a49ab764f99a76c82ed7107151c" and
  .failedAttempt.sourceLine==626 and .failedAttempt.phaseOccurrence==2 and .failedAttempt.exitCode==2 and
  .sourceMapping.substep=="exact-eight migration SQL binding scan" and
  .sourceMapping.operationsNotReached==["shadow database creation","Prisma migrate deploy","post-migration verification"] and
  .exactCauseProof.packageOwnerUid==998 and .exactCauseProof.acceptedGatewayRuntimeUid==1000 and
  .exactCauseProof.runtimeReadPermission==false and .exactCauseProof.unreadablePosixShellFixtureExit==2 and
  .exactCauseProof.migrationSqlContentsChanged==false and
  .systematicRepair.runtimeCopyMode=="0444" and .systematicRepair.primaryClassificationPreserved==true and
  .systematicRepair.checkIdNoneAfterSubstepEntry==false and .systematicRepair.regressionScenarioCount==26 and
  .systematicRepair.preparedScriptSha256=="1772cc2b99934c7c81c4832c29d60abfecbc21d1f3b250bcd437d77a377d22ed" and
  .systematicRepair.rootProbeRerun==false and .productionSafety.dockerExecutedNow==false and
  .productionSafety.productionDatabaseConnections==0' \
  "$SCRIPT_DIR/migration-preflight-forensic.json" >/dev/null
jq -e '.schemaVersion==1 and .incident=="POSTGRES_NETWORK_ALIAS_VALIDATION_FAILURE" and
  .evidenceClassification=="POSTGRES_NETWORK_ALIAS_EVIDENCE_INSUFFICIENT" and
  .failedAttempt.failureReportSha256=="b53706d5e89786cb572c8389d25cfa80a883c3d57fd40b9c083804ceff1f7524" and
  .failedAttempt.sourceLine==264 and .failedAttempt.checkId=="MIGRATION_POSTGRES_ALIAS_CHECK" and
  .failedAttempt.exitCode==65 and .failedAttempt.substep=="postgres_alias_validation" and
  .missingEvidence.observedNetworkCount=="NOT_RECORDED" and
  .missingEvidence.aliasArrayState=="NOT_RECORDED" and .missingEvidence.speculationUsed==false and
  .executionBoundary.exactEightSqlGateCompleted==true and
  .executionBoundary.shadowDatabaseCreationReached==false and
  .executionBoundary.prismaMigrateDeployReached==false and
  .systematicRepair.explicitNetworkAlias==true and .systematicRepair.structuredJsonValidation==true and
  .systematicRepair.regressionScenarioCount==28 and
  .systematicRepair.preparedScriptSha256=="6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3" and
  .systematicRepair.rootProbeRerun==false and .productionSafety.dockerExecutedNow==false and
  .productionSafety.productionDatabaseConnections==0' \
  "$SCRIPT_DIR/postgres-network-alias-forensic.json" >/dev/null

jq -e '.schemaVersion==1 and .stage=="8B1I" and .mode=="PREPARED_NOT_EXECUTED" and
  .rootProbe.executed==false and
  .rootProbe.sha256=="b3621e3f335c96015009f22f0bb640c190f99199db73445c526d980058eed0b2" and
  .rootProbe.runtimeArtifactBindingCount==12 and .rootProbe.runtimeArtifactChecksBeforeFirstUse==true and
  .rootProbe.sha256sumsRole=="complete_package_ledger_not_trust_anchor" and
  .rootProbe.pairedHelperAndLedgerSubstitutionRefused==true and
  (.runtimeArtifactBindings|length)==12 and
  .runtimeArtifactBindings["probe-output-helpers.sh"]=="64f4a885a1f109130059f9466712d5b9088cfe9154ad580903694b17403eeed7" and
  .runtimeArtifactBindings["failure-diagnostics.sh"]=="7d0704f522236c999ef185418633b049f0d39444e3df6aae76bc8a6a359cba8c" and
  .runtimeArtifactBindings["bounded-operations.sh"]=="bc02fe1cb9c3ce04f4a259cc288c120356e7085c7b2a99cc3efbcfd8ad9cd00b" and
  (.runtimeArtifactBindings|has("residual-cleanup.sh")|not) and
  .runtimeArtifactBindings["restore-verification.sh"]=="996721573f9b243598c2380497e44a8aafd2800330500256ddc53c2ef6779547" and
  .runtimeArtifactBindings["postgres-startup.sh"]=="54276af4a969b0003c907e249e1fdef04d2b8da6c101cc898aecc6d5685b56e3" and
  .runtimeArtifactBindings["migration-preflight.sh"]=="71ac68dde88da402179fce82f970b4820b7b696a98886a9135fb410d54d89735" and
  .runtimeArtifactBindings["prisma-legacy-diff-gate.sh"]=="d9867613380ffdba7af070e916ea782721810fe4268bf1c064b59a5de2cb27b0" and
  .runtimeArtifactBindings["prisma-diff-semantic-parser.py"]=="87024a3151d183292b1c94cd5c681470bd023eda4b57fc56cce255747edf4890" and
  .support.migrationVerificationTests.scenarioCount==14 and
  .support.failureHandoffTests.scenarioCount==29 and
  .support.scraperDefaultOffTests.scenarioCount==30 and
  .support.scraperDefaultOffTests.actualHarnessExecuted==true and
  .support.scraperDefaultOffTests.actualTransportInterceptorExecuted==true and
  .support.remainingTailTests.scenarioCount==29 and
  .support.remainingTailTests.requiredRegressionCasesCovered==19 and
  .support.nonRootTests.contractCount==77 and
  .support.nonRootTests.expectedPassCountWithoutShellcheck==76 and
  .support.prismaDiffSemanticTests.scenarioCount==36 and
  .support.prismaDiffSemanticTests.realGateExecuted==true and
  .support.prismaParserFailureTests.scenarioCount==25 and
  .support.prismaParserFailureTests.realisticPrismaFixtures==true and
  .restoreVerification.failureReportSha256=="c2cf0e2cb2e19e3f59d791c03af02163fe5571ffab7c993749b39a026948d2de" and
  .restoreVerification.exactCause=="PRISMA_USER_MODEL_MAPPED_TO_USERS" and
  .ledgerVerificationRepair.failureReportSha256=="9197be647171a35553189a0526a2d6e205442f15965f5ce0ae1c8a1934bd73bd" and
  .ledgerVerificationRepair.exactFailedCheck=="RESTORE_LEDGER_NAMES_CHECK" and
  .ledgerVerificationRepair.exactCause=="STRICT_MODERN_NAME_REGEX_APPLIED_TO_SAFE_HISTORICAL_LEDGER" and
  .ledgerVerificationRepair.ledgerNameCount==46 and .ledgerVerificationRepair.ledgerUniqueCount==46 and
  .ledgerVerificationRepair.ledgerDuplicateCount==0 and .ledgerVerificationRepair.ledgerUnsafeNameCount==0 and
  .ledgerVerificationRepair.acceptedHistoricalNames==["0_init"] and
  .ledgerVerificationRepair.productionLedgerAttestationSha256=="3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3" and
  .ledgerVerificationRepair.canonicalSortedLedgerNamesSha256=="d879288b3d8f4d38c1de8565987c231db32ddb322c20a6329519028d8b5a8114" and
  .ledgerVerificationRepair.repositoryToLedgerCount==8 and .ledgerVerificationRepair.ledgerToRepositoryCount==1 and
  .ledgerVerificationRepair.rootProbeRerun==false and
  .postgresVersionRepair.failureReportSha256=="b56ec34bd82255f603e0c34978eac07f386c94308aba191dd55a8cfb2a0376a5" and
  .postgresVersionRepair.sourceLine==562 and .postgresVersionRepair.exitCode==67 and
  .postgresVersionRepair.exactFirstFailedOperation=="DISPLAY_VERSION_EXACT_MATCH" and
  .postgresVersionRepair.containerStartReturnedSuccess==true and
  .postgresVersionRepair.containerState=="running" and
  .postgresVersionRepair.observedHumanReadableCategory=="FORMAT_VARIANT_NOT_RECORDED" and
  .postgresVersionRepair.observedDisplaySubtype=="INSUFFICIENT_EVIDENCE" and
  .postgresVersionRepair.expectedVersionNum==160014 and
  .postgresVersionRepair.exactCause=="FRAGILE_HUMAN_READABLE_SERVER_VERSION_EQUALITY" and
  .postgresVersionRepair.authoritativeVersionSource=="SHOW server_version_num" and
  .postgresVersionRepair.preparedScriptSha256=="55e730aa6db59637e51c3b171af802e0d95e6ae6688a2481e450a5b72cb18597" and
  .postgresVersionRepair.regressionScenarioCount==33 and
  .postgresVersionRepair.rootProbeRerun==false and
  .outputParameterCollisionRepair.failureReportSha256=="48567af33cd50d6e8a5d996971b015ab98b753a32ab6811c9db6ff8fdfcd9bef" and
  .outputParameterCollisionRepair.sourceLine==563 and .outputParameterCollisionRepair.queryLastExit==0 and
  .outputParameterCollisionRepair.reportedClassification=="POSTGRES_VERSION_OUTPUT_MALFORMED" and
  .outputParameterCollisionRepair.callerObservedValue=="empty" and
  .outputParameterCollisionRepair.realCapturedValue=="NOT_RECORDED_IN_SANITIZED_REPORT" and
  .outputParameterCollisionRepair.minimalFixtureCapturedValue=="160014" and
  .outputParameterCollisionRepair.exactCause=="CHILD_LOCAL_SHADOWED_CALLER_OUTPUT_TARGET" and
  .outputParameterCollisionRepair.dynamicScopeCollisionProven==true and
  .outputParameterCollisionRepair.functionsAudited==25 and
  .outputParameterCollisionRepair.remainingKnownCollisions==0 and
  .outputParameterCollisionRepair.preparedScriptSha256=="2c54907799dabee4c92eca40ebfd8176a8b8f4f61c70ed65f38a542cd0ea4b6e" and
  .outputParameterCollisionRepair.regressionScenarioCount==30 and
  .outputParameterCollisionRepair.staticSourceAudit=="PASS" and
  .outputParameterCollisionRepair.postgresStartupScenarioCount==34 and
  .outputParameterCollisionRepair.rootProbeRerun==false and
  .migrationPreflightEvidenceRepair.failureReportSha256=="20ed0d543ef36aaa97518968118cc0b7befa5a49ab764f99a76c82ed7107151c" and
  .migrationPreflightEvidenceRepair.evidenceClassification=="EXACT_MIGRATION_PREFLIGHT_DEFECT_PROVEN" and
  .migrationPreflightEvidenceRepair.sourceLine==626 and .migrationPreflightEvidenceRepair.phaseOccurrence==2 and
  .migrationPreflightEvidenceRepair.originalExitCode==2 and
  .migrationPreflightEvidenceRepair.reportedClassification=="DISPOSABLE_DOCKER_FAILED" and
  .migrationPreflightEvidenceRepair.reportedCheckId=="NONE" and
  .migrationPreflightEvidenceRepair.exactCause=="ROOT_LAUNCHED_DOCKER_BIND_MOUNT_PRESERVED_0600_PACKAGE_FILE_MODE_UNREADABLE_TO_GATEWAY_UID_1000" and
  .migrationPreflightEvidenceRepair.runtimeCopyMode=="0444" and
  .migrationPreflightEvidenceRepair.runtimeReadabilityValidated==true and
  .migrationPreflightEvidenceRepair.exactEightMigrationListPreserved==true and
  .migrationPreflightEvidenceRepair.distinctCheckIdCount==18 and
  .migrationPreflightEvidenceRepair.genericClassificationOverwritePrevented==true and
  .migrationPreflightEvidenceRepair.regressionScenarioCount==26 and
  .migrationPreflightEvidenceRepair.preparedScriptSha256=="1772cc2b99934c7c81c4832c29d60abfecbc21d1f3b250bcd437d77a377d22ed" and
  .migrationPreflightEvidenceRepair.rootProbeRerun==false and
  .postgresNetworkAliasRepair.failureReportSha256=="b53706d5e89786cb572c8389d25cfa80a883c3d57fd40b9c083804ceff1f7524" and
  .postgresNetworkAliasRepair.evidenceClassification=="POSTGRES_NETWORK_ALIAS_EVIDENCE_INSUFFICIENT" and
  .postgresNetworkAliasRepair.sourceLine==264 and .postgresNetworkAliasRepair.originalExitCode==65 and
  .postgresNetworkAliasRepair.reportedCheckId=="MIGRATION_POSTGRES_ALIAS_CHECK" and
  .postgresNetworkAliasRepair.explicitAliasConfigured==true and
  .postgresNetworkAliasRepair.databaseUrlHostBound==true and
  .postgresNetworkAliasRepair.shadowDatabaseUrlHostBound==true and
  .postgresNetworkAliasRepair.structuredValidation==true and
  .postgresNetworkAliasRepair.regressionScenarioCount==28 and
  .postgresNetworkAliasRepair.preparedScriptSha256=="6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3" and
  .postgresNetworkAliasRepair.rootProbeRerun==false and
  .migrationValidation.exactSqlBindingCount==8 and
  .migrationValidation.prismaDiffEmpty==false and
  .migrationVerificationHandoffRepair.migrationEvidenceClassification=="PRISMA_DIFF_GATE_REJECTION_PROVEN" and
  .migrationVerificationHandoffRepair.underlyingFailedRunDiffClassification=="PRISMA_DIFF_UNDERLYING_EVIDENCE_INSUFFICIENT" and
  .migrationVerificationHandoffRepair.priorResidualCleanupIncludedInNextProbe==false and
  .prismaDiffSemanticRepair.expectedSemanticMode=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and
  .prismaDiffSemanticRepair.semanticScenarioCount==36 and
  .prismaDiffSemanticRepair.historicalResidualCleanupInvoked==false and
  .prismaDiffSemanticRepair.unrelatedFailureReportCleanupBindingRemoved==true and
  .realPrismaDiffParseRepair.evidenceClassification=="B" and
  .realPrismaDiffParseRepair.exactCauseProven==false and
  .realPrismaDiffParseRepair.failureReportSha256=="92b2e8bac1a540824b595fcc6b1ad9714524ebfaf77d8f4a08511a551d6fd020" and
  .realPrismaDiffParseRepair.previousScriptSha256=="089a6a2e433ab7ffcfa5eeff5ac04f3499b67d749158e72efd1c697d6161a580" and
  .realPrismaDiffParseRepair.preparedScriptSha256=="e36ad6b2436dd827e33c8a996e22ebbd40e45ffb5e1cc1430f75195d9f9f791f" and
  .realPrismaDiffParseRepair.parserFailureScenarioCount==25 and
  .scraperDefaultOffRepair.failureReportSha256=="93d75f31f61bed37e7bcfb9cc8164007fc46732c536643d11c6bebcbc9bf6598" and
  .scraperDefaultOffRepair.evidenceClassification=="A" and
  .scraperDefaultOffRepair.evidenceClassificationName=="SCRAPER_DEFAULT_OFF_MODE_BINDING_DEFECT_PROVEN" and
  .scraperDefaultOffRepair.implicitSelectedMode=="capture-and-drain" and
  .scraperDefaultOffRepair.requiredSelectedMode=="default-off" and
  .scraperDefaultOffRepair.executableOldHarnessReplayExitCode==1 and
  .scraperDefaultOffRepair.explicitModeBinding==true and
  .scraperDefaultOffRepair.implicitModeFallbackRemoved==true and
  .scraperDefaultOffRepair.allHarnessInvocationsExplicit==true and
  .scraperDefaultOffRepair.defaultOffRegressionScenarioCount==30 and
  .scraperDefaultOffRepair.remainingTailScenarioCount==29 and
  .scraperDefaultOffRepair.newScriptSha256=="b3621e3f335c96015009f22f0bb640c190f99199db73445c526d980058eed0b2" and
  .scraperDefaultOffRepair.rootProbeRerun==false and
  .migrationValidation.prismaDiffStatus=="MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT" and
  .migrationValidation.prismaDiffExpectedSemanticMode=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and
  .migrationValidation.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"] and
  .safety.stage8B2Started==false' "$SCRIPT_DIR/MANIFEST.json" >/dev/null
pass manifest_validation
(cd "$SCRIPT_DIR" && sha256sum -c SHA256SUMS >/dev/null)
pass sha256sums_validation
if rg -n --hidden --glob '!SHA256SUMS' '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})' "$SCRIPT_DIR" >/dev/null; then exit 1; fi
pass secret_scan
refuse_pattern "$PROBE" '(docker[[:space:]]+(rm|stop|restart|kill)[[:space:]]+[^\n]*(crm-|com\.docker\.compose\.project)|git[[:space:]]+-C[[:space:]]+/opt/crm[[:space:]]+(checkout|reset|clean|commit)|/opt/crm/[^ ]*[[:space:]]*(>|>>))'
pass protected_path_scan
git -C "$SCRIPT_DIR/../.." diff --check
if rg -n '[[:blank:]]+$' "$SCRIPT_DIR" >/dev/null; then exit 1; fi
pass git_diff_check
(cd "$ARCHITECTURE" && sha256sum -c SHA256SUMS >/dev/null)
pass architecture_checksum

if (( PACKAGE_SKIP_COUNT == 0 )); then
  [[ $PACKAGE_PASS_COUNT -eq 77 ]]
else
  [[ $PACKAGE_SKIP_COUNT -eq 1 && $PACKAGE_PASS_COUNT -eq 76 ]]
fi

printf 'ROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\nPACKAGE_TEST_COUNT=%s\nPACKAGE_TEST_SKIPPED=%s\nFAULT_SCENARIO_COUNT=20\nOUTPUT_HANDOFF_TEST_COUNT=36\nOUTPUT_TARGET_COLLISION_TEST_COUNT=30\nRESTORE_REGRESSION_TEST_COUNT=25\nLEDGER_REGRESSION_TEST_COUNT=22\nPOSTGRES_STARTUP_TEST_COUNT=34\nMIGRATION_PREFLIGHT_TEST_COUNT=26\nPOSTGRES_NETWORK_ALIAS_TEST_COUNT=28\nMIGRATION_VERIFICATION_TEST_COUNT=14\nFAILURE_HANDOFF_TEST_COUNT=29\nSCRAPER_DEFAULT_OFF_TEST_COUNT=30\nREMAINING_TAIL_TEST_COUNT=29\nPRISMA_DIFF_SEMANTIC_TEST_COUNT=36\nPRISMA_PARSER_FAILURE_TEST_COUNT=25\nREQUIRED_REGRESSION_CASE_COUNT=88\n' \
  "$PACKAGE_PASS_COUNT" "$PACKAGE_SKIP_COUNT"
