#!/usr/bin/env bash
set -Eeuo pipefail

# PERSONAL MAX UAT failure incident response.
# Order is intentional: preserve the short-lived evidence first, then close all
# durable and physical text-sender gates, then perform read-only verification.

readonly PROD_DIR=/opt/crm
readonly BASE_COMPOSE=/opt/crm/deploy/docker-compose.production.yml
readonly RELEASE_DIR=/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z
readonly OPERATIONAL_COMPOSE="${RELEASE_DIR}/deploy/docker-compose.personal-max-text-operational.yml"
readonly DEFAULT_OFF_COMPOSE="${RELEASE_DIR}/deploy/docker-compose.personal-max-final-default-off.yml"
readonly PROD_ENV=/opt/crm/.env.production
readonly OPERATIONAL_ENV=/var/lib/crm/max-personal-text-operational.env
readonly INCIDENT_START='2026-07-30T09:07:00Z'
readonly INCIDENT_END='2026-07-30T09:13:00Z'
readonly BASE_COMPOSE_SHA256='153c48db0ee5ceecf545a57c257ac7f32886f26de7c9806b4097991124673e47'
readonly OPERATIONAL_COMPOSE_SHA256='d41a36de5a1a1e5330798d5bd40a5a0adcb84884c5e0748458df11ae2d8eaebd'
readonly DEFAULT_OFF_COMPOSE_SHA256='1f3b927190535991cc61c89b588c3c6a848c1da687843b2f442cb8f62f64b930'

if [[ ${EUID} -ne 0 ]]; then
  echo 'ERROR: this bounded incident script must run as root' >&2
  exit 77
fi

for required in "$PROD_DIR" "$BASE_COMPOSE" "$OPERATIONAL_COMPOSE" \
  "$DEFAULT_OFF_COMPOSE" "$PROD_ENV" "$OPERATIONAL_ENV"; do
  if [[ ! -e "$required" || -L "$required" ]]; then
    echo "ERROR: required exact non-symlink path is unavailable: $required" >&2
    exit 78
  fi
done

printf '%s  %s\n' "$BASE_COMPOSE_SHA256" "$BASE_COMPOSE" \
  "$OPERATIONAL_COMPOSE_SHA256" "$OPERATIONAL_COMPOSE" \
  "$DEFAULT_OFF_COMPOSE_SHA256" "$DEFAULT_OFF_COMPOSE" | sha256sum -c -

umask 0027
readonly STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly EVIDENCE_DIR="/var/backups/personal-max-uat-failure-${STAMP}"
install -d -o root -g codexbot -m 2750 "$EVIDENCE_DIR"

finalize_evidence() {
  local exit_status=$?
  trap - EXIT
  set +e
  printf 'script_exit_status=%s\n' "$exit_status" >"${EVIDENCE_DIR}/script-exit-status.txt"
  chown -R root:codexbot "$EVIDENCE_DIR"
  find "$EVIDENCE_DIR" -type d -exec chmod 2750 {} +
  find "$EVIDENCE_DIR" -type f -exec chmod 0640 {} +
  (
    cd "$EVIDENCE_DIR" || exit 1
    find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name SHA256SUMS.verify -printf '%P\0' \
      | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS
    sha256sum -c SHA256SUMS >SHA256SUMS.verify
  )
  chown root:codexbot "${EVIDENCE_DIR}/SHA256SUMS" "${EVIDENCE_DIR}/SHA256SUMS.verify" 2>/dev/null
  chmod 0640 "${EVIDENCE_DIR}/SHA256SUMS" "${EVIDENCE_DIR}/SHA256SUMS.verify" 2>/dev/null
  exit "$exit_status"
}
trap finalize_evidence EXIT

record_failure() {
  printf '%s\n' "$2" >"${EVIDENCE_DIR}/$1.error"
}

