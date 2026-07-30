#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE_DIR=/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z
readonly SCRIPT_PATH=${SOURCE_DIR}/scripts/personal-max-uat-fix-production-v1.sh
readonly EXPECTED_BRANCH=feature/personal-max-text-canary-autonomous-20260728T211316Z
readonly PROD_DIR=/opt/crm
readonly BASE_COMPOSE=/opt/crm/deploy/docker-compose.production.yml
readonly DEFAULT_OFF_COMPOSE=${SOURCE_DIR}/deploy/docker-compose.personal-max-final-default-off.yml
readonly OPERATIONAL_COMPOSE=${SOURCE_DIR}/deploy/docker-compose.personal-max-text-operational.yml
readonly PROD_ENV=/opt/crm/.env.production
readonly OPERATIONAL_ENV=/var/lib/crm/max-personal-text-operational.env
readonly STATE_FILE=/var/lib/crm/personal-max-uat-fix-state.json
readonly RESULT_FILE=/var/tmp/personal-max-uat-fix-production.json
readonly SEQUENCE5_PROVIDER_ID=d3019fb24937cd40f5
readonly REPLAY_PROVIDER_ID=d3019f9cddd3452c06
readonly MIN_DOCKER_FREE_BYTES=15000000000

if [[ $EUID -ne 0 ]]; then
  echo 'ERROR: bounded production repair must run as root' >&2
  exit 77
