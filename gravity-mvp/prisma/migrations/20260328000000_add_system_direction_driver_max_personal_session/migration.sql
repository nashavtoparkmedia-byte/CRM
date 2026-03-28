-- Migration: add_system_direction_driver_max_personal_session
-- Блок 1: Фундамент данных для MAX Transport Gateway + AI Agent

-- 1. Добавить значение 'system' в enum MessageDirection
ALTER TYPE "MessageDirection" ADD VALUE IF NOT EXISTS 'system';

-- 2. Создать enums для MaxPersonalSession
CREATE TYPE "MaxHistoryImportMode" AS ENUM ('none', 'from_connection_time', 'available_history');
CREATE TYPE "MaxHistorySyncMode" AS ENUM ('live_only', 'partial_backfill', 'full_backfill');
CREATE TYPE "MaxHistorySyncStatus" AS ENUM ('not_started', 'running', 'completed', 'partial', 'failed');

-- 3. Создать модель DriverMax (channel profile для водителя в MAX)
CREATE TABLE "DriverMax" (
    "id"                  TEXT NOT NULL,
    "driverId"            TEXT NOT NULL,
    "maxExternalUserId"   TEXT,
    "maxExternalChatId"   TEXT,
    "phone"               TEXT,
    "name"                TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverMax_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverMax_driverId_key" ON "DriverMax"("driverId");
CREATE INDEX "DriverMax_maxExternalUserId_idx" ON "DriverMax"("maxExternalUserId");
CREATE INDEX "DriverMax_maxExternalChatId_idx" ON "DriverMax"("maxExternalChatId");

ALTER TABLE "DriverMax" ADD CONSTRAINT "DriverMax_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Создать модель MaxPersonalSession (настройки QR-сессии)
CREATE TABLE "MaxPersonalSession" (
    "id"                     TEXT NOT NULL,
    "historyImportMode"      "MaxHistoryImportMode" NOT NULL DEFAULT 'from_connection_time',
    "connectedAt"            TIMESTAMP(3),
    "historySyncModeResolved" "MaxHistorySyncMode",
    "historySyncStatus"      "MaxHistorySyncStatus" NOT NULL DEFAULT 'not_started',
    "initialSyncCompletedAt" TIMESTAMP(3),
    "isActive"               BOOLEAN NOT NULL DEFAULT true,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxPersonalSession_pkey" PRIMARY KEY ("id")
);
