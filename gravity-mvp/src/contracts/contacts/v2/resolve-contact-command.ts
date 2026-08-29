export const RESOLVE_CONTACT_COMMAND_V2 = 'contacts.ResolveContactCommand.v2' as const
export const RESOLVE_CONTACT_RESULT_V2 = 'contacts.ResolveContactResult.v2' as const
export const PROMOTE_CHANNEL_DISPLAY_NAME_V2 = 'promote_channel_display_name' as const

export type ResolveContactStatusV2 = 'updated' | 'not_found' | 'preserved'

export interface ResolveContactCommandV2 {
    contract: typeof RESOLVE_CONTACT_COMMAND_V2
    operation: typeof PROMOTE_CHANNEL_DISPLAY_NAME_V2
    contactId: string
    candidateDisplayName: string
}

export interface ResolveContactResultV2 {
    contract: typeof RESOLVE_CONTACT_RESULT_V2
    status: ResolveContactStatusV2
}

export class ResolveContactV2ValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: ResolveContactV2ValidationError['code'], message: string) {
        super(message)
        this.name = 'ResolveContactV2ValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'operation', 'contactId', 'candidateDisplayName'])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never { throw new ResolveContactV2ValidationError('INVALID_CONTRACT', message) }

export function parseResolveContactCommandV2(input: unknown): ResolveContactCommandV2 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== RESOLVE_CONTACT_COMMAND_V2) {
        if (typeof input.contract === 'string' && input.contract.startsWith('contacts.ResolveContactCommand.')) {
            throw new ResolveContactV2ValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${RESOLVE_CONTACT_COMMAND_V2}`)
    }
    if (input.operation !== PROMOTE_CHANNEL_DISPLAY_NAME_V2) invalid('operation is invalid')
    if (typeof input.contactId !== 'string' || input.contactId.trim() === '') invalid('contactId is required')
    if (typeof input.candidateDisplayName !== 'string' || input.candidateDisplayName.trim() === '') invalid('candidateDisplayName is required')
    return input as unknown as ResolveContactCommandV2
}