run_sql() {
  local name=$1
  if ! docker exec -i crm-postgres sh -c \
    'exec psql -X -v ON_ERROR_STOP=1 --csv -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    >"${EVIDENCE_DIR}/${name}.private.csv" 2>"${EVIDENCE_DIR}/${name}.stderr"; then
    record_failure "$name" 'production PostgreSQL evidence query failed; see sibling stderr'
    return 0
  fi
  rm -f "${EVIDENCE_DIR}/${name}.stderr"
}

safe_env_flags() {
  local container=$1
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | LC_ALL=C sort \
    | grep -E '^(MAX_PERSONAL_DURABLE_TEXT_ENABLED|MAX_PERSONAL_TEXT_SENDER_ENABLED|MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED|MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR|MAX_PERSONAL_TEXT_SENDER_OPERATIONAL_MODE|MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED)=' || true
}

compose_cmd=(docker compose --env-file "$PROD_ENV" --env-file "$OPERATIONAL_ENV"
  -f "$BASE_COMPOSE" -f "$OPERATIONAL_COMPOSE" -f "$DEFAULT_OFF_COMPOSE")

cat >"${EVIDENCE_DIR}/manifest.txt" <<EOF
schema=personal-max-uat-failure-evidence-v1
created_at_utc=${STAMP}
incident_start=${INCIDENT_START}
incident_end=${INCIDENT_END}
operation_order=evidence_then_default_off_then_read_only_verification
physical_retry_performed=false
message_delete_performed=false
provider_action_performed=false
EOF

git -C "$PROD_DIR" rev-parse HEAD >"${EVIDENCE_DIR}/production-git-head.before"
git -C "$PROD_DIR" status --short --branch >"${EVIDENCE_DIR}/production-git-status.before"
find "$PROD_DIR" -xdev -type f -printf '%P\0' | LC_ALL=C sort -z | sha256sum \
  >"${EVIDENCE_DIR}/production-file-list.before.sha256"

for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper crm-postgres; do
  if ! docker inspect --format \
    'name={{.Name}} image={{.Config.Image}} image_id={{.Image}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart_count={{.RestartCount}} started_at={{.State.StartedAt}}' \
    "$container" >"${EVIDENCE_DIR}/${container}.before.txt" 2>&1; then
    record_failure "${container}.before" 'container metadata unavailable'
  fi
done
safe_env_flags crm-gravity-mvp >"${EVIDENCE_DIR}/gravity-flags.before.txt"
safe_env_flags crm-max-personal-gateway >"${EVIDENCE_DIR}/gateway-flags.before.txt"
safe_env_flags crm-max-scraper >"${EVIDENCE_DIR}/scraper-flags.before.txt"

# Logs are access-controlled incident evidence. They are captured before the
# containers are recreated so the original short-lived stdout/stderr survives.
for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper; do
  if ! docker logs --timestamps --since "$INCIDENT_START" --until "$INCIDENT_END" "$container" \
    >"${EVIDENCE_DIR}/${container}.incident.private.log" 2>&1; then
    record_failure "${container}.incident-log" 'incident log capture failed'
  fi
done

# Exact CRM bubbles and their immutable client/provider identities.
run_sql messages <<'SQL'
SELECT m."id", m."chatId", m."direction", m."type", m."content", m."status",
       m."externalId", m."clientMessageId", m."sentAt", m."createdAt", m."updatedAt",
       m."channel", m."metadata"
FROM "Message" m
WHERE m."createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
  AND m."createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
  AND m."content" IN (
    'Тест Personal MAX 1', 'Одинаковое сообщение',
    'Сообщение 1', 'Сообщение 2', 'Сообщение 3',
    'Ответ из MAX', 'Входящее 1', 'Входящее 2', 'Входящее 3', '3'
  )
ORDER BY m."createdAt", m."id";
SQL

run_sql message_events <<'SQL'
SELECT e."id" AS "eventLogId", e."messageId", e."eventType", e."status",
       e."metadata", e."createdAt", e."updatedAt",
       m."direction", m."content", m."externalId", m."clientMessageId"
