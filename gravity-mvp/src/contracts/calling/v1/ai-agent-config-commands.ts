export const SAVE_AI_AGENT_CONFIG_COMMAND_V1 =
  'calling.SaveAiAgentConfigCommand.v1' as const
export const SAVE_AI_AGENT_CONFIG_RESULT_V1 =
  'calling.SaveAiAgentConfigResult.v1' as const
export const RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1 =
  'calling.RecordSavedAiConnectionSuccessCommand.v1' as const
export const RECORD_SAVED_AI_CONNECTION_SUCCESS_RESULT_V1 =
  'calling.RecordSavedAiConnectionSuccessResult.v1' as const
export const SET_ACTIVE_AI_PROFILE_COMMAND_V1 =
  'calling.SetActiveAiProfileCommand.v1' as const
export const SET_ACTIVE_AI_PROFILE_RESULT_V1 =
  'calling.SetActiveAiProfileResult.v1' as const
export const SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1 =
  'calling.SaveExtractionQualityTierCommand.v1' as const
export const SAVE_EXTRACTION_QUALITY_TIER_RESULT_V1 =
  'calling.SaveExtractionQualityTierResult.v1' as const

export const AI_AGENT_CONFIG_PATCH_FIELDS_V1 = [
  'enabled',
  'mode',
  'provider',
  'providerCredential',
  'classificationModel',
  'responseModel',
  'language',
  'confidenceThreshold',
  'maxAutoRepliesPerChat',
  'activeChannels',
  'escalationPolicy',
  'workingHours',
  'routingRules',
  'promptRole',
  'promptTone',
  'promptAllowed',
  'promptForbidden',
  'activeProfileId',
  'connectionStatus',
  'lastConnectionCheckAt',
  'extractionQualityTier',
  'extractionPromptVersion',
  'internEnabled',
] as const

export const AI_AGENT_MODES_V1 = [
  'off',
  'suggest_only',
  'auto_reply',
  'operator_locked',
] as const
export const AI_PROVIDER_TYPES_V1 = ['anthropic', 'openai'] as const
export const EXTRACTION_QUALITY_TIERS_V1 = ['economy', 'balanced', 'quality'] as const

export type AiAgentModeV1 = (typeof AI_AGENT_MODES_V1)[number]
export type AiProviderTypeV1 = (typeof AI_PROVIDER_TYPES_V1)[number]
export type ExtractionQualityTierV1 = (typeof EXTRACTION_QUALITY_TIERS_V1)[number]

declare const OPAQUE_CREDENTIAL_REF_V1: unique symbol

/**
 * An identity-only reference. Its credential value is held by the Calling
 * adapter and is deliberately absent from this object and public contract.
 */
export type OpaqueCredentialRefV1 = Readonly<{
  readonly [OPAQUE_CREDENTIAL_REF_V1]: 'calling.provider-credential.v1'
}>

export type JsonValueV1 =
  | null
  | boolean
  | number
  | string
  | JsonValueV1[]
  | { [key: string]: JsonValueV1 }

type PatchEntryV1<Field extends string, Value> = Readonly<{
  field: Field
  value: Value
}>

export type AiAgentConfigPatchEntryV1 =
  | PatchEntryV1<'enabled', boolean>
  | PatchEntryV1<'mode', AiAgentModeV1>
  | PatchEntryV1<'provider', AiProviderTypeV1>
  | PatchEntryV1<'providerCredential', OpaqueCredentialRefV1 | null>
  | PatchEntryV1<'classificationModel', string>
  | PatchEntryV1<'responseModel', string>
  | PatchEntryV1<'language', string>
  | PatchEntryV1<'confidenceThreshold', number>
  | PatchEntryV1<'maxAutoRepliesPerChat', number>
  | PatchEntryV1<'activeChannels', string[]>
  | PatchEntryV1<'escalationPolicy', JsonValueV1>
  | PatchEntryV1<'workingHours', JsonValueV1>
  | PatchEntryV1<'routingRules', JsonValueV1>
  | PatchEntryV1<'promptRole', string | null>
  | PatchEntryV1<'promptTone', string | null>
  | PatchEntryV1<'promptAllowed', string | null>
  | PatchEntryV1<'promptForbidden', string | null>
  | PatchEntryV1<'activeProfileId', string | null>
  | PatchEntryV1<'connectionStatus', string | null>
  | PatchEntryV1<'lastConnectionCheckAt', Date | null>
  | PatchEntryV1<'extractionQualityTier', string | null>
  | PatchEntryV1<'extractionPromptVersion', string | null>
  | PatchEntryV1<'internEnabled', boolean>

