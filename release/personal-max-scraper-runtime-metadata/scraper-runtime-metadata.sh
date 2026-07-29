#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly PACKAGE_DIR='/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-scraper-runtime-metadata'
readonly RESULT_PATH='/var/tmp/personal-max-scraper-runtime-metadata.json'
readonly PROJECT_LABEL='com.docker.compose.project=crm'
readonly SERVICE_LABEL='com.docker.compose.service=max-web-scraper'
readonly PROJECT_NAME='crm'
readonly SERVICE_NAME='max-web-scraper'
readonly PROFILE_PATH='/app/user_data'
readonly ACCEPTED_UID='1001'
readonly ACCEPTED_GID='1001'
readonly EXPECTED_PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
readonly EXPECTED_PRODUCTION_STATUS_SHA='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'

phase=bootstrap
tmp_dir=''
published=false

fallback_failure() {
  printf '{"schemaVersion":1,"status":"FAILED_CLOSED","code":"%s","phase":"%s","exitCode":%s,"secretsPrinted":false,"productionMutation":false}\n' \
    "${1:-UNCLASSIFIED_FAILURE}" "${2:-unknown}" "${3:-1}" >&2
}

cleanup() {
  if [[ -n $tmp_dir && $tmp_dir == /var/tmp/personal-max-scraper-metadata.* && -d $tmp_dir && ! -L $tmp_dir ]]; then
    local owner mode
    owner=$(stat -c '%u:%g' "$tmp_dir" 2>/dev/null || true)
    mode=$(stat -c '%a' "$tmp_dir" 2>/dev/null || true)
    if [[ $owner == '0:0' && $mode == '700' ]]; then
      rm -rf -- "$tmp_dir"
    fi
  fi
}

on_error() {
  local code=$?
  trap - ERR
  if declare -F diagnostic_emit >/dev/null 2>&1; then
    diagnostic_emit UNEXPECTED_READ_ONLY_PROBE_FAILURE "$phase" "$code"
  else
    fallback_failure UNEXPECTED_READ_ONLY_PROBE_FAILURE "$phase" "$code"
  fi
  exit "$code"
}
trap cleanup EXIT
trap on_error ERR

fail() {
  local code=$1
  local exit_code=${2:-1}
  if declare -F diagnostic_emit >/dev/null 2>&1; then
    diagnostic_emit "$code" "$phase" "$exit_code"
  else
    fallback_failure "$code" "$phase" "$exit_code"
  fi
  exit "$exit_code"
}

run() {
  timeout --signal=TERM --kill-after=2 20 "$@"
}

hash_stream() {
  sha256sum | awk '{print $1}'
}

