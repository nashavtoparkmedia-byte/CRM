import { describe, expect, it, vi } from 'vitest'
import {
  AI_AGENT_CONFIG_PATCH_FIELDS_V1,
  RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
  RECORD_SAVED_AI_CONNECTION_SUCCESS_RESULT_V1,
  SAVE_AI_AGENT_CONFIG_COMMAND_V1,
  SAVE_AI_AGENT_CONFIG_RESULT_V1,
  SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
  SAVE_EXTRACTION_QUALITY_TIER_RESULT_V1,
  SET_ACTIVE_AI_PROFILE_COMMAND_V1,
  SET_ACTIVE_AI_PROFILE_RESULT_V1,
  AiAgentConfigCommandValidationError,
  parseRecordSavedAiConnectionSuccessCommandV1,
  parseSaveAiAgentConfigCommandV1,
  parseSaveExtractionQualityTierCommandV1,
  parseSetActiveAiProfileCommandV1,
  type AiAgentConfigPatchEntryV1,
  type OpaqueCredentialRefV1,
} from '../../../../contracts/calling/v1'
import {
  createRecordSavedAiConnectionSuccessHandlerV1,
  createSaveAiAgentConfigHandlerV1,
  createSaveExtractionQualityTierHandlerV1,
  createSetActiveAiProfileHandlerV1,
  type AiAgentConfigPersistencePortV1,
} from './ai-agent-config-handler'

function opaqueShape(): OpaqueCredentialRefV1 {
  return Object.freeze({}) as OpaqueCredentialRefV1
}

function allEntries(): AiAgentConfigPatchEntryV1[] {
  return [
    { field: 'enabled', value: true },
    { field: 'mode', value: 'suggest_only' },
    { field: 'provider', value: 'openai' },
    { field: 'providerCredential', value: opaqueShape() },
    { field: 'classificationModel', value: 'classification-model' },
    { field: 'responseModel', value: 'response-model' },
    { field: 'language', value: 'ru' },
    { field: 'confidenceThreshold', value: 0.625 },
    { field: 'maxAutoRepliesPerChat', value: 7 },
    { field: 'activeChannels', value: ['telegram', 'max'] },
    { field: 'escalationPolicy', value: { enabled: true, labels: ['urgent'] } },
    { field: 'workingHours', value: null },
    { field: 'routingRules', value: [{ route: 'operator' }] },
    { field: 'promptRole', value: 'role' },
    { field: 'promptTone', value: null },
    { field: 'promptAllowed', value: 'allowed' },
    { field: 'promptForbidden', value: null },
    { field: 'activeProfileId', value: 'profile-1' },
    { field: 'connectionStatus', value: 'ok' },
    { field: 'lastConnectionCheckAt', value: new Date('2026-08-10T00:00:00.000Z') },
    { field: 'extractionQualityTier', value: 'balanced' },
    { field: 'extractionPromptVersion', value: null },
    { field: 'internEnabled', value: false },
  ]
}

function makePort(options: { exists?: boolean; profile?: { id: string } | null } = {}) {
  const calls: string[] = []
  const methods = {
    singletonExists: vi.fn(async () => {
      calls.push('singletonExists')
      return options.exists ?? false
    }),
    createSingleton: vi.fn(async () => { calls.push('createSingleton') }),
    updateSingleton: vi.fn(async () => { calls.push('updateSingleton') }),
    recordSavedConnectionSuccess: vi.fn(async () => {
      calls.push('recordSavedConnectionSuccess')
    }),
    findProfile: vi.fn(async () => {
      calls.push('findProfile')
      return options.profile ?? null
    }),
    setActiveProfile: vi.fn(async () => { calls.push('setActiveProfile') }),
    saveExtractionQualityTier: vi.fn(async () => {
      calls.push('saveExtractionQualityTier')
    }),
  }
  return { calls, methods, port: methods as AiAgentConfigPersistencePortV1 }
}

