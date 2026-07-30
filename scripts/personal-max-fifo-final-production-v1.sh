#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE_DIR=/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z
readonly SCRIPT_PATH=${SOURCE_DIR}/scripts/personal-max-fifo-final-production-v1.sh
readonly EXPECTED_BRANCH=feature/personal-max-text-canary-autonomous-20260728T211316Z
readonly PROD_DIR=/opt/crm
readonly BASE_COMPOSE=/opt/crm/deploy/docker-compose.production.yml
readonly OPERATIONAL_COMPOSE=${SOURCE_DIR}/deploy/docker-compose.personal-max-text-operational.yml
readonly DEFAULT_OFF_COMPOSE=${SOURCE_DIR}/deploy/docker-compose.personal-max-final-default-off.yml
readonly PROD_ENV=/opt/crm/.env.production
readonly OPERATIONAL_ENV=/var/lib/crm/max-personal-text-operational.env
readonly RESULT_FILE=/var/tmp/personal-max-fifo-final-production.json
readonly BASE_COMPOSE_SHA=153c48db0ee5ceecf545a57c257ac7f32886f26de7c9806b4097991124673e47
readonly OPERATIONAL_COMPOSE_SHA=d41a36de5a1a1e5330798d5bd40a5a0adcb84884c5e0748458df11ae2d8eaebd
readonly DEFAULT_OFF_COMPOSE_SHA=1f3b927190535991cc61c89b588c3c6a848c1da687843b2f442cb8f62f64b930
readonly MIN_DOCKER_FREE_BYTES=15000000000

if [[ ${EUID} -ne 0 ]]; then
  echo 'ERROR: root is required for bounded production activation' >&2
  exit 77
