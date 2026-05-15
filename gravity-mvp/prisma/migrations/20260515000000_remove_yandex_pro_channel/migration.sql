-- Remove obsolete `yandex_pro` value from the ChatChannel enum.
--
-- yandex_pro was a read-only fleet channel and has been fully removed from the
-- product. All 24 ContactIdentity rows that referenced it were redundant with
-- Contact.yandexDriverId, so they are deleted before the enum is rebuilt.

DELETE FROM "ContactIdentity" WHERE "channel" = 'yandex_pro';

ALTER TYPE "ChatChannel" RENAME TO "ChatChannel_old";
CREATE TYPE "ChatChannel" AS ENUM ('telegram', 'whatsapp', 'max', 'phone', 'avito');

ALTER TABLE "Chat"
  ALTER COLUMN "channel" TYPE "ChatChannel"
  USING "channel"::text::"ChatChannel";

ALTER TABLE "Message"
  ALTER COLUMN "channel" DROP DEFAULT,
  ALTER COLUMN "channel" TYPE "ChatChannel"
  USING "channel"::text::"ChatChannel",
  ALTER COLUMN "channel" SET DEFAULT 'whatsapp';

ALTER TABLE "ContactIdentity"
  ALTER COLUMN "channel" TYPE "ChatChannel"
  USING "channel"::text::"ChatChannel";

DROP TYPE "ChatChannel_old";
