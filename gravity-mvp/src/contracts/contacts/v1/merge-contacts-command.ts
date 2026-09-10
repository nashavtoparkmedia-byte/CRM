export const MERGE_CONTACTS_COMMAND_V1 = 'contacts.MergeContactsCommand.v1' as const
export const MERGE_CONTACTS_RESULT_V1 = 'contacts.MergeContactsResult.v1' as const

export type MergeContactsCommandV1 =
  | {
      contract: typeof MERGE_CONTACTS_COMMAND_V1
      operation: 'contact_to_driver'
      contactId: string
      driverId: string
      mergedBy: string
    }
  | {
      contract: typeof MERGE_CONTACTS_COMMAND_V1
      operation: 'contact_to_contact'
      sourceId: string
      targetId: string
      mergedBy: string
      automation?: {
        trustedUniqueCurrentPhone: boolean
        phoneEvidenceRoot: string | null
        confirmedPersonEvidenceRoots: string[]
        normalizedVuEvidenceRoots: string[]
      }
    }

export type MergeContactsResultV1 =
  | {
      contract: typeof MERGE_CONTACTS_RESULT_V1
      status: 'already_linked'
      contactId: string
      driverId: string
    }
  | {
      contract: typeof MERGE_CONTACTS_RESULT_V1
      status: 'linked'
      contactId: string
      driverId: string
    }
  | {
      contract: typeof MERGE_CONTACTS_RESULT_V1
      status: 'merged'
      survivorId: string
      mergedId: string
      driverId: string
      mergeRecordId: string
    }
  | {
      contract: typeof MERGE_CONTACTS_RESULT_V1
      status: 'already_merged'
      sourceId: string
      targetId: string
    }
  | {
      contract: typeof MERGE_CONTACTS_RESULT_V1
      status: 'contact_merged'
      survivorId: string
      mergedId: string
      mergeRecordId: string
    }
  | {
      contract: typeof MERGE_CONTACTS_RESULT_V1
      status: 'automatic_merge_blocked'
      leftContactId: string
      rightContactId: string
      reason: string
    }

export class MergeContactsCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: MergeContactsCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'MergeContactsCommandValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new MergeContactsCommandValidationError('INVALID_CONTRACT', message)
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    invalid(`${field} must be a string`)
  }
}

export function parseMergeContactsCommandV1(input: unknown): MergeContactsCommandV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('command must be an object')
  }

  const value = input as Record<string, unknown>
  if (value.contract !== MERGE_CONTACTS_COMMAND_V1) {
    if (typeof value.contract === 'string' && value.contract.startsWith('contacts.MergeContactsCommand.')) {
      throw new MergeContactsCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${value.contract}`,
      )
    }
    invalid(`contract must equal ${MERGE_CONTACTS_COMMAND_V1}`)
  }

  if (value.operation === 'contact_to_driver') {
    const supported = ['contract', 'operation', 'contactId', 'driverId', 'mergedBy']
    const extra = Object.keys(value).filter((key) => !supported.includes(key))
    if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    requireString(value.contactId, 'contactId')
    requireString(value.driverId, 'driverId')
    requireString(value.mergedBy, 'mergedBy')
    return value as unknown as MergeContactsCommandV1
  }

  if (value.operation === 'contact_to_contact') {
    const supported = ['contract', 'operation', 'sourceId', 'targetId', 'mergedBy', 'automation']
    const extra = Object.keys(value).filter((key) => !supported.includes(key))
    if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    requireString(value.sourceId, 'sourceId')
    requireString(value.targetId, 'targetId')
    requireString(value.mergedBy, 'mergedBy')
    if (value.automation !== undefined) {
      if (!value.automation || typeof value.automation !== 'object' || Array.isArray(value.automation)) {
        invalid('automation must be an object')
      }
      const automation = value.automation as Record<string, unknown>
      const supportedAutomation = [
        'trustedUniqueCurrentPhone',
        'phoneEvidenceRoot',
        'confirmedPersonEvidenceRoots',
        'normalizedVuEvidenceRoots',
      ]
      const automationExtra = Object.keys(automation).filter(key => !supportedAutomation.includes(key))
      if (automationExtra.length > 0) invalid(`unsupported automation field(s): ${automationExtra.sort().join(', ')}`)
      if (typeof automation.trustedUniqueCurrentPhone !== 'boolean') {
        invalid('automation.trustedUniqueCurrentPhone must be a boolean')
      }
      if (automation.phoneEvidenceRoot !== null
        && (typeof automation.phoneEvidenceRoot !== 'string' || !automation.phoneEvidenceRoot.trim())) {
        invalid('automation.phoneEvidenceRoot must be null or a non-empty string')
      }
      for (const field of ['confirmedPersonEvidenceRoots', 'normalizedVuEvidenceRoots'] as const) {
        if (!Array.isArray(automation[field])
          || automation[field].some(root => typeof root !== 'string' || !root.trim())) {
          invalid(`automation.${field} must be a string array`)
        }
      }
    }
    return value as unknown as MergeContactsCommandV1
  }

  invalid('operation must equal contact_to_driver or contact_to_contact')
}
