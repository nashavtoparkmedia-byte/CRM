#!/usr/bin/env bash
set -Eeuo pipefail

# Preserve evidence for the 2026-07-30 FIFO incident, then close every
# Personal MAX physical/durable sender gate. This script never creates a
# command, retries a dispatch, or mutates ledger rows.

readonly PROD_DIR=/opt/crm
readonly BASE_COMPOSE=/opt/crm/deploy/docker-compose.production.yml
readonly RELEASE_DIR=/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z
readonly OPERATIONAL_COMPOSE="${RELEASE_DIR}/deploy/docker-compose.personal-max-text-operational.yml"
readonly DEFAULT_OFF_COMPOSE="${RELEASE_DIR}/deploy/docker-compose.personal-max-final-default-off.yml"
readonly PROD_ENV=/opt/crm/.env.production
readonly OPERATIONAL_ENV=/var/lib/crm/max-personal-text-operational.env
readonly INCIDENT_START=2026-07-30T13:19:00Z
readonly INCIDENT_END=2026-07-30T13:22:00Z

if [[ ${EUID} -ne 0 ]]; then
  echo 'ERROR: root is required for bounded production evidence and default-off' >&2
  exit 77
fi

umask 0027
readonly STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly EVIDENCE_DIR="/var/backups/personal-max-fifo-failure-${STAMP}"
install -d -o root -g codexbot -m 2750 "$EVIDENCE_DIR"

finish() {
  local status=$?
  trap - EXIT
  set +e
  printf 'script_exit_status=%s\n' "$status" >"${EVIDENCE_DIR}/script-exit-status.txt"
  chown -R root:codexbot "$EVIDENCE_DIR"
  find "$EVIDENCE_DIR" -type d -exec chmod 2750 {} +
  find "$EVIDENCE_DIR" -type f -exec chmod 0640 {} +
  (
    cd "$EVIDENCE_DIR" || exit 1
    find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name SHA256SUMS.verify -printf '%P\0' \
      | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS
    sha256sum -c SHA256SUMS >SHA256SUMS.verify
  )
  chown root:codexbot "${EVIDENCE_DIR}/SHA256SUMS" "${EVIDENCE_DIR}/SHA256SUMS.verify"
  chmod 0640 "${EVIDENCE_DIR}/SHA256SUMS" "${EVIDENCE_DIR}/SHA256SUMS.verify"
  echo "PERSONAL_MAX_FIFO_EVIDENCE_DIR=${EVIDENCE_DIR}"
  exit "$status"
}
trap finish EXIT

run_sql() {
  local name=$1
  docker exec -i crm-postgres sh -c \
    'exec psql -X -v ON_ERROR_STOP=1 --csv -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    >"${EVIDENCE_DIR}/${name}.private.csv"
}

safe_flags() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" \
    | LC_ALL=C sort \
    | grep -E '^(MAX_PERSONAL_DURABLE_TEXT_ENABLED|MAX_PERSONAL_TEXT_SENDER_ENABLED|MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED|MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR|MAX_PERSONAL_TEXT_SENDER_OPERATIONAL_MODE|MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED)=' || true
}

cat >"${EVIDENCE_DIR}/manifest.txt" <<EOF
schema=personal-max-fifo-failure-evidence-v1
created_at_utc=${STAMP}
incident_start=${INCIDENT_START}
incident_end=${INCIDENT_END}
operation_order=evidence_then_default_off_then_read_only_verification
provider_action_performed=false
retry_performed=false
ledger_mutation_performed=false
EOF

git -C "$PROD_DIR" rev-parse HEAD >"${EVIDENCE_DIR}/production-git-head.before"
git -C "$PROD_DIR" status --short --branch >"${EVIDENCE_DIR}/production-git-status.before"
for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper crm-postgres; do
  docker inspect --format \
    'name={{.Name}} image={{.Config.Image}} image_id={{.Image}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart_count={{.RestartCount}} started_at={{.State.StartedAt}}' \
    "$container" >"${EVIDENCE_DIR}/${container}.before.txt"
done
safe_flags crm-gravity-mvp >"${EVIDENCE_DIR}/gravity-flags.before.txt"
safe_flags crm-max-personal-gateway >"${EVIDENCE_DIR}/gateway-flags.before.txt"
safe_flags crm-max-scraper >"${EVIDENCE_DIR}/scraper-flags.before.txt"

