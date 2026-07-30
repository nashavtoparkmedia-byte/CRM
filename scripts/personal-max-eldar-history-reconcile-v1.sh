#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_PATH=${BASH_SOURCE[0]}
readonly EXPECTED_SNAPSHOT_SHA=932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6
readonly ACCOUNT_ID=max-personal-81d98d8cc9fc95c1f1c0461f
readonly PROTOCOL_CHAT_ID=902197592419
readonly UI_ROUTE_ID=254460259
readonly PROVIDER_PARTICIPANT_ID=901985778243
readonly OWNER_PROVIDER_USER_ID=902171753248
readonly CONTACT_ID=cms71ulev002xo90jdjqe9cks
readonly CHAT_ID=cms74ktyq0058o90jofjgattl
readonly ALIAS_CHAT_ID=cms74kox4004yo90jkwoxl2n2
readonly CANONICAL_IDENTITY_ID=cms74ku1m005fo90je6z5xlph
readonly PHONE=+79990838709
readonly PG_CONTAINER=${PG_CONTAINER:-crm-postgres}

if [[ ${EUID} -ne 0 ]]; then
  echo 'ERROR: root is required for the checksum-bound targeted repair' >&2
  exit 77
fi
if [[ $# -ne 4 || ! $1 =~ ^[0-9a-f]{64}$ || ! $3 =~ ^[0-9a-f]{64}$ \
   || ! $4 =~ ^(dry-run|apply)$ ]]; then
  echo 'usage: personal-max-eldar-history-reconcile-v1.sh <script-sha256> <snapshot.json> <snapshot-sha256> <dry-run|apply>' >&2
  exit 64
fi
readonly EXPECTED_SCRIPT_SHA=$1
readonly SNAPSHOT_PATH=$2
readonly PROVIDED_SNAPSHOT_SHA=$3
readonly MODE=$4
readonly APPLY=$([[ $MODE == apply ]] && echo true || echo false)

[[ ! -L $SCRIPT_PATH && $(sha256sum "$SCRIPT_PATH" | awk '{print $1}') == "$EXPECTED_SCRIPT_SHA" ]] \
  || { echo 'ERROR: script checksum mismatch' >&2; exit 66; }
[[ -f $SNAPSHOT_PATH && ! -L $SNAPSHOT_PATH ]] \
  || { echo 'ERROR: snapshot is missing or unsafe' >&2; exit 67; }
[[ $PROVIDED_SNAPSHOT_SHA == "$EXPECTED_SNAPSHOT_SHA" \
   && $(sha256sum "$SNAPSHOT_PATH" | awk '{print $1}') == "$EXPECTED_SNAPSHOT_SHA" ]] \
  || { echo 'ERROR: provider snapshot checksum mismatch' >&2; exit 68; }

jq -e --arg account "$ACCOUNT_ID" --arg chat "$PROTOCOL_CHAT_ID" \
  --arg route "$UI_ROUTE_ID" --arg participant "$PROVIDER_PARTICIPANT_ID" \
  --arg owner "$OWNER_PROVIDER_USER_ID" '
  .schemaVersion == 1 and .source == "max_provider_store_read_only" and
  .accountId == $account and .protocolChatId == $chat and .providerChatId == $route and
  .uiRouteId == $route and .providerUserId == $participant and .ownerUserId == $owner and
  .routeMatchCount == 1 and (.messages | length) == 22 and
  ([.messages[].providerMessageId] | unique | length) == 22 and
  ([.messages[] | select(.textDisposition != "exact_unicode")] | length) == 0 and
  .historyLoad.lastScroll.atTop == true and .historyLoad.stalledAttempts >= 4 and
  ([.messages[] | select(.providerMessageId == "d3019fb33e631871d9")] | length) == 1 and
  ([.messages[] | select(.providerMessageId == "d3019fb3a5477905cf" and .direction == "inbound")] | length) == 1 and
  ([.messages[] | select(.providerMessageId == "d3019fb3a5bcf93aab" and .direction == "outbound")] | length) == 1 and
  ([.messages[] | select(.providerMessageId == "d3019fb3a7977d3cba" and .direction == "inbound")] | length) == 1 and
  ([.messages[] | select(.providerMessageId == "d3019fb3a814055c20" and .direction == "outbound")] | length) == 1
' "$SNAPSHOT_PATH" >/dev/null

