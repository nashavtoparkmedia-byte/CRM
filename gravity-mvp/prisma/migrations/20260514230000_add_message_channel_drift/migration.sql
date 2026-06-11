-- Восстановленная миграция (drift от prisma db push): колонка
-- Message.channel существовала в БД без создающей миграции;
-- 20260515000000_remove_yandex_pro_channel падала при replay на
-- ALTER COLUMN "channel" у Message.

ALTER TABLE "Message" ADD COLUMN "channel" "ChatChannel" DEFAULT 'whatsapp';
