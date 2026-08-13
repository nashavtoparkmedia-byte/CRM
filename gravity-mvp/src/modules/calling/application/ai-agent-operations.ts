import {
  createCreateAiAgentProfileHandlerV1,
  createDeleteAiAgentProfileHandlerV1,
  createUpdateAiAgentProfileHandlerV1,
} from '../public/v1/ai-agent-profile-handler'
import { legacyPrismaAiAgentProfilePortV1 } from '../public/v1/legacy-prisma-ai-agent-profile-adapter'
import {
  createRecordSavedAiConnectionSuccessHandlerV1,
  createSaveAiAgentConfigHandlerV1,
  createSaveExtractionQualityTierHandlerV1,
  createSetActiveAiProfileHandlerV1,
} from '../public/v1/ai-agent-config-handler'
import { legacyPrismaAiAgentConfigPortV1 } from '../public/v1/legacy-prisma-ai-agent-config-adapter'

// Owner-only composition. The public facade exports these narrow command
// operations, never the persistence ports or their Prisma-backed adapters.
const createAiAgentProfile = createCreateAiAgentProfileHandlerV1(legacyPrismaAiAgentProfilePortV1)
const updateAiAgentProfile = createUpdateAiAgentProfileHandlerV1(legacyPrismaAiAgentProfilePortV1)
const deleteAiAgentProfile = createDeleteAiAgentProfileHandlerV1(legacyPrismaAiAgentProfilePortV1)
const saveAiAgentConfig = createSaveAiAgentConfigHandlerV1(legacyPrismaAiAgentConfigPortV1)
const recordSavedAiConnectionSuccess = createRecordSavedAiConnectionSuccessHandlerV1(legacyPrismaAiAgentConfigPortV1)
const setActiveAiProfile = createSetActiveAiProfileHandlerV1(legacyPrismaAiAgentConfigPortV1)
const saveExtractionQualityTier = createSaveExtractionQualityTierHandlerV1(legacyPrismaAiAgentConfigPortV1)

export async function createAiAgentProfileV1(command: unknown) {
  return createAiAgentProfile(command)
}

export async function updateAiAgentProfileV1(command: unknown) {
  return updateAiAgentProfile(command)
}

export async function deleteAiAgentProfileV1(command: unknown) {
  return deleteAiAgentProfile(command)
}

export async function saveAiAgentConfigV1(command: unknown) {
  return saveAiAgentConfig(command)
}

export async function recordSavedAiConnectionSuccessV1(command: unknown) {
  return recordSavedAiConnectionSuccess(command)
}

export async function setActiveAiProfileV1(command: unknown) {
  return setActiveAiProfile(command)
}

export async function saveExtractionQualityTierV1(command: unknown) {
  return saveExtractionQualityTier(command)
}
