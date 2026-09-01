export const RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1 =
  'contacts.RecoverAutomatedContactMergeCommand.v1' as const
export const RECOVER_AUTOMATED_CONTACT_MERGE_RESULT_V1 =
  'contacts.RecoverAutomatedContactMergeResult.v1' as const

export interface RecoverAutomatedContactMergeCommandV1 {
  contract: typeof RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1
  mergeId: string
  requestedBy: string
  basis: string
}

export type RecoverAutomatedContactMergeResultV1 = {
  contract: typeof RECOVER_AUTOMATED_CONTACT_MERGE_RESULT_V1
  status: 'recovered' | 'manual_reconciliation'
  mergeId: string
  reason?: string
}

export class RecoverAutomatedContactMergeCommandValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoverAutomatedContactMergeCommandValidationError'
  }
}

export function parseRecoverAutomatedContactMergeCommandV1(
  input: unknown,
): RecoverAutomatedContactMergeCommandV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RecoverAutomatedContactMergeCommandValidationError('command must be an object')
  }
  const value = input as Record<string, unknown>
  const allowed = new Set(['contract', 'mergeId', 'requestedBy', 'basis'])
  const extra = Object.keys(value).filter(key => !allowed.has(key))
  if (extra.length > 0) {
    throw new RecoverAutomatedContactMergeCommandValidationError(
      `unsupported field(s): ${extra.sort().join(', ')}`,
    )
  }
  if (value.contract !== RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1) {
    throw new RecoverAutomatedContactMergeCommandValidationError(
      `contract must equal ${RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1}`,
    )
  }
  for (const field of ['mergeId', 'requestedBy', 'basis'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new RecoverAutomatedContactMergeCommandValidationError(`${field} is required`)
    }
  }
  return value as unknown as RecoverAutomatedContactMergeCommandV1
}
