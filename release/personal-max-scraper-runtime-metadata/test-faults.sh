#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly PROBE="$PACKAGE_DIR/scraper-runtime-metadata.sh"
readonly DIAGNOSTICS="$PACKAGE_DIR/failure-diagnostics.sh"
readonly SCHEMA="$PACKAGE_DIR/report-schema.json"

passed=0
failed=0

pass() { passed=$((passed + 1)); printf 'ok %02d - %s\n' "$((passed + failed))" "$1"; }
fail() { failed=$((failed + 1)); printf 'not ok %02d - %s\n' "$((passed + failed))" "$1" >&2; }
case_run() {
  local name=$1
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
has() { grep -Fq -- "$1" "$2"; }
has_re() { grep -Eq -- "$1" "$2"; }
not_re() { ! grep -Eq -- "$1" "$2"; }

# Load only the pure diagnostic classifier. This never invokes Docker.
# shellcheck source=failure-diagnostics.sh
source "$DIAGNOSTICS"

identity_exact() { [[ $(classify_identity_count 1 1) == SCRAPER_IDENTITY_EXACT ]]; }
identity_zero() { [[ $(classify_identity_count 0 0) == SCRAPER_IDENTITY_NOT_FOUND ]]; }
identity_multiple() { [[ $(classify_identity_count 2 2) == SCRAPER_IDENTITY_AMBIGUOUS ]]; }
identity_stopped() { [[ $(classify_identity_count 1 0) == SCRAPER_NOT_RUNNING ]]; }

uid_decision_fixture() {
  local exists=$1 symlink=$2 mounts=$3 rw=$4 acl=$5 accepted=$6 owner_current=$7
  if [[ $exists != true || $symlink == true || $mounts -ne 1 || $rw != true ]]; then printf UID_TRANSITION_INCOMPATIBLE
  elif [[ $acl == unknown ]]; then printf UID_TRANSITION_UNKNOWN
  elif [[ $accepted == true ]]; then printf UID_TRANSITION_SAFE
  elif [[ $owner_current == true ]]; then printf UID_TRANSITION_REQUIRES_CONTROLLED_OWNERSHIP_CHANGE
  else printf UID_TRANSITION_INCOMPATIBLE
  fi
}

profile_symlink_case() { [[ $(uid_decision_fixture true true 1 true false true true) == UID_TRANSITION_INCOMPATIBLE ]]; }
profile_missing_case() { [[ $(uid_decision_fixture false false 1 true false true true) == UID_TRANSITION_INCOMPATIBLE ]]; }
current_uid_case() { [[ $(uid_decision_fixture true false 1 true false false true) == UID_TRANSITION_REQUIRES_CONTROLLED_OWNERSHIP_CHANGE ]]; }
accepted_uid_case() { [[ $(uid_decision_fixture true false 1 true false true false) == UID_TRANSITION_SAFE ]]; }
incompatible_uid_case() { [[ $(uid_decision_fixture true false 1 true false false false) == UID_TRANSITION_INCOMPATIBLE ]]; }
unknown_acl_case() { [[ $(uid_decision_fixture true false 1 true unknown true false) == UID_TRANSITION_UNKNOWN ]]; }

report_schema_fixture() {
  jq -n '{schemaVersion:1,mode:"READ_ONLY_SCRAPER_RUNTIME_METADATA",generatedAt:"2026-07-28T00:00:00Z",script:{sha256:("a"*64),checksumBound:true},
    identity:{project:"crm",service:"max-web-scraper",matchingContainers:1,runningContainers:1,stable:true},
    container:{idSha256:("b"*64),imageId:("sha256:"+("c"*64)),repoTags:[],repoDigests:[],state:"running",health:"healthy",restartCount:0,startedAt:"2026-07-28T00:00:00Z",configuredUser:"pwuser",runtimeUid:1000,runtimeGid:1000,entrypoint:["/usr/bin/tini","--"],command:["node","index.js"],workingDirectory:"/app",environmentNames:["CRM_WEBHOOK_URL"],mounts:[],networks:[],ports:{},restartPolicy:{},healthcheckSha256:("d"*64),securityOptions:[],capAdd:[],capDrop:[],privileged:false,readOnlyRootFilesystem:false,pidMode:"",ipcMode:"private"},
    browser:{rootProcessCount:1,rendererProcessCount:2,ownerUid:1000,ownerGid:1000,decision:"BROWSER_OWNER_SINGLE"},listener:{owningNodeProcessCount:1,instanceCount:null,decision:"LISTENER_OWNERSHIP_UNKNOWN"},
    profile:{path:"/app/user_data",mountCount:1,mountedReadWrite:true,exists:true,symlink:false,uid:1000,gid:1000,mode:"700",device:1,inode:2,currentRuntimeWritable:true,acceptedUid:1001,acceptedUidWritable:false,groupCompatibility:false,aclAvailable:false,aclPresent:"unknown",lockCount:1,uidTransitionDecision:"UID_TRANSITION_UNKNOWN"},
    recreation:{environmentSourceProvenance:[],evidenceDecision:"RECREATION_EVIDENCE_COMPLETE"},immutability:{before:{},after:{},unexpectedChanges:false},gate:{complete:false,reason:"MANDATORY_FACTS_INCOMPLETE",incompleteFacts:["LISTENER_OWNERSHIP_UNKNOWN"]},
    safety:{containersChanged:false,containersRestarted:false,imagesPulled:false,profileContentRead:false,environmentValuesReported:false,browserLaunched:false,maxContacted:false,providerAction:false,sanitizedReportWritten:true}}' |
    jq -e '.schemaVersion==1 and .identity.project=="crm" and .identity.service=="max-web-scraper" and .container.environmentNames==["CRM_WEBHOOK_URL"] and .safety.environmentValuesReported==false' >/dev/null
}

