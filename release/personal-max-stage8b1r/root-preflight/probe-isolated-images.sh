#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $(id -u) -ne 0 ]]; then
  echo 'ROOT_REQUIRED: this probe creates only uniquely named disposable Docker objects' >&2
  exit 77
fi
if [[ $# -ne 2 ]]; then
  echo 'usage: probe-isolated-images.sh <gateway-ref-by-digest> <scraper-ref-by-digest>' >&2
  exit 64
fi
GATEWAY_IMAGE=$1
SCRAPER_IMAGE=$2
[[ "$GATEWAY_IMAGE" =~ ^ghcr\.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:[0-9a-f]{64}$ ]]
[[ "$SCRAPER_IMAGE" =~ ^ghcr\.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:[0-9a-f]{64}$ ]]

for command in docker jq realpath; do command -v "$command" >/dev/null; done
POSTGRES_IMAGE='postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
PREFIX='max-stage8b1r-root-preflight'
LABEL_KEY='com.nashavtopark.personal-max-stage8b1r-run'
NETWORK="$PREFIX-internal"
PG_VOLUME="$PREFIX-postgres"
SPOOL_VOLUME="$PREFIX-spool"
PG_CONTAINER="$PREFIX-postgres"
GATEWAY_CONTAINER="$PREFIX-gateway"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HARNESS=$(realpath "$SCRIPT_DIR/../executable/synthetic-scraper-harness.js")
TMP=$(mktemp -d /tmp/personal-max-stage8b1r.XXXXXX)
chmod 700 "$TMP"
RUN_TOKEN=$(basename "$TMP")
SYNTHETIC_ACCOUNT='stage8b1r'
HMAC_KEY_ID='stage8b1r-root-probe'
HMAC_SECRET='stage8b1r-root-probe-only-00000000000000000000000000000000'
DATABASE_URL='postgresql://stage8b1r:stage8b1r-isolated-only@max-stage8b1r-root-preflight-postgres:5432/stage8b1r?schema=public'
docker ps -aq --no-trunc | sort >"$TMP/containers-before"

collision_exit() {
  echo "$1" >&2
  rm -rf -- "$TMP"
  exit 65
}

for name in "$PG_CONTAINER" "$GATEWAY_CONTAINER"; do
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$name"; then collision_exit "name collision: $name"; fi
done
if docker network inspect "$NETWORK" >/dev/null 2>&1; then collision_exit "network collision: $NETWORK"; fi
for volume in "$PG_VOLUME" "$SPOOL_VOLUME"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then collision_exit "volume collision: $volume"; fi
done

cleanup_labeled_objects() {
  local cleanup_failed=0 object object_list
  local -a objects=()

  object_list=$(docker ps -aq --no-trunc --filter "label=$LABEL_KEY=$RUN_TOKEN") || cleanup_failed=1
  if [[ -n "$object_list" ]]; then
    mapfile -t objects <<<"$object_list"
    for object in "${objects[@]}"; do docker rm -f "$object" >/dev/null 2>&1 || cleanup_failed=1; done
  fi
  object_list=$(docker network ls -q --filter "label=$LABEL_KEY=$RUN_TOKEN") || cleanup_failed=1
  if [[ -n "$object_list" ]]; then
    mapfile -t objects <<<"$object_list"
    for object in "${objects[@]}"; do docker network rm "$object" >/dev/null 2>&1 || cleanup_failed=1; done
  fi
  object_list=$(docker volume ls -q --filter "label=$LABEL_KEY=$RUN_TOKEN") || cleanup_failed=1
  if [[ -n "$object_list" ]]; then
    mapfile -t objects <<<"$object_list"
    for object in "${objects[@]}"; do docker volume rm "$object" >/dev/null 2>&1 || cleanup_failed=1; done
  fi

  object_list=$(docker ps -aq --no-trunc --filter "label=$LABEL_KEY=$RUN_TOKEN") || cleanup_failed=1
  [[ -z "$object_list" ]] || cleanup_failed=1
  object_list=$(docker network ls -q --filter "label=$LABEL_KEY=$RUN_TOKEN") || cleanup_failed=1
  [[ -z "$object_list" ]] || cleanup_failed=1
  object_list=$(docker volume ls -q --filter "label=$LABEL_KEY=$RUN_TOKEN") || cleanup_failed=1
  [[ -z "$object_list" ]] || cleanup_failed=1
  return "$cleanup_failed"
}

on_exit() {
  local original_status=$? cleanup_status=0
  trap - EXIT
  set +e
  cleanup_labeled_objects
  cleanup_status=$?
  rm -rf -- "$TMP" || cleanup_status=1
  if [[ $cleanup_status -ne 0 ]]; then
    echo 'ISOLATED_CLEANUP_FAILED: one or more run-labeled disposable Docker objects remain' >&2
    exit 70
  fi
  exit "$original_status"
}
trap on_exit EXIT

docker pull "$GATEWAY_IMAGE" >/dev/null
docker pull "$SCRAPER_IMAGE" >/dev/null
docker pull "$POSTGRES_IMAGE" >/dev/null
GATEWAY_ID=$(docker image inspect --format '{{.Id}}' "$GATEWAY_IMAGE")
SCRAPER_ID=$(docker image inspect --format '{{.Id}}' "$SCRAPER_IMAGE")
GATEWAY_UID_GID=$(docker run --rm --label "$LABEL_KEY=$RUN_TOKEN" --network none --entrypoint node "$GATEWAY_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')
SCRAPER_UID_GID=$(docker run --rm --label "$LABEL_KEY=$RUN_TOKEN" --network none --entrypoint node "$SCRAPER_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')
test "$GATEWAY_UID_GID" = '1000:1000'
test "$SCRAPER_UID_GID" = '1000:1000'

docker network create --internal --label "$LABEL_KEY=$RUN_TOKEN" "$NETWORK" >/dev/null
docker volume create --label "$LABEL_KEY=$RUN_TOKEN" "$PG_VOLUME" >/dev/null
docker volume create --label "$LABEL_KEY=$RUN_TOKEN" "$SPOOL_VOLUME" >/dev/null
PG_CONTAINER_ID=$(docker run -d --name "$PG_CONTAINER" --label "$LABEL_KEY=$RUN_TOKEN" --network "$NETWORK" \
  -e POSTGRES_USER=stage8b1r -e POSTGRES_PASSWORD=stage8b1r-isolated-only -e POSTGRES_DB=stage8b1r \
  -v "$PG_VOLUME:/var/lib/postgresql/data" "$POSTGRES_IMAGE")
for _ in $(seq 1 60); do
  docker exec "$PG_CONTAINER_ID" pg_isready -U stage8b1r -d stage8b1r >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG_CONTAINER_ID" pg_isready -U stage8b1r -d stage8b1r >/dev/null

docker run --rm --label "$LABEL_KEY=$RUN_TOKEN" --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" --entrypoint sh "$GATEWAY_IMAGE" \
  -c 'exec npx prisma migrate deploy --schema /app/prisma/schema.prisma' >"$TMP/migration.log"

start_gateway() {
  GATEWAY_CONTAINER_ID=$(docker run -d --name "$GATEWAY_CONTAINER" --label "$LABEL_KEY=$RUN_TOKEN" --network "$NETWORK" \
    -e MAX_RAW_JOURNAL_ENABLED="$SYNTHETIC_ACCOUNT" \
    -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$SYNTHETIC_ACCOUNT" \
    -e MAX_PERSONAL_GATEWAY_DATABASE_URL="$DATABASE_URL" \
    -e MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON="{\"$HMAC_KEY_ID\":\"$HMAC_SECRET\"}" \
    -e MAX_PERSONAL_GATEWAY_BIND_HOST=0.0.0.0 \
    -e MAX_PERSONAL_GATEWAY_PRIVATE_NETWORK=required \
    "$GATEWAY_IMAGE")
}
gateway_status() {
  local path=$1 expected=$2
  docker exec "$GATEWAY_CONTAINER_ID" node -e \
    "fetch('http://127.0.0.1:8080${path}',{signal:AbortSignal.timeout(10000)}).then(r=>{if(r.status!==${expected})process.exit(1);return r.json()}).then(v=>process.stdout.write(JSON.stringify(v)))"
}
run_harness() {
  docker run --rm --label "$LABEL_KEY=$RUN_TOKEN" --network "$NETWORK" \
    -e MAX_PERSONAL_ACCOUNT_ID="$SYNTHETIC_ACCOUNT" \
    -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$SYNTHETIC_ACCOUNT" \
    -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool \
    -e MAX_PERSONAL_CAPTURE_INGRESS_URL="http://$GATEWAY_CONTAINER:8080/v1/capture" \
    -e MAX_PERSONAL_CAPTURE_HMAC_KEY_ID="$HMAC_KEY_ID" \
    -e MAX_PERSONAL_CAPTURE_HMAC_SECRET="$HMAC_SECRET" \
    "$@" -v "$SPOOL_VOLUME:/spool" -v "$HARNESS:/tmp/harness.js:ro" \
    --entrypoint node "$SCRAPER_IMAGE" /tmp/harness.js
}

docker run --rm --label "$LABEL_KEY=$RUN_TOKEN" --user 0:0 --network none -v "$SPOOL_VOLUME:/spool" --entrypoint sh "$SCRAPER_IMAGE" \
  -c 'chown 1000:1000 /spool && chmod 0700 /spool'
start_gateway
sleep 2
gateway_status /ready 503 >"$TMP/ready-before-capture.json"
run_harness >"$TMP/initial-capture.json"
gateway_status /ready 200 >"$TMP/ready-after-capture.json"

docker stop "$PG_CONTAINER_ID" >/dev/null
run_harness -e STAGE8B1R_CAPTURE_ONLY=1 >"$TMP/outage-capture.json"
gateway_status /ready 503 >"$TMP/ready-database-down.json"
docker start "$PG_CONTAINER_ID" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG_CONTAINER_ID" pg_isready -U stage8b1r -d stage8b1r >/dev/null 2>&1 && break
  sleep 1
done
docker rm -f "$GATEWAY_CONTAINER_ID" >/dev/null
start_gateway
sleep 2
run_harness -e STAGE8B1R_DRAIN_ONLY=1 >"$TMP/recovery-drain.json"
gateway_status /ready 200 >"$TMP/ready-after-recovery.json"
RAW_ROWS=$(docker exec "$PG_CONTAINER_ID" psql --no-psqlrc -X -A -t -U stage8b1r -d stage8b1r -c 'SELECT count(*) FROM "MaxRawTransportEvent"')
test "$RAW_ROWS" -eq 2

cleanup_labeled_objects
docker ps -aq --no-trunc | sort >"$TMP/containers-after"
cmp "$TMP/containers-before" "$TMP/containers-after"

jq -n \
  --arg gatewayRef "$GATEWAY_IMAGE" --arg scraperRef "$SCRAPER_IMAGE" \
  --arg gatewayId "$GATEWAY_ID" --arg scraperId "$SCRAPER_ID" \
  --arg gatewayUidGid "$GATEWAY_UID_GID" --arg scraperUidGid "$SCRAPER_UID_GID" \
  --argjson rawRows "$RAW_ROWS" \
  '{schemaVersion:1,mode:"ISOLATED_ROOT_EXECUTION",gateway:{ref:$gatewayRef,imageId:$gatewayId,uidGid:$gatewayUidGid},scraper:{ref:$scraperRef,imageId:$scraperId,uidGid:$scraperUidGid},proof:{internalNetworkOnly:true,publicPorts:0,productionSecrets:false,chromiumProfileMounted:false,chromiumLaunched:false,maxContact:false,providerAction:false,migration:true,actualHook:true,databaseOutage:true,gatewayRestart:true,persistentSpool:true,rawRows:$rawRows,duplicates:0,productionContainerIdsUnchanged:true,runLabeledDisposableObjectsRemaining:0,cleanupVerified:true,imagesRetainedByDesign:true}}'
rm -rf -- "$TMP"
trap - EXIT
