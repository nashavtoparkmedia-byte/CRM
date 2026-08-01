#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE_DIR=/home/codexbot/releases/personal-max-text-v1
readonly SCRIPT_PATH=${SOURCE_DIR}/scripts/personal-max-rc3-contact-identity-production-v1.sh
readonly EXPECTED_BRANCH=release/personal-max-text-v1
readonly PROD_DIR=/opt/crm
readonly BASE_COMPOSE=/opt/crm/deploy/docker-compose.production.yml
readonly DEFAULT_OFF_COMPOSE=${SOURCE_DIR}/deploy/docker-compose.personal-max-final-default-off.yml
readonly OPERATIONAL_COMPOSE=${SOURCE_DIR}/deploy/docker-compose.personal-max-text-operational.yml
readonly PROD_ENV=/opt/crm/.env.production
readonly OPERATIONAL_ENV=/var/lib/crm/max-personal-text-operational.env
readonly RESULT_FILE=/var/tmp/personal-max-rc3-contact-identity-production.json
readonly MIN_DOCKER_FREE_BYTES=15000000000
readonly REPAIR_ACTOR=personal_max_rc3_contact_identity_repair
readonly TARGET_MESSAGE_ID=msg_1785617763194
readonly TARGET_CLIENT_MESSAGE_ID=cmid-1785617763428-mo6q1n

readonly A_PHONE=+79222155750
readonly A_SOURCE_CONTACT=cmrjjp0s400esrb24ahlvlhci
readonly A_TARGET_CONTACT=cmsaup40o0010ox0j8zyrwtlz
readonly A_PHONE_ID=cmrjjp0s600eurb24x4i8vcwr
readonly A_PROTOCOL_CHAT_ID=902144614300
readonly A_PROVIDER_USER_ID=901970535612
readonly A_WEB_ROUTE_ID=201482140
readonly A_CONVERSATION_KEY=conv_pmax_rc3_902144614300

readonly B_PHONE=+79126787532
readonly B_SOURCE_CONTACT=cmqqnj6fu00dlrx2a3452e9we
readonly B_TARGET_CONTACT=cmr5c2utp00emq52gv9104r2y
readonly B_PHONE_ID=cmqqnj6fx00dnrx2a6g64g0gv
readonly B_PROTOCOL_CHAT_ID=902454841098
readonly B_PROVIDER_USER_ID=902264026154
readonly B_OLD_PROVIDER_USER_ID=511708938
readonly B_WEB_ROUTE_ID=511708938
readonly B_CONVERSATION_KEY=conv_85417312-49a3-40f3-849e-caf3db91ff10

readonly RC2_GRAVITY_IMAGE=crm/gravity-mvp:personal-max-rc2-burst-e2711dc02d06
readonly RC2_GATEWAY_IMAGE=crm/max-personal-gateway:personal-max-rc2-burst-e2711dc02d06
readonly RC2_SCRAPER_IMAGE=crm/max-web-scraper:personal-max-rc2-burst-e2711dc02d06

if [[ ${EUID} -ne 0 ]]; then
  echo 'ERROR: root is required for bounded production repair and rollout' >&2
  exit 77
fi

