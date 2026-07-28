#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
passed=0

ok() { passed=$((passed + 1)); printf 'ok %02d - %s\n' "$passed" "$1"; }
check() { local name=$1; shift; "$@"; ok "$name"; }

printf '1..12\n'
check 'physical sender remains disabled' jq -e '.physicalSenderEnabled==false' "$PACKAGE_DIR/MANIFEST.json"
check 'production action remains absent' jq -e '.productionActionPerformed==false' "$PACKAGE_DIR/MANIFEST.json"
check 'authorized command list remains empty' jq -e '.authorizedProductionCommands==[]' "$PACKAGE_DIR/MANIFEST.json"
check 'future gateway image is not built' jq -e '.futureImages.gateway=="NOT_BUILT"' "$PACKAGE_DIR/MANIFEST.json"
check 'future scraper image is not built' jq -e '.futureImages.scraper=="NOT_BUILT"' "$PACKAGE_DIR/MANIFEST.json"
check 'metadata execution remains false' jq -e '.newPreparation.metadataProbeExecuted==false' "$PACKAGE_DIR/provenance.json"
check 'session migration execution remains false' jq -e '.newPreparation.sessionOwnerMigrationExecuted==false' "$PACKAGE_DIR/provenance.json"
check 'shadow migration execution remains false' jq -e '.newPreparation.shadowPlanMigrationExecuted==false' "$PACKAGE_DIR/provenance.json"
check 'sender runtime remains unwired' jq -e '.newPreparation.senderRuntimeWired==false' "$PACKAGE_DIR/provenance.json"
check 'all seventeen rollout stages are present' bash -c '[[ $(grep -Ec "^[0-9]+\\. " "$1") -eq 17 ]]' _ "$PACKAGE_DIR/staged-rollout-plan.md"
check 'UAT expects zero wrong-account and wrong-chat actions' bash -c 'grep -Fq "wrong-chat actions = 0" "$1" && grep -Fq "wrong-account actions = 0" "$2"' _ "$PACKAGE_DIR/uat-contact-a.md" "$PACKAGE_DIR/uat-contact-a-b.md"
check 'metadata command is not authorized' grep -Fq 'READY_NOT_AUTHORIZED' "$PACKAGE_DIR/metadata-root-command.md"

[[ $passed -eq 12 ]]
printf '%s\n' 'TEXT_CANARY_PREPARATION_FAULT_TESTS_PASSED production_execution=0'