for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper; do
  docker logs --timestamps --since "$INCIDENT_START" --until "$INCIDENT_END" "$container" 2>&1 \
    | grep -E 'PMAX IN 0[1-5]|d3019fb32f(2a284a8b|2f125165|350c6e35|3d033327|42526c10)|personal.max|dispatch|attempt|provider|physical|confirmation' \
    >"${EVIDENCE_DIR}/${container}.incident.filtered.log" || true
done

run_sql messages <<'SQL'
SELECT m."content", m."id" AS "messageId", m."clientMessageId", m."externalId",
       m."status", m."sentAt", m."createdAt", m."updatedAt", m."channel", m."metadata"
FROM "Message" m
WHERE m."content" IN ('PMAX IN 01','PMAX IN 02','PMAX IN 03','PMAX IN 04','PMAX IN 05')
ORDER BY m."createdAt", m."id";
SQL

run_sql outbound_chains <<'SQL'
WITH target AS (
  SELECT * FROM "MaxOutboundCommand"
  WHERE "commandPayload"::text ~ 'PMAX IN 0[1-5]'
)
SELECT c."commandPayload"->>'text' AS "directText", c."commandPayload", c."commandId",
       c."clientMessageId", c."accountId", c."conversationKey", c."commandSequence", c."createdAt" AS "commandCreatedAt",
       r."reservationId", r."reservationState", r."leaseOwnerId", r."leaseEpoch", r."reservedAt", r."leaseUntil", r."releasedAt", r."handedOffAt",
       d."dispatchId", d."state" AS "dispatchState", d."stateVersion", d."attemptCount", d."providerMessageId", d."providerConfirmedAt", d."reconciliationRequiredAt", d."terminalAt",
       a."attemptId", a."attemptNumber", a."attemptState", a."senderOwnerId", a."senderFencingEpoch", a."senderAuthorityVerifiedAt",
       a."physicalActionStartedAt", a."clientActionAcceptedAt", a."awaitingConfirmationAt", a."outcomeUnknownAt", a."completedAt",
       lane."nextPhysicalSequence", lane."optimisticVersion" AS "laneVersion",
       actor."leaseOwnerId" AS "actorOwnerId", actor."leaseEpoch" AS "actorLeaseEpoch", actor."leaseUntil" AS "actorLeaseUntil",
       owner."ownerInstanceId", owner."fencingToken", owner."heartbeatAt", owner."leaseUntil" AS "ownerLeaseUntil", owner."state" AS "ownerState",
       route."routeVersion", route."state" AS "routeState"
FROM target c
LEFT JOIN "MaxOutboundCommandReservation" r ON r."commandId"=c."commandId"
LEFT JOIN "MaxOutboundDispatch" d ON d."commandId"=c."commandId"
LEFT JOIN "MaxOutboundDispatchAttempt" a ON a."dispatchId"=d."dispatchId"
LEFT JOIN "MaxOutboundDispatchLane" lane ON lane."accountId"=c."accountId" AND lane."conversationKey"=c."conversationKey"
LEFT JOIN "MaxOutboundConversationActor" actor ON actor."accountId"=c."accountId" AND actor."conversationKey"=c."conversationKey"
LEFT JOIN "MaxAccountSessionOwner" owner ON owner."accountId"=c."accountId"
LEFT JOIN "MaxRouteConversation" route ON route."accountId"=c."accountId" AND route."conversationKey"=c."conversationKey"
ORDER BY c."commandSequence", a."attemptNumber";
SQL

run_sql confirmations <<'SQL'
WITH provider_ids AS (
  SELECT "externalId" AS id FROM "Message"
  WHERE "content" IN ('PMAX IN 01','PMAX IN 02','PMAX IN 03','PMAX IN 04','PMAX IN 05')
)
SELECT e."evidenceId", e."accountId", e."sourceJournalSequence", e."sourceEventOrdinal",
       e."evidenceKind", e."providerMessageId", e."attemptCorrelationId", e."clientMessageId",
       e."protocolChatId", e."webRouteId", e."providerOccurredAt", e."safeMetadata", e."createdAt",
       r."status" AS "resolutionStatus", r."matchMethod", r."dispatchId", r."attemptId", r."resolvedAt", r."resolutionReason"
FROM "MaxProviderConfirmationEvidence" e
LEFT JOIN "MaxProviderConfirmationResolution" r ON r."evidenceId"=e."evidenceId"
WHERE e."providerMessageId" IN (SELECT id FROM provider_ids)
ORDER BY e."providerOccurredAt", e."sourceJournalSequence", e."sourceEventOrdinal";
SQL