if [[ $# -ne 3 || ! $1 =~ ^[0-9a-f]{64}$ || ! $2 =~ ^[0-9a-f]{40}$ || ! $3 =~ ^(dry-run|apply)$ ]]; then
  echo 'usage: personal-max-rc3-contact-identity-production-v1.sh <script-sha256> <source-sha> <dry-run|apply>' >&2
  exit 64
fi

readonly EXPECTED_SCRIPT_SHA=$1
readonly SOURCE_SHA=$2
readonly MODE=$3
readonly SHORT_SHA=${SOURCE_SHA:0:12}
readonly GRAVITY_IMAGE=crm/gravity-mvp:personal-max-rc3-contact-${SHORT_SHA}
readonly GATEWAY_IMAGE=crm/max-personal-gateway:personal-max-rc3-contact-${SHORT_SHA}
readonly SCRAPER_IMAGE=crm/max-web-scraper:personal-max-rc3-contact-${SHORT_SHA}
readonly STAMP=$(date -u +%Y%m%dT%H%M%SZ)
readonly EVIDENCE_DIR=/var/backups/personal-max-rc3-contact-identity-${STAMP}

export PERSONAL_MAX_GRAVITY_IMAGE=$GRAVITY_IMAGE
export PERSONAL_MAX_GATEWAY_IMAGE=$GATEWAY_IMAGE
export PERSONAL_MAX_SCRAPER_IMAGE=$SCRAPER_IMAGE

if [[ $(sha256sum "$SCRIPT_PATH" | awk '{print $1}') != "$EXPECTED_SCRIPT_SHA" ]]; then
  echo 'ERROR: script checksum mismatch' >&2
  exit 66
fi

for required in "$SOURCE_DIR" "$PROD_DIR" "$BASE_COMPOSE" "$DEFAULT_OFF_COMPOSE" \
  "$OPERATIONAL_COMPOSE" "$PROD_ENV" "$OPERATIONAL_ENV"; do
  [[ -e $required && ! -L $required ]] || { echo "ERROR: unsafe or missing path: $required" >&2; exit 67; }
done

if [[ $(git -C "$SOURCE_DIR" branch --show-current) != "$EXPECTED_BRANCH" \
   || $(git -C "$SOURCE_DIR" rev-parse HEAD) != "$SOURCE_SHA" \
   || $(git -C "$SOURCE_DIR" rev-parse '@{u}') != "$SOURCE_SHA" \
   || $(git -C "$SOURCE_DIR" ls-remote origin "refs/heads/${EXPECTED_BRANCH}" | awk '{print $1}') != "$SOURCE_SHA" \
   || -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]]; then
  echo 'ERROR: source branch, SHA, upstream/remote binding, or cleanliness mismatch' >&2
  exit 68
fi

umask 0077
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
restore_container=
request_file=
response_file=

postgres_query() {
  docker exec -i crm-postgres sh -c \
    'exec psql -X -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

postgres_query_account() {
  docker exec -i -e PMAX_ACCOUNT_ID="$ACCOUNT_ID" crm-postgres sh -c \
    'exec psql -X -v ON_ERROR_STOP=1 -qAt -v account_id="$PMAX_ACCOUNT_ID" -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
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

default_off_now() {
  "${compose_default_off[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
    gravity-mvp max-personal-gateway max-web-scraper >/dev/null
}

operational_now() {
  "${compose_operational[@]}" up -d --no-build --pull never --wait --wait-timeout 300 \
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
  [[ -n ${request_file:-} ]] && rm -f -- "$request_file"
  [[ -n ${response_file:-} ]] && rm -f -- "$response_file"
  [[ -n ${restore_container:-} ]] && docker rm -f "$restore_container" >/dev/null 2>&1
  if [[ $status -ne 0 && $production_mutated == true ]]; then
    default_off_now >/dev/null 2>&1
  fi
  if [[ $status -ne 0 ]]; then
    jq -n --arg mode "$MODE" --arg sourceSha "$SOURCE_SHA" --arg evidenceDirectory "$EVIDENCE_DIR" \
      --argjson exitStatus "$status" --argjson defaultOffAttempted "$([[ $production_mutated == true ]] && echo true || echo false)" \
      '{schemaVersion:1,status:"BLOCKED_DEFAULT_OFF",mode:$mode,sourceSha:$sourceSha,evidenceDirectory:$evidenceDirectory,
        exitStatus:$exitStatus,automaticDefaultOffAttempted:$defaultOffAttempted,
        blindRetry:false,newCrmBubbleCreated:false}' \
      >"$EVIDENCE_DIR/failure-report.json"
  fi
  seal_evidence
  echo "PERSONAL_MAX_RC3_CONTACT_IDENTITY_EVIDENCE_DIR=$EVIDENCE_DIR"
  exit "$status"
}
trap cleanup EXIT

safe_runtime_snapshot() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq '
    map({
      name:.Name,
      image:.Config.Image,
      imageId:.Image,
      restartCount:.RestartCount,
      health:(.State.Health.Status // null),
      status:.State.Status,
      labels:(.Config.Labels // {}),
      personalMaxEnv:[
        (.Config.Env // [])[]
        | select(test("^(MAX_|PERSONAL_MAX_|NEXT_PUBLIC_MAX_)"))
        | if test("(SECRET|TOKEN|KEYS_JSON|DATABASE_URL|HMAC)") then sub("=.*$";"=<redacted>")
          elif test("^MAX_PERSONAL_ACCOUNT_ID=") then sub("=.*$";"=<set>")
          else . end
      ]
    })'
}

health_gate() {
  docker exec crm-max-personal-gateway node -e \
    "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
  docker exec crm-max-scraper node -e \
    "fetch('http://127.0.0.1:3005/health').then(async r=>{const b=await r.json();process.exit(r.status===200&&b.isReady===true&&b.queueLength===0?0:1)}).catch(()=>process.exit(1))"
  docker exec crm-gravity-mvp node -e \
    "fetch('http://127.0.0.1:3002/messages').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
}

actual_default_off_gate() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq -e '
    (map(select(.Name=="/crm-gravity-mvp"))[0].Config.Env|index("MAX_PERSONAL_DURABLE_TEXT_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false"))!=null and
    (map(select(.Name=="/crm-max-scraper"))[0].Config.Env|index("MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false"))!=null' >/dev/null
}

actual_operational_gate() {
  docker inspect crm-gravity-mvp crm-max-personal-gateway crm-max-scraper | jq -e '
    (map(select(.Name=="/crm-gravity-mvp"))[0].Config.Env|index("MAX_PERSONAL_DURABLE_TEXT_ENABLED=true"))!=null and
    (map(select(.Name=="/crm-max-personal-gateway"))[0].Config.Env|index("MAX_ROUTE_REGISTRY_ENABLED="+env.ACCOUNT_ID))!=null and
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
}

route_evidence_json() {
  local kind=$1 value=$2 conversation_key=$3 authority=$4
  jq -cn --arg repair "personal-max-rc3-contact-identity-v1" --arg actor "$REPAIR_ACTOR" \
    --arg accountId "$ACCOUNT_ID" --arg kind "$kind" --arg value "$value" \
    --arg conversationKey "$conversation_key" --arg authority "$authority" \
    '{schemaVersion:1,repair:$repair,actor:$actor,accountId:$accountId,identity:{kind:$kind,value:$value},
      conversationKey:$conversationKey,evidenceAuthority:$authority,
      source:"root_operator_verified_existing_contact_and_chat_evidence",messageTextPrinted:false,payloadPrinted:false}'
}

stable_idempotency_key() {
  local seed=$1
  printf '%s' "$seed" | sha256sum | awk '{print $1}'
}

repair_sql() {
  local apply=$1
  local rollback_command=ROLLBACK
  local psql_apply=false
  if [[ $apply == 1 ]]; then rollback_command=COMMIT; psql_apply=true; fi
  docker exec -i \
    -e PMAX_ACCOUNT_ID="$ACCOUNT_ID" \
    -e A_PROTOCOL_EVIDENCE_JSON="$a_protocol_evidence_json" \
    -e A_PROVIDER_EVIDENCE_JSON="$a_provider_evidence_json" \
    -e A_WEB_EVIDENCE_JSON="$a_web_evidence_json" \
    -e B_PROVIDER_EVIDENCE_JSON="$b_provider_evidence_json" \
    -e A_PROTOCOL_EVIDENCE_SHA="$a_protocol_evidence_sha" \
    -e A_PROVIDER_EVIDENCE_SHA="$a_provider_evidence_sha" \
    -e A_WEB_EVIDENCE_SHA="$a_web_evidence_sha" \
    -e B_PROVIDER_EVIDENCE_SHA="$b_provider_evidence_sha" \
    -e A_PROTOCOL_EVIDENCE_SIZE="$a_protocol_evidence_size" \
    -e A_PROVIDER_EVIDENCE_SIZE="$a_provider_evidence_size" \
    -e A_WEB_EVIDENCE_SIZE="$a_web_evidence_size" \
    -e B_PROVIDER_EVIDENCE_SIZE="$b_provider_evidence_size" \
    -e A_PROTOCOL_IDEMPOTENCY_KEY="$a_protocol_idempotency_key" \
    -e A_PROVIDER_IDEMPOTENCY_KEY="$a_provider_idempotency_key" \
    -e A_WEB_IDEMPOTENCY_KEY="$a_web_idempotency_key" \
    -e B_PROVIDER_IDEMPOTENCY_KEY="$b_provider_idempotency_key" \
    -e PMAX_REPAIR_APPLY="$psql_apply" \
    crm-postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 \
      -v account_id="$PMAX_ACCOUNT_ID" \
      -v a_protocol_evidence_json="$A_PROTOCOL_EVIDENCE_JSON" \
      -v a_provider_evidence_json="$A_PROVIDER_EVIDENCE_JSON" \
      -v a_web_evidence_json="$A_WEB_EVIDENCE_JSON" \
      -v b_provider_evidence_json="$B_PROVIDER_EVIDENCE_JSON" \
      -v a_protocol_evidence_sha="$A_PROTOCOL_EVIDENCE_SHA" \
      -v a_provider_evidence_sha="$A_PROVIDER_EVIDENCE_SHA" \
      -v a_web_evidence_sha="$A_WEB_EVIDENCE_SHA" \
      -v b_provider_evidence_sha="$B_PROVIDER_EVIDENCE_SHA" \
      -v a_protocol_evidence_size="$A_PROTOCOL_EVIDENCE_SIZE" \
      -v a_provider_evidence_size="$A_PROVIDER_EVIDENCE_SIZE" \
      -v a_web_evidence_size="$A_WEB_EVIDENCE_SIZE" \
      -v b_provider_evidence_size="$B_PROVIDER_EVIDENCE_SIZE" \
      -v a_protocol_idempotency_key="$A_PROTOCOL_IDEMPOTENCY_KEY" \
      -v a_provider_idempotency_key="$A_PROVIDER_IDEMPOTENCY_KEY" \
      -v a_web_idempotency_key="$A_WEB_IDEMPOTENCY_KEY" \
      -v b_provider_idempotency_key="$B_PROVIDER_IDEMPOTENCY_KEY" \
      -v apply="$PMAX_REPAIR_APPLY" \
      -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtext('personal-max-rc3-contact-identity-v1'));
SET LOCAL rc3.account_id TO :'account_id';

CREATE TEMP TABLE rc3_pairs (
  label text PRIMARY KEY,
  phone text NOT NULL,
  source_contact text NOT NULL,
  target_contact text NOT NULL,
  phone_id text NOT NULL
) ON COMMIT DROP;
INSERT INTO rc3_pairs VALUES
  ('A', '$A_PHONE', '$A_SOURCE_CONTACT', '$A_TARGET_CONTACT', '$A_PHONE_ID'),
  ('B', '$B_PHONE', '$B_SOURCE_CONTACT', '$B_TARGET_CONTACT', '$B_PHONE_ID');

CREATE TEMP TABLE rc3_optional_task_plan (
  tasks_to_move int NOT NULL DEFAULT 0
) ON COMMIT DROP;
INSERT INTO rc3_optional_task_plan VALUES (0);
DO \$\$
DECLARE
  task_count int;
BEGIN
  IF to_regclass('public."Task"') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM rc3_pairs p JOIN "Task" t ON t."contactId"=p.source_contact'
      INTO task_count;
    UPDATE rc3_optional_task_plan SET tasks_to_move=task_count;
  END IF;
END
\$\$;

CREATE TEMP TABLE rc3_plan AS
SELECT
  (SELECT count(*) FROM rc3_pairs p JOIN "Contact" c ON c.id=p.source_contact WHERE c."isArchived"=false) AS source_contacts_active,
  (SELECT count(*) FROM rc3_pairs p JOIN "ContactPhone" ph ON ph.id=p.phone_id WHERE ph."contactId"=p.source_contact) AS phones_to_move,
  (SELECT count(*) FROM rc3_pairs p JOIN "ContactIdentity" i ON i."contactId"=p.source_contact) AS identities_to_move,
  (SELECT count(*) FROM rc3_pairs p JOIN "Chat" ch ON ch."contactId"=p.source_contact) AS chats_to_move,
  (SELECT tasks_to_move FROM rc3_optional_task_plan) AS tasks_to_move,
  (SELECT count(*) FROM rc3_pairs p JOIN "Call" ca ON ca."contactId"=p.source_contact) AS calls_to_move,
  (SELECT count(*) FROM rc3_pairs p JOIN "Driver" d ON d."contactId"=p.source_contact) AS driver_profiles_to_move,
  (SELECT count(*) FROM "ContactMerge" cm WHERE cm."survivorId" IN ('$A_TARGET_CONTACT','$B_TARGET_CONTACT') AND cm."mergedId" IN ('$A_SOURCE_CONTACT','$B_SOURCE_CONTACT') AND cm."mergedBy"='$REPAIR_ACTOR' AND cm.action='merge') AS existing_repair_merges,
  (SELECT CASE WHEN EXISTS (SELECT 1 FROM "MaxRouteConversation" WHERE "accountId"=:'account_id' AND "conversationKey"='$A_CONVERSATION_KEY') THEN 0 ELSE 1 END) AS a_route_creates,
  (SELECT count(*) FROM (VALUES
      ('protocol_chat_id','$A_PROTOCOL_CHAT_ID','$A_CONVERSATION_KEY'),
      ('provider_user_id','$A_PROVIDER_USER_ID','$A_CONVERSATION_KEY'),
      ('web_route_id','$A_WEB_ROUTE_ID','$A_CONVERSATION_KEY'),
      ('provider_user_id','$B_PROVIDER_USER_ID','$B_CONVERSATION_KEY')
    ) wanted(kind,value,conversation_key)
    WHERE NOT EXISTS (
      SELECT 1 FROM "MaxRouteIdentityBinding" b
      WHERE b."accountId"=:'account_id' AND b."identityKind"=wanted.kind AND b."identityValue"=wanted.value
        AND b."conversationKey"=wanted.conversation_key AND b.status='active'
    )) AS route_bindings_to_activate,
  (SELECT count(*) FROM "MaxRouteIdentityBinding" b WHERE b."accountId"=:'account_id' AND b."identityKind"='provider_user_id'
    AND b."identityValue"='$B_OLD_PROVIDER_USER_ID' AND b."conversationKey"='$B_CONVERSATION_KEY' AND b.status='active') AS provider_bindings_to_supersede,
  (SELECT count(*) FROM "Message" m WHERE m.id='$TARGET_MESSAGE_ID' AND m."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID'
    AND m.status='failed' AND m."externalId" IS NULL
    AND coalesce(m.metadata->'maxDelivery'->>'status','')='hard_failed'
    AND coalesce(m.metadata->'maxDelivery'->>'safeErrorCode','')='ROUTE_NOT_SENDABLE'
    AND NOT EXISTS (
      SELECT 1 FROM "MaxOutboundCommand" c WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID'
    )) AS retry_reclassifies;

DO \$\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rc3_pairs p
    LEFT JOIN "Contact" s ON s.id=p.source_contact
    LEFT JOIN "Contact" t ON t.id=p.target_contact
    LEFT JOIN "ContactPhone" ph ON ph.id=p.phone_id
    WHERE s.id IS NULL OR t.id IS NULL OR ph.id IS NULL OR t."isArchived"=true
  ) THEN
    RAISE EXCEPTION 'RC3 precondition failed: required source/target/phone missing or target archived';
  END IF;

  IF EXISTS (
    SELECT 1 FROM rc3_pairs p
    JOIN "Contact" s ON s.id=p.source_contact
    WHERE s."isArchived"=true
      AND NOT EXISTS (
        SELECT 1 FROM "ContactMerge" cm
        WHERE cm."survivorId"=p.target_contact AND cm."mergedId"=p.source_contact AND cm.action='merge'
      )
  ) THEN
    RAISE EXCEPTION 'RC3 precondition failed: archived source without canonical merge audit';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ContactPhone" ph
    JOIN rc3_pairs p ON ph.phone=p.phone
    JOIN "Contact" c ON c.id=ph."contactId"
    WHERE ph."isActive"=true AND c."isArchived"=false AND ph."contactId" NOT IN (p.source_contact,p.target_contact)
  ) THEN
    RAISE EXCEPTION 'RC3 precondition failed: unexpected third active phone owner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MaxRouteIdentityBinding" b
    WHERE b."accountId"=current_setting('rc3.account_id')
      AND b.status IN ('active','provisional','conflicted')
      AND (
        (b."identityKind"='protocol_chat_id' AND b."identityValue"='$A_PROTOCOL_CHAT_ID' AND b."conversationKey"<>'$A_CONVERSATION_KEY')
        OR (b."identityKind"='provider_user_id' AND b."identityValue"='$A_PROVIDER_USER_ID' AND b."conversationKey"<>'$A_CONVERSATION_KEY')
        OR (b."identityKind"='web_route_id' AND b."identityValue"='$A_WEB_ROUTE_ID' AND b."conversationKey"<>'$A_CONVERSATION_KEY')
        OR (b."identityKind"='protocol_chat_id' AND b."identityValue"='$B_PROTOCOL_CHAT_ID' AND b."conversationKey"<>'$B_CONVERSATION_KEY')
        OR (b."identityKind"='provider_user_id' AND b."identityValue"='$B_PROVIDER_USER_ID' AND b."conversationKey"<>'$B_CONVERSATION_KEY')
        OR (b."identityKind"='web_route_id' AND b."identityValue"='$B_WEB_ROUTE_ID' AND b."conversationKey"<>'$B_CONVERSATION_KEY')
      )
  ) THEN
    RAISE EXCEPTION 'RC3 precondition failed: route identity belongs to another active route';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MaxOutboundCommand" c WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID'
  ) AND NOT EXISTS (
    SELECT 1
    FROM "MaxOutboundCommand" c
    JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
    WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID'
      AND d.state='provider_confirmed'
      AND d."providerMessageId" ~* '^d301[0-9a-f]{14}$'
  ) THEN
    RAISE EXCEPTION 'RC3 precondition failed: target retry has existing non-terminal durable command';
  END IF;
