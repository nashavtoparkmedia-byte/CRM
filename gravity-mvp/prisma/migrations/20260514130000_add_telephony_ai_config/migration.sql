-- Stage 4: Whisper transcription + GPT-4o evaluation of call recordings.
-- Singleton config row (id = 'singleton') — model and editable system prompt
-- managed by admins via /settings/integrations/telephony-ai.

CREATE TABLE "TelephonyAiConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT NOT NULL DEFAULT 'gpt-4o',
    "systemPrompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelephonyAiConfig_pkey" PRIMARY KEY ("id")
);