FROM "MessageEventLog" e
JOIN "Message" m ON m."id" = e."messageId"
WHERE m."createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
  AND m."createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
  AND m."content" IN (
    'Тест Personal MAX 1', 'Одинаковое сообщение',
    'Сообщение 1', 'Сообщение 2', 'Сообщение 3',
    'Ответ из MAX', 'Входящее 1', 'Входящее 2', 'Входящее 3', '3'
  )
ORDER BY e."createdAt", e."id";
SQL

# One row per immutable command with the full durable dispatch, attempt,
# reservation, FIFO-lane, route and fencing chain.
run_sql outbound_chains <<'SQL'
WITH incident_commands AS (
  SELECT * FROM "MaxOutboundCommand"
  WHERE "createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
    AND "createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
    AND "commandPayload"->>'text' IN (
      'Тест Personal MAX 1', 'Одинаковое сообщение',
      'Сообщение 1', 'Сообщение 2', 'Сообщение 3'
    )
)
SELECT c."commandId", c."accountId", c."conversationKey", c."clientMessageId",
       c."commandSequence", c."commandKind", c."commandPayload", c."payloadSha256",
       c."source", c."createdAt",
       r."reservationId", r."reservationState", r."reservationVersion",
       r."leaseOwnerId", r."leaseEpoch", r."reservedAt", r."leaseUntil",
       r."releasedAt", r."handoffReference", r."handedOffAt",
       d."dispatchId", d."state" AS "dispatchState", d."stateVersion",
       d."initialRouteVersion", d."initialProtocolChatId", d."initialProviderUserId",
       d."initialWebRouteId", d."currentAttemptId", d."attemptCount",
       d."providerMessageId", d."providerConfirmedAt", d."reconciliationRequiredAt",
       d."terminalAt", d."createdAt" AS "dispatchCreatedAt", d."updatedAt" AS "dispatchUpdatedAt",
       a."attemptId", a."attemptNumber", a."attemptState", a."attemptVersion",
       a."senderOwnerId", a."senderFencingEpoch", a."senderAuthorityVerifiedAt",
       a."attemptCorrelationId", a."routeVersion", a."protocolChatId", a."providerUserId",
       a."webRouteId", a."preparedAt", a."claimUntil", a."physicalActionStartedAt",
       a."clientActionAcceptedAt", a."awaitingConfirmationAt", a."outcomeUnknownAt",
       a."completedAt", a."safeErrorCode", a."createdAt" AS "attemptCreatedAt",
       lane."nextPhysicalSequence", lane."optimisticVersion" AS "laneVersion",
       actor."nextCommandSequence", actor."nextHandoffSequence", actor."leaseOwnerId" AS "actorLeaseOwnerId",
       actor."leaseEpoch" AS "actorLeaseEpoch", actor."leaseUntil" AS "actorLeaseUntil",
       owner."ownerInstanceId", owner."fencingToken", owner."heartbeatAt" AS "ownerHeartbeatAt",
       owner."leaseUntil" AS "ownerLeaseUntil", owner."state" AS "ownerState", owner."version" AS "ownerVersion",
       route."routeVersion" AS "currentRouteVersion", route."state" AS "routeState"
FROM incident_commands c
LEFT JOIN "MaxOutboundCommandReservation" r ON r."commandId" = c."commandId"
LEFT JOIN "MaxOutboundDispatch" d ON d."commandId" = c."commandId"
LEFT JOIN "MaxOutboundDispatchAttempt" a ON a."dispatchId" = d."dispatchId"
LEFT JOIN "MaxOutboundDispatchLane" lane
  ON lane."accountId" = c."accountId" AND lane."conversationKey" = c."conversationKey"
LEFT JOIN "MaxOutboundConversationActor" actor
  ON actor."accountId" = c."accountId" AND actor."conversationKey" = c."conversationKey"
LEFT JOIN "MaxAccountSessionOwner" owner ON owner."accountId" = c."accountId"
LEFT JOIN "MaxRouteConversation" route
  ON route."accountId" = c."accountId" AND route."conversationKey" = c."conversationKey"