END
\$\$;

\if :apply
CREATE TEMP TABLE rc3_merge_snapshots AS
SELECT p.*,
  (SELECT to_jsonb(c) FROM "Contact" c WHERE c.id=p.source_contact) AS source_contact_snapshot,
  (SELECT to_jsonb(c) FROM "Contact" c WHERE c.id=p.target_contact) AS target_contact_snapshot,
  (SELECT coalesce(jsonb_agg(to_jsonb(ph) ORDER BY ph.id),'[]'::jsonb) FROM "ContactPhone" ph WHERE ph."contactId"=p.source_contact) AS source_phones,
  (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM "ContactIdentity" i WHERE i."contactId"=p.source_contact) AS source_identities,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'channel',ch.channel,'externalChatId',ch."externalChatId",'messageCount',(SELECT count(*) FROM "Message" m WHERE m."chatId"=ch.id)) ORDER BY ch.id),'[]'::jsonb) FROM "Chat" ch WHERE ch."contactId"=p.source_contact) AS source_chats
FROM rc3_pairs p;

UPDATE "ContactIdentity" i
SET "contactId"=p.target_contact,
    metadata=coalesce(i.metadata,'{}'::jsonb) || jsonb_build_object('personalMaxRc3ContactIdentityRepair', jsonb_build_object('actor','$REPAIR_ACTOR','sourceContactId',p.source_contact,'targetContactId',p.target_contact,'phone',p.phone,'appliedAt',now()))
FROM rc3_pairs p
WHERE i."contactId"=p.source_contact;

UPDATE "ContactPhone" ph
SET "isPrimary"=false
FROM rc3_pairs p
WHERE ph."contactId" IN (p.source_contact,p.target_contact) AND ph."isPrimary"=true;

UPDATE "ContactPhone" ph
SET "contactId"=p.target_contact,
    "isActive"=true,
    "isPrimary"=true,
    source='max',
    "verifiedAt"=coalesce(ph."verifiedAt", now())
FROM rc3_pairs p
WHERE ph.id=p.phone_id AND ph."contactId"=p.source_contact;

UPDATE "ContactIdentity" i
SET "phoneId"=p.phone_id,
    "reachabilityStatus"=CASE WHEN i.channel='max' THEN 'confirmed'::"ReachabilityStatus" ELSE i."reachabilityStatus" END,
    "reachabilityCheckedAt"=CASE WHEN i.channel='max' THEN now() ELSE i."reachabilityCheckedAt" END,
    metadata=coalesce(i.metadata,'{}'::jsonb) || jsonb_build_object('phoneEvidence', jsonb_build_object('source','max_provider_exact','phone',p.phone,'trustedForAutomaticResolution',true,'repair','$REPAIR_ACTOR'))
FROM rc3_pairs p
WHERE i."contactId"=p.target_contact AND i.channel='max'
  AND (i."externalId" IN ('$A_PROVIDER_USER_ID','$B_PROVIDER_USER_ID') OR i."externalId" IN ('$A_PROTOCOL_CHAT_ID','$B_PROTOCOL_CHAT_ID'));

UPDATE "Chat" ch
SET "contactId"=p.target_contact
FROM rc3_pairs p
WHERE ch."contactId"=p.source_contact;

DO \$\$
BEGIN
  IF to_regclass('public."Task"') IS NOT NULL THEN
    EXECUTE 'UPDATE "Task" t SET "contactId"=p.target_contact FROM rc3_pairs p WHERE t."contactId"=p.source_contact';
  END IF;
END
\$\$;

UPDATE "Call" ca
SET "contactId"=p.target_contact
FROM rc3_pairs p
WHERE ca."contactId"=p.source_contact;

UPDATE "Driver" d
SET "contactId"=p.target_contact
FROM rc3_pairs p
WHERE d."contactId"=p.source_contact;

UPDATE "ContactDriverProfileAudit" audit
SET "contactId"=p.target_contact,
    metadata=coalesce(audit.metadata,'{}'::jsonb) || jsonb_build_object('personalMaxRc3PreviousContactId',p.source_contact)
FROM rc3_pairs p
WHERE audit."contactId"=p.source_contact;

UPDATE "Contact" c
SET "isArchived"=true,
    "primaryPhoneId"=NULL,
    "mainDriverId"=NULL,
    "mainDriverSelection"='auto',
    "mainDriverSelectedBy"=NULL,
    "mainDriverSelectedAt"=NULL,
    "yandexDriverId"=NULL,
    "customFields"=coalesce(c."customFields",'{}'::jsonb) || jsonb_build_object('personalMaxRc3MergedInto',p.target_contact,'personalMaxRc3RepairActor','$REPAIR_ACTOR')
FROM rc3_pairs p
WHERE c.id=p.source_contact AND c."isArchived"=false;

UPDATE "Contact" c
SET "primaryPhoneId"=p.phone_id,
    "customFields"=coalesce(c."customFields",'{}'::jsonb) || jsonb_build_object('personalMaxRc3CanonicalPhone',p.phone,'personalMaxRc3RepairActor','$REPAIR_ACTOR')
FROM rc3_pairs p
WHERE c.id=p.target_contact AND c."primaryPhoneId" IS DISTINCT FROM p.phone_id;