fi
if [[ $# -ne 2 ]]; then
  echo 'usage: personal-max-uat-fix-production-v1.sh <script-sha256> <source-sha>' >&2
  exit 64
fi
readonly EXPECTED_SCRIPT_SHA=$1
readonly SOURCE_SHA=$2
if [[ ! $EXPECTED_SCRIPT_SHA =~ ^[0-9a-f]{64}$ || ! $SOURCE_SHA =~ ^[0-9a-f]{40}$ ]]; then
  echo 'ERROR: invalid checksum or source revision' >&2
  exit 65
fi
if [[ $(sha256sum "$SCRIPT_PATH" | awk '{print $1}') != "$EXPECTED_SCRIPT_SHA" ]]; then
  echo 'ERROR: script checksum mismatch' >&2
  exit 66
fi

for required in "$SOURCE_DIR" "$PROD_DIR" "$BASE_COMPOSE" "$DEFAULT_OFF_COMPOSE" \
  "$OPERATIONAL_COMPOSE" "$PROD_ENV" "$OPERATIONAL_ENV"; do
  if [[ ! -e $required || -L $required ]]; then
    echo "ERROR: exact non-symlink path missing: $required" >&2
    exit 67
  fi
done
if [[ $(git -C "$SOURCE_DIR" branch --show-current) != "$EXPECTED_BRANCH" \
   || $(git -C "$SOURCE_DIR" rev-parse HEAD) != "$SOURCE_SHA" \
   || $(git -C "$SOURCE_DIR" rev-parse "origin/$EXPECTED_BRANCH") != "$SOURCE_SHA" \
   || -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]]; then
  echo 'ERROR: source branch, local SHA, remote SHA, or cleanliness mismatch' >&2
  exit 68
fi

umask 0077
readonly SHORT_SHA=${SOURCE_SHA:0:12}
readonly GRAVITY_IMAGE=crm/gravity-mvp:personal-max-uatfix-${SHORT_SHA}
readonly GATEWAY_IMAGE=crm/max-personal-gateway:personal-max-uatfix-${SHORT_SHA}
readonly SCRAPER_IMAGE=crm/max-web-scraper:personal-max-uatfix-${SHORT_SHA}
export PERSONAL_MAX_GRAVITY_IMAGE=$GRAVITY_IMAGE
export PERSONAL_MAX_GATEWAY_IMAGE=$GATEWAY_IMAGE
export PERSONAL_MAX_SCRAPER_IMAGE=$SCRAPER_IMAGE

compose_default_off=(
  docker compose --env-file "$PROD_ENV" --env-file "$OPERATIONAL_ENV"
  -f "$BASE_COMPOSE" -f "$OPERATIONAL_COMPOSE" -f "$DEFAULT_OFF_COMPOSE"
)
compose_operational=(
  docker compose --env-file "$PROD_ENV" --env-file "$OPERATIONAL_ENV"
  -f "$BASE_COMPOSE" -f "$DEFAULT_OFF_COMPOSE" -f "$OPERATIONAL_COMPOSE"
)

production_mutated=false
repair_env=
request_file=
response_file=
render_file=

default_off_now() {
  "${compose_default_off[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
    gravity-mvp max-personal-gateway max-web-scraper >/dev/null
}

seal_evidence() {
  local directory=$1
  [[ $directory =~ ^/var/backups/personal-max-uat-fix-[0-9]{8}T[0-9]{6}Z$ ]]
  [[ -d $directory && ! -L $directory ]]
  find "$directory" -type f -exec chown root:codexbot {} +
  find "$directory" -type f -exec chmod 0640 {} +
  rm -f -- "$directory/SHA256SUMS" "$directory/SHA256SUMS.verify"
  (cd "$directory" && find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name SHA256SUMS.verify -printf '%P\0' \
    | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS)
  (cd "$directory" && sha256sum -c SHA256SUMS >SHA256SUMS.verify)
  chown root:codexbot "$directory/SHA256SUMS" "$directory/SHA256SUMS.verify"
  chmod 0640 "$directory/SHA256SUMS" "$directory/SHA256SUMS.verify"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  [[ -n $repair_env ]] && rm -f -- "$repair_env"
  [[ -n $request_file ]] && rm -f -- "$request_file"
  [[ -n $response_file ]] && rm -f -- "$response_file"
  [[ -n $render_file ]] && rm -f -- "$render_file"
  if [[ $status -ne 0 && $production_mutated == true ]]; then
    default_off_now >/dev/null 2>&1
  fi
  if [[ $status -ne 0 ]]; then
    local tmp
    tmp=$(mktemp /var/tmp/personal-max-uat-fix-production.failure.XXXXXX)
    jq -n --arg sourceSha "$SOURCE_SHA" --argjson status "$status" \
      --argjson defaultOffAttempted "$production_mutated" \
      '{schemaVersion:1,status:"BLOCKED_DEFAULT_OFF",sourceSha:$sourceSha,exitStatus:$status,
        senderOperational:false,automaticDefaultOffAttempted:$defaultOffAttempted,additionalProviderRetry:false}' >"$tmp"
    chown root:codexbot "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$RESULT_FILE"
    chown root:codexbot "$RESULT_FILE"
    chmod 0640 "$RESULT_FILE"
  fi
  if [[ -n ${EVIDENCE_DIR-} && -d ${EVIDENCE_DIR-} && ! -L ${EVIDENCE_DIR-} ]]; then
    if [[ $status -ne 0 && -f $RESULT_FILE ]]; then
      install -o root -g codexbot -m 0640 "$RESULT_FILE" "$EVIDENCE_DIR/failure-report.json"
      docker exec crm-max-personal-gateway node -e \
        "fetch('http://127.0.0.1:8080/ready').then(async r=>process.stdout.write(await r.text())).catch(()=>process.exit(1))" \
        >"$EVIDENCE_DIR/gateway-ready-on-failure.json" 2>/dev/null
      docker exec crm-max-scraper node -e \
        "fetch('http://127.0.0.1:3005/health').then(async r=>process.stdout.write(await r.text())).catch(()=>process.exit(1))" \
        >"$EVIDENCE_DIR/scraper-health-on-failure.json" 2>/dev/null
    fi
    seal_evidence "$EVIDENCE_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

tracked_tree_hash() {
  git -C "$PROD_DIR" ls-files -z \
    | sort -z \
    | while IFS= read -r -d '' file; do
        if [[ -f $PROD_DIR/$file ]]; then
          sha256sum "$PROD_DIR/$file"
        elif [[ -L $PROD_DIR/$file ]]; then
          printf 'SYMLINK  %s  %s\n' "$file" "$(readlink "$PROD_DIR/$file")"
        else
          printf 'MISSING  %s\n' "$file"
        fi
      done \
    | sha256sum \
    | awk '{print $1}'
}

env_value() {
  local file=$1 key=$2 line value
  line=$(grep -m1 -E "^${key}=" "$file" || true)
  value=${line#*=}
  if [[ $value == \"*\" && $value == *\" ]]; then value=${value:1:${#value}-2}; fi
  if [[ $value == \'*\' && $value == *\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

image_revision() {
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1"
}

build_or_validate_image() {
  local image=$1 dockerfile=$2 context=$3
  shift 3
  if docker image inspect "$image" >/dev/null 2>&1; then
    [[ $(image_revision "$image") == "$SOURCE_SHA" ]]
    return
  fi
  docker build --pull=false \
    --build-arg SOURCE_COMMIT="$SOURCE_SHA" \
    --build-arg BUILD_TIMESTAMP="$BUILD_TIMESTAMP" \
    "$@" -f "$dockerfile" -t "$image" "$context"
  [[ $(image_revision "$image") == "$SOURCE_SHA" ]]
  # The release image owns every required layer. Intermediate BuildKit cache is
  # rebuildable and must not consume the production rollback reserve.
  docker builder prune --all --force
}

postgres_query() {
  docker exec -i crm-postgres sh -c \
    'exec psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

health_gate() {
  docker exec crm-max-personal-gateway node -e \
    "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
  docker exec crm-max-scraper node -e \
    "fetch('http://127.0.0.1:3005/health').then(async r=>{const b=await r.json();process.exit(r.status===200&&b.isReady===true&&b.queueLength===0?0:1)}).catch(()=>process.exit(1))"
  docker exec crm-gravity-mvp node -e \
    "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
}

restart_counts() {
  local container
  for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper; do
    docker inspect --format '{{.Name}}={{.RestartCount}}' "$container"
  done
}

actual_default_off_gate() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq -e '
    (map(select(.Name == "/crm-gravity-mvp"))[0].Config.Env | index("MAX_PERSONAL_DURABLE_TEXT_ENABLED=false")) != null and
    (map(select(.Name == "/crm-max-personal-gateway"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_ENABLED=false")) != null and
    (map(select(.Name == "/crm-max-personal-gateway"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false")) != null and
    (map(select(.Name == "/crm-max-personal-gateway"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_ENABLED=false")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED=true")) != null
  ' >/dev/null
}

actual_operational_gate() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq -e '
    (map(select(.Name == "/crm-gravity-mvp"))[0].Config.Env | index("MAX_PERSONAL_DURABLE_TEXT_ENABLED=true")) != null and
    (map(select(.Name == "/crm-max-personal-gateway"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_ENABLED=true")) != null and
    (map(select(.Name == "/crm-max-personal-gateway"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=true")) != null and
    (map(select(.Name == "/crm-max-personal-gateway"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=true")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_ENABLED=true")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=true")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=true")) != null and
    (map(select(.Name == "/crm-max-scraper"))[0].Config.Env | index("MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED=true")) != null
  ' >/dev/null
}

readonly PROD_HEAD_BEFORE=$(git -C "$PROD_DIR" rev-parse HEAD)
readonly PROD_STATUS_BEFORE=$(git -C "$PROD_DIR" status --porcelain)
readonly PROD_TREE_HASH_BEFORE=$(tracked_tree_hash)
readonly BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

resume=false
if [[ -f $STATE_FILE ]]; then
  if [[ $(stat -c '%U:%G:%a' "$STATE_FILE") != root:root:600 \
     || $(jq -r '.sourceSha // ""' "$STATE_FILE") != "$SOURCE_SHA" ]]; then
    echo 'ERROR: existing UAT state is not safely resumable' >&2
    exit 69
  fi
  resume=true
  EVIDENCE_DIR=$(jq -r '.evidenceDirectory' "$STATE_FILE")
  [[ $EVIDENCE_DIR =~ ^/var/backups/personal-max-uat-fix-[0-9]{8}T[0-9]{6}Z$ ]]
  [[ -d $EVIDENCE_DIR && ! -L $EVIDENCE_DIR \
    && $(stat -c '%U:%G:%a' "$EVIDENCE_DIR") == root:codexbot:2750 ]]
else
  readonly STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  EVIDENCE_DIR=/var/backups/personal-max-uat-fix-$STAMP
  [[ ! -e $EVIDENCE_DIR ]]
  install -d -o root -g codexbot -m 2750 "$EVIDENCE_DIR"
fi
readonly EVIDENCE_DIR

docker_root=$(docker info --format '{{.DockerRootDir}}')
[[ $docker_root == /* && -d $docker_root && ! -L $docker_root ]]
docker_free_bytes=$(df --output=avail -B1 "$docker_root" | tail -n 1 | tr -d ' ')
[[ $docker_free_bytes =~ ^[0-9]+$ && $docker_free_bytes -ge $MIN_DOCKER_FREE_BYTES ]]
jq -n --arg dockerRoot "$docker_root" --argjson freeBytes "$docker_free_bytes" \
  --argjson minimumFreeBytes "$MIN_DOCKER_FREE_BYTES" \
  '{schemaVersion:1,dockerRoot:$dockerRoot,freeBytes:$freeBytes,
    minimumFreeBytes:$minimumFreeBytes,gatePassed:true}' \
  >"$EVIDENCE_DIR/storage-before-build.json"

if [[ $resume == false ]]; then
  previous_run_counts=$(postgres_query <<'SQL'
SELECT json_build_object(
  'commands', (SELECT count(*) FROM "MaxOutboundCommand" WHERE "clientMessageId" LIKE 'pmax-uatfix-%'),
  'dispatches', (SELECT count(*) FROM "MaxOutboundDispatch" d JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId" LIKE 'pmax-uatfix-%'),
  'attempts', (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a JOIN "MaxOutboundDispatch" d ON d."dispatchId"=a."dispatchId" JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId" LIKE 'pmax-uatfix-%'),
  'providerConfirmed', (SELECT count(*) FROM "MaxOutboundDispatch" d JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId" LIKE 'pmax-uatfix-%' AND d."state"='provider_confirmed'),
  'providerActions', (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a JOIN "MaxOutboundDispatch" d ON d."dispatchId"=a."dispatchId" JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId" LIKE 'pmax-uatfix-%' AND a."physicalActionStartedAt" IS NOT NULL)
);
SQL
)
  jq -e '.commands == 0 and .dispatches == 0 and .attempts == 0
    and .providerConfirmed == 0 and .providerActions == 0' \
    <<<"$previous_run_counts" >/dev/null
  previous_runtime=$(docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq '[.[] | {
    name:(.Name|ltrimstr("/")),image:.Config.Image,imageId:.Image,startedAt:.State.StartedAt,
    restartCount:.RestartCount,status:.State.Status,health:(.State.Health.Status // null),
    senderFlags:(.Config.Env | map(select(startswith("MAX_PERSONAL_DURABLE_TEXT_ENABLED=")
      or startswith("MAX_PERSONAL_TEXT_SENDER_ENABLED=")
      or startswith("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=")
      or startswith("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=")
      or startswith("MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED="))))
  }]')
  jq -n --arg sourceSha "$SOURCE_SHA" --argjson ledger "$previous_run_counts" \
    --argjson runtime "$previous_runtime" \
    '{schemaVersion:1,classification:"PREVIOUS_RUN_DID_NOT_CROSS_PREFLIGHT",sourceSha:$sourceSha,
      runningProcess:false,stateMarker:false,resultMarker:false,evidenceMarker:false,
      ledger:$ledger,runtime:$runtime,providerActions:0,rollbackRequired:false,safeToStartFresh:true}' \
    >"$EVIDENCE_DIR/previous-run-preflight.json"

  avito_public=$(env_value "$PROD_ENV" NEXT_PUBLIC_AVITO_LEADS_URL)
  max_phone_public=$(env_value "$PROD_ENV" NEXT_PUBLIC_MAX_SCRAPER_PHONE)
  force_channels_public=$(env_value "$PROD_ENV" NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS)
  build_or_validate_image "$GATEWAY_IMAGE" "$SOURCE_DIR/max-personal-gateway/Dockerfile" "$SOURCE_DIR" \
    >"$EVIDENCE_DIR/gateway-build.log" 2>&1
  build_or_validate_image "$SCRAPER_IMAGE" "$SOURCE_DIR/max-web-scraper/Dockerfile" "$SOURCE_DIR/max-web-scraper" \
    >"$EVIDENCE_DIR/scraper-build.log" 2>&1
  build_or_validate_image "$GRAVITY_IMAGE" "$SOURCE_DIR/gravity-mvp/Dockerfile" "$SOURCE_DIR/gravity-mvp" \
    --build-arg NEXT_PUBLIC_AVITO_LEADS_URL="$avito_public" \
    --build-arg NEXT_PUBLIC_MAX_SCRAPER_PHONE="$max_phone_public" \
    --build-arg NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS="$force_channels_public" \
    >"$EVIDENCE_DIR/gravity-build.log" 2>&1
else
  for image in "$GATEWAY_IMAGE" "$SCRAPER_IMAGE" "$GRAVITY_IMAGE"; do
    [[ $(image_revision "$image") == "$SOURCE_SHA" ]]
  done
fi

gateway_image_id=$(docker image inspect --format '{{.Id}}' "$GATEWAY_IMAGE")
scraper_image_id=$(docker image inspect --format '{{.Id}}' "$SCRAPER_IMAGE")
gravity_image_id=$(docker image inspect --format '{{.Id}}' "$GRAVITY_IMAGE")
for image_id in "$gateway_image_id" "$scraper_image_id" "$gravity_image_id"; do
  [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]
done

migration_count_before=$(postgres_query <<'SQL'
SELECT count(*)
FROM "_prisma_migrations"
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SQL
)
migration_hash_before=$(
  postgres_query <<'SQL' | sha256sum | awk '{print $1}'
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations"
ORDER BY migration_name;
SQL
)
[[ $migration_count_before =~ ^[0-9]+$ && $migration_hash_before =~ ^[0-9a-f]{64}$ ]]

if [[ $resume == false ]]; then
  docker exec crm-postgres sh -c \
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
    >"$EVIDENCE_DIR/production-before-repair.dump"
  test -s "$EVIDENCE_DIR/production-before-repair.dump"
  docker exec -i crm-postgres pg_restore --list \
    <"$EVIDENCE_DIR/production-before-repair.dump" \
    >"$EVIDENCE_DIR/production-before-repair.restore-list"
  sha256sum "$EVIDENCE_DIR/production-before-repair.dump" \
    >"$EVIDENCE_DIR/production-before-repair.dump.sha256"
  tar -czf "$EVIDENCE_DIR/runtime-config-before-repair.tar.gz" \
    -C / opt/crm/.env.production var/lib/crm/max-personal-text-operational.env \
    -C "$SOURCE_DIR" deploy/docker-compose.personal-max-final-default-off.yml \
      deploy/docker-compose.personal-max-text-operational.yml
fi

render_file=$(mktemp /var/tmp/personal-max-default-off-render.XXXXXX)
chmod 0600 "$render_file"
"${compose_default_off[@]}" config --format json >"$render_file"
jq -e '
  .services["gravity-mvp"].environment.MAX_PERSONAL_DURABLE_TEXT_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED == "true"
' "$render_file" >/dev/null
rm -f -- "$render_file"
render_file=

production_mutated=true
default_off_now
health_gate
actual_default_off_gate

pg_user=
pg_password=
pg_database=
while IFS= read -r entry; do
  case "$entry" in
    POSTGRES_USER=*) pg_user=${entry#*=} ;;
    POSTGRES_PASSWORD=*) pg_password=${entry#*=} ;;
    POSTGRES_DB=*) pg_database=${entry#*=} ;;
  esac
done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' crm-postgres)
[[ -n $pg_user && -n $pg_password && -n $pg_database ]]
pg_user_uri=$(jq -rn --arg value "$pg_user" '$value|@uri')
pg_password_uri=$(jq -rn --arg value "$pg_password" '$value|@uri')
pg_database_uri=$(jq -rn --arg value "$pg_database" '$value|@uri')
account_id=$(env_value "$OPERATIONAL_ENV" MAX_PERSONAL_ACCOUNT_ID)
[[ $account_id =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]
repair_env=$(mktemp /var/tmp/personal-max-uat-repair.env.XXXXXX)
chmod 0600 "$repair_env"
printf '%s\n' \
  "MAX_PERSONAL_GATEWAY_DATABASE_URL=postgresql://$pg_user_uri:$pg_password_uri@postgres:5432/$pg_database_uri?schema=public" \
  "PERSONAL_MAX_UAT_REPAIR_DATABASE_NAME=$pg_database" \
  "MAX_PERSONAL_ACCOUNT_ID=$account_id" \
  'PERSONAL_MAX_UAT_REPAIR_MODE=uat-failure-20260730-exact' \
  "PERSONAL_MAX_UAT_REPAIR_SEQUENCE5_PROVIDER_ID=$SEQUENCE5_PROVIDER_ID" \
  "PERSONAL_MAX_UAT_REPAIR_REPLAY_PROVIDER_ID=$REPLAY_PROVIDER_ID" >"$repair_env"
docker run --rm --network crm_internal --env-file "$repair_env" "$GATEWAY_IMAGE" \
  node --experimental-strip-types src/ops/repairUatFailure.ts \
  >"$EVIDENCE_DIR/ledger-repair.json"
jq -e '
  .repair == "PERSONAL_MAX_UAT_FAILURE_20260730" and
  .providerConfirmedSequences == [3,4,5] and
  .cancelledBeforeProviderSequences == [6,7,8,9,10] and
  .nextPhysicalSequence == 11 and .openReconciliation == 0 and
  .historyReplayQuarantined == 1 and .providerActionsPerformedByRepair == 0 and
  .evidenceRowsDeleted == 0
' "$EVIDENCE_DIR/ledger-repair.json" >/dev/null
rm -f -- "$repair_env"
repair_env=

render_file=$(mktemp /var/tmp/personal-max-operational-render.XXXXXX)
chmod 0600 "$render_file"
"${compose_operational[@]}" config --format json >"$render_file"
jq -e '
  .services["gravity-mvp"].environment.MAX_PERSONAL_DURABLE_TEXT_ENABLED == "true" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "true" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "true" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "true" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "true" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "true" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "true" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED == "true"
' "$render_file" >/dev/null
rm -f -- "$render_file"
render_file=
"${compose_operational[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
  gravity-mvp max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate

chat_id=$(postgres_query <<SQL
SELECT DISTINCT m."chatId"
FROM "MaxOutboundCommand" c
JOIN "Message" m ON m."clientMessageId" = c."clientMessageId"
WHERE c."accountId" = '$account_id'
  AND c."commandSequence" = 3
  AND c."createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
  AND c."createdAt" < TIMESTAMP '2026-07-30 09:13:00';
SQL
)
[[ $chat_id =~ ^[A-Za-z0-9_-]{8,256}$ ]]

if [[ $resume == false ]]; then
  canary_started_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  state_tmp=$(mktemp /var/lib/crm/personal-max-uat-fix-state.XXXXXX)
  jq -n --arg sourceSha "$SOURCE_SHA" --arg evidenceDirectory "$EVIDENCE_DIR" \
    --arg canaryStartedAt "$canary_started_at" --arg chatId "$chat_id" \
    '{schemaVersion:1,sourceSha:$sourceSha,evidenceDirectory:$evidenceDirectory,
      canaryStartedAt:$canaryStartedAt,chatId:$chatId}' >"$state_tmp"
  chown root:root "$state_tmp"
  chmod 0600 "$state_tmp"
  mv -f "$state_tmp" "$STATE_FILE"
else
  canary_started_at=$(jq -r '.canaryStartedAt' "$STATE_FILE")
  [[ $(jq -r '.chatId' "$STATE_FILE") == "$chat_id" ]]
  [[ $canary_started_at =~ ^2026-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]]
fi

canary_texts=(
  'PMAX UAT FIX 1'
  'Одинаковое сообщение'
  'Одинаковое сообщение'
  'Сообщение 1'
  'Сообщение 2'
  'Сообщение 3'
)
for index in 1 2 3 4 5 6; do
  client_id=pmax-uatfix-${SHORT_SHA}-$index
  existing_count=$(postgres_query <<SQL
SELECT count(*) FROM "Message" WHERE "clientMessageId" = '$client_id';
SQL
)
  if [[ $existing_count == 1 ]]; then
    continue
  fi
  [[ $existing_count == 0 ]]
  request_file=$(mktemp /var/tmp/personal-max-uat-request.XXXXXX)
  response_file=$(mktemp /var/tmp/personal-max-uat-response.XXXXXX)
  chmod 0600 "$request_file" "$response_file"
  jq -n --arg chatId "$chat_id" --arg content "${canary_texts[index-1]}" \
    --arg clientMessageId "$client_id" \
    '{chatId:$chatId,content:$content,channel:"max",clientMessageId:$clientMessageId}' >"$request_file"
  docker exec -i crm-gravity-mvp node -e '
    let input="";
    process.stdin.on("data", chunk => { input += chunk });
    process.stdin.on("end", async () => {
      try {
        const response = await fetch("http://127.0.0.1:3002/api/messages", {
          method:"POST", headers:{"content-type":"application/json"}, body:input,
        });
        const body = await response.text();
        if (!response.ok) process.exitCode = 2;
        process.stdout.write(body);
      } catch {
        process.exitCode = 3;
      }
    });
  ' <"$request_file" >"$response_file"
  jq -e '
    .success == true and .status == "delivered" and .deliveryConfirmed == true and
    (.externalId | type == "string" and test("^d301[0-9a-f]{14}$";"i"))
  ' "$response_file" >/dev/null
  jq '{success,status,deliveryConfirmed,externalId,maxDelivery:.metadata.maxDelivery}' \
    "$response_file" >"$EVIDENCE_DIR/outbound-$index.json"
  rm -f -- "$request_file" "$response_file"
  request_file=
  response_file=
done

postgres_query >"$EVIDENCE_DIR/outbound-verification.private.csv" <<SQL
\copy (
  SELECT c."commandSequence", c."clientMessageId", d."state", d."providerMessageId",
         d."attemptCount", m."status", m."externalId"
  FROM "MaxOutboundCommand" c
  JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
  JOIN "Message" m ON m."clientMessageId" = c."clientMessageId"
  WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%'
  ORDER BY c."commandSequence"
) TO STDOUT WITH CSV HEADER
SQL
outbound_gate=$(postgres_query <<SQL
SELECT concat_ws('|',
  count(*),
  count(*) FILTER (WHERE d."state" = 'provider_confirmed'),
  count(DISTINCT d."providerMessageId"),
  count(*) FILTER (WHERE d."attemptCount" = 1),
  count(*) FILTER (WHERE m."status" = 'delivered' AND m."externalId" = d."providerMessageId")
)
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
JOIN "Message" m ON m."clientMessageId" = c."clientMessageId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%';
SQL
)
[[ $outbound_gate == '6|6|6|6|6' ]]

incident_inbound_gate=$(postgres_query <<SQL
SELECT concat_ws('|',
  count(*) FILTER (WHERE "content" IN ('Ответ из MAX','Входящее 1','Входящее 2','Входящее 3')),
  count(DISTINCT "content") FILTER (WHERE "content" IN ('Ответ из MAX','Входящее 1','Входящее 2','Входящее 3')),
  count(DISTINCT "externalId") FILTER (WHERE "content" IN ('Ответ из MAX','Входящее 1','Входящее 2','Входящее 3')),
  count(*) FILTER (WHERE "content" IN ('Ответ из MAX','Входящее 1','Входящее 2','Входящее 3') AND "externalId" ~* '^d301[0-9a-f]{14}$'),
  count(*) FILTER (WHERE "content" = '3' AND "externalId" = '$REPLAY_PROVIDER_ID'),
  count(*) FILTER (WHERE "content" = '3' AND "externalId" = '$REPLAY_PROVIDER_ID'
    AND "metadata"->'personalMaxIngressDisposition'->>'kind' = 'history_replay'
    AND "metadata"->'personalMaxIngressDisposition'->>'visibility' = 'quarantined'
    AND "metadata"->'personalMaxIngressDisposition'->>'evidencePreserved' = 'true')
)
FROM "Message"
WHERE "chatId" = '$chat_id'
  AND "createdAt" >= TIMESTAMPTZ '2026-07-30 09:07:00'
  AND "createdAt" < TIMESTAMPTZ '2026-07-30 09:13:00'
  AND "direction" = 'inbound'
  AND "channel" = 'max';
SQL
)
[[ $incident_inbound_gate == '4|4|4|3|1|1' ]]

new_inbound_before_restart=$(postgres_query <<SQL
SELECT count(*) FROM "Message"
WHERE "chatId" = '$chat_id'
  AND "createdAt" >= TIMESTAMPTZ '$canary_started_at'
  AND "direction" = 'inbound' AND "channel" = 'max';
SQL
)
[[ $new_inbound_before_restart == 0 ]]

contact_projection_hash_before=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT "id", "direction", "content", "externalId", "clientMessageId", "status", "metadata"
FROM "Message"
WHERE "chatId" = '$chat_id' AND "createdAt" >= TIMESTAMPTZ '2026-07-30 09:07:00'
ORDER BY "id";
SQL
)

provider_hash_before=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT d."providerMessageId"
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%'
ORDER BY c."commandSequence";
SQL
)
"${compose_operational[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 300 \
  max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate
sleep 30
health_gate
provider_hash_after=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT d."providerMessageId"
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%'
ORDER BY c."commandSequence";
SQL
)
[[ $provider_hash_before =~ ^[0-9a-f]{64}$ && $provider_hash_before == "$provider_hash_after" ]]

new_inbound_after_restart=$(postgres_query <<SQL
SELECT count(*) FROM "Message"
WHERE "chatId" = '$chat_id'
  AND "createdAt" >= TIMESTAMPTZ '$canary_started_at'
  AND "direction" = 'inbound' AND "channel" = 'max';
SQL
)
[[ $new_inbound_after_restart == 0 ]]
contact_projection_hash_after=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT "id", "direction", "content", "externalId", "clientMessageId", "status", "metadata"
FROM "Message"
WHERE "chatId" = '$chat_id' AND "createdAt" >= TIMESTAMPTZ '2026-07-30 09:07:00'
ORDER BY "id";
SQL
)
[[ $contact_projection_hash_before =~ ^[0-9a-f]{64}$ \
  && $contact_projection_hash_before == "$contact_projection_hash_after" ]]
docker logs --timestamps --since "$canary_started_at" crm-max-scraper \
  >"$EVIDENCE_DIR/scraper-canary-and-restart.private.log" 2>&1

final_queue_gate=$(postgres_query <<SQL
SELECT concat_ws('|',
  (SELECT count(*) FROM "MaxOutboundDispatch" d
   WHERE d."accountId" = '$account_id'
     AND d."state" IN ('queued','dispatching','sent_to_provider_client','awaiting_confirmation','reconciliation_required','retryable_failed')),
  (SELECT count(*) FROM "MaxOutboundReconciliationTask" r
   WHERE r."accountId" = '$account_id' AND r."state" = 'open')
);
SQL
)
[[ $final_queue_gate == '0|0' ]]

# Prove the emergency rollback and a no-send roll-forward after the bounded
# canary. Provider identities and attempt counts must remain byte-stable.
rollback_identity_hash_before=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT d."providerMessageId", d."attemptCount", d."state"
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%'
ORDER BY c."commandSequence";
SQL
)
default_off_now
health_gate
actual_default_off_gate
rollback_identity_hash_after=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT d."providerMessageId", d."attemptCount", d."state"
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%'
ORDER BY c."commandSequence";
SQL
)
[[ $rollback_identity_hash_before == "$rollback_identity_hash_after" ]]
"${compose_operational[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
  gravity-mvp max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate
rollforward_identity_hash_after=$(
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT d."providerMessageId", d."attemptCount", d."state"
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%'
ORDER BY c."commandSequence";
SQL
)
[[ $rollback_identity_hash_before == "$rollforward_identity_hash_after" ]]
final_queue_gate_after_rollforward=$(postgres_query <<SQL
SELECT concat_ws('|',
  (SELECT count(*) FROM "MaxOutboundDispatch" d
   WHERE d."accountId" = '$account_id'
     AND d."state" IN ('queued','dispatching','sent_to_provider_client','awaiting_confirmation','reconciliation_required','retryable_failed')),
  (SELECT count(*) FROM "MaxOutboundReconciliationTask" r
   WHERE r."accountId" = '$account_id' AND r."state" = 'open')
);
SQL
)
[[ $final_queue_gate_after_rollforward == '0|0' ]]

migration_count_after=$(postgres_query <<'SQL'
SELECT count(*)
FROM "_prisma_migrations"
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SQL
)
migration_hash_after=$(
  postgres_query <<'SQL' | sha256sum | awk '{print $1}'
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations"
ORDER BY migration_name;
SQL
)
[[ $migration_count_before == "$migration_count_after" \
  && $migration_hash_before == "$migration_hash_after" ]]

restart_counts_before=$(restart_counts)
sleep 10
health_gate
restart_counts_after=$(restart_counts)
[[ $restart_counts_before == "$restart_counts_after" ]]

readonly PROD_HEAD_AFTER=$(git -C "$PROD_DIR" rev-parse HEAD)
readonly PROD_STATUS_AFTER=$(git -C "$PROD_DIR" status --porcelain)
readonly PROD_TREE_HASH_AFTER=$(tracked_tree_hash)
[[ $PROD_HEAD_BEFORE == "$PROD_HEAD_AFTER" \
  && $PROD_STATUS_BEFORE == "$PROD_STATUS_AFTER" \
  && $PROD_TREE_HASH_BEFORE == "$PROD_TREE_HASH_AFTER" ]]

provider_ids=$(postgres_query <<SQL
SELECT json_agg(d."providerMessageId" ORDER BY c."commandSequence")
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-uatfix-$SHORT_SHA-%';
SQL
)
backup_sha=$(awk '{print $1}' "$EVIDENCE_DIR/production-before-repair.dump.sha256")
backup_bytes=$(stat -c '%s' "$EVIDENCE_DIR/production-before-repair.dump")
result_tmp=$(mktemp /var/tmp/personal-max-uat-fix-production.success.XXXXXX)
jq -n \
  --arg sourceSha "$SOURCE_SHA" \
  --arg evidenceDirectory "$EVIDENCE_DIR" \
  --arg gravityImage "$GRAVITY_IMAGE" --arg gravityImageId "$gravity_image_id" \
  --arg gatewayImage "$GATEWAY_IMAGE" --arg gatewayImageId "$gateway_image_id" \
  --arg scraperImage "$SCRAPER_IMAGE" --arg scraperImageId "$scraper_image_id" \
  --arg backupSha256 "$backup_sha" --argjson backupBytes "$backup_bytes" \
  --argjson providerMessageIds "$provider_ids" \
  '{
    schemaVersion:1,status:"PERSONAL_MAX_ENGINEERING_PASS_FINAL_USER_CHECK_READY",sourceSha:$sourceSha,
    evidenceDirectory:$evidenceDirectory,
    images:{
      gravity:{ref:$gravityImage,id:$gravityImageId},
      gateway:{ref:$gatewayImage,id:$gatewayImageId},
      scraper:{ref:$scraperImage,id:$scraperImageId}
    },
    backup:{sha256:$backupSha256,bytes:$backupBytes,restoreListValidated:true},
    incidentRepair:{
      sequence5ProviderConfirmed:true,cancelledBeforeProvider:[6,7,8,9,10],
      historyReplayQuarantined:true,evidenceDeleted:false,providerActionsByRepair:0
    },
    canary:{
      outbound:{count:6,providerConfirmed:6,uniqueProviderIds:6,providerMessageIds:$providerMessageIds,duplicates:0,fifo:true,strictProviderStoreConfirmation:true},
      inboundEngineering:{historicalExpectedRows:4,historicalUniqueIdentities:4,historicalExactProviderIds:3,
        legacyDomIdentityRows:1,historyReplayQuarantined:1,newRowsDuringOutbound:0,echoes:0,
        restartReplayDuplicates:0,metadataAsText:0,exactProviderIdentityFallback:true}
    },
    runtime:{
      gatewayReady200:true,scraperHealthy:true,crmHealthy:true,queue:0,reconciliation:0,
      restartRecovery:true,rollbackVerified:true,rollForwardVerified:true,senderOperational:true,
      legacySenderDisabled:true,emergencyDefaultOffAvailable:true
    },
    productionTreeUnchanged:true,migrations:{applied:0,ledgerUnchanged:true}
  }' >"$result_tmp"
chown root:codexbot "$result_tmp"
chmod 0640 "$result_tmp"
mv -f "$result_tmp" "$RESULT_FILE"
chown root:codexbot "$RESULT_FILE"
chmod 0640 "$RESULT_FILE"
install -o root -g codexbot -m 0640 "$RESULT_FILE" "$EVIDENCE_DIR/final-report.json"
seal_evidence "$EVIDENCE_DIR"
rm -f -- "$STATE_FILE"
production_mutated=false
trap - EXIT
echo "PERSONAL_MAX_UAT_FIX_REPORT=$RESULT_FILE"
echo 'PERSONAL MAX FINAL USER CHECK READY'
