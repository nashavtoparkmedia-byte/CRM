#!/usr/bin/env bash
# Non-root fault matrix. It does not invoke Docker or the isolated root probe.
# shellcheck disable=SC2034
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"

TMP_FAULT=$(mktemp -d /tmp/personal-max-stage8b1i-faults.XXXXXX)
trap 'rm -rf -- "$TMP_FAULT"' EXIT
readonly FAILURE_PATH='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'
readonly PRODUCTION_SENTINEL='production-scope-unchanged'
FAULT_COUNT=0

make_valid_report() {
  jq -n '{
    schemaVersion:1,mode:"ISOLATED_RELEASE_PROOF",
    script:{sha256:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",checksumBound:true},
    bindings:{backupReportSha256:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      dumpSha256:"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",dumpBytes:45284314},
    restore:{FULL_RESTORE_PROOF:"PASS",objectCount:581,
      requiredRelations:["_prisma_migrations","users","Contact","Chat"],
      ledgerNameCount:46,ledgerUniqueCount:46,ledgerDuplicateCount:0,
      ledgerInvalidFormatCount:1,ledgerUnsafeNameCount:0,
      ledgerNamesSha256:"d879288b3d8f4d38c1de8565987c231db32ddb322c20a6329519028d8b5a8114",
      ledgerAttestationSha256:"3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3",
      ledgerNamingClassification:"RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED",
      acceptedHistoricalNames:["0_init"],repositoryToLedgerCount:8,ledgerToRepositoryCount:1,
      representativeCounts:{user:{physicalRelation:"users",available:true}}},
    migration:{DISPOSABLE_MIGRATION_PROOF:"PASS",beforeFinished:46,afterFinished:54,failed:0,prismaDiffEmpty:false,
      prismaDiffStatus:"ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS",
      acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"],
      appliedNames:["20260726162043_add_max_raw_transport_journal","20260726190658_add_max_route_registry",
        "20260726205437_add_max_inbound_normalization","20260726215715_add_max_per_chat_outbound_actor",
        "20260726225737_add_max_dispatch_ledger","20260727053744_add_max_provider_confirmation_matcher",
        "20260727141925_add_max_shadow_semantic_comparison","20260727154647_add_max_capture_ingress"]},
    images:{gateway:{ref:"ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de",
        digestVerified:true,runtimeUser:"1000:1000",preexistingBeforePull:false},
      scraper:{ref:"ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768",
        digestVerified:true,runtimeUser:"1001:1001",preexistingBeforePull:false},
      postgresql:{ref:"sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
        digestVerified:true,version:"16.14"},retained:true},
    e2e:{frames:1000,identicalFrames:100,captureLoss:0,accidentalDuplicateRawRows:0,wrongAccount:0,criticalSemanticRegressions:0},
    cleanup:{containersRemaining:0,networksRemaining:0,volumesRemaining:0,tempFilesRemaining:0},
    productionImmutability:{
      before:{productionHead:"e6a0a833fbb756216b058bfe326f9f9c77c4cc6d",
        productionStatusV2RawSha256:"2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b",
        acceptedProductionGitBaseline:true},
      after:{productionHead:"e6a0a833fbb756216b058bfe326f9f9c77c4cc6d",
        productionStatusV2RawSha256:"2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b",
        acceptedProductionGitBaseline:true},
      unchanged:true,productionDatabaseConnections:0,
      productionMigrationLedgerSource:"accepted_preflight_attestation"},
    storage:{freeBytesBeforePull:22000000000,freeBytesAfterPull:19000000000,freeBytesAfterCleanup:18000000000},
    safety:{productionDDL:false,productionDML:false,productionMigration:false,restart:false,deploy:false,
      browserLaunched:false,maxContacted:false,providerAction:false,productionNetworkAttached:false,
      productionVolumeMounted:false,profileMounted:false}}
  ' >"$1"
}

fault_timeout() {
  local classification=$1
  pm_run_bounded mock 1 "$classification" UNEXPECTED_COMMAND_FAILURE sh -c 'exit 124'
}

fault_auth_denied() {
  printf 'unauthorized\n' >"$TMP_FAULT/registry.stderr"
  pm_classify_registry_failure "$TMP_FAULT/registry.stderr"
  return 77
}

poll_never_ready() { return 1; }
fault_polling() { pm_poll_until 2 1 POLLING_DEADLINE_EXCEEDED poll_never_ready; }
fault_cleanup_deadline() { pm_deadline_remaining "$((SECONDS - 1))" >/dev/null; }
fault_post_pull_disk() { pm_check_disk_gate 14672240239 14672240240 POST_PULL_DISK_GATE_FAILED; }
fault_final_disk() { pm_check_disk_gate 12499999999 12500000000 FINAL_DISK_GATE_FAILED; }
fault_malformed_report() { printf '{bad json\n' >"$TMP_FAULT/report.json"; pm_validate_success_report "$TMP_FAULT/report.json"; }
fault_unsafe_report() {
  make_valid_report "$TMP_FAULT/report.json"
  jq '.safety.deploy=true' "$TMP_FAULT/report.json" >"$TMP_FAULT/unsafe.json"
  pm_validate_success_report "$TMP_FAULT/unsafe.json"
}
fault_cleanup_incomplete() { pm_assert_cleanup_zero 1 0 0 0; }
fault_original_exit() {
  local preserved
  PROBE_ERROR_CLASSIFICATION=CLEANUP_INCOMPLETE
  preserved=$(pm_preserve_original_exit 42 70)
  [[ $preserved == 42 ]]
  return "$preserved"
}