INSERT INTO "ContactMerge" (id,"survivorId","mergedId",action,"mergedBy",reason,confidence,"snapshotBefore","createdAt")
SELECT
  'pmax_rc3_contact_merge_' || lower(label),
  target_contact,
  source_contact,
  'merge'::"MergeAction",
  '$REPAIR_ACTOR',
  'manual'::"MergeReason",
  1,
  jsonb_build_object(
    'manifestVersion',1,
    'repair','personal-max-rc3-contact-identity-v1',
    'actor','$REPAIR_ACTOR',
    'sourceContactId',source_contact,
    'targetContactId',target_contact,
    'phone',phone,
    'sourceContact',source_contact_snapshot,
    'targetContact',target_contact_snapshot,
    'sourcePhones',source_phones,
    'sourceIdentities',source_identities,
    'sourceChats',source_chats,
    'rollback','restore production backup or execute operator-reviewed inverse manifest'
  ),
  now()
FROM rc3_merge_snapshots s
WHERE NOT EXISTS (
  SELECT 1 FROM "ContactMerge" cm
  WHERE cm."survivorId"=s.target_contact AND cm."mergedId"=s.source_contact AND cm.action='merge'
);

INSERT INTO "ContactDriverProfileAudit" (id,"contactId","driverId",action,"selectedBy",reason,metadata,"createdAt")
SELECT
  'pmax_rc3_contact_identity_audit_' || lower(label),
  target_contact,
  NULL,
  'personal_max_rc3_contact_identity_merge',
  '$REPAIR_ACTOR',
  'provider_exact_phone_and_route_consolidation',
  jsonb_build_object('sourceContactId',source_contact,'targetContactId',target_contact,'phone',phone,'repair','personal-max-rc3-contact-identity-v1'),
  now()
FROM rc3_pairs p
WHERE NOT EXISTS (
  SELECT 1 FROM "ContactDriverProfileAudit" audit WHERE audit.id='pmax_rc3_contact_identity_audit_' || lower(p.label)
);

INSERT INTO "MaxRouteConversation" (id,"accountId","conversationKey","routeVersion","optimisticVersion",state,"createdAt","updatedAt")
VALUES ('pmax_rc3_route_a', :'account_id', '$A_CONVERSATION_KEY', 1, 1, 'active', now(), now())
ON CONFLICT ("accountId","conversationKey") DO UPDATE
SET state='active',
    "routeVersion"=GREATEST("MaxRouteConversation"."routeVersion",1),
    "optimisticVersion"=GREATEST("MaxRouteConversation"."optimisticVersion",1),
    "updatedAt"=now();

CREATE TEMP TABLE rc3_route_observations (
  route_observation_id text PRIMARY KEY,
  idempotency_key text NOT NULL,
  conversation_key text NOT NULL,
  identity_kind text NOT NULL,
  identity_value text NOT NULL,
  authority text NOT NULL,
  evidence_json jsonb NOT NULL,
  evidence_sha text NOT NULL,
  evidence_size int NOT NULL,
  route_version_after int
) ON COMMIT DROP;
INSERT INTO rc3_route_observations VALUES
  ('pmax_rc3_route_a_protocol', :'a_protocol_idempotency_key', '$A_CONVERSATION_KEY', 'protocol_chat_id', '$A_PROTOCOL_CHAT_ID', 'manual_approved', :'a_protocol_evidence_json'::jsonb, :'a_protocol_evidence_sha', :'a_protocol_evidence_size', 1),
  ('pmax_rc3_route_a_provider', :'a_provider_idempotency_key', '$A_CONVERSATION_KEY', 'provider_user_id', '$A_PROVIDER_USER_ID', 'manual_approved', :'a_provider_evidence_json'::jsonb, :'a_provider_evidence_sha', :'a_provider_evidence_size', 1),
  ('pmax_rc3_route_a_web', :'a_web_idempotency_key', '$A_CONVERSATION_KEY', 'web_route_id', '$A_WEB_ROUTE_ID', 'manual_approved', :'a_web_evidence_json'::jsonb, :'a_web_evidence_sha', :'a_web_evidence_size', 1),
  ('pmax_rc3_route_b_provider', :'b_provider_idempotency_key', '$B_CONVERSATION_KEY', 'provider_user_id', '$B_PROVIDER_USER_ID', 'manual_approved', :'b_provider_evidence_json'::jsonb, :'b_provider_evidence_sha', :'b_provider_evidence_size', NULL);

UPDATE "MaxRouteIdentityBinding" b
SET status='superseded', version=b.version+1, "lastSeenAt"=now(), "updatedAt"=now()
WHERE b."accountId"=:'account_id' AND b."identityKind"='provider_user_id' AND b."identityValue"='$B_OLD_PROVIDER_USER_ID'
  AND b."conversationKey"='$B_CONVERSATION_KEY' AND b.status='active';

INSERT INTO "MaxRouteObservation" (
  "routeObservationId","accountId","idempotencyKey","sourceRawObservationId","extractorVersion","observedAt",
  "evidenceSource","evidenceAuthority","candidateConversationKey","identityKind","identityValue","sanitizedEvidence",
  "evidenceSha256","evidenceSizeBytes","evidenceQuarantined","redactionMetadata","processingResult","routeVersionAfter","createdAt"
)
SELECT route_observation_id, :'account_id', idempotency_key, NULL, 'manual-route-operation-v1', now(),
  'manual:$REPAIR_ACTOR', authority, conversation_key, identity_kind, identity_value, evidence_json,
  evidence_sha, evidence_size, false,
  jsonb_build_object('messageTextPrinted',false,'payloadPrinted',false,'secretValuesPrinted',false),
  CASE WHEN identity_kind='provider_user_id' AND identity_value='$B_PROVIDER_USER_ID' THEN 'superseded' ELSE 'attached' END,
  route_version_after,
  now()
FROM rc3_route_observations ro
WHERE NOT EXISTS (
  SELECT 1 FROM "MaxRouteObservation" existing
  WHERE existing."accountId"=:'account_id' AND existing."idempotencyKey"=ro.idempotency_key
);

INSERT INTO "MaxRouteIdentityBinding" (id,"accountId","identityKind","identityValue","conversationKey",status,"firstSeenAt","lastSeenAt","evidenceRef",version,"createdAt","updatedAt")
SELECT
  'pmax_rc3_binding_' || replace(ro.route_observation_id,'pmax_rc3_route_',''),
  :'account_id',
  ro.identity_kind,
  ro.identity_value,
  ro.conversation_key,
  'active',
  now(),
  now(),
  ro.route_observation_id,
  0,
  now(),
  now()
FROM rc3_route_observations ro
WHERE NOT EXISTS (
  SELECT 1 FROM "MaxRouteIdentityBinding" b
  WHERE b."accountId"=:'account_id' AND b."identityKind"=ro.identity_kind AND b."identityValue"=ro.identity_value
);

UPDATE "MaxRouteIdentityBinding" b
SET status='active', "lastSeenAt"=now(), "evidenceRef"=ro.route_observation_id, version=b.version+1, "updatedAt"=now()
FROM rc3_route_observations ro
WHERE b."accountId"=:'account_id' AND b."identityKind"=ro.identity_kind AND b."identityValue"=ro.identity_value
  AND b."conversationKey"=ro.conversation_key AND b.status<>'active';

UPDATE "MaxRouteConversation" r
SET "routeVersion"=r."routeVersion"+1, "optimisticVersion"=r."optimisticVersion"+1, "updatedAt"=now()
WHERE r."accountId"=:'account_id' AND r."conversationKey"='$B_CONVERSATION_KEY'
  AND EXISTS (
    SELECT 1 FROM "MaxRouteIdentityBinding" b
    WHERE b."accountId"=:'account_id' AND b."conversationKey"='$B_CONVERSATION_KEY'
      AND b."identityKind"='provider_user_id' AND b."identityValue"='$B_PROVIDER_USER_ID' AND b.status='active'
  )
  AND EXISTS (
    SELECT 1 FROM "MaxRouteObservation" o
    WHERE o."accountId"=:'account_id' AND o."idempotencyKey"=:'b_provider_idempotency_key'
      AND o."createdAt" >= now() - interval '2 minutes'
  );

UPDATE "Message" m
SET status='failed',
    metadata=coalesce(m.metadata,'{}'::jsonb)
      || jsonb_build_object(
        'retryable',true,
        'retryAttempt',0,
        'maxRetries',3,
        'lastFailedAt','1970-01-01T00:00:00.000Z',
        'personalMaxRc3RetryReclass',jsonb_build_object('actor','$REPAIR_ACTOR','reason','pre_provider_route_repaired','appliedAt',now()),
        'maxDelivery',
          coalesce(m.metadata->'maxDelivery','{}'::jsonb)
          || jsonb_build_object(
            'operation','send',
            'status','retryable_failed',
            'deliveryConfirmed',false,
            'safeErrorCode','ROUTE_NOT_SENDABLE',
            'failurePhase','before_provider_action',
            'protocolChatId','$A_PROTOCOL_CHAT_ID',
            'providerUserId','$A_PROVIDER_USER_ID',
            'webRouteId','$A_WEB_ROUTE_ID',
            'maxMessageId',NULL,
            'externalId',NULL
          )
      )
WHERE m.id='$TARGET_MESSAGE_ID' AND m."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID'
  AND m.status='failed' AND m."externalId" IS NULL
  AND coalesce(m.metadata->'maxDelivery'->>'safeErrorCode','')='ROUTE_NOT_SENDABLE'
  AND NOT EXISTS (
    SELECT 1 FROM "MaxOutboundCommand" c WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID'
  );

