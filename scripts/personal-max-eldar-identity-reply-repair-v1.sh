#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_PATH=${BASH_SOURCE[0]}
readonly CONTACT_ID=cms71ulev002xo90jdjqe9cks
readonly CHAT_ID=cms74ktyq0058o90jofjgattl
readonly CANONICAL_IDENTITY_ID=cms74ku1m005fo90je6z5xlph
readonly ACCOUNT_ID=max-personal-81d98d8cc9fc95c1f1c0461f
readonly PROTOCOL_CHAT_ID=902197592419
readonly UI_ROUTE_ID=254460259
readonly PROVIDER_PARTICIPANT_ID=901985778243
readonly OWNER_PROVIDER_USER_ID=902171753248
readonly CANONICAL_PHONE=+79990838709
readonly WRONG_PHONE=+79140635630
readonly WRONG_PHONE_ROW_ID=cms80vq4s0001o90j9uyn9qf9
readonly SPLIT_CONTACT_ID=pmax_lukyanova_contact_20260801
readonly SPLIT_DRIVER_ID=cms825epi00gto90j92uchfxb
readonly SPLIT_DRIVER_NAME='Лукьянова Виктория Евгеньевна'
readonly REPLY_PROVIDER_ID=d3019fb3b2a7db2aed
readonly REPLY_TARGET_PROVIDER_ID=d3019fb3ab8bcb0673
readonly PG_CONTAINER=${PG_CONTAINER:-crm-postgres}

if [[ ${EUID} -ne 0 ]]; then
  echo 'ERROR: root is required for the checksum-bound targeted repair' >&2
  exit 77
fi
if [[ $# -ne 4 || ! $1 =~ ^[0-9a-f]{64}$ || ! $3 =~ ^[0-9a-f]{64}$ \
   || ! $4 =~ ^(dry-run|apply)$ ]]; then
  echo 'usage: personal-max-eldar-identity-reply-repair-v1.sh <script-sha256> <snapshot.json> <snapshot-sha256> <dry-run|apply>' >&2
  exit 64
fi

readonly EXPECTED_SCRIPT_SHA=$1
readonly SNAPSHOT_PATH=$2
readonly SNAPSHOT_SHA=$3
readonly MODE=$4
readonly APPLY=$([[ $MODE == apply ]] && echo true || echo false)

[[ ! -L $SCRIPT_PATH && $(sha256sum "$SCRIPT_PATH" | awk '{print $1}') == "$EXPECTED_SCRIPT_SHA" ]] \
  || { echo 'ERROR: script checksum mismatch' >&2; exit 66; }
[[ -f $SNAPSHOT_PATH && ! -L $SNAPSHOT_PATH ]] \
  || { echo 'ERROR: snapshot is missing or unsafe' >&2; exit 67; }
[[ $(sha256sum "$SNAPSHOT_PATH" | awk '{print $1}') == "$SNAPSHOT_SHA" ]] \
  || { echo 'ERROR: snapshot checksum mismatch' >&2; exit 68; }

jq -e --arg account "$ACCOUNT_ID" --arg chat "$PROTOCOL_CHAT_ID" \
  --arg route "$UI_ROUTE_ID" --arg participant "$PROVIDER_PARTICIPANT_ID" \
  --arg owner "$OWNER_PROVIDER_USER_ID" --arg reply "$REPLY_PROVIDER_ID" \
  --arg target "$REPLY_TARGET_PROVIDER_ID" '
  .schemaVersion == 1 and .source == "max_provider_store_read_only" and
  .accountId == $account and .protocolChatId == $chat and .uiRouteId == $route and
  .providerUserId == $participant and .ownerUserId == $owner and
  .routeMatchCount == 1 and (.messages | length) == 22 and
  ([.messages[].providerMessageId] | unique | length) == 22 and
  ([.messages[] | select(.textDisposition != "exact_unicode" and .messageType == "text")] | length) == 0 and
  ([.messages[] | select(.providerMessageId == $reply and .replyToProviderMessageId == $target)] | length) == 1 and
  ([.messages[] | select(.providerMessageId == $target and .direction == "inbound")] | length) == 1
' "$SNAPSHOT_PATH" >/dev/null