run_fault() {
  local name=$1 phase=$2 expected=$3 status output before after
  shift 3
  PROBE_PHASE=$phase
  PROBE_SAFE_COMMAND_CLASS=mock
  PROBE_ERROR_CLASSIFICATION=NONE
  output="$TMP_FAULT/$name.output"
  before=$PRODUCTION_SENTINEL
  set +e
  "$@" >"$output" 2>&1
  status=$?
  set -e
  after=$PRODUCTION_SENTINEL
  (( status != 0 ))
  pm_phase_is_safe "$PROBE_PHASE"
  pm_error_classification_is_safe "$PROBE_ERROR_CLASSIFICATION"
  [[ $PROBE_ERROR_CLASSIFICATION == "$expected" ]]
  [[ $FAILURE_PATH =~ ^/var/tmp/personal-max-stage8b1i-isolated-release-proof\.failure\.[0-9a-f]{64}\.json$ ]]
  ! grep -Eiq '(password|database_url|hmac|token|secret|private key|postgresql://)' "$output"
  [[ $before == "$after" ]]
  FAULT_COUNT=$((FAULT_COUNT + 1))
  printf '%s=PASS\n' "$name"
}

run_fault gateway_pull_timeout image_acquisition GATEWAY_PULL_TIMEOUT fault_timeout GATEWAY_PULL_TIMEOUT
run_fault scraper_pull_timeout image_acquisition SCRAPER_PULL_TIMEOUT fault_timeout SCRAPER_PULL_TIMEOUT
run_fault registry_access_denied image_acquisition REGISTRY_AUTHENTICATION_DENIED fault_auth_denied
run_fault restore_list_timeout backup_restore RESTORE_LIST_TIMEOUT fault_timeout RESTORE_LIST_TIMEOUT
run_fault full_restore_timeout backup_restore FULL_RESTORE_TIMEOUT fault_timeout FULL_RESTORE_TIMEOUT
run_fault migrate_deploy_timeout disposable_migration MIGRATE_DEPLOY_TIMEOUT fault_timeout MIGRATE_DEPLOY_TIMEOUT
run_fault prisma_diff_timeout migration_verification PRISMA_DIFF_TIMEOUT fault_timeout PRISMA_DIFF_TIMEOUT
run_fault gateway_startup_timeout gateway_active GATEWAY_STARTUP_TIMEOUT fault_timeout GATEWAY_STARTUP_TIMEOUT
run_fault synthetic_harness_timeout e2e_recovery SYNTHETIC_HARNESS_TIMEOUT fault_timeout SYNTHETIC_HARNESS_TIMEOUT
run_fault polling_deadline e2e_verification POLLING_DEADLINE_EXCEEDED fault_polling
run_fault container_removal_timeout cleanup CONTAINER_REMOVAL_TIMEOUT fault_timeout CONTAINER_REMOVAL_TIMEOUT
run_fault network_removal_timeout cleanup NETWORK_REMOVAL_TIMEOUT fault_timeout NETWORK_REMOVAL_TIMEOUT
run_fault volume_removal_timeout cleanup VOLUME_REMOVAL_TIMEOUT fault_timeout VOLUME_REMOVAL_TIMEOUT
run_fault cleanup_global_deadline cleanup CLEANUP_GLOBAL_DEADLINE_EXCEEDED fault_cleanup_deadline
run_fault post_pull_disk_gate post_pull_storage_gate POST_PULL_DISK_GATE_FAILED fault_post_pull_disk
run_fault final_disk_gate final_storage_gate FINAL_DISK_GATE_FAILED fault_final_disk
run_fault malformed_success_report report_validation SUCCESS_REPORT_MALFORMED fault_malformed_report
run_fault unsafe_success_report report_validation SUCCESS_REPORT_SAFETY_VIOLATION fault_unsafe_report
run_fault cleanup_incomplete cleanup CLEANUP_INCOMPLETE fault_cleanup_incomplete
run_fault original_exit_preserved cleanup CLEANUP_INCOMPLETE fault_original_exit

[[ $FAULT_COUNT -eq 20 ]]
ERR_TRAP_COUNT=0
PROBE_ERROR_CLASSIFICATION=NONE
trap 'ERR_TRAP_COUNT=$((ERR_TRAP_COUNT + 1))' ERR
set +e
pm_run_bounded mock 1 GATEWAY_PULL_TIMEOUT UNEXPECTED_COMMAND_FAILURE sh -c 'exit 124'
err_boundary_status=$?
set -e
trap - ERR
[[ $err_boundary_status -eq 124 && $ERR_TRAP_COUNT -eq 1 && $PROBE_ERROR_CLASSIFICATION == GATEWAY_PULL_TIMEOUT ]]
printf 'FAULT_TEST_COUNT=20\nERR_TRAP_BOUNDARY=VERIFIED\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\n'