INSERT INTO "MessageEventLog" (id,"messageId","eventType",metadata,status,"createdAt","updatedAt")
SELECT 'pmax_rc3_retry_reclass_' || '$TARGET_MESSAGE_ID', '$TARGET_MESSAGE_ID', 'personal_max_rc3_retry_reclassified',
  jsonb_build_object('actor','$REPAIR_ACTOR','safeErrorCode','ROUTE_NOT_SENDABLE','physicalActionStartedBeforeRepair',false),
  'done',
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM "MessageEventLog" l WHERE l.id='pmax_rc3_retry_reclass_' || '$TARGET_MESSAGE_ID'
);
\endif

DO \$\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rc3_pairs p
    WHERE (SELECT count(*) FROM "ContactPhone" ph JOIN "Contact" c ON c.id=ph."contactId" WHERE ph.phone=p.phone AND ph."isActive"=true AND c."isArchived"=false) <> 1
  ) THEN
    RAISE EXCEPTION 'RC3 postcondition failed: duplicate or missing active phone owner';
  END IF;
END
\$\$;

SELECT jsonb_pretty(jsonb_build_object(
  'schemaVersion',1,
  'mode',CASE WHEN $apply=1 THEN 'apply' ELSE 'dry-run' END,
  'plan',(SELECT to_jsonb(rc3_plan) FROM rc3_plan),
  'post',jsonb_build_object(
    'a',jsonb_build_object(
      'sourceArchived',(SELECT c."isArchived" FROM "Contact" c WHERE c.id='$A_SOURCE_CONTACT'),
      'targetPhoneOwner',(SELECT ph."contactId" FROM "ContactPhone" ph WHERE ph.id='$A_PHONE_ID'),
      'targetPrimaryPhone',(SELECT c."primaryPhoneId" FROM "Contact" c WHERE c.id='$A_TARGET_CONTACT'),
      'activeMaxChats',(SELECT count(*) FROM "Chat" ch WHERE ch."contactId"='$A_TARGET_CONTACT' AND ch.channel='max'),
      'activeRouteBindings',(SELECT count(*) FROM "MaxRouteIdentityBinding" b WHERE b."accountId"=:'account_id' AND b."conversationKey"='$A_CONVERSATION_KEY' AND b.status='active')
    ),
    'b',jsonb_build_object(
      'sourceArchived',(SELECT c."isArchived" FROM "Contact" c WHERE c.id='$B_SOURCE_CONTACT'),
      'targetPhoneOwner',(SELECT ph."contactId" FROM "ContactPhone" ph WHERE ph.id='$B_PHONE_ID'),
      'targetPrimaryPhone',(SELECT c."primaryPhoneId" FROM "Contact" c WHERE c.id='$B_TARGET_CONTACT'),
      'activeMaxChats',(SELECT count(*) FROM "Chat" ch WHERE ch."contactId"='$B_TARGET_CONTACT' AND ch.channel='max'),
      'activeRouteBindings',(SELECT count(*) FROM "MaxRouteIdentityBinding" b WHERE b."accountId"=:'account_id' AND b."conversationKey"='$B_CONVERSATION_KEY' AND b.status='active')
    ),
    'retryCandidate',(SELECT jsonb_build_object('status',m.status,'externalId',m."externalId",'retryable',m.metadata->>'retryable','maxDeliveryStatus',m.metadata->'maxDelivery'->>'status') FROM "Message" m WHERE m.id='$TARGET_MESSAGE_ID'),
    'duplicatePhoneOwnership',(SELECT count(*) FROM rc3_pairs p WHERE (SELECT count(*) FROM "ContactPhone" ph JOIN "Contact" c ON c.id=ph."contactId" WHERE ph.phone=p.phone AND ph."isActive"=true AND c."isArchived"=false)<>1),
    'openRouteConflicts',(SELECT count(*) FROM "MaxRouteConflict" WHERE "accountId"=:'account_id' AND status='open')
  )
));
$rollback_command;
SQL
}

target_attempt_hash() {
  postgres_query <<SQL | sha256sum | awk '{print $1}'
SELECT c."commandId", c."clientMessageId", c."conversationKey", c."commandSequence",
       d."dispatchId", d.state, d."providerMessageId", d."attemptCount",
       a."attemptId", a."attemptState", a."protocolChatId", a."providerUserId", a."webRouteId",
       a."physicalActionStartedAt", a."completedAt", m.id, m.status, m."externalId"
FROM "Message" m
LEFT JOIN "MaxOutboundCommand" c ON c."clientMessageId"=m."clientMessageId"
LEFT JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
LEFT JOIN "MaxOutboundDispatchAttempt" a ON a."dispatchId"=d."dispatchId"
WHERE m.id='$TARGET_MESSAGE_ID'
ORDER BY c."commandSequence", a."attemptNumber";
SQL
}

