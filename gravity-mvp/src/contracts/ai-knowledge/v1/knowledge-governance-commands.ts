export const EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.EditGovernanceKnowledgeItemCommand.v1' as const
export const EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.EditGovernanceKnowledgeItemResult.v1' as const
export const ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.ArchiveGovernanceKnowledgeItemCommand.v1' as const
export const ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.ArchiveGovernanceKnowledgeItemResult.v1' as const
export const RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.RestoreGovernanceKnowledgeItemCommand.v1' as const
export const RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.RestoreGovernanceKnowledgeItemResult.v1' as const
export const VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.VerifyGovernanceKnowledgeItemCommand.v1' as const
export const VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.VerifyGovernanceKnowledgeItemResult.v1' as const
export const UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.UnverifyGovernanceKnowledgeItemCommand.v1' as const
export const UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.UnverifyGovernanceKnowledgeItemResult.v1' as const
export const SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.SupersedeGovernanceKnowledgeItemCommand.v1' as const
export const SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.SupersedeGovernanceKnowledgeItemResult.v1' as const
export const ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1 =
  'ai_knowledge.ArchiveKnowledgeConflictMemberCommand.v1' as const
export const ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_RESULT_V1 =
  'ai_knowledge.ArchiveKnowledgeConflictMemberResult.v1' as const
export const CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1 =
  'ai_knowledge.ClearKnowledgeConflictWinnerCommand.v1' as const
export const CLEAR_KNOWLEDGE_CONFLICT_WINNER_RESULT_V1 =
  'ai_knowledge.ClearKnowledgeConflictWinnerResult.v1' as const
export const CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1 =
  'ai_knowledge.ClearKnowledgeConflictGroupCommand.v1' as const
export const CLEAR_KNOWLEDGE_CONFLICT_GROUP_RESULT_V1 =
  'ai_knowledge.ClearKnowledgeConflictGroupResult.v1' as const
export const CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1 =
  'ai_knowledge.CreateManualGovernanceKnowledgeItemCommand.v1' as const
export const CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1 =
  'ai_knowledge.CreateManualGovernanceKnowledgeItemResult.v1' as const
export const MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1 =
  'ai_knowledge.MarkKnowledgeItemSourcesDisabledCommand.v1' as const
export const MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_RESULT_V1 =
  'ai_knowledge.MarkKnowledgeItemSourcesDisabledResult.v1' as const
export const ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1 =
  'ai_knowledge.ArchiveKnowledgeItemAfterSourceDisableCommand.v1' as const
export const ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_RESULT_V1 =
  'ai_knowledge.ArchiveKnowledgeItemAfterSourceDisableResult.v1' as const
export const ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1 =
  'ai_knowledge.ArchiveKnowledgeItemForCoreResetCommand.v1' as const
export const ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_RESULT_V1 =
  'ai_knowledge.ArchiveKnowledgeItemForCoreResetResult.v1' as const

export const KNOWLEDGE_GOVERNANCE_SAFETY_LEVELS_V1 = [
  'normal',
  'sensitive',
  'requires_human',
] as const

export type KnowledgeGovernanceSafetyLevelV1 =
  (typeof KNOWLEDGE_GOVERNANCE_SAFETY_LEVELS_V1)[number]

export interface KnowledgeGovernanceEditPatchV1 {
  title?: string
  canonicalStatement?: string
  tags?: string[]
  safetyLevel?: KnowledgeGovernanceSafetyLevelV1
}

export interface EditGovernanceKnowledgeItemCommandV1 {
  contract: typeof EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  itemId: string
  patch: KnowledgeGovernanceEditPatchV1
}

export interface EditGovernanceKnowledgeItemResultV1 {
  contract: typeof EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  updated: boolean
}

export interface ArchiveGovernanceKnowledgeItemCommandV1 {
  contract: typeof ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  itemId: string
}

export interface ArchiveGovernanceKnowledgeItemResultV1 {
  contract: typeof ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  updated: true
}