ORDER BY c."commandSequence", a."attemptNumber", r."createdAt";
SQL

run_sql outbound_transitions <<'SQL'
WITH incident_dispatches AS (
  SELECT d."dispatchId"
  FROM "MaxOutboundDispatch" d
  JOIN "MaxOutboundCommand" c ON c."commandId" = d."commandId"
  WHERE c."createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
    AND c."createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
    AND c."commandPayload"->>'text' IN (
      'Тест Personal MAX 1', 'Одинаковое сообщение',
      'Сообщение 1', 'Сообщение 2', 'Сообщение 3'
    )
)
SELECT t.* FROM "MaxOutboundDispatchTransition" t
JOIN incident_dispatches d ON d."dispatchId" = t."dispatchId"
ORDER BY t."dispatchId", t."transitionSequence";
SQL

run_sql reconciliation <<'SQL'
WITH incident_dispatches AS (
  SELECT d."dispatchId"
  FROM "MaxOutboundDispatch" d
  JOIN "MaxOutboundCommand" c ON c."commandId" = d."commandId"
  WHERE c."createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
    AND c."createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
    AND c."commandPayload"->>'text' IN (
      'Тест Personal MAX 1', 'Одинаковое сообщение',
      'Сообщение 1', 'Сообщение 2', 'Сообщение 3'
    )
)
SELECT r.* FROM "MaxOutboundReconciliationTask" r
JOIN incident_dispatches d ON d."dispatchId" = r."dispatchId"
ORDER BY r."openedAt", r."reconciliationId";
SQL

run_sql confirmation <<'SQL'
WITH incident_dispatches AS (
  SELECT d."dispatchId"
  FROM "MaxOutboundDispatch" d
  JOIN "MaxOutboundCommand" c ON c."commandId" = d."commandId"
  WHERE c."createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
    AND c."createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
    AND c."commandPayload"->>'text' IN (
      'Тест Personal MAX 1', 'Одинаковое сообщение',
      'Сообщение 1', 'Сообщение 2', 'Сообщение 3'
    )
)
SELECT e.*, r."resolutionId", r."status" AS "resolutionStatus", r."matchMethod",
       r."dispatchId", r."attemptId", r."transitionId", r."canonicalEvidenceId",
       r."issueCode", r."safeIssueSummary", r."resolutionVersion", r."retryCount",
       r."nextRetryAt", r."resolvedAt", r."resolvedBy", r."resolutionReason",
       d."decisionId", d."decisionSequence", d."decisionType", d."fromStatus",
       d."toStatus", d."actor", d."reason", d."createdAt" AS "decisionCreatedAt"
FROM "MaxProviderConfirmationEvidence" e
LEFT JOIN "MaxProviderConfirmationResolution" r ON r."evidenceId" = e."evidenceId"
LEFT JOIN "MaxProviderConfirmationDecision" d ON d."resolutionId" = r."resolutionId"
WHERE r."dispatchId" IN (SELECT "dispatchId" FROM incident_dispatches)
   OR e."createdAt" BETWEEN TIMESTAMP '2026-07-30 09:07:00' AND TIMESTAMP '2026-07-30 09:13:00'
ORDER BY e."sourceJournalSequence", e."sourceEventOrdinal", d."decisionSequence";
SQL

# Full already-sanitized journal payload is retained internally so the bogus
# standalone `3` can be traced to one physical frame and parser outcome.
run_sql raw_transport <<'SQL'
SELECT r."observationId", r."journalSequence", r."accountId", r."captureEnvelopeId",
       r."observedAt", r."persistedAt", r."sourceTransport", r."sourceOrigin",
       r."historyLive", r."socketGeneration", r."frameId", r."providerEventId",
       r."transportSequence", r."opcode", r."eventType", r."payloadEncoding",
       r."sanitizedPayload", r."payloadSha256", r."payloadSizeBytes",
       r."replayAvailability", r."quarantineReason", r."sanitizerVersion",
       r."captureAdapterVersion", r."schemaVersion", r."correlationMetadata",
       r."redactionMetadata", r."quarantineEligible"
