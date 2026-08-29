-- Restore the original MAX Web chronology for Sergey's dialog after the
-- one-time DOM mirror recovery. The provider-backed final message already
-- existed, so remove only its synthetic recovery duplicate.
UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-05 13:06:00+00'
WHERE "externalId" = 'max-dom-902136564252-d57ac3c1abf2d6b9';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-05 15:44:00+00'
WHERE "externalId" = 'max-mirror-902136564252-59015dfbd76eef5a';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-05 15:44:30+00'
WHERE "externalId" = 'max-dom-902136564252-2e3c862326579551';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-05 15:48:00+00'
WHERE "externalId" = 'max-mirror-902136564252-b468dc5a30407a98';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-05 15:49:00+00'
WHERE "externalId" = 'max-dom-902136564252-f93e258bc19acac2';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-06 13:49:00+00'
WHERE "externalId" = 'max-dom-902136564252-a1f7c49da225b50b';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-06 14:12:10+00'
WHERE "externalId" = 'max-mirror-902136564252-746a8ad13c4ce2ae';

UPDATE "Message" SET "sentAt" = TIMESTAMPTZ '2026-08-06 14:12:30+00'
WHERE "externalId" = 'max-mirror-902136564252-80bb4f1be7a542e0';

DELETE FROM "Message"
WHERE "externalId" = 'max-dom-902136564252-5f3b71b101734a85';

UPDATE "Chat"
SET
  "lastMessageAt" = TIMESTAMPTZ '2026-08-06 14:12:59.319+00',
  "lastInboundAt" = TIMESTAMPTZ '2026-08-06 14:12:59.319+00',
  "lastOutboundAt" = TIMESTAMPTZ '2026-08-06 14:12:30+00'
WHERE "id" = 'cmshlio0f01o5p925s3hn73pq';