export interface RestoreGovernanceKnowledgeItemCommandV1 {
  contract: typeof RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  itemId: string
}

export interface RestoreGovernanceKnowledgeItemResultV1 {
  contract: typeof RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  updated: true
}

export interface VerifyGovernanceKnowledgeItemCommandV1 {
  contract: typeof VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  itemId: string
  actorId: string
}

export interface VerifyGovernanceKnowledgeItemResultV1 {
  contract: typeof VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  updated: true
}

export interface UnverifyGovernanceKnowledgeItemCommandV1 {
  contract: typeof UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  itemId: string
}

export interface UnverifyGovernanceKnowledgeItemResultV1 {
  contract: typeof UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  updated: true
}

export interface SupersedeGovernanceKnowledgeItemCommandV1 {
  contract: typeof SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  oldItemId: string
  newItemId: string
}

export interface SupersedeGovernanceKnowledgeItemResultV1 {
  contract: typeof SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  updated: true
}

export interface ArchiveKnowledgeConflictMemberCommandV1 {
  contract: typeof ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1
  itemId: string
}

export interface ArchiveKnowledgeConflictMemberResultV1 {
  contract: typeof ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_RESULT_V1
  updated: true
}

export interface ClearKnowledgeConflictWinnerCommandV1 {
  contract: typeof CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1
  itemId: string
}

export interface ClearKnowledgeConflictWinnerResultV1 {
  contract: typeof CLEAR_KNOWLEDGE_CONFLICT_WINNER_RESULT_V1
  updated: true
}

export interface ClearKnowledgeConflictGroupCommandV1 {
  contract: typeof CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1
  conflictGroupId: string
}

export interface ClearKnowledgeConflictGroupResultV1 {
  contract: typeof CLEAR_KNOWLEDGE_CONFLICT_GROUP_RESULT_V1
  updated: true
}

export interface CreateManualGovernanceKnowledgeItemCommandV1 {
  contract: typeof CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1
  itemId: string
  sectionId: string
  title: string
  canonicalStatement: string
  tags: string[]
  safetyLevel: KnowledgeGovernanceSafetyLevelV1
  actorId: string
}

export interface CreateManualGovernanceKnowledgeItemResultV1 {
  contract: typeof CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1
  created: true
}

export interface MarkKnowledgeItemSourcesDisabledCommandV1 {
  contract: typeof MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1
  itemId: string
}

export interface MarkKnowledgeItemSourcesDisabledResultV1 {
  contract: typeof MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_RESULT_V1
  updated: true
}

export interface ArchiveKnowledgeItemAfterSourceDisableCommandV1 {
  contract: typeof ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1
  itemId: string
}

export interface ArchiveKnowledgeItemAfterSourceDisableResultV1 {
  contract: typeof ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_RESULT_V1
  updated: true
}

export interface ArchiveKnowledgeItemForCoreResetCommandV1 {
  contract: typeof ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1
  itemId: string
}

export interface ArchiveKnowledgeItemForCoreResetResultV1 {
  contract: typeof ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_RESULT_V1
  updated: true
}

export class KnowledgeGovernanceCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: KnowledgeGovernanceCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'KnowledgeGovernanceCommandValidationError'
    this.code = code
  }
}

const SAFETY_LEVELS = new Set<string>(KNOWLEDGE_GOVERNANCE_SAFETY_LEVELS_V1)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isTruthyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function invalid(message: string): never {
  throw new KnowledgeGovernanceCommandValidationError('INVALID_CONTRACT', message)
}