FROM "MaxRawTransportEvent" r
WHERE r."observedAt" >= TIMESTAMP '2026-07-30 09:07:00'
  AND r."observedAt" <  TIMESTAMP '2026-07-30 09:13:00'
ORDER BY r."journalSequence";
SQL

run_sql normalized_inbound <<'SQL'
SELECT n."normalizationResultId", n."accountId", n."sourceObservationId",
       n."sourceJournalSequence", n."parserVersion", n."envelopeVersion",
       n."status", n."eventCount", n."issueCode", n."safeIssueSummary",
       n."startedAt", n."completedAt",
       e."normalizedEventId", e."eventOrdinal", e."eventKind", e."direction",
       e."origin", e."providerMessageId", e."providerUserId", e."protocolChatId",
       e."webRouteId", e."clientMessageId", e."targetProviderMessageId",
       e."providerOccurredAt", e."normalizedPayload", e."semanticSha256", e."createdAt"
FROM "MaxInboundNormalizationResult" n
JOIN "MaxRawTransportEvent" raw ON raw."observationId" = n."sourceObservationId"
LEFT JOIN "MaxInboundNormalizedEvent" e
  ON e."normalizationResultId" = n."normalizationResultId"
WHERE raw."observedAt" >= TIMESTAMP '2026-07-30 09:07:00'
  AND raw."observedAt" <  TIMESTAMP '2026-07-30 09:13:00'
ORDER BY n."sourceJournalSequence", e."eventOrdinal";
SQL

run_sql route_isolation <<'SQL'
WITH incident_routes AS (
  SELECT DISTINCT "accountId", "conversationKey"
  FROM "MaxOutboundCommand"
  WHERE "createdAt" >= TIMESTAMP '2026-07-30 09:07:00'
    AND "createdAt" <  TIMESTAMP '2026-07-30 09:13:00'
    AND "commandPayload"->>'text' IN (
      'Тест Personal MAX 1', 'Одинаковое сообщение',
      'Сообщение 1', 'Сообщение 2', 'Сообщение 3'
    )
)
SELECT r.*, b."id" AS "bindingId", b."identityKind", b."identityValue",
       b."status" AS "bindingStatus", b."version" AS "bindingVersion"
FROM "MaxRouteConversation" r
JOIN incident_routes i ON i."accountId" = r."accountId" AND i."conversationKey" = r."conversationKey"
LEFT JOIN "MaxRouteIdentityBinding" b
  ON b."accountId" = r."accountId" AND b."conversationKey" = r."conversationKey"
ORDER BY r."accountId", r."conversationKey", b."identityKind", b."id";
SQL

# Render and prove the exact emergency state before changing containers.
"${compose_cmd[@]}" config --format json >"${EVIDENCE_DIR}/default-off-render.private.json"
jq -e '
  .services["gravity-mvp"].environment.MAX_PERSONAL_DURABLE_TEXT_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED == "true"
' "${EVIDENCE_DIR}/default-off-render.private.json" >"${EVIDENCE_DIR}/default-off-render.validation.txt"

# The only production mutation: recreate the three bounded services from their
# already accepted immutable images, with every physical/durable text gate off.
"${compose_cmd[@]}" up -d --no-build --pull never --wait --wait-timeout 240 \
  gravity-mvp max-personal-gateway max-web-scraper \
  >"${EVIDENCE_DIR}/default-off-compose.stdout" \
  2>"${EVIDENCE_DIR}/default-off-compose.stderr"

safe_env_flags crm-gravity-mvp >"${EVIDENCE_DIR}/gravity-flags.after.txt"
safe_env_flags crm-max-personal-gateway >"${EVIDENCE_DIR}/gateway-flags.after.txt"
safe_env_flags crm-max-scraper >"${EVIDENCE_DIR}/scraper-flags.after.txt"

