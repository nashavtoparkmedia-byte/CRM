-- AiProviderSetting: persisted AI-call provider config. Replaces .env-only
-- key storage with an admin-editable table. Composite uniqueness on
-- (provider, key) — there's exactly one apiKey per provider.
CREATE TABLE "AiProviderSetting" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT,
    "valuePlain" TEXT,
    "mask" TEXT,
    "isConfigured" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastCheckMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiProviderSetting_provider_key_key"
    ON "AiProviderSetting"("provider", "key");

CREATE INDEX "AiProviderSetting_provider_idx"
    ON "AiProviderSetting"("provider");