function parseEnvelope(
  input: unknown,
  expected: string,
  prefix: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) invalid('command must be an object')
  const unsupported = Object.keys(input).filter((field) => !allowedFields.includes(field))
  if (unsupported.length > 0) {
    invalid(`unsupported field(s): ${unsupported.sort().join(', ')}`)
  }
  if (input.contract !== expected) {
    if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
      throw new KnowledgeGovernanceCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${expected}`)
  }
  return input
}

function requireNonEmpty(value: Record<string, unknown>, field: string): void {
  if (!isNonEmptyString(value[field])) invalid(`${field} is required`)
}

function requireTruthyString(value: Record<string, unknown>, field: string): void {
  if (!isTruthyString(value[field])) invalid(`${field} is required`)
}

function requireString(value: Record<string, unknown>, field: string): void {
  if (typeof value[field] !== 'string') invalid(`${field} must be a string`)
}

function parseItemCommand(
  input: unknown,
  expected: string,
  prefix: string,
): Record<string, unknown> {
  const value = parseEnvelope(input, expected, prefix, ['contract', 'itemId'])
  requireString(value, 'itemId')
  return value
}

function parseTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === 'string')
}

function parseSafetyLevel(value: unknown): value is KnowledgeGovernanceSafetyLevelV1 {
  return typeof value === 'string' && SAFETY_LEVELS.has(value)
}

export function parseEditGovernanceKnowledgeItemCommandV1(
  input: unknown,
): EditGovernanceKnowledgeItemCommandV1 {
  const value = parseEnvelope(
    input,
    EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.EditGovernanceKnowledgeItemCommand.',
    ['contract', 'itemId', 'patch'],
  )
  requireString(value, 'itemId')
  if (!isRecord(value.patch)) invalid('patch must be an object')
  const unsupported = Object.keys(value.patch).filter(
    (field) => !['title', 'canonicalStatement', 'tags', 'safetyLevel'].includes(field),
  )
  if (unsupported.length > 0) invalid(`unsupported patch field(s): ${unsupported.sort().join(', ')}`)
  if (value.patch.title !== undefined && !isNonEmptyString(value.patch.title)) {
    invalid('patch.title must be a non-empty string')
  }
  if (
    value.patch.canonicalStatement !== undefined
    && !isNonEmptyString(value.patch.canonicalStatement)
  ) {
    invalid('patch.canonicalStatement must be a non-empty string')
  }
  if (value.patch.tags !== undefined && !parseTags(value.patch.tags)) {
    invalid('patch.tags must be a string array')
  }
  if (value.patch.safetyLevel !== undefined && !parseSafetyLevel(value.patch.safetyLevel)) {
    invalid('patch.safetyLevel is invalid')
  }
  return value as unknown as EditGovernanceKnowledgeItemCommandV1
}

export function parseArchiveGovernanceKnowledgeItemCommandV1(
  input: unknown,
): ArchiveGovernanceKnowledgeItemCommandV1 {
  return parseItemCommand(
    input,
    ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.ArchiveGovernanceKnowledgeItemCommand.',
  ) as unknown as ArchiveGovernanceKnowledgeItemCommandV1
}

export function parseRestoreGovernanceKnowledgeItemCommandV1(
  input: unknown,
): RestoreGovernanceKnowledgeItemCommandV1 {
  return parseItemCommand(
    input,
    RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.RestoreGovernanceKnowledgeItemCommand.',
  ) as unknown as RestoreGovernanceKnowledgeItemCommandV1
}

export function parseVerifyGovernanceKnowledgeItemCommandV1(
  input: unknown,
): VerifyGovernanceKnowledgeItemCommandV1 {
  const value = parseEnvelope(
    input,
    VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.VerifyGovernanceKnowledgeItemCommand.',
    ['contract', 'itemId', 'actorId'],
  )
  requireString(value, 'itemId')
  requireTruthyString(value, 'actorId')
  return value as unknown as VerifyGovernanceKnowledgeItemCommandV1
}

export function parseUnverifyGovernanceKnowledgeItemCommandV1(
  input: unknown,
): UnverifyGovernanceKnowledgeItemCommandV1 {
  return parseItemCommand(
    input,
    UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.UnverifyGovernanceKnowledgeItemCommand.',
  ) as unknown as UnverifyGovernanceKnowledgeItemCommandV1
}

export function parseSupersedeGovernanceKnowledgeItemCommandV1(
  input: unknown,
): SupersedeGovernanceKnowledgeItemCommandV1 {
  const value = parseEnvelope(
    input,
    SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.SupersedeGovernanceKnowledgeItemCommand.',
    ['contract', 'oldItemId', 'newItemId'],
  )
  requireString(value, 'oldItemId')
  requireString(value, 'newItemId')
  return value as unknown as SupersedeGovernanceKnowledgeItemCommandV1
}

export function parseArchiveKnowledgeConflictMemberCommandV1(
  input: unknown,
): ArchiveKnowledgeConflictMemberCommandV1 {
  return parseItemCommand(
    input,
    ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1,
    'ai_knowledge.ArchiveKnowledgeConflictMemberCommand.',
  ) as unknown as ArchiveKnowledgeConflictMemberCommandV1
}

export function parseClearKnowledgeConflictWinnerCommandV1(
  input: unknown,
): ClearKnowledgeConflictWinnerCommandV1 {
  return parseItemCommand(
    input,
    CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1,
    'ai_knowledge.ClearKnowledgeConflictWinnerCommand.',
  ) as unknown as ClearKnowledgeConflictWinnerCommandV1
}

export function parseClearKnowledgeConflictGroupCommandV1(
  input: unknown,
): ClearKnowledgeConflictGroupCommandV1 {
  const value = parseEnvelope(
    input,
    CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
    'ai_knowledge.ClearKnowledgeConflictGroupCommand.',
    ['contract', 'conflictGroupId'],
  )
  requireTruthyString(value, 'conflictGroupId')
  return value as unknown as ClearKnowledgeConflictGroupCommandV1
}

export function parseCreateManualGovernanceKnowledgeItemCommandV1(
  input: unknown,
): CreateManualGovernanceKnowledgeItemCommandV1 {
  const value = parseEnvelope(
    input,
    CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
    'ai_knowledge.CreateManualGovernanceKnowledgeItemCommand.',
    [
      'contract',
      'itemId',
      'sectionId',
      'title',
      'canonicalStatement',
      'tags',
      'safetyLevel',
      'actorId',
    ],
  )
  requireTruthyString(value, 'itemId')
  requireTruthyString(value, 'sectionId')
  requireNonEmpty(value, 'title')
  requireNonEmpty(value, 'canonicalStatement')
  requireTruthyString(value, 'actorId')
  if (!parseTags(value.tags)) invalid('tags must be a string array')
  if (!parseSafetyLevel(value.safetyLevel)) invalid('safetyLevel is invalid')
  return value as unknown as CreateManualGovernanceKnowledgeItemCommandV1
}

export function parseMarkKnowledgeItemSourcesDisabledCommandV1(
  input: unknown,
): MarkKnowledgeItemSourcesDisabledCommandV1 {
  return parseItemCommand(
    input,
    MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1,
    'ai_knowledge.MarkKnowledgeItemSourcesDisabledCommand.',
  ) as unknown as MarkKnowledgeItemSourcesDisabledCommandV1
}

export function parseArchiveKnowledgeItemAfterSourceDisableCommandV1(
  input: unknown,
): ArchiveKnowledgeItemAfterSourceDisableCommandV1 {
  return parseItemCommand(
    input,
    ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1,
    'ai_knowledge.ArchiveKnowledgeItemAfterSourceDisableCommand.',
  ) as unknown as ArchiveKnowledgeItemAfterSourceDisableCommandV1
}

export function parseArchiveKnowledgeItemForCoreResetCommandV1(
  input: unknown,
): ArchiveKnowledgeItemForCoreResetCommandV1 {
  return parseItemCommand(
    input,
    ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1,
    'ai_knowledge.ArchiveKnowledgeItemForCoreResetCommand.',
  ) as unknown as ArchiveKnowledgeItemForCoreResetCommandV1
}