describe('Calling AiAgentConfig v1 contracts', () => {
  it('pins the strict 23-field union and preserves caller entry order', () => {
    const entries = allEntries()
    expect(AI_AGENT_CONFIG_PATCH_FIELDS_V1).toHaveLength(23)
    expect(entries.map((entry) => entry.field)).toEqual(AI_AGENT_CONFIG_PATCH_FIELDS_V1)

    const parsed = parseSaveAiAgentConfigCommandV1({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: [...entries].reverse(),
    })
    expect(parsed.entries.map((entry) => entry.field)).toEqual(
      [...AI_AGENT_CONFIG_PATCH_FIELDS_V1].reverse(),
    )
  })

  it('rejects unknown, duplicate, malformed and capability-expanding patch entries', () => {
    const base = { contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1 }
    const invalidEntries = [
      [{ field: 'updatedAt', value: new Date() }],
      [{ field: 'enabled', value: true }, { field: 'enabled', value: false }],
      [{ field: 'provider', value: 'other' }],
      [{ field: 'mode', value: 'automatic' }],
      [{ field: 'activeChannels', value: ['telegram', 1] }],
      [{ field: 'maxAutoRepliesPerChat', value: 1.5 }],
      [{ field: 'confidenceThreshold', value: Number.NaN }],
      [{ field: 'lastConnectionCheckAt', value: new Date('invalid') }],
      [{ field: 'routingRules', value: { nested: undefined } }],
      [{ field: 'providerCredential', value: {} }],
      [{ field: 'enabled', value: true, where: { id: 'other' } }],
    ]
    for (const entries of invalidEntries) {
      expect(() => parseSaveAiAgentConfigCommandV1({ ...base, entries })).toThrow(
        AiAgentConfigCommandValidationError,
      )
    }
    expect(() => parseSaveAiAgentConfigCommandV1({
      ...base,
      entries: [{ field: 'enabled' }],
    })).toThrow(AiAgentConfigCommandValidationError)
  })

  it('accepts only frozen empty credential references at the contract edge', () => {
    const reference = opaqueShape()
    const parsed = parseSaveAiAgentConfigCommandV1({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: [{ field: 'providerCredential', value: reference }],
    })
    expect(parsed.entries[0]?.value).toBe(reference)
    expect(Object.isFrozen(reference)).toBe(true)
    expect(Reflect.ownKeys(reference)).toEqual([])
    expect(JSON.stringify(reference)).toBe('{}')
    expect(() => parseSaveAiAgentConfigCommandV1({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: [{ field: 'providerCredential', value: Object.freeze({ exposed: true }) }],
    })).toThrow(AiAgentConfigCommandValidationError)
  })

  it('distinguishes future versions and closes all four envelopes', () => {
    expect(() => parseSaveAiAgentConfigCommandV1({
      contract: 'calling.SaveAiAgentConfigCommand.v2',
      entries: [],
    })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTRACT_VERSION' }))

    expect(parseRecordSavedAiConnectionSuccessCommandV1({
      contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
    })).toEqual({ contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1 })
    expect(parseSetActiveAiProfileCommandV1({
      contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1,
      profileId: '',
    })).toEqual({ contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1, profileId: '' })
    expect(parseSaveExtractionQualityTierCommandV1({
      contract: SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
      tier: 'quality',
    })).toEqual({ contract: SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1, tier: 'quality' })

    expect(() => parseRecordSavedAiConnectionSuccessCommandV1({
      contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
      sql: 'not allowed',
    })).toThrow(AiAgentConfigCommandValidationError)
    expect(() => parseSetActiveAiProfileCommandV1({
      contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1,
      profileId: undefined,
    })).toThrow(AiAgentConfigCommandValidationError)
    expect(() => parseSaveExtractionQualityTierCommandV1({
      contract: SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
      tier: 'custom',
    })).toThrow(AiAgentConfigCommandValidationError)
  })
})

describe('Calling AiAgentConfig v1 handlers', () => {
  it('keeps an empty save a no-read no-write result', async () => {
    const { calls, port } = makePort()
    await expect(createSaveAiAgentConfigHandlerV1(port)({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: [],
    })).resolves.toEqual({ contract: SAVE_AI_AGENT_CONFIG_RESULT_V1, saved: false })
    expect(calls).toEqual([])
  })

  it('preserves nontransactional existence-read selection and exact entry identity', async () => {
    const insert = makePort({ exists: false })
    const insertEntries: AiAgentConfigPatchEntryV1[] = [
      { field: 'language', value: 'ru' },
      { field: 'enabled', value: true },
    ]
    await expect(createSaveAiAgentConfigHandlerV1(insert.port)({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: insertEntries,
    })).resolves.toEqual({ contract: SAVE_AI_AGENT_CONFIG_RESULT_V1, saved: true })
    expect(insert.calls).toEqual(['singletonExists', 'createSingleton'])
    expect(insert.methods.createSingleton).toHaveBeenCalledWith(insertEntries)

    const update = makePort({ exists: true })
    await createSaveAiAgentConfigHandlerV1(update.port)({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: insertEntries,
    })
    expect(update.calls).toEqual(['singletonExists', 'updateSingleton'])
    expect(update.methods.updateSingleton).toHaveBeenCalledWith(insertEntries)
  })

  it('maps the fixed status and tier commands one-to-one', async () => {
    const { calls, methods, port } = makePort()
    await expect(createRecordSavedAiConnectionSuccessHandlerV1(port)({
      contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
    })).resolves.toEqual({
      contract: RECORD_SAVED_AI_CONNECTION_SUCCESS_RESULT_V1,
      updated: true,
    })
    await expect(createSaveExtractionQualityTierHandlerV1(port)({
      contract: SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
      tier: 'economy',
    })).resolves.toEqual({
      contract: SAVE_EXTRACTION_QUALITY_TIER_RESULT_V1,
      updated: true,
    })
    expect(calls).toEqual(['recordSavedConnectionSuccess', 'saveExtractionQualityTier'])
    expect(methods.saveExtractionQualityTier).toHaveBeenCalledWith('economy')
  })

  it('retains truthy profile lookup, exact missing error and falsy upsert behavior', async () => {
    const present = makePort({ profile: { id: 'profile-1' } })
    await expect(createSetActiveAiProfileHandlerV1(present.port)({
      contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1,
      profileId: 'profile-1',
    })).resolves.toEqual({ contract: SET_ACTIVE_AI_PROFILE_RESULT_V1, updated: true })
    expect(present.calls).toEqual(['findProfile', 'setActiveProfile'])
    expect(present.methods.setActiveProfile).toHaveBeenCalledWith('profile-1')

    const missing = makePort({ profile: null })
    await expect(createSetActiveAiProfileHandlerV1(missing.port)({
      contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1,
      profileId: 'missing',
    })).rejects.toThrow('Профиль не найден')
    expect(missing.calls).toEqual(['findProfile'])

    for (const profileId of ['', null] as const) {
      const falsy = makePort()
      await createSetActiveAiProfileHandlerV1(falsy.port)({
        contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1,
        profileId,
      })
      expect(falsy.calls).toEqual(['setActiveProfile'])
      expect(falsy.methods.setActiveProfile).toHaveBeenCalledWith(profileId)
    }
  })

  it('validates before persistence and leaves owner/race failures visible', async () => {
    const { methods, port } = makePort({ exists: false })
    await expect(createSaveAiAgentConfigHandlerV1(port)({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: [{ field: 'id', value: 'other' }],
    })).rejects.toBeInstanceOf(AiAgentConfigCommandValidationError)
    expect(methods.singletonExists).not.toHaveBeenCalled()

    methods.createSingleton.mockRejectedValueOnce(new Error('insert race'))
    await expect(createSaveAiAgentConfigHandlerV1(port)({
      contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
      entries: [{ field: 'enabled', value: true }],
    })).rejects.toThrow('insert race')

    const profileRace = makePort({ profile: { id: 'profile-race' } })
    profileRace.methods.setActiveProfile.mockRejectedValueOnce(new Error('foreign key race'))
    await expect(createSetActiveAiProfileHandlerV1(profileRace.port)({
      contract: SET_ACTIVE_AI_PROFILE_COMMAND_V1,
      profileId: 'profile-race',
    })).rejects.toThrow('foreign key race')
  })
})