fi
if [[ $# -ne 2 || ! $1 =~ ^[0-9a-f]{64}$ || ! $2 =~ ^[0-9a-f]{40}$ ]]; then
  echo 'usage: personal-max-fifo-final-production-v1.sh <script-sha256> <source-sha>' >&2
  exit 64
fi
readonly EXPECTED_SCRIPT_SHA=$1
readonly SOURCE_SHA=$2
if [[ $(sha256sum "$SCRIPT_PATH" | awk '{print $1}') != "$EXPECTED_SCRIPT_SHA" ]]; then
  echo 'ERROR: script checksum mismatch' >&2
  exit 66
fi

for required in "$SOURCE_DIR" "$PROD_DIR" "$BASE_COMPOSE" "$OPERATIONAL_COMPOSE" \
  "$DEFAULT_OFF_COMPOSE" "$PROD_ENV" "$OPERATIONAL_ENV"; do
  [[ -e $required && ! -L $required ]] || { echo "ERROR: unsafe or missing path: $required" >&2; exit 67; }
done
printf '%s  %s\n' "$BASE_COMPOSE_SHA" "$BASE_COMPOSE" \
  "$OPERATIONAL_COMPOSE_SHA" "$OPERATIONAL_COMPOSE" \
  "$DEFAULT_OFF_COMPOSE_SHA" "$DEFAULT_OFF_COMPOSE" | sha256sum -c - >/dev/null
if [[ $(git -C "$SOURCE_DIR" branch --show-current) != "$EXPECTED_BRANCH" \
   || $(git -C "$SOURCE_DIR" rev-parse HEAD) != "$SOURCE_SHA" \
   || $(git -C "$SOURCE_DIR" rev-parse "origin/$EXPECTED_BRANCH") != "$SOURCE_SHA" \
   || -n $(git -C "$SOURCE_DIR" status --porcelain) ]]; then
  echo 'ERROR: source branch, SHA, remote binding, or cleanliness mismatch' >&2
  exit 68
fi

umask 0077
readonly SHORT_SHA=${SOURCE_SHA:0:12}
readonly GRAVITY_IMAGE=crm/gravity-mvp:personal-max-fifo-${SHORT_SHA}
readonly GATEWAY_IMAGE=crm/max-personal-gateway:personal-max-fifo-${SHORT_SHA}
readonly SCRAPER_IMAGE=crm/max-web-scraper:personal-max-fifo-${SHORT_SHA}
readonly STAMP=$(date -u +%Y%m%dT%H%M%SZ)
readonly EVIDENCE_DIR=/var/backups/personal-max-fifo-final-${STAMP}
export PERSONAL_MAX_GRAVITY_IMAGE=$GRAVITY_IMAGE
export PERSONAL_MAX_GATEWAY_IMAGE=$GATEWAY_IMAGE
export PERSONAL_MAX_SCRAPER_IMAGE=$SCRAPER_IMAGE

[[ ! -e $EVIDENCE_DIR ]]
install -d -o root -g codexbot -m 2750 "$EVIDENCE_DIR"

compose_default_off=(
  docker compose --env-file "$PROD_ENV" --env-file "$OPERATIONAL_ENV"
  -f "$BASE_COMPOSE" -f "$OPERATIONAL_COMPOSE" -f "$DEFAULT_OFF_COMPOSE"
)
compose_operational=(
  docker compose --env-file "$PROD_ENV" --env-file "$OPERATIONAL_ENV"
  -f "$BASE_COMPOSE" -f "$DEFAULT_OFF_COMPOSE" -f "$OPERATIONAL_COMPOSE"
)

production_mutated=false
request_file=
response_file=
render_file=

default_off_now() {
  "${compose_default_off[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
    gravity-mvp max-personal-gateway max-web-scraper >/dev/null
}

seal_evidence() {
  find "$EVIDENCE_DIR" -type f -exec chown root:codexbot {} +
  find "$EVIDENCE_DIR" -type f -exec chmod 0640 {} +
  rm -f -- "$EVIDENCE_DIR/SHA256SUMS" "$EVIDENCE_DIR/SHA256SUMS.verify"
  (cd "$EVIDENCE_DIR" && find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name SHA256SUMS.verify -printf '%P\0' \
    | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS)
  (cd "$EVIDENCE_DIR" && sha256sum -c SHA256SUMS >SHA256SUMS.verify)
  chown root:codexbot "$EVIDENCE_DIR/SHA256SUMS" "$EVIDENCE_DIR/SHA256SUMS.verify"
  chmod 0640 "$EVIDENCE_DIR/SHA256SUMS" "$EVIDENCE_DIR/SHA256SUMS.verify"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  [[ -n $request_file ]] && rm -f -- "$request_file"
  [[ -n $response_file ]] && rm -f -- "$response_file"
  [[ -n $render_file ]] && rm -f -- "$render_file"
  if [[ $status -ne 0 && $production_mutated == true ]]; then default_off_now >/dev/null 2>&1; fi
  if [[ $status -ne 0 ]]; then
    jq -n --arg sourceSha "$SOURCE_SHA" --argjson exitStatus "$status" \
      --argjson defaultOffAttempted "$production_mutated" \
      '{schemaVersion:1,status:"BLOCKED_DEFAULT_OFF",sourceSha:$sourceSha,exitStatus:$exitStatus,
        automaticDefaultOffAttempted:$defaultOffAttempted,blindRetry:false}' \
      >"$EVIDENCE_DIR/failure-report.json"
  fi
  seal_evidence
  echo "PERSONAL_MAX_FIFO_EVIDENCE_DIR=$EVIDENCE_DIR"
  exit "$status"
}
trap cleanup EXIT

postgres_query() {
  docker exec -i crm-postgres sh -c \
    'exec psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

env_value() {
  local file=$1 key=$2 line value
  line=$(grep -m1 -E "^${key}=" "$file" || true)
  value=${line#*=}
  if [[ $value == \"*\" && $value == *\" ]]; then value=${value:1:${#value}-2}; fi
  if [[ $value == \'*\' && $value == *\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

tracked_tree_hash() {
  git -C "$PROD_DIR" ls-files -z | sort -z | while IFS= read -r -d '' file; do
    if [[ -f $PROD_DIR/$file ]]; then sha256sum "$PROD_DIR/$file"
    elif [[ -L $PROD_DIR/$file ]]; then printf 'SYMLINK  %s  %s\n' "$file" "$(readlink "$PROD_DIR/$file")"
    else printf 'MISSING  %s\n' "$file"; fi
  done | sha256sum | awk '{print $1}'
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
  docker build --pull=false --build-arg SOURCE_COMMIT="$SOURCE_SHA" \
    --build-arg BUILD_TIMESTAMP="$BUILD_TIMESTAMP" "$@" -f "$dockerfile" -t "$image" "$context"
  [[ $(image_revision "$image") == "$SOURCE_SHA" ]]
  docker builder prune --all --force >/dev/null
}

health_gate() {
  docker exec crm-max-personal-gateway node -e \
    "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
  docker exec crm-max-scraper node -e \
    "fetch('http://127.0.0.1:3005/health').then(async r=>{const b=await r.json();process.exit(r.status===200&&b.isReady===true&&b.queueLength===0?0:1)}).catch(()=>process.exit(1))"
  docker exec crm-gravity-mvp node -e \
    "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
}

actual_default_off_gate() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq -e '
    (map(select(.Name=="/crm-gravity-mvp"))[0].Config.Env|index("MAX_PERSONAL_DURABLE_TEXT_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED=true"))!=null' >/dev/null
}

actual_operational_gate() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq -e '
    (map(select(.Name=="/crm-gravity-mvp"))[0].Config.Env|index("MAX_PERSONAL_DURABLE_TEXT_ENABLED=true"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_ENABLED=true"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=true"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=true"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_ENABLED=true"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=true"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=true"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED=true"))!=null' >/dev/null
}

actual_release_images_gate() {
  [[ $(docker inspect --format '{{.Config.Image}}' crm-gravity-mvp) == "$GRAVITY_IMAGE" \
    && $(docker inspect --format '{{.Config.Image}}' crm-max-personal-gateway) == "$GATEWAY_IMAGE" \
    && $(docker inspect --format '{{.Config.Image}}' crm-max-scraper) == "$SCRAPER_IMAGE" ]]
}

canary_hash() {
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT c."commandSequence",c."clientMessageId",c."commandPayload"->>'text',d."state",d."providerMessageId",
       d."attemptCount",m."status",m."externalId",a."attemptState",a."physicalActionStartedAt",a."completedAt"
FROM "MaxOutboundCommand" c
JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
JOIN "Message" m ON m."clientMessageId"=c."clientMessageId"
JOIN "MaxOutboundDispatchAttempt" a ON a."dispatchId"=d."dispatchId"
WHERE c."clientMessageId" LIKE 'pmax-fifo-${SHORT_SHA}-%'
ORDER BY c."commandSequence";
SQL
}

readonly PROD_HEAD_BEFORE=$(git -C "$PROD_DIR" rev-parse HEAD)
readonly PROD_STATUS_BEFORE=$(git -C "$PROD_DIR" status --porcelain)
readonly PROD_TREE_HASH_BEFORE=$(tracked_tree_hash)
readonly BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

docker_root=$(docker info --format '{{.DockerRootDir}}')
docker_free_bytes=$(df --output=avail -B1 "$docker_root" | tail -n 1 | tr -d ' ')
[[ $docker_root == /* && -d $docker_root && ! -L $docker_root \
  && $docker_free_bytes =~ ^[0-9]+$ && $docker_free_bytes -ge $MIN_DOCKER_FREE_BYTES ]]
jq -n --arg dockerRoot "$docker_root" --argjson freeBytes "$docker_free_bytes" \
  --argjson minimum "$MIN_DOCKER_FREE_BYTES" \
  '{schemaVersion:1,dockerRoot:$dockerRoot,freeBytes:$freeBytes,minimum:$minimum,passed:true}' \
  >"$EVIDENCE_DIR/storage-before.json"

account_id=$(env_value "$OPERATIONAL_ENV" MAX_PERSONAL_ACCOUNT_ID)
[[ $account_id =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]
existing_canaries=$(postgres_query <<SQL
SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.index), '[]'::json)
FROM (
  SELECT right(c."clientMessageId",2)::int AS index,c."commandPayload"->>'text' AS content,
         d."state",d."providerMessageId",d."attemptCount",m."status",m."externalId",
         (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a WHERE a."dispatchId"=d."dispatchId") AS attempts,
         (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a WHERE a."dispatchId"=d."dispatchId" AND a."physicalActionStartedAt" IS NOT NULL) AS physical
  FROM "MaxOutboundCommand" c
  LEFT JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
  LEFT JOIN "Message" m ON m."clientMessageId"=c."clientMessageId"
  WHERE c."clientMessageId" LIKE 'pmax-fifo-${SHORT_SHA}-%'
) x;
SQL
)
jq -e '
  to_entries | all(.value.index == (.key+1) and .value.content == ("PMAX FIFO FINAL " + ((.key+1)|tostring|if length==1 then "0"+. else . end)) and
    .value.state=="provider_confirmed" and .value.attemptCount==1 and .value.attempts==1 and .value.physical==1 and
    .value.status=="delivered" and .value.externalId==.value.providerMessageId and
    (.value.providerMessageId|test("^d301[0-9a-f]{14}$";"i")))' <<<"$existing_canaries" >/dev/null
existing_count=$(jq length <<<"$existing_canaries")
[[ $existing_count -ge 0 && $existing_count -le 10 ]]
jq -n --argjson existing "$existing_canaries" --argjson confirmedPrefix "$existing_count" \
  '{schemaVersion:1,existing:$existing,confirmedPrefix:$confirmedPrefix,resumeSafe:true,blindRetry:false}' \
  >"$EVIDENCE_DIR/preexisting-canary-gate.private.json"

migration_count_before=$(postgres_query <<'SQL'
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SQL
)
migration_hash_before=$(postgres_query <<'SQL' | sha256sum | awk '{print $1}'
SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name;
SQL
)

# Fresh, restore-list-validated production backup precedes the rollout.
docker exec crm-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  >"$EVIDENCE_DIR/production-before-fifo-rollout.dump"
test -s "$EVIDENCE_DIR/production-before-fifo-rollout.dump"
docker exec -i crm-postgres pg_restore --list <"$EVIDENCE_DIR/production-before-fifo-rollout.dump" \
  >"$EVIDENCE_DIR/production-before-fifo-rollout.restore-list"
sha256sum "$EVIDENCE_DIR/production-before-fifo-rollout.dump" \
  >"$EVIDENCE_DIR/production-before-fifo-rollout.dump.sha256"
tar -czf "$EVIDENCE_DIR/runtime-config-before-fifo-rollout.tar.gz" \
  -C / opt/crm/.env.production var/lib/crm/max-personal-text-operational.env \
  -C "$SOURCE_DIR" deploy/docker-compose.personal-max-final-default-off.yml \
    deploy/docker-compose.personal-max-text-operational.yml

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
for image in "$GRAVITY_IMAGE" "$GATEWAY_IMAGE" "$SCRAPER_IMAGE"; do
  [[ $(image_revision "$image") == "$SOURCE_SHA" ]]
  docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image"
done >"$EVIDENCE_DIR/immutable-images.txt"

render_file=$(mktemp /var/tmp/personal-max-fifo-default-off.XXXXXX)
"${compose_default_off[@]}" config --format json >"$render_file"
jq -e '.services["gravity-mvp"].environment.MAX_PERSONAL_DURABLE_TEXT_ENABLED=="false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED=="false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED=="false"' "$render_file" >/dev/null
rm -f -- "$render_file"; render_file=
production_mutated=true
default_off_now
health_gate
actual_default_off_gate

"${compose_operational[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
  gravity-mvp max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate
actual_release_images_gate

chat_id=$(postgres_query <<SQL
SELECT min(m."chatId")
FROM "Message" m
JOIN "MaxOutboundCommand" c ON c."clientMessageId"=m."clientMessageId"
JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
WHERE c."accountId"='$account_id' AND c."clientMessageId" LIKE 'pmax-uatfix-%' AND d."state"='provider_confirmed'
HAVING count(DISTINCT m."chatId")=1;
SQL
)
[[ $chat_id =~ ^[A-Za-z0-9_-]{8,256}$ ]]

if (( existing_count < 10 )); then
  request_file=$(mktemp /var/tmp/personal-max-fifo-requests.XXXXXX)
  response_file=$(mktemp /var/tmp/personal-max-fifo-responses.XXXXXX)
  jq -n --arg chatId "$chat_id" --arg prefix "pmax-fifo-${SHORT_SHA}-" --argjson start "$((existing_count+1))" '
    [range($start;11) | {chatId:$chatId,channel:"max",
      content:("PMAX FIFO FINAL " + (tostring|if length==1 then "0"+. else . end)),
      clientMessageId:($prefix + (tostring|if length==1 then "0"+. else . end))}]' >"$request_file"
  docker exec -i crm-gravity-mvp node -e '
    let input="";
    process.stdin.on("data",chunk=>{input+=chunk});
    process.stdin.on("end",async()=>{
      try {
        const requests=JSON.parse(input); const responses=[]; let tail=Promise.resolve();
        const registered=requests.map(request=>{
          const current=tail.then(async()=>{
            const response=await fetch("http://127.0.0.1:3002/api/messages",{
              method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request),
            });
            const body=await response.json();
            if(!response.ok) throw new Error("bounded CRM request failed");
            responses.push(body); return body;
          });
          tail=current.then(()=>undefined); return current;
        });
        await Promise.all(registered); process.stdout.write(JSON.stringify(responses));
      } catch { process.exitCode=2; }
    });
  ' <"$request_file" >"$response_file"
  jq -e 'length>0 and all(.success==true and .status=="delivered" and .deliveryConfirmed==true and
    (.externalId|test("^d301[0-9a-f]{14}$";"i")) and .metadata.maxDelivery.status=="provider_confirmed" and
    .metadata.maxDelivery.deliveryConfirmed==true)' \
    "$response_file" >/dev/null
  jq '[.[]|{success,status,deliveryConfirmed,externalId,maxDelivery:.metadata.maxDelivery}]' \
    "$response_file" >"$EVIDENCE_DIR/crm-canary-responses.private.json"
  rm -f -- "$request_file" "$response_file"; request_file=; response_file=
fi

postgres_query >"$EVIDENCE_DIR/outbound-fifo-verification.private.csv" <<SQL
COPY (
  SELECT c."commandSequence",c."clientMessageId",c."commandPayload"->>'text' AS text,d."state",d."providerMessageId",
         d."attemptCount",m."status",m."externalId",a."attemptState",a."physicalActionStartedAt",a."completedAt",
         c."accountId",c."conversationKey"
  FROM "MaxOutboundCommand" c JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
  JOIN "Message" m ON m."clientMessageId"=c."clientMessageId"
  JOIN "MaxOutboundDispatchAttempt" a ON a."dispatchId"=d."dispatchId"
  WHERE c."clientMessageId" LIKE 'pmax-fifo-${SHORT_SHA}-%' ORDER BY c."commandSequence"
) TO STDOUT WITH CSV HEADER
SQL

fifo_gate=$(postgres_query <<SQL
WITH rows AS (
  SELECT c."commandSequence",right(c."clientMessageId",2)::int AS index,c."commandPayload"->>'text' AS text,
         c."accountId",c."conversationKey",d."state",d."providerMessageId",d."attemptCount",
         m."status",m."externalId",a."attemptState",a."physicalActionStartedAt",a."completedAt",
         lag(a."completedAt") OVER (ORDER BY c."commandSequence") AS previous_completed,
         lag(d."providerMessageId") OVER (ORDER BY c."commandSequence") AS previous_provider_id
  FROM "MaxOutboundCommand" c JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
  JOIN "Message" m ON m."clientMessageId"=c."clientMessageId"
  JOIN "MaxOutboundDispatchAttempt" a ON a."dispatchId"=d."dispatchId"
  WHERE c."clientMessageId" LIKE 'pmax-fifo-${SHORT_SHA}-%'
)
SELECT concat_ws('|',count(*),count(DISTINCT "providerMessageId"),count(DISTINCT "conversationKey"),
 count(*) FILTER (WHERE "state"='provider_confirmed' AND "attemptState"='provider_confirmed' AND "attemptCount"=1),
 count(*) FILTER (WHERE "status"='delivered' AND "externalId"="providerMessageId"),
 count(*) FILTER (WHERE "accountId"='$account_id'),
 count(*) FILTER (WHERE text='PMAX FIFO FINAL '||lpad(index::text,2,'0')),
 count(*) FILTER (WHERE previous_completed IS NULL OR "physicalActionStartedAt">=previous_completed),
 count(*) FILTER (WHERE previous_provider_id IS NULL OR lower("providerMessageId")>lower(previous_provider_id)),
 max("commandSequence")-min("commandSequence")) FROM rows;
SQL
)
[[ $fifo_gate == '10|10|1|10|10|10|10|10|10|9' ]]

route_gate=$(postgres_query <<SQL
WITH scope AS (SELECT DISTINCT "conversationKey" FROM "MaxOutboundCommand" WHERE "clientMessageId" LIKE 'pmax-fifo-${SHORT_SHA}-%')
SELECT concat_ws('|',
 (SELECT count(*) FROM scope),
 (SELECT count(*) FROM "MaxRouteConversation" r JOIN scope s ON s."conversationKey"=r."conversationKey"
   WHERE r."accountId"='$account_id' AND r."state"='active'),
 (SELECT count(*) FROM "MaxRouteConflict" c JOIN scope s ON s."conversationKey" IN (c."incumbentConversationKey",c."candidateConversationKey")
   WHERE c."accountId"='$account_id' AND c."status"='open'),
 (SELECT count(*) FROM "MaxOutboundDispatch" d WHERE d."accountId"='$account_id'
   AND d."state" IN ('queued','dispatching','sent_to_provider_client','awaiting_confirmation','reconciliation_required','retryable_failed')),
 (SELECT count(*) FROM "MaxOutboundReconciliationTask" r WHERE r."accountId"='$account_id' AND r."state"='open'));
SQL
)
[[ $route_gate == '1|1|0|0|0' ]]

canary_hash_before_restart=$(canary_hash)
"${compose_operational[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 300 \
  max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate
actual_release_images_gate
sleep 30
health_gate
canary_hash_after_restart=$(canary_hash)
[[ $canary_hash_before_restart == "$canary_hash_after_restart" ]]

default_off_now
health_gate
actual_default_off_gate
canary_hash_default_off=$(canary_hash)
[[ $canary_hash_before_restart == "$canary_hash_default_off" ]]
"${compose_operational[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
  gravity-mvp max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate
actual_release_images_gate
canary_hash_rollforward=$(canary_hash)
[[ $canary_hash_before_restart == "$canary_hash_rollforward" ]]

final_queue_gate=$(postgres_query <<SQL
SELECT concat_ws('|',
 (SELECT count(*) FROM "MaxOutboundDispatch" WHERE "accountId"='$account_id' AND "state" IN ('queued','dispatching','sent_to_provider_client','awaiting_confirmation','reconciliation_required','retryable_failed')),
 (SELECT count(*) FROM "MaxOutboundReconciliationTask" WHERE "accountId"='$account_id' AND "state"='open'));
SQL
)
[[ $final_queue_gate == '0|0' ]]

migration_count_after=$(postgres_query <<'SQL'
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SQL
)
migration_hash_after=$(postgres_query <<'SQL' | sha256sum | awk '{print $1}'
SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name;
SQL
)
[[ $migration_count_before == "$migration_count_after" && $migration_hash_before == "$migration_hash_after" ]]

restart_counts_before=$(docker inspect --format '{{.Name}}={{.RestartCount}}' \
  crm-gravity-mvp crm-max-personal-gateway crm-max-scraper)
sleep 10
health_gate
restart_counts_after=$(docker inspect --format '{{.Name}}={{.RestartCount}}' \
  crm-gravity-mvp crm-max-personal-gateway crm-max-scraper)
[[ $restart_counts_before == "$restart_counts_after" ]]

readonly PROD_HEAD_AFTER=$(git -C "$PROD_DIR" rev-parse HEAD)
readonly PROD_STATUS_AFTER=$(git -C "$PROD_DIR" status --porcelain)
readonly PROD_TREE_HASH_AFTER=$(tracked_tree_hash)
[[ $PROD_HEAD_BEFORE == "$PROD_HEAD_AFTER" && $PROD_STATUS_BEFORE == "$PROD_STATUS_AFTER" \
  && $PROD_TREE_HASH_BEFORE == "$PROD_TREE_HASH_AFTER" ]]

provider_ids=$(postgres_query <<SQL
SELECT json_agg(d."providerMessageId" ORDER BY c."commandSequence")
FROM "MaxOutboundCommand" c JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
WHERE c."clientMessageId" LIKE 'pmax-fifo-${SHORT_SHA}-%';
SQL
)
backup_sha=$(awk '{print $1}' "$EVIDENCE_DIR/production-before-fifo-rollout.dump.sha256")
backup_bytes=$(stat -c '%s' "$EVIDENCE_DIR/production-before-fifo-rollout.dump")
jq -n --arg sourceSha "$SOURCE_SHA" --arg evidenceDirectory "$EVIDENCE_DIR" \
  --arg gravityImage "$GRAVITY_IMAGE" --arg gatewayImage "$GATEWAY_IMAGE" --arg scraperImage "$SCRAPER_IMAGE" \
  --arg backupSha "$backup_sha" --argjson backupBytes "$backup_bytes" --argjson providerIds "$provider_ids" \
  '{schemaVersion:1,status:"PERSONAL_MAX_FIFO_FINAL_USER_CHECK_READY",sourceSha:$sourceSha,
    evidenceDirectory:$evidenceDirectory,images:{gravity:$gravityImage,gateway:$gatewayImage,scraper:$scraperImage},
    backup:{sha256:$backupSha,bytes:$backupBytes,restoreListValidated:true},
    canary:{count:10,exactlyOnce:true,fifo:true,uniqueProviderIds:10,providerMessageIds:$providerIds,
      providerConfirmed:10,blindRetries:0,duplicateProviderActions:0,correctAccount:true,correctRoute:true},
    runtime:{gatewayReady200:true,scraperHealthy:true,crmHealthy:true,queue:0,reconciliation:0,
      restartRecovery:true,defaultOffVerified:true,rollForwardVerified:true,senderOperational:true,
      legacyDomSenderDisabled:true,rollbackAvailable:true},
    productionTreeUnchanged:true,migrationLedgerUnchanged:true,temporaryFlagsRemaining:false}' \
  >"$EVIDENCE_DIR/final-report.json"
install -o root -g codexbot -m 0640 "$EVIDENCE_DIR/final-report.json" "$RESULT_FILE"
seal_evidence
production_mutated=false
trap - EXIT
echo "PERSONAL_MAX_FIFO_FINAL_REPORT=$RESULT_FILE"
echo 'PERSONAL MAX FIFO FINAL USER CHECK READY'
