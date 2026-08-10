import {
  RECORD_SAVED_AI_CONNECTION_SUCCESS_RESULT_V1,
  SAVE_AI_AGENT_CONFIG_RESULT_V1,
  SAVE_EXTRACTION_QUALITY_TIER_RESULT_V1,
  SET_ACTIVE_AI_PROFILE_RESULT_V1,
  parseRecordSavedAiConnectionSuccessCommandV1,
  parseSaveAiAgentConfigCommandV1,
  parseSaveExtractionQualityTierCommandV1,
  parseSetActiveAiProfileCommandV1,
  type AiAgentConfigPatchEntryV1,
  type ExtractionQualityTierV1,
  type RecordSavedAiConnectionSuccessCommandV1,
  type RecordSavedAiConnectionSuccessResultV1,
  type SaveAiAgentConfigCommandV1,
  type SaveAiAgentConfigResultV1,
  type SaveExtractionQualityTierCommandV1,
  type SaveExtractionQualityTierResultV1,
  type SetActiveAiProfileCommandV1,
  type SetActiveAiProfileResultV1,
} from '../../../../contracts/calling/v1'

export interface AiAgentConfigPersistencePortV1 {
  singletonExists(): Promise<boolean>
  createSingleton(entries: readonly AiAgentConfigPatchEntryV1[]): Promise<void>
  updateSingleton(entries: readonly AiAgentConfigPatchEntryV1[]): Promise<void>
  recordSavedConnectionSuccess(): Promise<void>
  findProfile(profileId: string): Promise<{ id: string } | null>
  setActiveProfile(profileId: string | null): Promise<void>
  saveExtractionQualityTier(tier: ExtractionQualityTierV1): Promise<void>
}

export function createSaveAiAgentConfigHandlerV1(port: AiAgentConfigPersistencePortV1) {
  return async function saveAiAgentConfigV1(
    command: SaveAiAgentConfigCommandV1 | unknown,
  ): Promise<SaveAiAgentConfigResultV1> {
    const parsed = parseSaveAiAgentConfigCommandV1(command)
    if (parsed.entries.length === 0) {
      return { contract: SAVE_AI_AGENT_CONFIG_RESULT_V1, saved: false }
    }
    if (await port.singletonExists()) await port.updateSingleton(parsed.entries)
    else await port.createSingleton(parsed.entries)
    return { contract: SAVE_AI_AGENT_CONFIG_RESULT_V1, saved: true }
  }
}

export function createRecordSavedAiConnectionSuccessHandlerV1(
  port: AiAgentConfigPersistencePortV1,
) {
  return async function recordSavedAiConnectionSuccessV1(
    command: RecordSavedAiConnectionSuccessCommandV1 | unknown,
  ): Promise<RecordSavedAiConnectionSuccessResultV1> {
    parseRecordSavedAiConnectionSuccessCommandV1(command)
    await port.recordSavedConnectionSuccess()
    return { contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_RESULT_V1, updated: true }
  }
}

export function createSetActiveAiProfileHandlerV1(port: AiAgentConfigPersistencePortV1) {
  return async function setActiveAiProfileV1(
    command: SetActiveAiProfileCommandV1 | unknown,
  ): Promise<SetActiveAiProfileResultV1> {
    const parsed = parseSetActiveAiProfileCommandV1(command)
    if (parsed.profileId) {
      const profile = await port.findProfile(parsed.profileId)
      if (!profile) throw new Error('Профиль не найден')
    }
    await port.setActiveProfile(parsed.profileId)
    return { contract: SET_ACTIVE_AI_PROFILE_RESULT_V1, updated: true }
  }
}

export function createSaveExtractionQualityTierHandlerV1(
  port: AiAgentConfigPersistencePortV1,
) {
  return async function saveExtractionQualityTierV1(
    command: SaveExtractionQualityTierCommandV1 | unknown,
  ): Promise<SaveExtractionQualityTierResultV1> {
    const parsed = parseSaveExtractionQualityTierCommandV1(command)
    await port.saveExtractionQualityTier(parsed.tier)
    return { contract: SAVE_EXTRACTION_QUALITY_TIER_RESULT_V1, updated: true }
  }
}
