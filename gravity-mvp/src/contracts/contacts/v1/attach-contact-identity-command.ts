export const ATTACH_CONTACT_IDENTITY_COMMAND_V1 = 'contacts.AttachContactIdentityCommand.v1' as const
export const ATTACH_CONTACT_IDENTITY_RESULT_V1 = 'contacts.AttachContactIdentityResult.v1' as const
export const REPLACE_IDENTITY_PROFILE_V1 = 'replace_identity_profile' as const

export interface AttachContactIdentityCommandV1 {
    contract: typeof ATTACH_CONTACT_IDENTITY_COMMAND_V1
    operation: typeof REPLACE_IDENTITY_PROFILE_V1
    identityId: string
    profile: {
        handle: string | null
        givenName: string | null
        familyName: string | null
    }
}

export interface AttachContactIdentityResultV1 {
    contract: typeof ATTACH_CONTACT_IDENTITY_RESULT_V1
    identityId: string
}

export class AttachContactIdentityContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: AttachContactIdentityContractValidationError['code'], message: string) {
        super(message)
        this.name = 'AttachContactIdentityContractValidationError'
        this.code = code
    }
}

const COMMAND_FIELDS = new Set(['contract', 'operation', 'identityId', 'profile'])
const PROFILE_FIELDS = new Set(['handle', 'givenName', 'familyName'])
const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)
function invalid(message: string): never {
    throw new AttachContactIdentityContractValidationError('INVALID_CONTRACT', message)
}
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

export function parseAttachContactIdentityCommandV1(input: unknown): AttachContactIdentityCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== ATTACH_CONTACT_IDENTITY_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('contacts.AttachContactIdentityCommand.')) {
            throw new AttachContactIdentityContractValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${ATTACH_CONTACT_IDENTITY_COMMAND_V1}`)
    }
    if (input.operation !== REPLACE_IDENTITY_PROFILE_V1) invalid('operation is invalid')
    if (typeof input.identityId !== 'string' || input.identityId.trim() === '') invalid('identityId is required')
    if (!isRecord(input.profile)) invalid('profile must be an object')
    const unexpectedProfile = Object.keys(input.profile).filter((key) => !PROFILE_FIELDS.has(key))
    if (unexpectedProfile.length > 0) invalid(`unsupported profile field(s): ${unexpectedProfile.sort().join(', ')}`)
    if (![input.profile.handle, input.profile.givenName, input.profile.familyName].every(isNullableString)) {
        invalid('profile fields must be strings or null')
    }
    return input as unknown as AttachContactIdentityCommandV1
}
