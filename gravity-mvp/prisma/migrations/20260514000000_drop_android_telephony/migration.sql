-- Drop Android telephony: reverses baseline_telephony_safety_scenarios.
-- Phone-based call models replaced by SIP-based stack (FreeSWITCH + Megafon trunk).

-- DropForeignKey
ALTER TABLE IF EXISTS "CallSession" DROP CONSTRAINT IF EXISTS "CallSession_chatId_fkey";
ALTER TABLE IF EXISTS "CallSession" DROP CONSTRAINT IF EXISTS "CallSession_contactId_fkey";
ALTER TABLE IF EXISTS "CallSession" DROP CONSTRAINT IF EXISTS "CallSession_deviceId_fkey";
ALTER TABLE IF EXISTS "CallSession" DROP CONSTRAINT IF EXISTS "CallSession_messageId_fkey";
ALTER TABLE IF EXISTS "TelephonyCommand" DROP CONSTRAINT IF EXISTS "TelephonyCommand_deviceId_fkey";

-- DropTable
DROP TABLE IF EXISTS "CallSession" CASCADE;
DROP TABLE IF EXISTS "TelephonyCommand" CASCADE;
DROP TABLE IF EXISTS "TelephonyDevice" CASCADE;

-- DropEnum
DROP TYPE IF EXISTS "CallDisposition";
DROP TYPE IF EXISTS "CallStatus";
DROP TYPE IF EXISTS "CommandStatus";
DROP TYPE IF EXISTS "DeviceStatus";
