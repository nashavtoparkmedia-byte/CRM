-- AiAgentProfile — стили общения AI-агента в чатах.
-- Один профиль = один стиль (Role/Tone/Allowed/Forbidden).
-- Админ создаёт несколько, переключает активный через AiAgentConfig.activeProfileId.

CREATE TABLE "AiAgentProfile" (
    "id"              TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT,
    "promptRole"      TEXT,
    "promptTone"      TEXT,
    "promptAllowed"   TEXT,
    "promptForbidden" TEXT,
    "isDefault"       BOOLEAN NOT NULL DEFAULT false,
    "sortOrder"       INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAgentProfile_pkey" PRIMARY KEY ("id")
);

-- Указатель из config'а на активный профиль.
-- onDelete: SET NULL — удаление профиля не ломает config, а откатывает
-- активный в null (тогда runtime fallback'ится на legacy-поля).
ALTER TABLE "AiAgentConfig"
    ADD COLUMN "activeProfileId" TEXT;

ALTER TABLE "AiAgentConfig"
    ADD CONSTRAINT "AiAgentConfig_activeProfileId_fkey"
    FOREIGN KEY ("activeProfileId") REFERENCES "AiAgentProfile"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