export interface SaveAiAgentConfigCommandV1 {
  contract: typeof SAVE_AI_AGENT_CONFIG_COMMAND_V1
  entries: readonly AiAgentConfigPatchEntryV1[]
}

export interface SaveAiAgentConfigResultV1 {
  contract: typeof SAVE_AI_AGENT_CONFIG_RESULT_V1
  saved: boolean
}

export interface RecordSavedAiConnectionSuccessCommandV1 {
  contract: typeof RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1
}

export interface RecordSavedAiConnectionSuccessResultV1 {
  contract: typeof RECORD_SAVED_AI_CONNECTION_SUCCESS_RESULT_V1
  updated: true
}

export interface SetActiveAiProfileCommandV1 {
  contract: typeof SET_ACTIVE_AI_PROFILE_COMMAND_V1
  profileId: string | null
}

export interface SetActiveAiProfileResultV1 {
  contract: typeof SET_ACTIVE_AI_PROFILE_RESULT_V1
  updated: true
}

export interface SaveExtractionQualityTierCommandV1 {
  contract: typeof SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1
  tier: ExtractionQualityTierV1
}

export interface SaveExtractionQualityTierResultV1 {
  contract: typeof SAVE_EXTRACTION_QUALITY_TIER_RESULT_V1
  updated: true
}

export class AiAgentConfigCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: AiAgentConfigCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'AiAgentConfigCommandValidationError'
    this.code = code
  }
}

const PATCH_FIELDS = new Set<string>(AI_AGENT_CONFIG_PATCH_FIELDS_V1)
const MODES = new Set<string>(AI_AGENT_MODES_V1)
const PROVIDERS = new Set<string>(AI_PROVIDER_TYPES_V1)
const QUALITY_TIERS = new Set<string>(EXTRACTION_QUALITY_TIERS_V1)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new AiAgentConfigCommandValidationError('INVALID_CONTRACT', message)
}