run_sql raw_provider_order <<'SQL'
WITH provider_ids AS (
  SELECT "externalId" AS id FROM "Message"
  WHERE "content" IN ('PMAX IN 01','PMAX IN 02','PMAX IN 03','PMAX IN 04','PMAX IN 05')
)
SELECT r."observationId", r."journalSequence", r."observedAt", r."persistedAt", r."historyLive",
       r."socketGeneration", r."frameId", r."providerEventId", r."transportSequence", r."opcode",
       r."eventType", r."sanitizedPayload", r."correlationMetadata", r."quarantineReason"
FROM "MaxRawTransportEvent" r
WHERE EXISTS (SELECT 1 FROM provider_ids p WHERE r."sanitizedPayload"::text LIKE '%' || p.id || '%')
ORDER BY r."journalSequence";
SQL

run_sql transitions <<'SQL'
WITH target_dispatch AS (
  SELECT d."dispatchId"
  FROM "MaxOutboundDispatch" d JOIN "MaxOutboundCommand" c ON c."commandId"=d."commandId"
  WHERE c."commandPayload"::text ~ 'PMAX IN 0[1-5]'
)
SELECT t.* FROM "MaxOutboundDispatchTransition" t
WHERE t."dispatchId" IN (SELECT "dispatchId" FROM target_dispatch)
ORDER BY t."dispatchId", t."transitionSequence";
SQL

run_sql open_counts <<'SQL'
SELECT 'dispatch' AS kind, "state" AS state, count(*)::bigint FROM "MaxOutboundDispatch" GROUP BY "state"
UNION ALL SELECT 'reconciliation', "state", count(*)::bigint FROM "MaxOutboundReconciliationTask" GROUP BY "state"
ORDER BY kind,state;
SQL

compose=(docker compose --env-file "$PROD_ENV" --env-file "$OPERATIONAL_ENV"
  -f "$BASE_COMPOSE" -f "$OPERATIONAL_COMPOSE" -f "$DEFAULT_OFF_COMPOSE")
"${compose[@]}" config --format json >"${EVIDENCE_DIR}/default-off-render.private.json"
jq -e '
  .services["gravity-mvp"].environment.MAX_PERSONAL_DURABLE_TEXT_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "false" and
  .services["max-personal-gateway"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_ENABLED == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED == "false" and
  .services["max-web-scraper"].environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR == "false"
' "${EVIDENCE_DIR}/default-off-render.private.json" >"${EVIDENCE_DIR}/default-off-render.validation.txt"

"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 \
  gravity-mvp max-personal-gateway max-web-scraper \
  >"${EVIDENCE_DIR}/default-off-compose.stdout" 2>"${EVIDENCE_DIR}/default-off-compose.stderr"

safe_flags crm-gravity-mvp >"${EVIDENCE_DIR}/gravity-flags.after.txt"
safe_flags crm-max-personal-gateway >"${EVIDENCE_DIR}/gateway-flags.after.txt"
safe_flags crm-max-scraper >"${EVIDENCE_DIR}/scraper-flags.after.txt"
grep -Fx 'MAX_PERSONAL_DURABLE_TEXT_ENABLED=false' "${EVIDENCE_DIR}/gravity-flags.after.txt"
for name in gateway scraper; do
  grep -Fx 'MAX_PERSONAL_TEXT_SENDER_ENABLED=false' "${EVIDENCE_DIR}/${name}-flags.after.txt"
  grep -Fx 'MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED=false' "${EVIDENCE_DIR}/${name}-flags.after.txt"
  grep -Fx 'MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR=false' "${EVIDENCE_DIR}/${name}-flags.after.txt"
done

for container in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper crm-postgres; do
  docker inspect --format \
    'name={{.Name}} image={{.Config.Image}} image_id={{.Image}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart_count={{.RestartCount}} started_at={{.State.StartedAt}}' \
    "$container" >"${EVIDENCE_DIR}/${container}.after.txt"
done
git -C "$PROD_DIR" rev-parse HEAD >"${EVIDENCE_DIR}/production-git-head.after"
git -C "$PROD_DIR" status --short --branch >"${EVIDENCE_DIR}/production-git-status.after"
cmp "${EVIDENCE_DIR}/production-git-head.before" "${EVIDENCE_DIR}/production-git-head.after"
cmp "${EVIDENCE_DIR}/production-git-status.before" "${EVIDENCE_DIR}/production-git-status.after"

printf '%s\n' 'DEFAULT_OFF_VERIFIED=true' 'ADDITIONAL_PROVIDER_ACTIONS=0' \
  'AUTOMATIC_RETRIES_TRIGGERED_BY_SCRIPT=0' 'LEDGER_ROWS_DELETED=0' >"${EVIDENCE_DIR}/gate.txt"