grep -Fx 'MAX_PERSONAL_DURABLE_TEXT_ENABLED=false' "${EVIDENCE_DIR}/gravity-flags.after.txt"
for flag_file in gateway scraper; do
  grep -Fx 'MAX_PERSONAL_TEXT_SENDER_ENABLED=false' "${EVIDENCE_DIR}/${flag_file}-flags.after.txt"
  grep -Fx 'MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false' "${EVIDENCE_DIR}/${flag_file}-flags.after.txt"
  grep -Fx 'MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false' "${EVIDENCE_DIR}/${flag_file}-flags.after.txt"
done
grep -Fx 'MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED=true' "${EVIDENCE_DIR}/scraper-flags.after.txt"

for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper crm-postgres; do
  docker inspect --format \
    'name={{.Name}} image={{.Config.Image}} image_id={{.Image}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart_count={{.RestartCount}} started_at={{.State.StartedAt}}' \
    "$container" >"${EVIDENCE_DIR}/${container}.after.txt"
done

docker exec crm-max-personal-gateway node -e \
  "fetch('http://127.0.0.1:8080/ready').then(async r=>{console.log(JSON.stringify({status:r.status,body:await r.json()}));process.exit(r.status===200?0:1)}).catch(()=>process.exit(1))" \
  >"${EVIDENCE_DIR}/gateway-ready.after.json"
docker exec crm-max-scraper node -e \
  "fetch('http://127.0.0.1:3005/health').then(async r=>{const b=await r.json();console.log(JSON.stringify({status:r.status,body:b}));process.exit(r.status===200&&b.isReady===true&&b.queueLength===0?0:1)}).catch(()=>process.exit(1))" \
  >"${EVIDENCE_DIR}/scraper-health.after.json"

run_sql post_default_off_counts <<'SQL'
SELECT 'dispatch_state' AS kind, "state" AS value, count(*)::bigint AS count
FROM "MaxOutboundDispatch"
GROUP BY "state"
UNION ALL
SELECT 'attempt_state', "attemptState", count(*)::bigint
FROM "MaxOutboundDispatchAttempt"
GROUP BY "attemptState"
UNION ALL
SELECT 'reconciliation_state', "state", count(*)::bigint
FROM "MaxOutboundReconciliationTask"
GROUP BY "state"
UNION ALL
SELECT 'confirmation_resolution', "status", count(*)::bigint
FROM "MaxProviderConfirmationResolution"
GROUP BY "status"
ORDER BY kind, value;
SQL

git -C "$PROD_DIR" rev-parse HEAD >"${EVIDENCE_DIR}/production-git-head.after"
git -C "$PROD_DIR" status --short --branch >"${EVIDENCE_DIR}/production-git-status.after"
find "$PROD_DIR" -xdev -type f -printf '%P\0' | LC_ALL=C sort -z | sha256sum \
  >"${EVIDENCE_DIR}/production-file-list.after.sha256"
cmp "${EVIDENCE_DIR}/production-git-head.before" "${EVIDENCE_DIR}/production-git-head.after"
cmp "${EVIDENCE_DIR}/production-git-status.before" "${EVIDENCE_DIR}/production-git-status.after"
cmp "${EVIDENCE_DIR}/production-file-list.before.sha256" "${EVIDENCE_DIR}/production-file-list.after.sha256"

printf '%s\n' 'DEFAULT_OFF_VERIFIED=true' >"${EVIDENCE_DIR}/gate.txt"
printf '%s\n' 'ADDITIONAL_PROVIDER_ACTIONS=0' >>"${EVIDENCE_DIR}/gate.txt"
printf '%s\n' 'AUTOMATIC_RETRIES_TRIGGERED_BY_SCRIPT=0' >>"${EVIDENCE_DIR}/gate.txt"
printf '%s\n' 'MESSAGE_ROWS_DELETED=0' >>"${EVIDENCE_DIR}/gate.txt"

echo "PERSONAL_MAX_UAT_EVIDENCE_DIR=${EVIDENCE_DIR}"
echo 'PERSONAL_MAX_PHYSICAL_SENDER_DEFAULT_OFF=VERIFIED'
