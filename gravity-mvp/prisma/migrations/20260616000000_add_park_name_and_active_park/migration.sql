-- AlterTable: add name to ApiConnection
ALTER TABLE "ApiConnection" ADD COLUMN IF NOT EXISTS "name" TEXT;

-- AlterTable: add activeParkId to DriverTelegram
ALTER TABLE "DriverTelegram" ADD COLUMN IF NOT EXISTS "activeParkId" TEXT;