verify_final_database_gate() {
  postgres_query_account <<SQL
CREATE TEMP TABLE rc3_final_facts ON COMMIT DROP AS
WITH facts AS (
  SELECT
    (SELECT count(*) FROM "Contact" WHERE id IN ('$A_TARGET_CONTACT','$B_TARGET_CONTACT') AND "isArchived"=false) AS targets_active,
    (SELECT count(*) FROM "Contact" WHERE id IN ('$A_SOURCE_CONTACT','$B_SOURCE_CONTACT') AND "isArchived"=true) AS sources_archived,
    (SELECT count(*) FROM "ContactPhone" ph JOIN "Contact" c ON c.id=ph."contactId" WHERE ph.phone IN ('$A_PHONE','$B_PHONE') AND ph."isActive"=true AND c."isArchived"=false) AS active_phone_owners,
    (SELECT count(*) FROM "ContactPhone" WHERE id='$A_PHONE_ID' AND "contactId"='$A_TARGET_CONTACT' AND "isPrimary"=true AND "isActive"=true) AS a_phone_ok,
    (SELECT count(*) FROM "ContactPhone" WHERE id='$B_PHONE_ID' AND "contactId"='$B_TARGET_CONTACT' AND "isPrimary"=true AND "isActive"=true) AS b_phone_ok,
    (SELECT count(*) FROM "Chat" WHERE id='cmrjjp0rq00eprb24knc0xf5s' AND "contactId"='$A_TARGET_CONTACT' AND channel='max') AS a_chat_ok,
    (SELECT count(*) FROM "Chat" WHERE id='cmqxmbjor00epqn24vofl30bm' AND "contactId"='$B_TARGET_CONTACT' AND channel='max') AS b_chat_ok,
    (SELECT count(*) FROM "MaxRouteIdentityBinding" WHERE "accountId"=:'account_id' AND "conversationKey"='$A_CONVERSATION_KEY' AND status='active') AS a_route_bindings,
    (SELECT count(*) FROM "MaxRouteIdentityBinding" WHERE "accountId"=:'account_id' AND "conversationKey"='$B_CONVERSATION_KEY' AND status='active') AS b_route_bindings,
    (SELECT count(*) FROM "MaxRouteConflict" WHERE "accountId"=:'account_id' AND status='open') AS open_route_conflicts,
    (SELECT count(*) FROM "MaxOutboundDispatch" WHERE "accountId"=:'account_id' AND state IN ('queued','dispatching','sent_to_provider_client','awaiting_confirmation','reconciliation_required','retryable_failed')) AS open_queue,
    (SELECT count(*) FROM "MaxOutboundReconciliationTask" WHERE "accountId"=:'account_id' AND state='open') AS open_reconciliation,
    (SELECT count(*) FROM "MaxOutboundDispatchAttempt" WHERE "accountId"=:'account_id' AND "attemptState" IN ('outcome_unknown','awaiting_confirmation','retryable_failed')) AS unresolved_unknown,
    (SELECT count(*) FROM "Message" WHERE "clientMessageId"='$TARGET_CLIENT_MESSAGE_ID') AS target_bubbles,
    (SELECT count(*) FROM "MaxOutboundCommand" WHERE "clientMessageId"='$TARGET_CLIENT_MESSAGE_ID') AS target_commands,
    (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a JOIN "MaxOutboundDispatch" d ON d."dispatchId"=a."dispatchId" JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID' AND a."physicalActionStartedAt" IS NOT NULL) AS target_physical_actions,
    (SELECT count(DISTINCT d."providerMessageId") FROM "MaxOutboundDispatch" d JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID' AND d."providerMessageId" ~* '^d301[0-9a-f]{14}$') AS target_provider_ids,
    (SELECT count(*) FROM "Message" WHERE id='$TARGET_MESSAGE_ID' AND status='delivered' AND "externalId" ~* '^d301[0-9a-f]{14}$') AS target_delivered
)
SELECT * FROM facts;
DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rc3_final_facts
    WHERE targets_active=2 AND sources_archived=2 AND active_phone_owners=2 AND a_phone_ok=1 AND b_phone_ok=1
      AND a_chat_ok=1 AND b_chat_ok=1 AND a_route_bindings=3 AND b_route_bindings=3
      AND open_route_conflicts=0 AND open_queue=0 AND open_reconciliation=0 AND unresolved_unknown=0
      AND target_bubbles=1 AND target_commands=1 AND target_physical_actions=1 AND target_provider_ids=1 AND target_delivered=1
  ) THEN
    RAISE EXCEPTION 'RC3 final database gate failed';
  END IF;
END
\$\$;
SELECT jsonb_pretty(to_jsonb(rc3_final_facts)) FROM rc3_final_facts;
SQL
}

profile_gate() {
  local contact_id=$1 expected_phone=$2 expected_source=$3
  docker exec crm-gravity-mvp node - "$contact_id" "$expected_phone" "$expected_source" <<'NODE'
const [contactId, expectedPhone, expectedSource] = process.argv.slice(2)
const fail = (reason, data) => {
  process.stdout.write(JSON.stringify({ ok: false, reason, data }))
  process.exit(2)
}
const res = await fetch(`http://127.0.0.1:3002/api/contacts/${contactId}`)
const body = await res.json().catch(() => ({}))
if (res.status !== 200) fail('profile_status', { status: res.status, body })
const phones = Array.isArray(body.phones) ? body.phones : []
const maxChannels = Array.isArray(body.channels) ? body.channels.filter(item => item.channel === 'max') : []
const maxIdentities = Array.isArray(body.identities) ? body.identities.filter(item => item.channel === 'max') : []
const expected = {
  status: res.status,
  id: body.id,
  primaryPhone: body.primaryPhone?.phone || null,
  phoneCount: phones.filter(item => item.phone === expectedPhone && item.isActive !== false).length,
  maxChannelCount: maxChannels.length,
  maxIdentityCount: maxIdentities.length,
  maxRouteKnown: maxChannels[0]?.personalMaxRouteKnown ?? false,
  hasExpectedSource: maxIdentities.some(item => item.externalId === expectedSource),
}
if (expected.primaryPhone !== expectedPhone) fail('primary_phone', expected)
if (expected.phoneCount !== 1) fail('phone_count', expected)
if (expected.maxChannelCount !== 1 || expected.maxIdentityCount !== 1) fail('duplicate_max_channels', expected)
if (expected.maxRouteKnown !== true) fail('route_known', expected)
if (!expected.hasExpectedSource) fail('provider_identity', expected)
process.stdout.write(JSON.stringify({ ok: true, ...expected }))
NODE
}

search_gate() {
  local phone=$1 expected_contact=$2
  docker exec crm-gravity-mvp node - "$phone" "$expected_contact" <<'NODE'
const [phone, expectedContact] = process.argv.slice(2)
const res = await fetch(`http://127.0.0.1:3002/api/contacts/search?q=${encodeURIComponent(phone)}&limit=5`)
const body = await res.json().catch(() => ({}))
const ids = Array.isArray(body.contacts) ? body.contacts.map(contact => contact.id) : []
const first = ids[0] || null
if (res.status !== 200 || first !== expectedContact || ids.filter(id => id === expectedContact).length !== 1) {
  process.stdout.write(JSON.stringify({ ok: false, status: res.status, first, ids }))
  process.exit(2)
}
process.stdout.write(JSON.stringify({ ok: true, first, ids }))
NODE
}

archive_redirect_gate() {
  local archived_contact=$1 expected_contact=$2
  docker exec crm-gravity-mvp node - "$archived_contact" "$expected_contact" <<'NODE'
const [archivedContact, expectedContact] = process.argv.slice(2)
const res = await fetch(`http://127.0.0.1:3002/api/contacts/${archivedContact}`)
const body = await res.json().catch(() => ({}))
if (res.status !== 409 || body.code !== 'CONTACT_MERGED' || body.canonicalContactId !== expectedContact) {
  process.stdout.write(JSON.stringify({ ok: false, status: res.status, body }))
  process.exit(2)
}
process.stdout.write(JSON.stringify({ ok: true, status: res.status, canonicalContactId: body.canonicalContactId }))
NODE
}

provider_snapshot_gate() {
  local provider_message_id=$1
  request_file=$(mktemp /var/tmp/personal-max-rc3-history-request.XXXXXX)
  response_file=$(mktemp /var/tmp/personal-max-rc3-history-response.XXXXXX)
  local window_end
  window_end=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%S.%3NZ)
  jq -n --arg accountId "$ACCOUNT_ID" --arg protocolChatId "$A_PROTOCOL_CHAT_ID" \
    --arg uiRouteId "$A_WEB_ROUTE_ID" --arg providerUserId "$A_PROVIDER_USER_ID" \
    --arg windowStart "2026-08-01T00:00:00.000Z" --arg windowEnd "$window_end" \
    '{accountId:$accountId,protocolChatId:$protocolChatId,uiRouteId:$uiRouteId,
      providerUserId:$providerUserId,windowStart:$windowStart,windowEnd:$windowEnd,includeProfile:false}' \
    >"$request_file"
  docker exec -i crm-max-scraper node -e '
    let input="";
    process.stdin.on("data",chunk=>{input+=chunk});
    process.stdin.on("end",async()=>{
      try {
        const response=await fetch("http://127.0.0.1:3005/v1/personal-max/history/snapshot",{
          method:"POST",headers:{"content-type":"application/json"},body:input
        });
        const body=await response.json();
        process.stdout.write(JSON.stringify({status:response.status,body}));
        process.exit(response.status===200?0:2);
      } catch (error) {
        process.stdout.write(JSON.stringify({status:0,error:String(error && error.message || error)}));
        process.exit(2);
      }
    });
  ' <"$request_file" >"$response_file"
  jq -e --arg providerMessageId "$provider_message_id" '
    .status==200 and .body.schemaVersion==1 and .body.source=="max_provider_store_read_only"
    and .body.accountId==env.ACCOUNT_ID
    and .body.protocolChatId==env.A_PROTOCOL_CHAT_ID
    and .body.providerUserId==env.A_PROVIDER_USER_ID
    and ([.body.messages[] | select(.providerMessageId==$providerMessageId and .direction=="outbound")]|length)==1' \
    "$response_file" >/dev/null
  cp "$response_file" "$EVIDENCE_DIR/provider-snapshot-target-message.private.json"
  rm -f -- "$request_file" "$response_file"; request_file=; response_file=
}

export A_PROTOCOL_CHAT_ID A_PROVIDER_USER_ID