function parseEnvelope(
  input: unknown,
  expected: string,
  prefix: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) invalid('command must be an object')
  const unsupported = Object.keys(input).filter((field) => !fields.includes(field))
  if (unsupported.length > 0) invalid(`unsupported field(s): ${unsupported.sort().join(', ')}`)
  if (input.contract !== expected) {
    if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
      throw new AiAgentConfigCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${expected}`)
  }
  return input
}

function isJsonValue(value: unknown, seen: WeakSet<object>): value is JsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every((item) => isJsonValue(item, seen))
}

function isOpaqueCredentialShape(value: unknown): value is OpaqueCredentialRefV1 {
  return isRecord(value) && Object.isFrozen(value) && Reflect.ownKeys(value).length === 0
}

function validatePatchValue(field: string, value: unknown): void {
  switch (field) {
    case 'enabled':
    case 'internEnabled':
      if (typeof value !== 'boolean') invalid(`${field} must be a boolean`)
      return
    case 'mode':
      if (typeof value !== 'string' || !MODES.has(value)) invalid('mode is invalid')
      return
    case 'provider':
      if (typeof value !== 'string' || !PROVIDERS.has(value)) invalid('provider is invalid')
      return
    case 'providerCredential':
      if (value !== null && !isOpaqueCredentialShape(value)) {
        invalid('providerCredential must be an opaque credential reference or null')
      }
      return
    case 'classificationModel':
    case 'responseModel':
    case 'language':
      if (typeof value !== 'string') invalid(`${field} must be a string`)
      return
    case 'confidenceThreshold':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        invalid('confidenceThreshold must be a finite number')
      }
      return
    case 'maxAutoRepliesPerChat':
      if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < -2147483648
        || value > 2147483647
      ) {
        invalid('maxAutoRepliesPerChat must be a 32-bit integer')
      }
      return
    case 'activeChannels':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        invalid('activeChannels must be a string array')
      }
      return
    case 'escalationPolicy':
    case 'workingHours':
    case 'routingRules':
      if (!isJsonValue(value, new WeakSet<object>())) invalid(`${field} must be JSON-compatible`)
      return
    case 'promptRole':
    case 'promptTone':
    case 'promptAllowed':
    case 'promptForbidden':
    case 'activeProfileId':
    case 'connectionStatus':
    case 'extractionQualityTier':
    case 'extractionPromptVersion':
      if (value !== null && typeof value !== 'string') invalid(`${field} must be a string or null`)
      return
    case 'lastConnectionCheckAt':
      if (value !== null && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
        invalid('lastConnectionCheckAt must be a valid Date or null')
      }
      return
    default:
      invalid(`unsupported patch field: ${field}`)
  }
}

export function parseSaveAiAgentConfigCommandV1(input: unknown): SaveAiAgentConfigCommandV1 {
  const value = parseEnvelope(
    input,
    SAVE_AI_AGENT_CONFIG_COMMAND_V1,
    'calling.SaveAiAgentConfigCommand.',
    ['contract', 'entries'],
  )
  if (!Array.isArray(value.entries)) invalid('entries must be an array')
  const seen = new Set<string>()
  for (const entry of value.entries) {
    if (!isRecord(entry)) invalid('each patch entry must be an object')
    const unsupported = Object.keys(entry).filter((field) => field !== 'field' && field !== 'value')
    if (unsupported.length > 0) invalid(`unsupported patch entry field(s): ${unsupported.sort().join(', ')}`)
    if (typeof entry.field !== 'string' || !PATCH_FIELDS.has(entry.field)) {
      invalid(`unsupported patch field: ${String(entry.field)}`)
    }
    if (seen.has(entry.field)) invalid(`duplicate patch field: ${entry.field}`)
    seen.add(entry.field)
    if (!Object.prototype.hasOwnProperty.call(entry, 'value')) invalid(`${entry.field} value is required`)
    validatePatchValue(entry.field, entry.value)
  }
  return value as unknown as SaveAiAgentConfigCommandV1
}

export function parseRecordSavedAiConnectionSuccessCommandV1(
  input: unknown,
): RecordSavedAiConnectionSuccessCommandV1 {
  return parseEnvelope(
    input,
    RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1,
    'calling.RecordSavedAiConnectionSuccessCommand.',
    ['contract'],
  ) as unknown as RecordSavedAiConnectionSuccessCommandV1
}

export function parseSetActiveAiProfileCommandV1(input: unknown): SetActiveAiProfileCommandV1 {
  const value = parseEnvelope(
    input,
    SET_ACTIVE_AI_PROFILE_COMMAND_V1,
    'calling.SetActiveAiProfileCommand.',
    ['contract', 'profileId'],
  )
  if (value.profileId !== null && typeof value.profileId !== 'string') {
    invalid('profileId must be a string or null')
  }
  return value as unknown as SetActiveAiProfileCommandV1
}

export function parseSaveExtractionQualityTierCommandV1(
  input: unknown,
): SaveExtractionQualityTierCommandV1 {
  const value = parseEnvelope(
    input,
    SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1,
    'calling.SaveExtractionQualityTierCommand.',
    ['contract', 'tier'],
  )
  if (typeof value.tier !== 'string' || !QUALITY_TIERS.has(value.tier)) {
    invalid('tier is invalid')
  }
  return value as unknown as SaveExtractionQualityTierCommandV1
}