readonly STAMP=$(date -u +%Y%m%dT%H%M%SZ)
readonly EVIDENCE_ROOT=${EVIDENCE_ROOT:-/var/backups}
readonly EVIDENCE_DIR=${EVIDENCE_DIR:-${EVIDENCE_ROOT}/personal-max-eldar-history-repair-${STAMP}}
[[ ! -e $EVIDENCE_DIR ]]
install -d -o root -g codexbot -m 2750 "$EVIDENCE_DIR"
readonly PROVIDER_TSV=$EVIDENCE_DIR/provider-evidence.private.tsv
readonly RESULT_JSON=$EVIDENCE_DIR/result.json

jq -r '.messages[] | [
  .providerMessageId,
  .direction,
  .providerUserId,
  (.timestamp | tostring),
  ((.text // "") | @base64),
  .textDisposition,
  (.messageType // "text"),
  ((.attachmentCount // 0) | tostring)
] | @tsv' "$SNAPSHOT_PATH" >"$PROVIDER_TSV"
chmod 0640 "$PROVIDER_TSV"
chown root:codexbot "$PROVIDER_TSV"

{
  cat <<SQL
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE runtime_mode AS SELECT :'apply'::boolean AS apply;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE TEMP TABLE provider_snapshot (
  provider_message_id text PRIMARY KEY,
  direction text NOT NULL,
  provider_user_id text NOT NULL,
  timestamp_ms bigint NOT NULL,
  text_base64 text NOT NULL,
  text_disposition text NOT NULL,
  message_type text NOT NULL,
  attachment_count integer NOT NULL
) ON COMMIT DROP;
COPY provider_snapshot FROM STDIN;
SQL
  cat "$PROVIDER_TSV"
  cat <<'SQL'
\.
ALTER TABLE provider_snapshot ADD COLUMN exact_text text;
UPDATE provider_snapshot SET exact_text=convert_from(decode(text_base64,'base64'),'UTF8');

CREATE TEMP VIEW expected_provider AS
SELECT p.*,
  CASE
    WHEN p.provider_message_id='d3019fb1aed5e41fd1' THEN '[Фото]'
    WHEN p.exact_text<>'' THEN p.exact_text
    ELSE coalesce(m.content,'')
  END AS expected_content,
  CASE WHEN p.provider_message_id IN ('d3019fb1aed5e41fd1','d3019fb1af06246bff')
    THEN 'image' ELSE 'text' END AS expected_type,
  CASE WHEN p.direction='outbound' THEN 'sent' ELSE 'delivered' END AS expected_status,
  jsonb_build_object(
    'origin',CASE WHEN p.direction='outbound' THEN 'max_native' ELSE 'max_provider' END,
    'source','provider_store_recovery',
    'retryable',false,
    'protocolChatId','902197592419',
    'uiRouteId','254460259',
    'providerAccountId','max-personal-81d98d8cc9fc95c1f1c0461f',
    'providerUserId',p.provider_user_id,
    'personalMaxIdentity',jsonb_build_object(
      'accountId','max-personal-81d98d8cc9fc95c1f1c0461f',
      'protocolChatId','902197592419',
      'uiRouteId','254460259',
      'providerUserId',p.provider_user_id
    ),
    'personalMaxRepair',jsonb_build_object(
      'version','eldar-exact-history-v1',
      'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6',
      'evidencePreserved',true
    )
  ) || CASE WHEN p.direction='outbound' THEN jsonb_build_object(
    'maxDelivery',jsonb_build_object(
      'status','provider_present','deliveryConfirmed',false,'retryable',false
    )
  ) ELSE '{}'::jsonb END AS expected_metadata
FROM provider_snapshot p
LEFT JOIN "Message" m ON m."externalId"=p.provider_message_id;

DO $$
BEGIN
  PERFORM id FROM "Contact" WHERE id='cms71ulev002xo90jdjqe9cks' FOR UPDATE;
  PERFORM id FROM "Chat" WHERE id IN ('cms74ktyq0058o90jofjgattl','cms74kox4004yo90jkwoxl2n2') ORDER BY id FOR UPDATE;
  PERFORM id FROM "Message" WHERE "chatId"='cms74ktyq0058o90jofjgattl' ORDER BY id FOR UPDATE;
  PERFORM id FROM "ContactIdentity" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM provider_snapshot) <> 22 THEN RAISE EXCEPTION 'provider count mismatch'; END IF;
  IF (SELECT count(*) FROM "ContactPhone" WHERE phone='+79990838709' AND "isActive") <> 1
    OR (SELECT "contactId" FROM "ContactPhone" WHERE phone='+79990838709' AND "isActive") <> 'cms71ulev002xo90jdjqe9cks'
    THEN RAISE EXCEPTION 'phone ownership mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id='cms74ktyq0058o90jofjgattl'
      AND channel='max' AND "externalChatId"='902197592419' AND "contactId"='cms71ulev002xo90jdjqe9cks')
    THEN RAISE EXCEPTION 'canonical chat mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ContactIdentity" WHERE id='cms74ku1m005fo90je6z5xlph'
      AND channel='max' AND "externalId"='901985778243' AND "contactId"='cms71ulev002xo90jdjqe9cks')
    THEN RAISE EXCEPTION 'canonical participant identity mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_snapshot WHERE direction NOT IN ('inbound','outbound')
      OR text_disposition<>'exact_unicode' OR provider_message_id !~ '^d301[0-9a-f]{14}$')
    THEN RAISE EXCEPTION 'unsafe provider evidence';
  END IF;
END $$;

CREATE TEMP TABLE repair_plan AS
SELECT
  (SELECT count(*) FROM expected_provider p JOIN "Message" m ON m."externalId"=p.provider_message_id
    WHERE m."chatId"<>'cms74ktyq0058o90jofjgattl'
       OR m.content<>p.expected_content
       OR m.direction::text<>p.direction
       OR m.type::text<>p.expected_type
       OR m.status::text<>p.expected_status
       OR round(extract(epoch FROM m."sentAt")*1000)::bigint<>p.timestamp_ms
       OR coalesce(m.metadata #>> '{personalMaxIngressDisposition,visibility}','')='quarantined'
       OR NOT (coalesce(m.metadata,'{}'::jsonb) @> p.expected_metadata)) AS updates,
  (SELECT count(*) FROM expected_provider p LEFT JOIN "Message" m ON m."externalId"=p.provider_message_id
    WHERE m.id IS NULL) AS creates,
  (SELECT count(*) FROM "Message" m
    WHERE m.id IN (
      'cms74koxj0050o90jmno9xgvh','cms74kxe9005ho90j1dptjdsn','cms74kzuk005qo90jxtkw57hb',
      'cms752ixq006go90jnpci6hx1','cms78n3yz009so90jevlwtow4','cms7k5v060001uh0jyns8j2be'
    ) AND coalesce(m.metadata #>> '{personalMaxProjection,visibility}','')<>'suppressed_duplicate') AS duplicate_suppressions,
  (SELECT count(*) FROM "Message" m WHERE m.id='cms7jd97g0001p60jk05fnf9z'
    AND coalesce(m.metadata #>> '{personalMaxProjection,visibility}','')<>'suppressed_provider_absent') AS provider_absent_suppressions,
  (SELECT count(*) FROM "ContactIdentity" WHERE id IN ('cms74koz80057o90jfq39p15e','cms74kxfn005oo90jk7gs8efv') AND "isActive") AS alias_deactivations,
  (SELECT CASE WHEN EXISTS (SELECT 1 FROM "MessageAttachment" WHERE "messageId"='cms7rgxe0000foe2ncj9s6mtv') THEN 0 ELSE 1 END) AS attachment_copies;

SELECT jsonb_build_object('phase','plan','mode',:'mode','counts',to_jsonb(repair_plan)) FROM repair_plan;
SQL

  if [[ $MODE == apply ]]; then
    cat <<'SQL'
UPDATE "Message" m SET
  "chatId"='cms74ktyq0058o90jofjgattl',
  content=p.expected_content,
  direction=p.direction::"MessageDirection",
  type=p.expected_type::"MessageType",
  status=p.expected_status::"MessageStatus",
  "sentAt"=to_timestamp(p.timestamp_ms/1000.0),
  metadata=(coalesce(m.metadata,'{}'::jsonb) - 'personalMaxIngressDisposition') || p.expected_metadata,
  "updatedAt"=now()
FROM expected_provider p
WHERE m."externalId"=p.provider_message_id
  AND (m."chatId"<>'cms74ktyq0058o90jofjgattl'
    OR m.content<>p.expected_content
    OR m.direction::text<>p.direction
    OR m.type::text<>p.expected_type
    OR m.status::text<>p.expected_status
    OR round(extract(epoch FROM m."sentAt")*1000)::bigint<>p.timestamp_ms
    OR coalesce(m.metadata #>> '{personalMaxIngressDisposition,visibility}','')='quarantined'
    OR NOT (coalesce(m.metadata,'{}'::jsonb) @> p.expected_metadata));

INSERT INTO "Message" (
  id,"chatId",direction,type,content,status,"externalId",metadata,"sentAt","createdAt","updatedAt",channel
)
SELECT
  'pmax_eldar_'||substr(p.provider_message_id,5),
  'cms74ktyq0058o90jofjgattl',p.direction::"MessageDirection",p.expected_type::"MessageType",
  p.expected_content,p.expected_status::"MessageStatus",p.provider_message_id,p.expected_metadata,
  to_timestamp(p.timestamp_ms/1000.0),to_timestamp(p.timestamp_ms/1000.0),now(),'max'::"ChatChannel"
FROM expected_provider p LEFT JOIN "Message" m ON m."externalId"=p.provider_message_id
WHERE m.id IS NULL;

INSERT INTO "MessageAttachment" (id,"messageId",type,url,"fileName","fileSize","mimeType","createdAt")
SELECT 'pmax_eldar_photo_aed5','cms7rgxe0000foe2ncj9s6mtv',a.type,a.url,a."fileName",a."fileSize",a."mimeType",now()
FROM "MessageAttachment" a
WHERE a."messageId"='cms74koxj0050o90jmno9xgvh'
  AND NOT EXISTS (SELECT 1 FROM "MessageAttachment" WHERE "messageId"='cms7rgxe0000foe2ncj9s6mtv')
ORDER BY a."fileSize" DESC NULLS LAST,a.id
LIMIT 1;

WITH duplicate_map(message_id,canonical_provider_message_id,reason) AS (VALUES
  ('cms74koxj0050o90jmno9xgvh','d3019fb1aed5e41fd1','dom_media_projection'),
  ('cms74kxe9005ho90j1dptjdsn','d3019fb1aed5e41fd1','dom_media_projection'),
  ('cms74kzuk005qo90jxtkw57hb','d3019fb1af06246bff','dom_media_projection'),
  ('cms752ixq006go90jnpci6hx1','d3019fb1bb99243c87','dom_text_placeholder'),
  ('cms78n3yz009so90jevlwtow4','d3019fb217236b5347','dom_text_placeholder'),
  ('cms7k5v060001uh0jyns8j2be','d3019fb33e631871d9','dom_text_placeholder')
)
UPDATE "Message" m SET metadata=coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object(
  'personalMaxProjection',jsonb_build_object(
    'visibility','suppressed_duplicate','evidencePreserved',true,
    'canonicalProviderMessageId',d.canonical_provider_message_id,'reason',d.reason,
    'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6'
  )
),"updatedAt"=now()
FROM duplicate_map d WHERE m.id=d.message_id
  AND coalesce(m.metadata #>> '{personalMaxProjection,visibility}','')<>'suppressed_duplicate';

UPDATE "Message" SET metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
  'personalMaxProjection',jsonb_build_object(
    'visibility','suppressed_provider_absent','evidencePreserved',true,
    'availableHistoryExhausted',true,'providerMessageId','d3019fb32a04c169e4',
    'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6'
  )
),"updatedAt"=now()
WHERE id='cms7jd97g0001p60jk05fnf9z'
  AND coalesce(metadata #>> '{personalMaxProjection,visibility}','')<>'suppressed_provider_absent';

UPDATE "ContactIdentity" SET "isActive"=false,metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
  'personalMaxAlias',jsonb_build_object(
    'canonicalIdentityId','cms74ku1m005fo90je6z5xlph','providerParticipantId','901985778243',
    'protocolChatId','902197592419','uiRouteId','254460259','evidencePreserved',true,
    'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6'
  )
)
WHERE id IN ('cms74koz80057o90jfq39p15e','cms74kxfn005oo90jk7gs8efv') AND "isActive";

UPDATE "Chat" SET metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
  'personalMaxProjection',jsonb_build_object(
    'state','canonical','evidencePreserved',true,
    'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6',
    'accountId','max-personal-81d98d8cc9fc95c1f1c0461f','providerParticipantId','901985778243',
    'protocolChatId','902197592419','uiRouteId','254460259',
    'routeAliases',jsonb_build_array('254460259')
  )
),"lastMessageAt"=(SELECT max(to_timestamp(timestamp_ms/1000.0)) FROM provider_snapshot),
  "lastInboundAt"=(SELECT max(to_timestamp(timestamp_ms/1000.0)) FROM provider_snapshot WHERE direction='inbound'),
  "lastOutboundAt"=(SELECT max(to_timestamp(timestamp_ms/1000.0)) FROM provider_snapshot WHERE direction='outbound'),
  "requiresResponse"=false,"updatedAt"=now()
WHERE id='cms74ktyq0058o90jofjgattl' AND (
  NOT (coalesce(metadata,'{}'::jsonb) @> jsonb_build_object(
    'personalMaxProjection',jsonb_build_object(
      'state','canonical','evidencePreserved',true,
      'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6',
      'accountId','max-personal-81d98d8cc9fc95c1f1c0461f','providerParticipantId','901985778243',
      'protocolChatId','902197592419','uiRouteId','254460259',
      'routeAliases',jsonb_build_array('254460259')
    )
  ))
  OR "lastMessageAt" IS DISTINCT FROM (SELECT max(to_timestamp(timestamp_ms/1000.0)) FROM provider_snapshot)
  OR "lastInboundAt" IS DISTINCT FROM (SELECT max(to_timestamp(timestamp_ms/1000.0)) FROM provider_snapshot WHERE direction='inbound')
  OR "lastOutboundAt" IS DISTINCT FROM (SELECT max(to_timestamp(timestamp_ms/1000.0)) FROM provider_snapshot WHERE direction='outbound')
  OR "requiresResponse"
);

UPDATE "Chat" SET metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
  'personalMaxProjection',jsonb_build_object(
    'state','superseded','canonicalChatId','cms74ktyq0058o90jofjgattl',
    'aliasExternalChatId','254460259','evidencePreserved',true,
    'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6'
  )
),"updatedAt"=now() WHERE id='cms74kox4004yo90jkwoxl2n2'
  AND NOT (coalesce(metadata,'{}'::jsonb) @> jsonb_build_object(
    'personalMaxProjection',jsonb_build_object(
      'state','superseded','canonicalChatId','cms74ktyq0058o90jofjgattl',
      'aliasExternalChatId','254460259','evidencePreserved',true,
      'snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6'
    )
  ));

INSERT INTO "MessageEventLog" (id,"messageId","eventType",metadata,status,"createdAt","updatedAt")
SELECT 'pmax_repair_'||substr(md5(m.id),1,16),m.id,'personal_max_history_repair_v1',
  jsonb_build_object('snapshotSha256','932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6',
    'evidencePreserved',true),'completed',now(),now()
FROM "Message" m
WHERE m."chatId"='cms74ktyq0058o90jofjgattl'
  AND (m."externalId" IN (SELECT provider_message_id FROM provider_snapshot)
    OR m.id IN ('cms74koxj0050o90jmno9xgvh','cms74kxe9005ho90j1dptjdsn','cms74kzuk005qo90jxtkw57hb',
      'cms752ixq006go90jnpci6hx1','cms78n3yz009so90jevlwtow4','cms7k5v060001uh0jyns8j2be','cms7jd97g0001p60jk05fnf9z'))
  AND NOT EXISTS (SELECT 1 FROM "MessageEventLog" e WHERE e."messageId"=m.id
    AND e."eventType"='personal_max_history_repair_v1'
    AND e.metadata->>'snapshotSha256'='932c3fbe502ec499f8eb56d65154e91bc11176ae22a41ecdca711a22262790b6');
SQL
  fi

  cat <<'SQL'
CREATE TEMP VIEW visible_target_messages AS
SELECT m.* FROM "Message" m
WHERE m."chatId"='cms74ktyq0058o90jofjgattl'
  AND NOT (
    coalesce((m.metadata #>> '{personalMaxProjection,visibility}')='suppressed_duplicate'
      AND (m.metadata #>> '{personalMaxProjection,evidencePreserved}')='true',false)
    OR coalesce((m.metadata #>> '{personalMaxProjection,visibility}')='suppressed_provider_absent'
      AND (m.metadata #>> '{personalMaxProjection,evidencePreserved}')='true'
      AND (m.metadata #>> '{personalMaxProjection,availableHistoryExhausted}')='true',false)
  );

DO $$
BEGIN
  IF (SELECT apply FROM runtime_mode) THEN
    IF (SELECT count(*) FROM visible_target_messages) <> 22 THEN RAISE EXCEPTION 'visible count mismatch'; END IF;
    IF EXISTS (
      (SELECT provider_message_id FROM provider_snapshot EXCEPT SELECT "externalId" FROM visible_target_messages)
      UNION ALL
      (SELECT "externalId" FROM visible_target_messages EXCEPT SELECT provider_message_id FROM provider_snapshot)
    ) THEN RAISE EXCEPTION 'provider parity mismatch'; END IF;
    IF EXISTS (SELECT 1 FROM expected_provider p JOIN visible_target_messages m ON m."externalId"=p.provider_message_id
      WHERE m.content<>p.expected_content OR m.direction::text<>p.direction OR m.type::text<>p.expected_type
        OR m.status::text<>p.expected_status OR round(extract(epoch FROM m."sentAt")*1000)::bigint<>p.timestamp_ms
        OR coalesce(m.metadata #>> '{personalMaxIngressDisposition,visibility}','')='quarantined'
        OR NOT (coalesce(m.metadata,'{}'::jsonb) @> p.expected_metadata))
      THEN RAISE EXCEPTION 'message field parity mismatch';
    END IF;
    IF (SELECT count(*) FROM "ContactIdentity" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max' AND "isActive")<>1
      OR NOT EXISTS (SELECT 1 FROM "ContactIdentity" WHERE id='cms74ku1m005fo90je6z5xlph' AND "isActive")
      THEN RAISE EXCEPTION 'active MAX identity mismatch';
    END IF;
    IF (SELECT count(*) FROM "Chat" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max'
      AND coalesce(metadata #>> '{personalMaxProjection,state}','canonical')<>'superseded')<>1
      THEN RAISE EXCEPTION 'active MAX chat mismatch';
    END IF;
    IF EXISTS (SELECT 1 FROM visible_target_messages WHERE content LIKE '%'||chr(65533)||'%'
      OR content ~ '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'
      OR lower(content) ~ 'attaches.{0,32}prevm|prevmsg|ttl.{0,16}unread')
      THEN RAISE EXCEPTION 'visible damaged text remains';
    END IF;
  END IF;
END $$;

SELECT jsonb_build_object(
  'phase','result','mode',:'mode',
  'providerMessages',(SELECT count(*) FROM provider_snapshot),
  'visibleMessages',(SELECT count(*) FROM visible_target_messages),
  'providerParity',(SELECT count(*)=0 FROM (
    (SELECT provider_message_id FROM provider_snapshot EXCEPT SELECT "externalId" FROM visible_target_messages)
    UNION ALL
    (SELECT "externalId" FROM visible_target_messages EXCEPT SELECT provider_message_id FROM provider_snapshot)
  ) d),
  'damagedVisible',(SELECT count(*) FROM visible_target_messages WHERE content LIKE '%'||chr(65533)||'%'
    OR lower(content) ~ 'attaches.{0,32}prevm|prevmsg|ttl.{0,16}unread'),
  'activeMaxIdentities',(SELECT count(*) FROM "ContactIdentity" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max' AND "isActive"),
  'activeMaxChats',(SELECT count(*) FROM "Chat" WHERE "contactId"='cms71ulev002xo90jdjqe9cks' AND channel='max'
    AND coalesce(metadata #>> '{personalMaxProjection,state}','canonical')<>'superseded'),
  'phoneOwners',(SELECT count(*) FROM "ContactPhone" WHERE phone='+79990838709' AND "isActive"),
  'planCounts',(SELECT to_jsonb(repair_plan) FROM repair_plan)
);
SQL
  if [[ $MODE == apply ]]; then echo 'COMMIT;'; else echo 'ROLLBACK;'; fi
} | docker exec -i "$PG_CONTAINER" sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -qAt -v mode="$1" -v apply="$2" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  sh "$MODE" "$APPLY" >"$RESULT_JSON"

chown root:codexbot "$RESULT_JSON"
chmod 0640 "$RESULT_JSON"
jq -s -e 'map(select(.phase=="result")) | length==1' "$RESULT_JSON" >/dev/null
jq -s 'map(select(.phase=="result"))[0]' "$RESULT_JSON"
(cd "$EVIDENCE_DIR" && sha256sum provider-evidence.private.tsv result.json >SHA256SUMS)
chown root:codexbot "$EVIDENCE_DIR/SHA256SUMS"
chmod 0640 "$EVIDENCE_DIR/SHA256SUMS"
echo "PERSONAL_MAX_ELDAR_REPAIR_EVIDENCE_DIR=$EVIDENCE_DIR"
