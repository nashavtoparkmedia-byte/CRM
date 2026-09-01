export const CLEANUP_GROUP_CONTACT_IDENTITIES_COMMAND_V1 = 'contacts.CleanupGroupContactIdentitiesCommand.v1' as const
export const CLEANUP_GROUP_CONTACT_IDENTITIES_RESULT_V1 = 'contacts.CleanupGroupContactIdentitiesResult.v1' as const

export interface CleanupGroupContactIdentitiesCommandV1 {
  contract: typeof CLEANUP_GROUP_CONTACT_IDENTITIES_COMMAND_V1
  operationId: string
  intent: 'preview' | 'apply'
  prospectiveIdentityIds: string[]
  detachedConversationIds: string[]
  afterId: string | null
  limit: number
  expectedCandidateDigest: string | null
}

export interface CleanupGroupContactIdentitiesResultV1 {
  contract: typeof CLEANUP_GROUP_CONTACT_IDENTITIES_RESULT_V1
  operationId: string
  intent: 'preview' | 'apply'
  candidateDigest: string
  candidateIds: string[]
  deletedIds: string[]
  nextAfterId: string | null
  hasMore: boolean
}

export class GroupContactIdentityCleanupValidationError extends Error {
  readonly code = 'INVALID_CONTRACT'
}

function invalid(message: string): never {
  throw new GroupContactIdentityCleanupValidationError(message)
}

export function parseCleanupGroupContactIdentitiesCommandV1(input: unknown): CleanupGroupContactIdentitiesCommandV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('command must be an object')
  const value = input as Record<string, unknown>
  const fields = ['contract', 'operationId', 'intent', 'prospectiveIdentityIds', 'detachedConversationIds', 'afterId', 'limit', 'expectedCandidateDigest']
  const extra = Object.keys(value).filter(key => !fields.includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (value.contract !== CLEANUP_GROUP_CONTACT_IDENTITIES_COMMAND_V1) invalid(`contract must equal ${CLEANUP_GROUP_CONTACT_IDENTITIES_COMMAND_V1}`)
  if (typeof value.operationId !== 'string' || value.operationId.trim() === '') invalid('operationId is required')
  if (!['preview', 'apply'].includes(String(value.intent))) invalid('intent must be preview or apply')
  for (const field of ['prospectiveIdentityIds', 'detachedConversationIds'] as const) {
    const ids = value[field]
    if (!Array.isArray(ids) || ids.length > 64 || ids.some(id => typeof id !== 'string' || id.trim() === '') || new Set(ids).size !== ids.length) invalid(`${field} must be a unique string array with at most 64 values`)
  }
  if (value.afterId !== null && (typeof value.afterId !== 'string' || value.afterId.trim() === '')) invalid('afterId must be null or a non-empty string')
  if (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 64) invalid('limit must be an integer between 1 and 64')
  if ((value.prospectiveIdentityIds as string[]).length > Number(value.limit)) invalid('prospectiveIdentityIds cannot exceed limit')
  if (value.intent === 'apply') {
    if (typeof value.expectedCandidateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedCandidateDigest)) invalid('apply requires expectedCandidateDigest')
  } else if (value.expectedCandidateDigest !== null) invalid('preview expectedCandidateDigest must be null')
  return value as unknown as CleanupGroupContactIdentitiesCommandV1
}