readonly QUOTE_B64=$(jq -r --arg reply "$REPLY_PROVIDER_ID" \
  '.messages[] | select(.providerMessageId == $reply) | (.quotedTextPreview // "") | @base64' "$SNAPSHOT_PATH")
readonly QUOTE_DIRECTION=$(jq -r --arg reply "$REPLY_PROVIDER_ID" \
  '.messages[] | select(.providerMessageId == $reply) | (.quotedDirection // "inbound")' "$SNAPSHOT_PATH")
readonly QUOTE_TIMESTAMP=$(jq -r --arg reply "$REPLY_PROVIDER_ID" \
  '.messages[] | select(.providerMessageId == $reply) | ((.quotedTimestamp // 0) | tostring)' "$SNAPSHOT_PATH")

readonly STAMP=$(date -u +%Y%m%dT%H%M%SZ)
readonly EVIDENCE_ROOT=${EVIDENCE_ROOT:-/var/backups}
readonly EVIDENCE_DIR=${EVIDENCE_DIR:-${EVIDENCE_ROOT}/personal-max-eldar-identity-reply-repair-${STAMP}}
[[ ! -e $EVIDENCE_DIR ]]
install -d -o root -g codexbot -m 2750 "$EVIDENCE_DIR"
readonly RESULT_JSON=$EVIDENCE_DIR/result.json
readonly FORENSIC_JSON=$EVIDENCE_DIR/forensic.private.json

jq --arg snapshotSha "$SNAPSHOT_SHA" --arg contact "$CONTACT_ID" \
  --arg wrongPhone "$WRONG_PHONE" --arg splitDriver "$SPLIT_DRIVER_ID" \
  --arg reply "$REPLY_PROVIDER_ID" --arg target "$REPLY_TARGET_PROVIDER_ID" '
  {
    schemaVersion: 1,
    repair: "personal-max-eldar-identity-reply-v1",
    snapshotSha256: $snapshotSha,
    contactId: $contact,
    wrongPhone: $wrongPhone,
    splitDriverId: $splitDriver,
    replyProviderMessageId: $reply,
    replyTargetProviderMessageId: $target,
    providerReply: (.messages[] | select(.providerMessageId == $reply)),
    providerReplyTarget: (.messages[] | select(.providerMessageId == $target))
  }
' "$SNAPSHOT_PATH" >"$FORENSIC_JSON"
chown root:codexbot "$FORENSIC_JSON"
chmod 0640 "$FORENSIC_JSON"

docker exec -i "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt \
  -v mode="$MODE" -v apply="$APPLY" \
  -v quote_b64="$QUOTE_B64" -v quote_direction="$QUOTE_DIRECTION" -v quote_timestamp="$QUOTE_TIMESTAMP" \
  -U crm -d tg_bot_db >"$RESULT_JSON" <<'SQL'
BEGIN;
CREATE TEMP TABLE runtime_mode AS SELECT :'apply'::boolean AS apply;
CREATE TEMP TABLE reply_context AS SELECT
  convert_from(decode(:'quote_b64','base64'),'UTF8') AS quote_text,
  :'quote_direction'::text AS quote_direction,
  (:'quote_timestamp')::numeric AS quote_timestamp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  PERFORM id FROM "Contact" WHERE id='cms71ulev002xo90jdjqe9cks' AND NOT "isArchived" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical Contact mismatch'; END IF;
  PERFORM id FROM "Chat" WHERE id='cms74ktyq0058o90jofjgattl' AND "contactId"='cms71ulev002xo90jdjqe9cks' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical Chat mismatch'; END IF;
  PERFORM id FROM "ContactIdentity" WHERE id='cms74ku1m005fo90je6z5xlph'
    AND "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max' AND "externalId"='901985778243' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical MAX identity mismatch'; END IF;
  IF (SELECT count(*) FROM "ContactPhone" WHERE phone='+79990838709' AND "isActive") <> 1
    OR (SELECT "contactId" FROM "ContactPhone" WHERE phone='+79990838709' AND "isActive") <> 'cms71ulev002xo90jdjqe9cks'
    THEN RAISE EXCEPTION 'canonical phone ownership mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM "Driver" WHERE regexp_replace(coalesce(phone,''),'[^0-9]','','g')='79990838709') THEN
    RAISE EXCEPTION 'unexpected DriverProfile for Eldar canonical phone';
  END IF;
  IF (SELECT count(*) FROM "Driver" WHERE id='cms825epi00gto90j92uchfxb'
    AND regexp_replace(coalesce(phone,''),'[^0-9]','','g')='79140635630'
    AND "fullName"='Лукьянова Виктория Евгеньевна') <> 1 THEN
    RAISE EXCEPTION 'wrong-phone DriverProfile proof mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Message" WHERE "chatId"='cms74ktyq0058o90jofjgattl'
    AND "externalId"='d3019fb3ab8bcb0673' AND direction='inbound') THEN
    RAISE EXCEPTION 'reply target message mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Message" WHERE "chatId"='cms74ktyq0058o90jofjgattl'
    AND "externalId"='d3019fb3b2a7db2aed' AND direction='outbound') THEN
    RAISE EXCEPTION 'reply message mismatch';
  END IF;