readonly PROD_HEAD_BEFORE=$(git -C "$PROD_DIR" rev-parse HEAD)
readonly PROD_STATUS_BEFORE=$(git -C "$PROD_DIR" status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}')
readonly PROD_TREE_HASH_BEFORE=$(tracked_tree_hash)
readonly BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
readonly ACCOUNT_ID=$(env_value "$OPERATIONAL_ENV" MAX_PERSONAL_ACCOUNT_ID)
export ACCOUNT_ID
[[ $ACCOUNT_ID =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]

docker_root=$(docker info --format '{{.DockerRootDir}}')
docker_free_bytes=$(df --output=avail -B1 "$docker_root" | tail -n 1 | tr -d ' ')
[[ $docker_root == /* && -d $docker_root && ! -L $docker_root \
  && $docker_free_bytes =~ ^[0-9]+$ && $docker_free_bytes -ge $MIN_DOCKER_FREE_BYTES ]]
jq -n --arg dockerRoot "$docker_root" --argjson freeBytes "$docker_free_bytes" \
  --argjson minimum "$MIN_DOCKER_FREE_BYTES" \
  '{schemaVersion:1,dockerRoot:$dockerRoot,freeBytes:$freeBytes,minimum:$minimum,passed:true}' \
  >"$EVIDENCE_DIR/storage-before.json"

safe_runtime_snapshot >"$EVIDENCE_DIR/pre-runtime-snapshot.json"
health_gate
actual_default_off_gate

postgres_query_account >"$EVIDENCE_DIR/pre-identity-outbound-matrix.private.json" <<SQL
SELECT jsonb_pretty(jsonb_build_object(
  'schemaVersion',1,
  'accountId', :'account_id',
  'contacts',(SELECT jsonb_agg(jsonb_build_object(
    'id',c.id,'displayName',c."displayName",'isArchived',c."isArchived",'primaryPhoneId',c."primaryPhoneId",
    'phones',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',ph.id,'phone',ph.phone,'isPrimary',ph."isPrimary",'isActive',ph."isActive",'source',ph.source) ORDER BY ph.id),'[]'::jsonb) FROM "ContactPhone" ph WHERE ph."contactId"=c.id),
    'identities',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'channel',i.channel,'externalId',i."externalId",'phoneId',i."phoneId",'reachabilityStatus',i."reachabilityStatus") ORDER BY i.channel,i."externalId"),'[]'::jsonb) FROM "ContactIdentity" i WHERE i."contactId"=c.id),
    'chats',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'channel',ch.channel,'externalChatId',ch."externalChatId",'messageCount',(SELECT count(*) FROM "Message" m WHERE m."chatId"=ch.id)) ORDER BY ch.channel,ch."externalChatId"),'[]'::jsonb) FROM "Chat" ch WHERE ch."contactId"=c.id)
  ) ORDER BY c.id) FROM "Contact" c WHERE c.id IN ('$A_SOURCE_CONTACT','$A_TARGET_CONTACT','$B_SOURCE_CONTACT','$B_TARGET_CONTACT')),
  'routes',(SELECT coalesce(jsonb_agg(jsonb_build_object('conversationKey',r."conversationKey",'state',r.state,'routeVersion',r."routeVersion",'bindings',(SELECT jsonb_agg(jsonb_build_object('kind',b."identityKind",'value',b."identityValue",'status',b.status,'version',b.version) ORDER BY b."identityKind",b."identityValue") FROM "MaxRouteIdentityBinding" b WHERE b."accountId"=r."accountId" AND b."conversationKey"=r."conversationKey")) ORDER BY r."conversationKey"),'[]'::jsonb) FROM "MaxRouteConversation" r WHERE r."accountId"=:'account_id'),
  'targetMessage',(SELECT jsonb_build_object('id',m.id,'chatId',m."chatId",'status',m.status,'externalId',m."externalId",'clientMessageId',m."clientMessageId",'retryable',m.metadata->>'retryable','deliveryStatus',m.metadata->'maxDelivery'->>'status','safeErrorCode',m.metadata->'maxDelivery'->>'safeErrorCode') FROM "Message" m WHERE m.id='$TARGET_MESSAGE_ID'),
  'targetPhysicalActions',(SELECT count(*) FROM "MaxOutboundDispatchAttempt" a JOIN "MaxOutboundDispatch" d ON d."dispatchId"=a."dispatchId" JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID' AND a."physicalActionStartedAt" IS NOT NULL)
));
SQL

docker exec crm-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' \
  >"$EVIDENCE_DIR/production-before-rc3-contact-identity.dump"
test -s "$EVIDENCE_DIR/production-before-rc3-contact-identity.dump"
docker exec -i crm-postgres pg_restore --list <"$EVIDENCE_DIR/production-before-rc3-contact-identity.dump" \
  >"$EVIDENCE_DIR/production-before-rc3-contact-identity.restore-list"
sha256sum "$EVIDENCE_DIR/production-before-rc3-contact-identity.dump" \
  >"$EVIDENCE_DIR/production-before-rc3-contact-identity.dump.sha256"

restore_container=personal-max-rc3-contact-restore-${STAMP,,}
printf 'isolated_restore_container=%s\n' "$restore_container" >"$EVIDENCE_DIR/isolated-restore-check.log"
docker run -d --rm --network none --name "$restore_container" \
  -e POSTGRES_PASSWORD=restore-check-not-production postgres:16-alpine \
  >>"$EVIDENCE_DIR/isolated-restore-check.log" 2>&1
restore_ready_count=0
for _ in {1..120}; do
  if docker exec "$restore_container" pg_isready -U postgres >/dev/null 2>&1; then
    restore_ready_count=$((restore_ready_count + 1))
    if [[ $restore_ready_count -ge 2 ]]; then break; fi
  else
    restore_ready_count=0
  fi
  sleep 1
done
if [[ $restore_ready_count -lt 2 ]]; then
  docker logs "$restore_container" >>"$EVIDENCE_DIR/isolated-restore-check.log" 2>&1 || true
  echo 'ERROR: isolated restore postgres did not become stable-ready' >&2
  exit 72
fi
docker exec "$restore_container" pg_isready -U postgres \
  >>"$EVIDENCE_DIR/isolated-restore-check.log" 2>&1
docker exec "$restore_container" createdb -U postgres restore_check \
  >>"$EVIDENCE_DIR/isolated-restore-check.log" 2>&1
docker exec -i "$restore_container" pg_restore --no-owner --no-acl -U postgres -d restore_check \
  </"$EVIDENCE_DIR/production-before-rc3-contact-identity.dump" \
  >>"$EVIDENCE_DIR/isolated-restore-check.log" 2>&1
docker exec "$restore_container" psql -X -v ON_ERROR_STOP=1 -At -U postgres -d restore_check \
  -c 'SELECT count(*) FROM "_prisma_migrations";' >>"$EVIDENCE_DIR/isolated-restore-check.log"
docker rm -f "$restore_container" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -Fx "$restore_container" >/dev/null; then
  echo 'ERROR: isolated restore container cleanup failed' >&2
  exit 69
fi
restore_container=

a_protocol_evidence_json=$(route_evidence_json protocol_chat_id "$A_PROTOCOL_CHAT_ID" "$A_CONVERSATION_KEY" manual_approved)
a_provider_evidence_json=$(route_evidence_json provider_user_id "$A_PROVIDER_USER_ID" "$A_CONVERSATION_KEY" manual_approved)
a_web_evidence_json=$(route_evidence_json web_route_id "$A_WEB_ROUTE_ID" "$A_CONVERSATION_KEY" manual_approved)
b_provider_evidence_json=$(route_evidence_json provider_user_id "$B_PROVIDER_USER_ID" "$B_CONVERSATION_KEY" manual_approved)
readonly a_protocol_evidence_sha=$(printf '%s' "$a_protocol_evidence_json" | sha256sum | awk '{print $1}')
readonly a_provider_evidence_sha=$(printf '%s' "$a_provider_evidence_json" | sha256sum | awk '{print $1}')
readonly a_web_evidence_sha=$(printf '%s' "$a_web_evidence_json" | sha256sum | awk '{print $1}')
readonly b_provider_evidence_sha=$(printf '%s' "$b_provider_evidence_json" | sha256sum | awk '{print $1}')
readonly a_protocol_idempotency_key=$(stable_idempotency_key "personal-max-rc3-contact-identity:a:protocol:${ACCOUNT_ID}:${A_PROTOCOL_CHAT_ID}:${A_CONVERSATION_KEY}")
readonly a_provider_idempotency_key=$(stable_idempotency_key "personal-max-rc3-contact-identity:a:provider:${ACCOUNT_ID}:${A_PROVIDER_USER_ID}:${A_CONVERSATION_KEY}")
readonly a_web_idempotency_key=$(stable_idempotency_key "personal-max-rc3-contact-identity:a:web:${ACCOUNT_ID}:${A_WEB_ROUTE_ID}:${A_CONVERSATION_KEY}")
readonly b_provider_idempotency_key=$(stable_idempotency_key "personal-max-rc3-contact-identity:b:provider:${ACCOUNT_ID}:${B_PROVIDER_USER_ID}:${B_CONVERSATION_KEY}")
readonly a_protocol_evidence_size=$(printf '%s' "$a_protocol_evidence_json" | wc -c)
readonly a_provider_evidence_size=$(printf '%s' "$a_provider_evidence_json" | wc -c)
readonly a_web_evidence_size=$(printf '%s' "$a_web_evidence_json" | wc -c)
readonly b_provider_evidence_size=$(printf '%s' "$b_provider_evidence_json" | wc -c)

repair_sql 0 >"$EVIDENCE_DIR/data-repair-dry-run-before.private.json"
if [[ $MODE == dry-run ]]; then
  jq -n --arg sourceSha "$SOURCE_SHA" --arg evidenceDirectory "$EVIDENCE_DIR" \
    '{schemaVersion:1,status:"DRY_RUN_PASS",sourceSha:$sourceSha,evidenceDirectory:$evidenceDirectory,
      productionMutated:false,providerActions:0,newCrmBubbleCreated:false}' \
    >"$EVIDENCE_DIR/final-report.json"
  install -o root -g codexbot -m 0640 "$EVIDENCE_DIR/final-report.json" "$RESULT_FILE"
  seal_evidence
  trap - EXIT
  echo "PERSONAL_MAX_RC3_CONTACT_IDENTITY_REPORT=$RESULT_FILE"
  echo 'PERSONAL MAX RC3 CONTACT IDENTITY DRY RUN PASS'
  exit 0
fi

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
  docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{.RepoTags}}' "$image"
done >"$EVIDENCE_DIR/immutable-images.txt"

repair_sql 1 >"$EVIDENCE_DIR/data-repair-apply.private.json"
production_mutated=true
repair_sql 0 >"$EVIDENCE_DIR/data-repair-dry-run-after.private.json"
jq -e '
  .plan.source_contacts_active==0 and .plan.phones_to_move==0 and .plan.identities_to_move==0
  and .plan.chats_to_move==0 and .plan.tasks_to_move==0 and .plan.calls_to_move==0
  and .plan.driver_profiles_to_move==0 and .plan.a_route_creates==0
  and .plan.route_bindings_to_activate==0 and .plan.provider_bindings_to_supersede==0
  and .plan.retry_reclassifies==0 and .post.duplicatePhoneOwnership==0' \
  "$EVIDENCE_DIR/data-repair-dry-run-after.private.json" >/dev/null

default_off_now
health_gate
actual_default_off_gate
safe_runtime_snapshot >"$EVIDENCE_DIR/default-off-runtime-snapshot.json"

operational_now
health_gate
actual_operational_gate
actual_release_images_gate
safe_runtime_snapshot >"$EVIDENCE_DIR/operational-runtime-snapshot.json"

retry_state=$(postgres_query <<SQL
SELECT concat_ws('|',
  m.status,
  coalesce(m."externalId",''),
  coalesce(m.metadata->>'retryable',''),
  coalesce(m.metadata->'maxDelivery'->>'status',''),
  (SELECT count(*) FROM "MaxOutboundCommand" c WHERE c."clientMessageId"=m."clientMessageId"),
  (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a JOIN "MaxOutboundDispatch" d ON d."dispatchId"=a."dispatchId" JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId" WHERE c."clientMessageId"=m."clientMessageId" AND a."physicalActionStartedAt" IS NOT NULL)
) FROM "Message" m WHERE m.id='$TARGET_MESSAGE_ID';
SQL
)
if [[ $retry_state == "failed||true|retryable_failed|0|0" ]]; then
  request_file=$(mktemp /var/tmp/personal-max-rc3-retry-request.XXXXXX)
  response_file=$(mktemp /var/tmp/personal-max-rc3-retry-response.XXXXXX)
  jq -n --arg messageId "$TARGET_MESSAGE_ID" '{messageId:$messageId}' >"$request_file"
  docker exec -i crm-gravity-mvp node -e '
    let input="";
    process.stdin.on("data",chunk=>{input+=chunk});
    process.stdin.on("end",async()=>{
      try {
        const response=await fetch("http://127.0.0.1:3002/api/messages/retry",{
          method:"POST",headers:{"content-type":"application/json"},body:input
        });
        const body=await response.json();
        process.stdout.write(JSON.stringify({status:response.status,body}));
        process.exit(response.status===200&&body.success===true?0:2);
      } catch (error) {
        process.stdout.write(JSON.stringify({status:0,error:String(error && error.message || error)}));
        process.exit(2);
      }
    });
  ' <"$request_file" >"$response_file"
  jq -e '.status==200 and .body.success==true' "$response_file" >/dev/null
  cp "$response_file" "$EVIDENCE_DIR/controlled-retry-response.private.json"
  rm -f -- "$request_file" "$response_file"; request_file=; response_file=
fi

for _ in {1..90}; do
  if postgres_query <<SQL | grep -qx 'ready'
WITH target AS (
  SELECT m.id,m.status,m."externalId",d.state,d."providerMessageId",d."attemptCount",
    (SELECT count(*) FROM "MaxOutboundDispatchAttempt" a WHERE a."dispatchId"=d."dispatchId" AND a."physicalActionStartedAt" IS NOT NULL) AS physical_count
  FROM "Message" m
  JOIN "MaxOutboundCommand" c ON c."clientMessageId"=m."clientMessageId"
  JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
  WHERE m.id='$TARGET_MESSAGE_ID'
)
SELECT CASE WHEN status='delivered' AND "externalId" ~* '^d301[0-9a-f]{14}$'
  AND state='provider_confirmed' AND "providerMessageId"="externalId" AND "attemptCount"=1 AND physical_count=1
  THEN 'ready' ELSE 'wait' END FROM target;
SQL
  then
    break
  fi
  sleep 2
done

verify_final_database_gate >"$EVIDENCE_DIR/final-database-gate.private.json"
provider_message_id=$(postgres_query <<SQL
SELECT d."providerMessageId"
FROM "MaxOutboundDispatch" d
JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId"
WHERE c."clientMessageId"='$TARGET_CLIENT_MESSAGE_ID' AND d.state='provider_confirmed';
SQL
)
[[ $provider_message_id =~ ^d301[0-9a-f]{14}$ ]]

provider_snapshot_gate "$provider_message_id"
profile_gate "$A_TARGET_CONTACT" "$A_PHONE" "$A_PROVIDER_USER_ID" >"$EVIDENCE_DIR/profile-gate-a.json"
profile_gate "$B_TARGET_CONTACT" "$B_PHONE" "$B_PROVIDER_USER_ID" >"$EVIDENCE_DIR/profile-gate-b.json"
search_gate "$A_PHONE" "$A_TARGET_CONTACT" >"$EVIDENCE_DIR/search-gate-a.json"
search_gate "$B_PHONE" "$B_TARGET_CONTACT" >"$EVIDENCE_DIR/search-gate-b.json"
archive_redirect_gate "$A_SOURCE_CONTACT" "$A_TARGET_CONTACT" >"$EVIDENCE_DIR/archive-redirect-gate-a.json"
archive_redirect_gate "$B_SOURCE_CONTACT" "$B_TARGET_CONTACT" >"$EVIDENCE_DIR/archive-redirect-gate-b.json"

attempt_hash_before_restart=$(target_attempt_hash)
"${compose_operational[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 300 \
  max-personal-gateway max-web-scraper >/dev/null
health_gate
actual_operational_gate
actual_release_images_gate
sleep 20
health_gate
attempt_hash_after_restart=$(target_attempt_hash)
[[ $attempt_hash_before_restart == "$attempt_hash_after_restart" ]]

export PERSONAL_MAX_GRAVITY_IMAGE=$RC2_GRAVITY_IMAGE
export PERSONAL_MAX_GATEWAY_IMAGE=$RC2_GATEWAY_IMAGE
export PERSONAL_MAX_SCRAPER_IMAGE=$RC2_SCRAPER_IMAGE
default_off_now
health_gate
actual_default_off_gate
attempt_hash_after_rollback=$(target_attempt_hash)
[[ $attempt_hash_before_restart == "$attempt_hash_after_rollback" ]]

export PERSONAL_MAX_GRAVITY_IMAGE=$GRAVITY_IMAGE
export PERSONAL_MAX_GATEWAY_IMAGE=$GATEWAY_IMAGE
export PERSONAL_MAX_SCRAPER_IMAGE=$SCRAPER_IMAGE
operational_now
health_gate
actual_operational_gate
actual_release_images_gate
sleep 10
attempt_hash_after_rollforward=$(target_attempt_hash)
[[ $attempt_hash_before_restart == "$attempt_hash_after_rollforward" ]]

verify_final_database_gate >"$EVIDENCE_DIR/final-database-gate-after-rollforward.private.json"
safe_runtime_snapshot >"$EVIDENCE_DIR/final-runtime-snapshot.json"

restart_counts_before=$(docker inspect --format '{{.Name}}={{.RestartCount}}' \
  crm-gravity-mvp crm-max-personal-gateway crm-max-scraper)
sleep 10
health_gate
restart_counts_after=$(docker inspect --format '{{.Name}}={{.RestartCount}}' \
  crm-gravity-mvp crm-max-personal-gateway crm-max-scraper)
[[ $restart_counts_before == "$restart_counts_after" ]]

readonly PROD_HEAD_AFTER=$(git -C "$PROD_DIR" rev-parse HEAD)
readonly PROD_STATUS_AFTER=$(git -C "$PROD_DIR" status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}')
readonly PROD_TREE_HASH_AFTER=$(tracked_tree_hash)
[[ $PROD_HEAD_BEFORE == "$PROD_HEAD_AFTER" && $PROD_STATUS_BEFORE == "$PROD_STATUS_AFTER" \
  && $PROD_TREE_HASH_BEFORE == "$PROD_TREE_HASH_AFTER" ]]

backup_sha=$(awk '{print $1}' "$EVIDENCE_DIR/production-before-rc3-contact-identity.dump.sha256")
backup_bytes=$(stat -c '%s' "$EVIDENCE_DIR/production-before-rc3-contact-identity.dump")
jq -n --arg sourceSha "$SOURCE_SHA" --arg evidenceDirectory "$EVIDENCE_DIR" \
  --arg gravityImage "$GRAVITY_IMAGE" --arg gatewayImage "$GATEWAY_IMAGE" --arg scraperImage "$SCRAPER_IMAGE" \
  --arg providerMessageId "$provider_message_id" --arg backupSha "$backup_sha" --argjson backupBytes "$backup_bytes" \
  '{schemaVersion:1,status:"PERSONAL_MAX_TEXT_V1_RC3_CONTACT_IDENTITY_CONSOLIDATION_USER_CHECK_READY",
    sourceSha:$sourceSha,evidenceDirectory:$evidenceDirectory,
    images:{gravity:$gravityImage,gateway:$gatewayImage,scraper:$scraperImage},
    backup:{path:($evidenceDirectory+"/production-before-rc3-contact-identity.dump"),sha256:$backupSha,bytes:$backupBytes,
      pgRestoreList:true,isolatedRestore:true},
    incidentA:{phonePersisted:true,canonicalContact:true,activeMaxChat:1,activeRoute:1,
      existingBubbleRetried:true,newCrmBubbleCreated:false,providerActionCount:1,
      providerMessageId:$providerMessageId,providerStorePresence:"exactly_once"},
    incidentB:{phonePersisted:true,canonicalContact:true,historyPreserved:true,activeMaxChat:1,
      activeRoute:1,deadContactArchivedWithRedirect:true,duplicateMaxChannels:false},
    safety:{wrongContact:0,wrongPhone:0,wrongRoute:0,duplicateContactOwnership:0,
      queue:0,reconciliation:0,unresolvedUnknown:0,blindRetry:0,duplicateProviderActions:0},
    runtime:{gatewayReady200:true,scraperHealthy:true,crmHealthy:true,restartReplay:true,
      rollback:true,rollForward:true,senderEnabled:true,domFallback:false},
    productionTreeUnchanged:true,temporaryFlagsRemaining:false}' \
  >"$EVIDENCE_DIR/final-report.json"
install -o root -g codexbot -m 0640 "$EVIDENCE_DIR/final-report.json" "$RESULT_FILE"
seal_evidence
production_mutated=false
trap - EXIT
echo "PERSONAL_MAX_RC3_CONTACT_IDENTITY_REPORT=$RESULT_FILE"
echo 'PERSONAL MAX TEXT V1 RC3 CONTACT IDENTITY CONSOLIDATION USER CHECK READY'
