-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('yandex', 'chat', 'manual');
CREATE TYPE "ContactNameSource" AS ENUM ('yandex', 'channel', 'manual');
CREATE TYPE "ContactPhoneSource" AS ENUM ('yandex', 'whatsapp', 'telegram', 'max', 'manual');
CREATE TYPE "ContactIdentitySource" AS ENUM ('auto', 'manual', 'yandex');
CREATE TYPE "MergeAction" AS ENUM ('merge', 'unmerge');
CREATE TYPE "MergeReason" AS ENUM ('phone_match', 'identity_match', 'yandex_link', 'manual', 'undo');

-- CreateTable: Contact
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayNameSource" "ContactNameSource" NOT NULL DEFAULT 'channel',
    "masterSource" "ContactSource" NOT NULL DEFAULT 'chat',
    "yandexDriverId" TEXT,
    "primaryPhoneId" TEXT,
    "notes" TEXT,
    "customFields" JSONB DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ContactPhone
CREATE TABLE "ContactPhone" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" "ContactPhoneSource" NOT NULL DEFAULT 'manual',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ContactIdentity
CREATE TABLE "ContactIdentity" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "ChatChannel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "phoneId" TEXT,
    "displayName" TEXT,
    "source" "ContactIdentitySource" NOT NULL DEFAULT 'auto',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ContactMerge
CREATE TABLE "ContactMerge" (
    "id" TEXT NOT NULL,
    "survivorId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "action" "MergeAction" NOT NULL DEFAULT 'merge',
    "mergedBy" TEXT NOT NULL DEFAULT 'system',
    "reason" "MergeReason" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "snapshotBefore" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMerge_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Chat — add contactId, contactIdentityId
ALTER TABLE "Chat" ADD COLUMN "contactId" TEXT;
ALTER TABLE "Chat" ADD COLUMN "contactIdentityId" TEXT;

-- AlterTable: Task — add contactId
ALTER TABLE "tasks" ADD COLUMN "contactId" TEXT;

-- Unique constraints
CREATE UNIQUE INDEX "Contact_yandexDriverId_key" ON "Contact"("yandexDriverId");
CREATE UNIQUE INDEX "ContactPhone_contactId_phone_key" ON "ContactPhone"("contactId", "phone");
CREATE UNIQUE INDEX "ContactIdentity_channel_externalId_key" ON "ContactIdentity"("channel", "externalId");

-- Indexes: Contact
CREATE INDEX "Contact_displayName_idx" ON "Contact"("displayName");
CREATE INDEX "Contact_isArchived_idx" ON "Contact"("isArchived");

-- Indexes: ContactPhone
CREATE INDEX "ContactPhone_phone_idx" ON "ContactPhone"("phone");

-- Indexes: ContactIdentity
CREATE INDEX "ContactIdentity_contactId_idx" ON "ContactIdentity"("contactId");
CREATE INDEX "ContactIdentity_phoneId_idx" ON "ContactIdentity"("phoneId");

-- Indexes: ContactMerge
CREATE INDEX "ContactMerge_survivorId_idx" ON "ContactMerge"("survivorId");
CREATE INDEX "ContactMerge_mergedId_idx" ON "ContactMerge"("mergedId");

-- Indexes: Chat (new columns)
CREATE INDEX "Chat_contactId_idx" ON "Chat"("contactId");
CREATE INDEX "Chat_contactIdentityId_idx" ON "Chat"("contactIdentityId");

-- Indexes: Task (new column)
CREATE INDEX "tasks_contactId_idx" ON "tasks"("contactId");

-- Foreign keys
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_yandexDriverId_fkey" FOREIGN KEY ("yandexDriverId") REFERENCES "Driver"("yandexDriverId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactPhone" ADD CONSTRAINT "ContactPhone_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "ContactPhone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_survivorId_fkey" FOREIGN KEY ("survivorId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_mergedId_fkey" FOREIGN KEY ("mergedId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_contactIdentityId_fkey" FOREIGN KEY ("contactIdentityId") REFERENCES "ContactIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Functional index for ILIKE search on displayName (spec §12.5)
-- Prisma does not support functional indexes natively
CREATE INDEX "Contact_displayName_lower_idx" ON "Contact" (lower("displayName"));