phase=authorization
[[ $EUID -eq 0 ]] || fail ROOT_REQUIRED
[[ $# -eq 1 && $1 =~ ^[0-9a-f]{64}$ ]] || fail EXPECTED_SCRIPT_SHA_REQUIRED
readonly EXPECTED_SCRIPT_SHA=$1
actual_script_sha=$(sha256sum "$PACKAGE_DIR/scraper-runtime-metadata.sh" | awk '{print $1}')
[[ $actual_script_sha == "$EXPECTED_SCRIPT_SHA" ]] || fail SCRIPT_CHECKSUM_MISMATCH
(
  cd "$PACKAGE_DIR"
  sha256sum --check --strict --quiet SHA256SUMS
) || fail PACKAGE_CHECKSUM_MISMATCH
# shellcheck source=failure-diagnostics.sh
source "$PACKAGE_DIR/failure-diagnostics.sh"

phase=preflight
for command_name in docker jq sha256sum timeout stat git df awk sort; do
  command -v "$command_name" >/dev/null 2>&1 || fail REQUIRED_TOOL_MISSING
done
[[ ! -e $RESULT_PATH ]] || fail REPORT_ALREADY_EXISTS
getent group codexbot >/dev/null 2>&1 || fail REPORT_GROUP_MISSING
tmp_dir=$(mktemp -d /var/tmp/personal-max-scraper-metadata.XXXXXX)
chmod 0700 "$tmp_dir"
[[ $(stat -c '%u:%g:%a' "$tmp_dir") == '0:0:700' ]] || fail PRIVATE_TEMP_DIRECTORY_INVALID

snapshot() {
  local production_ids container_hash state_hash restart_hash volume_hash network_hash head status_hash disk_json
  mapfile -t production_ids < <(run docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" | sort)
  container_hash=$(printf '%s\n' "${production_ids[@]}" | hash_stream)
  if ((${#production_ids[@]})); then
    state_hash=$(run docker inspect --format '{{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.State.StartedAt}}' "${production_ids[@]}" | sort | hash_stream)
    restart_hash=$(run docker inspect --format '{{.Id}}|{{.RestartCount}}' "${production_ids[@]}" | sort | hash_stream)
  else
    state_hash=$(printf '' | hash_stream)
    restart_hash=$(printf '' | hash_stream)
  fi
  volume_hash=$(run docker volume ls --filter "label=com.docker.compose.project=$PROJECT_NAME" --format '{{.Name}}|{{.Driver}}|{{.Scope}}' | sort | hash_stream)
  network_hash=$(run docker network ls --filter "label=com.docker.compose.project=$PROJECT_NAME" --format '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}' | sort | hash_stream)
  head=$(git -C /opt/crm rev-parse HEAD)
  status_hash=$(env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm status --porcelain=v2 --untracked-files=all | hash_stream)
  disk_json=$(df -B1 --output=source,size,used,avail,pcent,target /opt/crm | tail -n 1 | awk '{printf "{\"filesystem\":\"%s\",\"sizeBytes\":%s,\"usedBytes\":%s,\"freeBytes\":%s,\"percentUsed\":\"%s\",\"target\":\"%s\"}",$1,$2,$3,$4,$5,$6}')
  jq -cn \
    --arg containerHash "$container_hash" --arg stateHash "$state_hash" --arg restartHash "$restart_hash" \
    --arg volumeHash "$volume_hash" --arg networkHash "$network_hash" --arg head "$head" --arg statusHash "$status_hash" \
    --arg expectedHead "$EXPECTED_PRODUCTION_HEAD" --arg expectedStatusHash "$EXPECTED_PRODUCTION_STATUS_SHA" --argjson disk "$disk_json" \
    '{containerHash:$containerHash,stateHash:$stateHash,restartHash:$restartHash,volumeInventoryHash:$volumeHash,networkInventoryHash:$networkHash,
      productionGit:{head:$head,statusSha256:$statusHash,acceptedBaselineMatch:($head==$expectedHead and $statusHash==$expectedStatusHash)},disk:$disk}'
}

phase=before-snapshot
before_json=$(snapshot)

phase=identity-discovery
mapfile -t all_ids < <(run docker ps -aq --filter "label=$PROJECT_LABEL" --filter "label=$SERVICE_LABEL")
mapfile -t running_ids < <(run docker ps -q --filter "label=$PROJECT_LABEL" --filter "label=$SERVICE_LABEL" --filter status=running)
identity_decision=$(classify_identity_count "${#all_ids[@]}" "${#running_ids[@]}")
[[ $identity_decision == SCRAPER_IDENTITY_EXACT ]] || fail "$identity_decision"
container_id=${running_ids[0]}
run docker inspect "$container_id" >"$tmp_dir/container-inspect.json"
chmod 0600 "$tmp_dir/container-inspect.json"
jq -e --arg project "$PROJECT_NAME" --arg service "$SERVICE_NAME" \
  'length==1 and .[0].Config.Labels["com.docker.compose.project"]==$project and .[0].Config.Labels["com.docker.compose.service"]==$service and .[0].State.Running==true' \
  "$tmp_dir/container-inspect.json" >/dev/null || fail SCRAPER_IDENTITY_AMBIGUOUS

image_id=$(jq -r '.[0].Image' "$tmp_dir/container-inspect.json")
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || fail IMAGE_ID_INVALID
run docker image inspect "$image_id" >"$tmp_dir/image-inspect.json"
chmod 0600 "$tmp_dir/image-inspect.json"
jq -e --arg imageId "$image_id" 'length==1 and .[0].Id==$imageId' "$tmp_dir/image-inspect.json" >/dev/null || fail WRONG_IMAGE_IDENTITY

phase=container-metadata
container_id_sha=$(printf '%s' "$container_id" | hash_stream)
repo_tags=$(jq -c '.[0].RepoTags // [] | sort' "$tmp_dir/image-inspect.json")
repo_digests=$(jq -c '.[0].RepoDigests // [] | sort' "$tmp_dir/image-inspect.json")
state=$(jq -r '.[0].State.Status' "$tmp_dir/container-inspect.json")
health=$(jq -c '.[0].State.Health.Status // null' "$tmp_dir/container-inspect.json")
restart_count=$(jq -r '.[0].RestartCount' "$tmp_dir/container-inspect.json")
started_at=$(jq -r '.[0].State.StartedAt' "$tmp_dir/container-inspect.json")
configured_user=$(jq -r '.[0].Config.User // ""' "$tmp_dir/container-inspect.json")
entrypoint=$(jq -c '.[0].Config.Entrypoint // []' "$tmp_dir/container-inspect.json")
command_json=$(jq -c '.[0].Config.Cmd // []' "$tmp_dir/container-inspect.json")
working_directory=$(jq -r '.[0].Config.WorkingDir // ""' "$tmp_dir/container-inspect.json")
environment_names=$(jq -c '[(.[0].Config.Env // [])[] | split("=")[0]] | unique | sort' "$tmp_dir/container-inspect.json")
mounts=$(jq -c '[.[0].Mounts[] | {type:.Type,source:(.Name // .Source),destination:.Destination,readWrite:.RW}] | sort_by(.destination)' "$tmp_dir/container-inspect.json")
networks=$(jq -c '[.[0].NetworkSettings.Networks | to_entries[] | {name:.key,aliases:(.value.Aliases // [] | sort),networkIdSha256:(.value.NetworkID // "")}] | sort_by(.name)' "$tmp_dir/container-inspect.json")
ports=$(jq -c '.[0].NetworkSettings.Ports // {}' "$tmp_dir/container-inspect.json")
restart_policy=$(jq -c '.[0].HostConfig.RestartPolicy // {}' "$tmp_dir/container-inspect.json")
healthcheck_sha=$(jq -cS '.[0].Config.Healthcheck // {}' "$tmp_dir/container-inspect.json" | hash_stream)
security_options=$(jq -c '.[0].HostConfig.SecurityOpt // [] | sort' "$tmp_dir/container-inspect.json")
cap_add=$(jq -c '.[0].HostConfig.CapAdd // [] | sort' "$tmp_dir/container-inspect.json")
cap_drop=$(jq -c '.[0].HostConfig.CapDrop // [] | sort' "$tmp_dir/container-inspect.json")
privileged=$(jq -r '.[0].HostConfig.Privileged // false' "$tmp_dir/container-inspect.json")
read_only_root=$(jq -r '.[0].HostConfig.ReadonlyRootfs // false' "$tmp_dir/container-inspect.json")
pid_mode=$(jq -r '.[0].HostConfig.PidMode // ""' "$tmp_dir/container-inspect.json")
ipc_mode=$(jq -r '.[0].HostConfig.IpcMode // ""' "$tmp_dir/container-inspect.json")

phase=runtime-process-metadata
runtime_uid=$(run docker exec "$container_id" id -u)
runtime_gid=$(run docker exec "$container_id" id -g)
[[ $runtime_uid =~ ^[0-9]+$ && $runtime_gid =~ ^[0-9]+$ ]] || fail RUNTIME_IDENTITY_INVALID
run docker top "$container_id" -eo uid,gid,pid,args >"$tmp_dir/processes.txt"
chmod 0600 "$tmp_dir/processes.txt"
browser_root_count=$(awk 'NR>1 && tolower($0) ~ /(chromium|chrome)/ && $0 !~ /--type=/ {n++} END {print n+0}' "$tmp_dir/processes.txt")
renderer_count=$(awk 'NR>1 && tolower($0) ~ /(chromium|chrome)/ && $0 ~ /--type=renderer/ {n++} END {print n+0}' "$tmp_dir/processes.txt")
node_owner_count=$(awk 'NR>1 && $0 ~ /node[[:space:]]+index\.js/ {n++} END {print n+0}' "$tmp_dir/processes.txt")
if [[ $browser_root_count -eq 1 ]]; then browser_decision=BROWSER_OWNER_SINGLE; elif [[ $browser_root_count -eq 0 ]]; then browser_decision=BROWSER_OWNER_NOT_RUNNING; else browser_decision=SECOND_BROWSER_DETECTED; fi
if [[ $node_owner_count -gt 1 ]]; then listener_decision=SECOND_LISTENER_DETECTED; else listener_decision=LISTENER_OWNERSHIP_UNKNOWN; fi

phase=profile-metadata
profile_line=$(run docker exec "$container_id" sh -ceu '
  p=/app/user_data
  if [ -L "$p" ]; then symlink=true; else symlink=false; fi
  if [ -d "$p" ]; then exists=true; else exists=false; fi
  if [ -w "$p" ]; then writable=true; else writable=false; fi
  if command -v getfacl >/dev/null 2>&1; then
    acl_available=true
    if getfacl -cp "$p" 2>/dev/null | awk -F: '\''NF==3 && ($1=="user" || $1=="group") && $2!="" {found=1} END {exit !found}'\''; then acl_present=true; else acl_present=false; fi
  else acl_available=false; acl_present=unknown; fi
  locks=0
  for n in SingletonLock SingletonCookie SingletonSocket; do [ -e "$p/$n" ] && locks=$((locks+1)); done
  if [ "$exists" = true ]; then meta=$(stat -Lc "%u|%g|%a|%d|%i" "$p"); else meta="-1|-1|0|0|0"; fi
  printf "%s|%s|%s|%s|%s|%s|%s\n" "$exists" "$symlink" "$writable" "$acl_available" "$acl_present" "$locks" "$meta"
')
IFS='|' read -r profile_exists profile_symlink current_writable acl_available acl_present lock_count profile_uid profile_gid profile_mode profile_device profile_inode <<<"$profile_line"
profile_mount_count=$(jq --arg path "$PROFILE_PATH" '[.[] | .Mounts[]? | select(.Destination==$path)] | length' "$tmp_dir/container-inspect.json")
profile_mount_rw=$(jq -r --arg path "$PROFILE_PATH" '[.[] | .Mounts[]? | select(.Destination==$path and .RW==true)] | length==1' "$tmp_dir/container-inspect.json")
mapfile -t production_ids < <(run docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME")
run docker inspect "${production_ids[@]}" >"$tmp_dir/production-inspect.json"
chmod 0600 "$tmp_dir/production-inspect.json"
production_profile_mount_count=$(jq --arg path "$PROFILE_PATH" '[.[] | .Mounts[]? | select(.Destination==$path)] | length' "$tmp_dir/production-inspect.json")

accepted_writable=false
group_compatibility=false
if [[ $profile_exists == true && $profile_symlink == false && $profile_mode =~ ^[0-7]{3,4}$ ]]; then
  permission_value=$((8#$profile_mode))
  if [[ $profile_uid == "$ACCEPTED_UID" && $((permission_value & 8#200)) -ne 0 ]]; then accepted_writable=true; fi
  if [[ $profile_gid == "$ACCEPTED_GID" ]]; then
    group_compatibility=true
    if [[ $((permission_value & 8#020)) -ne 0 ]]; then accepted_writable=true; fi
  fi
  if [[ $((permission_value & 8#002)) -ne 0 ]]; then accepted_writable=true; fi
fi
if [[ $profile_exists != true || $profile_symlink == true || $profile_mount_count -ne 1 || $production_profile_mount_count -ne 1 || $profile_mount_rw != true ]]; then
  uid_decision=UID_TRANSITION_INCOMPATIBLE
elif [[ $acl_present == unknown ]]; then
  uid_decision=UID_TRANSITION_UNKNOWN
elif [[ $accepted_writable == true ]]; then
  uid_decision=UID_TRANSITION_SAFE
elif [[ $profile_uid == "$runtime_uid" ]]; then
  uid_decision=UID_TRANSITION_REQUIRES_CONTROLLED_OWNERSHIP_CHANGE
else
  uid_decision=UID_TRANSITION_INCOMPATIBLE
fi

phase=after-snapshot
after_json=$(snapshot)
identity_after=$(run docker inspect --format '{{.Id}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")
identity_stable=false
if [[ $identity_after == "$container_id|true|$restart_count|$PROJECT_NAME|$SERVICE_NAME" ]]; then identity_stable=true; fi
unexpected_changes=$(jq -n --argjson before "$before_json" --argjson after "$after_json" \
  '$before.containerHash!=$after.containerHash or $before.stateHash!=$after.stateHash or $before.restartHash!=$after.restartHash or $before.volumeInventoryHash!=$after.volumeInventoryHash or $before.networkInventoryHash!=$after.networkInventoryHash or $before.productionGit!=$after.productionGit')

recreation_decision=RECREATION_EVIDENCE_COMPLETE
if [[ -z $image_id || -z $working_directory || $configured_user == null ]] || [[ $(jq 'length' <<<"$entrypoint") -eq 0 ]] || [[ $(jq 'length' <<<"$command_json") -eq 0 ]]; then
  recreation_decision=RECREATION_EVIDENCE_INCOMPLETE
fi

incomplete=()
[[ $identity_stable == true ]] || incomplete+=(CONTAINER_IDENTITY_CHANGED)
[[ $unexpected_changes == false ]] || incomplete+=(PRODUCTION_IMMUTABILITY_MISMATCH)
[[ $browser_decision == BROWSER_OWNER_SINGLE ]] || incomplete+=("$browser_decision")
[[ $listener_decision != LISTENER_OWNERSHIP_UNKNOWN ]] || incomplete+=(LISTENER_OWNERSHIP_UNKNOWN)
[[ $listener_decision != SECOND_LISTENER_DETECTED ]] || incomplete+=(SECOND_LISTENER_DETECTED)
[[ $uid_decision == UID_TRANSITION_SAFE ]] || incomplete+=("$uid_decision")
[[ $recreation_decision == RECREATION_EVIDENCE_COMPLETE ]] || incomplete+=(RECREATION_EVIDENCE_INCOMPLETE)
incomplete_json=$(printf '%s\n' "${incomplete[@]}" | jq -Rsc 'split("\n") | map(select(length>0)) | unique')
gate_complete=false
gate_reason=MANDATORY_FACTS_INCOMPLETE
if ((${#incomplete[@]} == 0)); then gate_complete=true; gate_reason=MANDATORY_FACTS_COMPLETE; fi

phase=report-generation
jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg scriptSha "$actual_script_sha" \
  --arg idSha "$container_id_sha" --arg imageId "$image_id" --argjson repoTags "$repo_tags" --argjson repoDigests "$repo_digests" \
  --arg state "$state" --argjson health "$health" --argjson restartCount "$restart_count" --arg startedAt "$started_at" \
  --arg configuredUser "$configured_user" --argjson runtimeUid "$runtime_uid" --argjson runtimeGid "$runtime_gid" \
  --argjson entrypoint "$entrypoint" --argjson command "$command_json" --arg workdir "$working_directory" --argjson envNames "$environment_names" \
  --argjson mounts "$mounts" --argjson networks "$networks" --argjson ports "$ports" --argjson restartPolicy "$restart_policy" \
  --arg healthSha "$healthcheck_sha" --argjson securityOptions "$security_options" --argjson capAdd "$cap_add" --argjson capDrop "$cap_drop" \
  --argjson privileged "$privileged" --argjson readOnlyRoot "$read_only_root" --arg pidMode "$pid_mode" --arg ipcMode "$ipc_mode" \
  --argjson browserRoots "$browser_root_count" --argjson renderers "$renderer_count" --arg browserDecision "$browser_decision" \
  --argjson nodeOwners "$node_owner_count" --arg listenerDecision "$listener_decision" \
  --argjson profileMounts "$production_profile_mount_count" --argjson profileRw "$profile_mount_rw" --argjson profileExists "$profile_exists" --argjson profileSymlink "$profile_symlink" \
  --argjson profileUid "$profile_uid" --argjson profileGid "$profile_gid" --arg profileMode "$profile_mode" --argjson profileDevice "$profile_device" --argjson profileInode "$profile_inode" \
  --argjson currentWritable "$current_writable" --argjson acceptedWritable "$accepted_writable" --argjson groupCompatibility "$group_compatibility" \
  --argjson aclAvailable "$acl_available" --arg aclPresent "$acl_present" --argjson locks "$lock_count" --arg uidDecision "$uid_decision" \
  --arg recreationDecision "$recreation_decision" --argjson before "$before_json" --argjson after "$after_json" \
  --argjson unexpectedChanges "$unexpected_changes" --argjson stable "$identity_stable" --argjson incomplete "$incomplete_json" --argjson complete "$gate_complete" --arg reason "$gate_reason" \
  '{schemaVersion:1,mode:"READ_ONLY_SCRAPER_RUNTIME_METADATA",generatedAt:$generatedAt,script:{sha256:$scriptSha,checksumBound:true},
    identity:{project:"crm",service:"max-web-scraper",matchingContainers:1,runningContainers:1,stable:$stable},
    container:{idSha256:$idSha,imageId:$imageId,repoTags:$repoTags,repoDigests:$repoDigests,state:$state,health:$health,restartCount:$restartCount,startedAt:$startedAt,
      configuredUser:$configuredUser,runtimeUid:$runtimeUid,runtimeGid:$runtimeGid,entrypoint:$entrypoint,command:$command,workingDirectory:$workdir,environmentNames:$envNames,
      mounts:$mounts,networks:$networks,ports:$ports,restartPolicy:$restartPolicy,healthcheckSha256:$healthSha,securityOptions:$securityOptions,capAdd:$capAdd,capDrop:$capDrop,
      privileged:$privileged,readOnlyRootFilesystem:$readOnlyRoot,pidMode:$pidMode,ipcMode:$ipcMode},
    browser:{rootProcessCount:$browserRoots,rendererProcessCount:$renderers,ownerUid:$runtimeUid,ownerGid:$runtimeGid,decision:$browserDecision},
    listener:{owningNodeProcessCount:$nodeOwners,instanceCount:null,decision:$listenerDecision},
    profile:{path:"/app/user_data",mountCount:$profileMounts,mountedReadWrite:$profileRw,exists:$profileExists,symlink:$profileSymlink,uid:$profileUid,gid:$profileGid,mode:$profileMode,
      device:$profileDevice,inode:$profileInode,currentRuntimeWritable:$currentWritable,acceptedUid:1001,acceptedUidWritable:$acceptedWritable,groupCompatibility:$groupCompatibility,
      aclAvailable:$aclAvailable,aclPresent:$aclPresent,lockCount:$locks,uidTransitionDecision:$uidDecision},
    recreation:{environmentSourceProvenance:["container Config.Env name set","tracked deploy/docker-compose.production.yml env_file declaration"],evidenceDecision:$recreationDecision},
    immutability:{before:$before,after:$after,unexpectedChanges:$unexpectedChanges},gate:{complete:$complete,reason:$reason,incompleteFacts:$incomplete},
    safety:{containersChanged:false,containersRestarted:false,imagesPulled:false,profileContentRead:false,environmentValuesReported:false,browserLaunched:false,maxContacted:false,providerAction:false,sanitizedReportWritten:true}}' \
  >"$tmp_dir/report.json"
chmod 0600 "$tmp_dir/report.json"
jq -e '.schemaVersion==1 and .mode=="READ_ONLY_SCRAPER_RUNTIME_METADATA" and .identity.project=="crm" and .identity.service=="max-web-scraper" and .safety.environmentValuesReported==false' "$tmp_dir/report.json" >/dev/null || fail REPORT_SCHEMA_INVALID
if grep -Eiq '(DATABASE_URL=|PASSWORD=|TOKEN=|SECRET=|COOKIE=|AUTHORIZATION:|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|message(Text|Body)|providerPayload)' "$tmp_dir/report.json"; then
  fail SANITIZED_REPORT_SECRET_SCAN_FAILED
fi
[[ $unexpected_changes == false ]] || fail PRODUCTION_IMMUTABILITY_MISMATCH

phase=publish
set -o noclobber
exec 9>"$RESULT_PATH" || fail REPORT_ALREADY_EXISTS
chown root:codexbot "$RESULT_PATH"
chmod 0640 "$RESULT_PATH"
cat "$tmp_dir/report.json" >&9
exec 9>&-
[[ $(stat -c '%U:%G:%a' "$RESULT_PATH") == 'root:codexbot:640' ]] || fail REPORT_HANDOFF_INVALID
published=true
phase=complete
printf '%s\n' SCRAPER_RUNTIME_METADATA_REPORT_WRITTEN