END $$;

CREATE TEMP TABLE repair_plan AS
WITH target AS (
  SELECT id, content FROM "Message" WHERE "externalId"='d3019fb3ab8bcb0673'
), reply AS (
  SELECT id, metadata FROM "Message" WHERE "externalId"='d3019fb3b2a7db2aed'
)
SELECT
  (SELECT count(*) FROM "Contact" WHERE id='cms71ulev002xo90jdjqe9cks'
    AND ("displayName" IS DISTINCT FROM 'Эльдар' OR "displayNameSource" IS DISTINCT FROM 'channel')) AS contact_updates,
  (SELECT count(*) FROM "ContactIdentity" WHERE id='cms74ku1m005fo90je6z5xlph'
    AND "displayName" IS DISTINCT FROM 'Эльдар') AS identity_updates,
  (SELECT count(*) FROM "ContactPhone" WHERE id='cms80vq4s0001o90j9uyn9qf9'
    AND "contactId"='cms71ulev002xo90jdjqe9cks' AND "isActive") AS wrong_phone_splits,
  (SELECT CASE WHEN EXISTS (
      SELECT 1 FROM "ContactPhone" WHERE id='cms80vq4s0001o90j9uyn9qf9'
        AND "contactId"='cms71ulev002xo90jdjqe9cks' AND "isActive"
    ) AND NOT EXISTS (SELECT 1 FROM "Contact" WHERE id='pmax_lukyanova_contact_20260801')
    THEN 1 ELSE 0 END) AS split_contact_creates,
  (SELECT count(*) FROM "Driver" WHERE id='cms825epi00gto90j92uchfxb'
    AND "contactId" IS DISTINCT FROM 'pmax_lukyanova_contact_20260801') AS driver_link_changes,
  (SELECT count(*) FROM reply,target WHERE
    coalesce(reply.metadata #>> '{replyToExternalId}','') IS DISTINCT FROM 'd3019fb3ab8bcb0673'
    OR coalesce(reply.metadata #>> '{replyToMessageId}','') IS DISTINCT FROM target.id
    OR coalesce(reply.metadata #>> '{replyResolutionStatus}','') IS DISTINCT FROM 'resolved') AS reply_changes,
  0 AS channel_changes;

SELECT jsonb_build_object('phase','plan','mode',:'mode','counts',to_jsonb(repair_plan)) FROM repair_plan;

DO $$
BEGIN
  IF (SELECT apply FROM runtime_mode) THEN
    UPDATE "Contact" SET
      "displayName"='Эльдар',
      "displayNameSource"='channel',
      "updatedAt"=now()
    WHERE id='cms71ulev002xo90jdjqe9cks'
      AND ("displayName" IS DISTINCT FROM 'Эльдар' OR "displayNameSource" IS DISTINCT FROM 'channel');

    UPDATE "ContactIdentity" SET
      "displayName"='Эльдар',
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'personalMaxDisplayName',jsonb_build_object(
          'value','Эльдар','source','provider_participant_display_name',
          'repair','personal-max-eldar-identity-reply-v1','evidencePreserved',true
        )
      )
    WHERE id='cms74ku1m005fo90je6z5xlph' AND "displayName" IS DISTINCT FROM 'Эльдар';

    INSERT INTO "Contact" (
      id,"displayName","displayNameSource","masterSource","mainDriverId","mainDriverSelection",
      "primaryPhoneId","customFields","isArchived","createdAt","updatedAt"
    )
    SELECT 'pmax_lukyanova_contact_20260801','Лукьянова Виктория Евгеньевна','yandex','yandex',
      'cms825epi00gto90j92uchfxb','auto','cms80vq4s0001o90j9uyn9qf9',
      jsonb_build_object(
        'personalMaxSplit',jsonb_build_object(
          'fromContactId','cms71ulev002xo90jdjqe9cks',
          'reason','wrong_phone_exact_driver_profile',
          'phone','+79140635630',
          'driverId','cms825epi00gto90j92uchfxb',
          'evidencePreserved',true
        )
      ),false,now(),now()
    WHERE EXISTS (
      SELECT 1 FROM "ContactPhone" WHERE id='cms80vq4s0001o90j9uyn9qf9'
        AND "contactId"='cms71ulev002xo90jdjqe9cks' AND "isActive"
    ) AND NOT EXISTS (SELECT 1 FROM "Contact" WHERE id='pmax_lukyanova_contact_20260801');

    UPDATE "ContactPhone" SET
      "contactId"='pmax_lukyanova_contact_20260801',
      "isPrimary"=true,
      source='yandex',
      label='Основной'
    WHERE id='cms80vq4s0001o90j9uyn9qf9'
      AND "contactId"='cms71ulev002xo90jdjqe9cks'
      AND "isActive";

    UPDATE "Driver" SET
      "contactId"='pmax_lukyanova_contact_20260801',
      "updatedAt"=now()
    WHERE id='cms825epi00gto90j92uchfxb'
      AND "contactId" IS DISTINCT FROM 'pmax_lukyanova_contact_20260801';

    UPDATE "Contact" SET
      "mainDriverId"='cms825epi00gto90j92uchfxb',
      "primaryPhoneId"='cms80vq4s0001o90j9uyn9qf9',
      "updatedAt"=now()
    WHERE id='pmax_lukyanova_contact_20260801'
      AND ("mainDriverId" IS DISTINCT FROM 'cms825epi00gto90j92uchfxb'
        OR "primaryPhoneId" IS DISTINCT FROM 'cms80vq4s0001o90j9uyn9qf9');

    INSERT INTO "ContactMerge" (id,"survivorId","mergedId",action,reason,"snapshotBefore","createdAt")
    SELECT 'pmax_eldar_wrong_phone_unmerge_v1','pmax_lukyanova_contact_20260801','cms71ulev002xo90jdjqe9cks',
      'unmerge','undo',
      jsonb_build_object(
        'phoneId','cms80vq4s0001o90j9uyn9qf9',
        'phone','+79140635630',
        'fromContactId','cms71ulev002xo90jdjqe9cks',
        'toContactId','pmax_lukyanova_contact_20260801',
        'driverId','cms825epi00gto90j92uchfxb',
        'reason','wrong_phone_exact_driver_profile',
        'evidencePreserved',true
      ),now()
    WHERE NOT EXISTS (SELECT 1 FROM "ContactMerge" WHERE id='pmax_eldar_wrong_phone_unmerge_v1');

    INSERT INTO "ContactDriverProfileAudit" (
      id,"contactId","driverId","previousMainDriverId",action,"selectedBy",reason,metadata,"createdAt"
    )
    SELECT 'pmax_lukyanova_driver_link_v1','pmax_lukyanova_contact_20260801','cms825epi00gto90j92uchfxb',
      null,'personal_max_wrong_phone_split_link_driver','system',
      'exact phone belongs to this DriverProfile, not Eldar',
      jsonb_build_object('phone','+79140635630','fromContactId','cms71ulev002xo90jdjqe9cks','evidencePreserved',true),
      now()
    WHERE NOT EXISTS (SELECT 1 FROM "ContactDriverProfileAudit" WHERE id='pmax_lukyanova_driver_link_v1');

    INSERT INTO "ContactDriverProfileAudit" (
      id,"contactId","driverId","previousMainDriverId",action,"selectedBy",reason,metadata,"createdAt"
    )
    SELECT 'pmax_eldar_identity_name_repair_v1','cms71ulev002xo90jdjqe9cks',null,null,
      'personal_max_identity_name_repair','system',
      'restore provider participant display name and keep Eldar unlinked because no exact DriverProfile exists',
      jsonb_build_object('displayName','Эльдар','canonicalPhone','+79990838709','driverProfileCandidates',0,'evidencePreserved',true),
      now()
    WHERE NOT EXISTS (SELECT 1 FROM "ContactDriverProfileAudit" WHERE id='pmax_eldar_identity_name_repair_v1');

    WITH target AS (
      SELECT id, content, direction, "sentAt" FROM "Message" WHERE "externalId"='d3019fb3ab8bcb0673'
    ), reply AS (
      SELECT id, metadata FROM "Message" WHERE "externalId"='d3019fb3b2a7db2aed'
    )
    UPDATE "Message" m SET
      metadata=coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object(
        'replyToExternalId','d3019fb3ab8bcb0673',
        'replyToMessageId',target.id,
        'replyResolutionStatus','resolved',
        'replyQuoteText',(SELECT quote_text FROM reply_context),
        'replyQuotedSenderName','Эльдар',
        'replyQuotedDirection',(SELECT quote_direction FROM reply_context),
        'replyQuotedTimestamp',to_char(to_timestamp((SELECT quote_timestamp FROM reply_context)/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'personalMaxReplyRepair',jsonb_build_object(
          'version','eldar-identity-reply-v1',
          'providerMessageId','d3019fb3b2a7db2aed',
          'replyToProviderMessageId','d3019fb3ab8bcb0673',
          'evidencePreserved',true
        )
      ),
      "updatedAt"=now()
    FROM target,reply
    WHERE m.id=reply.id AND (
      coalesce(m.metadata #>> '{replyToExternalId}','') IS DISTINCT FROM 'd3019fb3ab8bcb0673'
      OR coalesce(m.metadata #>> '{replyToMessageId}','') IS DISTINCT FROM target.id
      OR coalesce(m.metadata #>> '{replyResolutionStatus}','') IS DISTINCT FROM 'resolved'
    );

    INSERT INTO "MessageEventLog" (id,"messageId","eventType",metadata,status,"createdAt","updatedAt")
    SELECT 'pmax_eldar_reply_repair_v1',m.id,'personal_max_reply_repair_v1',
      jsonb_build_object('replyToExternalId','d3019fb3ab8bcb0673','evidencePreserved',true),
      'completed',now(),now()
    FROM "Message" m
    WHERE m."externalId"='d3019fb3b2a7db2aed'
      AND NOT EXISTS (SELECT 1 FROM "MessageEventLog" WHERE id='pmax_eldar_reply_repair_v1');
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT apply FROM runtime_mode) THEN
    IF NOT EXISTS (SELECT 1 FROM "Contact" WHERE id='cms71ulev002xo90jdjqe9cks'
      AND "displayName"='Эльдар' AND "displayNameSource"='channel'
      AND "mainDriverId" IS NULL) THEN RAISE EXCEPTION 'Eldar Contact state mismatch'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "ContactIdentity" WHERE id='cms74ku1m005fo90je6z5xlph'
      AND "displayName"='Эльдар' AND "isActive") THEN RAISE EXCEPTION 'Eldar MAX identity display mismatch'; END IF;
    IF EXISTS (SELECT 1 FROM "ContactPhone" WHERE id='cms80vq4s0001o90j9uyn9qf9'
      AND "contactId"='cms71ulev002xo90jdjqe9cks' AND "isActive") THEN RAISE EXCEPTION 'wrong phone still on Eldar'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "ContactPhone" WHERE id='cms80vq4s0001o90j9uyn9qf9'
      AND "contactId"='pmax_lukyanova_contact_20260801' AND phone='+79140635630' AND "isActive") THEN
      RAISE EXCEPTION 'split phone state mismatch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Driver" WHERE id='cms825epi00gto90j92uchfxb'
      AND "contactId"='pmax_lukyanova_contact_20260801') THEN RAISE EXCEPTION 'split driver link mismatch'; END IF;
    IF (SELECT count(*) FROM "ContactIdentity" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max' AND "isActive") <> 1
      THEN RAISE EXCEPTION 'active MAX identity count mismatch';
    END IF;
    IF (SELECT count(*) FROM "Chat" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max'
      AND coalesce(metadata #>> '{personalMaxProjection,state}','canonical')<>'superseded') <> 1
      THEN RAISE EXCEPTION 'active MAX Chat count mismatch';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "Message" reply JOIN "Message" target ON target."externalId"='d3019fb3ab8bcb0673'
      WHERE reply."externalId"='d3019fb3b2a7db2aed'
        AND reply.metadata #>> '{replyToExternalId}'='d3019fb3ab8bcb0673'
        AND reply.metadata #>> '{replyToMessageId}'=target.id
        AND reply.metadata #>> '{replyResolutionStatus}'='resolved'
    ) THEN RAISE EXCEPTION 'reply relation mismatch'; END IF;
  END IF;
END $$;

WITH visible AS (
  SELECT m.* FROM "Message" m
  WHERE m."chatId"='cms74ktyq0058o90jofjgattl'
    AND NOT (
      coalesce((m.metadata #>> '{personalMaxProjection,visibility}')='suppressed_duplicate'
        AND (m.metadata #>> '{personalMaxProjection,evidencePreserved}')='true',false)
      OR coalesce((m.metadata #>> '{personalMaxProjection,visibility}')='suppressed_provider_absent'
        AND (m.metadata #>> '{personalMaxProjection,evidencePreserved}')='true'
        AND (m.metadata #>> '{personalMaxProjection,availableHistoryExhausted}')='true',false)
    )
), target AS (
  SELECT id FROM "Message" WHERE "externalId"='d3019fb3ab8bcb0673'
), reply AS (
  SELECT metadata FROM "Message" WHERE "externalId"='d3019fb3b2a7db2aed'
)
SELECT jsonb_build_object(
  'phase','result','mode',:'mode',
  'contactDisplayName',(SELECT "displayName" FROM "Contact" WHERE id='cms71ulev002xo90jdjqe9cks'),
  'canonicalPhoneOwners',(SELECT count(*) FROM "ContactPhone" WHERE phone='+79990838709' AND "isActive"),
  'wrongPhoneOnEldar',(SELECT count(*) FROM "ContactPhone" WHERE phone='+79140635630' AND "contactId"='cms71ulev002xo90jdjqe9cks' AND "isActive"),
  'splitContactExists',EXISTS(SELECT 1 FROM "Contact" WHERE id='pmax_lukyanova_contact_20260801'),
  'eldarDriverProfileCandidates',(SELECT count(*) FROM "Driver" WHERE regexp_replace(coalesce(phone,''),'[^0-9]','','g')='79990838709'),
  'driverLinkedToSplit',EXISTS(SELECT 1 FROM "Driver" WHERE id='cms825epi00gto90j92uchfxb' AND "contactId"='pmax_lukyanova_contact_20260801'),
  'activeMaxIdentities',(SELECT count(*) FROM "ContactIdentity" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max' AND "isActive"),
  'activeMaxChats',(SELECT count(*) FROM "Chat" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max'
    AND coalesce(metadata #>> '{personalMaxProjection,state}','canonical')<>'superseded'),
  'visibleMessages',(SELECT count(*) FROM visible),
  'replyLinked',EXISTS(SELECT 1 FROM reply,target WHERE reply.metadata #>> '{replyToExternalId}'='d3019fb3ab8bcb0673'
    AND reply.metadata #>> '{replyToMessageId}'=target.id
    AND reply.metadata #>> '{replyResolutionStatus}'='resolved'),
  'planCounts',(SELECT to_jsonb(repair_plan) FROM repair_plan)
);

SELECT CASE WHEN (SELECT apply FROM runtime_mode) THEN 'COMMIT;' ELSE 'ROLLBACK;' END \gexec
SQL

chown root:codexbot "$RESULT_JSON"
chmod 0640 "$RESULT_JSON"
jq -s -e 'map(select(.phase=="result")) | length==1' "$RESULT_JSON" >/dev/null
jq -s 'map(select(.phase=="result"))[0]' "$RESULT_JSON"
(cd "$EVIDENCE_DIR" && sha256sum forensic.private.json result.json >SHA256SUMS)
chown root:codexbot "$EVIDENCE_DIR/SHA256SUMS"
chmod 0640 "$EVIDENCE_DIR/SHA256SUMS"
echo "PERSONAL_MAX_ELDAR_IDENTITY_REPLY_REPAIR_EVIDENCE_DIR=$EVIDENCE_DIR"
