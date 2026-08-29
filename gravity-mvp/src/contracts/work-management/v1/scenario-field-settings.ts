export const GET_MERGED_SCENARIO_FIELDS_QUERY_V1 = 'work_management.GetMergedScenarioFieldsQuery.v1' as const
export const GET_MERGED_SCENARIO_FIELDS_RESULT_V1 = 'work_management.GetMergedScenarioFieldsResult.v1' as const
export const UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1 = 'work_management.UpsertScenarioFieldSettingCommand.v1' as const
export const UPSERT_SCENARIO_FIELD_SETTING_RESULT_V1 = 'work_management.UpsertScenarioFieldSettingResult.v1' as const
export const RESET_SCENARIO_FIELD_SETTING_COMMAND_V1 = 'work_management.ResetScenarioFieldSettingCommand.v1' as const
export const RESET_SCENARIO_FIELD_SETTING_RESULT_V1 = 'work_management.ResetScenarioFieldSettingResult.v1' as const

export const MAX_LIST_PREVIEW_FIELDS = 8 as const

export type ScenarioFieldTypeV1 = 'boolean' | 'number' | 'string' | 'enum' | 'date'
export type ScenarioFieldSourceV1 = 'auto' | 'manual' | 'derived'

export interface ScenarioFieldEnumOptionV1 {
  value: string
  label: string
}

export interface MergedScenarioFieldV1 {
  id: string
  label: string
  type: ScenarioFieldTypeV1
  source: ScenarioFieldSourceV1
  showInList: boolean
  showInCard: boolean
  filterable: boolean
  sortable?: boolean
  groupable?: boolean
  priorityWeight: number
  enumOptions?: ScenarioFieldEnumOptionV1[]
  shortLabel?: string
  order: number
  hasOverride: boolean
}

export interface ScenarioFieldSettingPatchV1 {
  showInList?: boolean | null
  showInCard?: boolean | null
  filterable?: boolean | null
  sortable?: boolean | null
  groupable?: boolean | null
  order?: number | null
}

export interface GetMergedScenarioFieldsQueryV1 {
  contract: typeof GET_MERGED_SCENARIO_FIELDS_QUERY_V1
  scenarioId: string
}

export interface GetMergedScenarioFieldsResultV1 {
  contract: typeof GET_MERGED_SCENARIO_FIELDS_RESULT_V1
  fields: MergedScenarioFieldV1[]
}

export interface UpsertScenarioFieldSettingCommandV1 {
  contract: typeof UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1
  scenarioId: string
  fieldId: string
  patch: ScenarioFieldSettingPatchV1
  userId: string | null
}

export interface UpsertScenarioFieldSettingResultV1 {
  contract: typeof UPSERT_SCENARIO_FIELD_SETTING_RESULT_V1
  completed: true
}

export interface ResetScenarioFieldSettingCommandV1 {
  contract: typeof RESET_SCENARIO_FIELD_SETTING_COMMAND_V1
  scenarioId: string
  fieldId: string
}

export interface ResetScenarioFieldSettingResultV1 {
  contract: typeof RESET_SCENARIO_FIELD_SETTING_RESULT_V1
  completed: true
}

export class ScenarioFieldSettingsContractValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: ScenarioFieldSettingsContractValidationError['code'], message: string) {
    super(message)
    this.name = 'ScenarioFieldSettingsContractValidationError'
    this.code = code
  }
}

const PATCH_FIELDS = [
  'showInList',
  'showInCard',
  'filterable',
  'sortable',
  'groupable',
  'order',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

function invalid(message: string): never {
  throw new ScenarioFieldSettingsContractValidationError('INVALID_CONTRACT', message)
}

function envelope(
  input: unknown,
  expected: string,
  prefix: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) invalid('request must be an object')
  const extra = Object.keys(input).filter(key => !fields.includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (input.contract !== expected) {
    if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
      throw new ScenarioFieldSettingsContractValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${expected}`)
  }
  return input
}

function scenarioId(value: unknown): asserts value is string {
  if (!isNonEmptyString(value)) invalid('scenarioId must be a non-empty string')
}

function fieldId(value: unknown): asserts value is string {
  if (!isNonEmptyString(value)) invalid('fieldId must be a non-empty string')
}

function parsePatch(value: unknown): ScenarioFieldSettingPatchV1 {
  if (!isRecord(value)) invalid('patch must be an object')
  const extra = Object.keys(value).filter(key => !PATCH_FIELDS.includes(key as typeof PATCH_FIELDS[number]))
  if (extra.length > 0) invalid(`patch has unsupported field(s): ${extra.sort().join(', ')}`)
  for (const key of PATCH_FIELDS.slice(0, 5)) {
    const item = value[key]
    if (item !== undefined && item !== null && typeof item !== 'boolean') {
      invalid(`patch.${key} must be a boolean or null`)
    }
  }
  if (value.order !== undefined && value.order !== null) {
    if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
      invalid('patch.order must be a finite number or null')
    }
  }
  return value as ScenarioFieldSettingPatchV1
}

export function parseGetMergedScenarioFieldsQueryV1(input: unknown): GetMergedScenarioFieldsQueryV1 {
  const value = envelope(
    input,
    GET_MERGED_SCENARIO_FIELDS_QUERY_V1,
    'work_management.GetMergedScenarioFieldsQuery.',
    ['contract', 'scenarioId'],
  )
  scenarioId(value.scenarioId)
  return value as unknown as GetMergedScenarioFieldsQueryV1
}

export function parseUpsertScenarioFieldSettingCommandV1(
  input: unknown,
): UpsertScenarioFieldSettingCommandV1 {
  const value = envelope(
    input,
    UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
    'work_management.UpsertScenarioFieldSettingCommand.',
    ['contract', 'scenarioId', 'fieldId', 'patch', 'userId'],
  )
  scenarioId(value.scenarioId)
  fieldId(value.fieldId)
  parsePatch(value.patch)
  if (value.userId !== null && !isNonEmptyString(value.userId)) {
    invalid('userId must be a non-empty string or null')
  }
  return value as unknown as UpsertScenarioFieldSettingCommandV1
}

export function parseResetScenarioFieldSettingCommandV1(
  input: unknown,
): ResetScenarioFieldSettingCommandV1 {
  const value = envelope(
    input,
    RESET_SCENARIO_FIELD_SETTING_COMMAND_V1,
    'work_management.ResetScenarioFieldSettingCommand.',
    ['contract', 'scenarioId', 'fieldId'],
  )
  scenarioId(value.scenarioId)
  fieldId(value.fieldId)
  return value as unknown as ResetScenarioFieldSettingCommandV1
}