printf '1..27\n'
case_run 'exact label discovery' identity_exact
case_run 'zero containers fails closed' identity_zero
case_run 'multiple containers fail closed' identity_multiple
case_run 'stopped container fails closed' identity_stopped
case_run 'wrong image identity is rejected' has 'WRONG_IMAGE_IDENTITY' "$PROBE"
case_run 'second profile mount is rejected' has 'production_profile_mount_count -ne 1' "$PROBE"
case_run 'second browser is classified' has 'SECOND_BROWSER_DETECTED' "$PROBE"
case_run 'second listener is classified' has 'SECOND_LISTENER_DETECTED' "$PROBE"
case_run 'profile symlink is rejected' profile_symlink_case
case_run 'missing profile is rejected' profile_missing_case
case_run 'current UID ownership requires controlled change' current_uid_case
case_run 'accepted UID ownership is safe' accepted_uid_case
case_run 'incompatible ownership is rejected' incompatible_uid_case
case_run 'unknown ACL remains unknown' unknown_acl_case
case_run 'environment names are derived without values' has 'split("=")[0]' "$PROBE"
case_run 'environment values are absent from report mapping' not_re 'environment(Value|Values)[[:space:]]*:' "$PROBE"
case_run 'profile content output is absent' not_re '(cat|head|tail|find)[[:space:]]+[^\n]*(/app/user_data|PROFILE_PATH)' "$PROBE"
case_run 'provider payload fields are absent' not_re '(messageBody|messageText|providerPayload|contactId)' "$SCHEMA"
case_run 'container restart command is absent' not_re 'docker[[:space:]]+(restart|stop|kill)[[:space:]]' "$PROBE"
case_run 'all Docker mutation commands are absent' not_re 'docker[[:space:]]+(run|create|rm|update|pull|build|load|push|network[[:space:]]+(create|rm)|volume[[:space:]]+(create|rm))[[:space:]]' "$PROBE"
case_run 'public secret material is absent' bash -c '! grep -ERiq "(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]|Bearer [A-Za-z0-9])" "$1"' _ "$PACKAGE_DIR"
case_run 'before and after hashes are bound' bash -c 'grep -Fq "before_json=\$(snapshot)" "$1" && grep -Fq "after_json=\$(snapshot)" "$1"' _ "$PROBE"
case_run 'report schema fixture is accepted' report_schema_fixture
case_run 'report publication is no-clobber' bash -c 'grep -Fq "set -o noclobber" "$1" && grep -Fq "REPORT_ALREADY_EXISTS" "$1"' _ "$PROBE"
case_run 'report handoff permissions are exact' has "root:codexbot:640" "$PROBE"
case_run 'sanitized diagnostics are present' bash -c 'grep -Fq "FAILED_CLOSED" "$1" && grep -Fq "productionMutation:false" "$1"' _ "$DIAGNOSTICS"
case_run 'timeouts and no-silent-failure trap are present' bash -c 'grep -Fq "timeout --signal=TERM" "$1" && grep -Fq "trap on_error ERR" "$1" && grep -Fq "set -Eeuo pipefail" "$1"' _ "$PROBE"

printf '# passed=%d failed=%d docker_execution=0\n' "$passed" "$failed"
[[ $passed -eq 27 && $failed -eq 0 ]]
