export const RESOLVE_CONTACT_COMMAND_V1 = 'contacts.ResolveContactCommand.v1' as const
export const RESOLVE_CONTACT_RESULT_V1 = 'contacts.ResolveContactResult.v1' as const
export const PROMOTE_PLACEHOLDER_DISPLAY_NAME_V1 = 'promote_placeholder_display_name' as const

export type ResolveContactStatusV1 = 'updated' | 'not_found' | 'preserved'

export interface ResolveContactCommandV1 {
    contract: typeof RESOLVE_CONTACT_COMMAND_V1
    operation: typeof PROMOTE_PLACEHOLDER_DISPLAY_NAME_V1
    contactId: string
    candidateDisplayName: string
}

export interface ResolveContactResultV1 {
    contract: typeof RESOLVE_CONTACT_RESULT_V1
    status: ResolveContactStatusV1
}

export class ResolveContactContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ResolveContactContractValidationError['code'], message: string) {
        super(message)
        this.name = 'ResolveContactContractValidationError'
        this.code = code
    }
}

const COMMAND_FIELDS = new Set(['contract', 'operation', 'contactId', 'candidateDisplayName'])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
    throw new ResolveContactContractValidationError('INVALID_CONTRACT', message)
}

export function parseResolveContactCommandV1(input: unknown): ResolveContactCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)

    if (input.contract !== RESOLVE_CONTACT_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('contacts.ResolveContactCommand.')) {
            throw new ResolveContactContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${RESOLVE_CONTACT_COMMAND_V1}`)
    }
    if (input.operation !== PROMOTE_PLACEHOLDER_DISPLAY_NAME_V1) invalid('operation is invalid')
    if (typeof input.contactId !== 'string' || input.contactId.trim() === '') invalid('contactId is required')
    if (typeof input.candidateDisplayName !== 'string' || input.candidateDisplayName.trim() === '') {
        invalid('candidateDisplayName is required')
    }

    return input as unknown as ResolveContactCommandV1
}
