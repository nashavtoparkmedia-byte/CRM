export const SET_CONTACT_DISPLAY_NAME_COMMAND_V1 = 'contacts.SetContactDisplayNameCommand.v1' as const
export const SET_CONTACT_DISPLAY_NAME_RESULT_V1 = 'contacts.SetContactDisplayNameResult.v1' as const
export type SetContactDisplayNameStatusV1 = 'updated' | 'not_found'

export interface SetContactDisplayNameCommandV1 {
    contract: typeof SET_CONTACT_DISPLAY_NAME_COMMAND_V1
    contactId: string
    displayName: string
}

export interface SetContactDisplayNameResultV1 {
    contract: typeof SET_CONTACT_DISPLAY_NAME_RESULT_V1
    status: SetContactDisplayNameStatusV1
}

export class SetContactDisplayNameValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: SetContactDisplayNameValidationError['code'], message: string) {
        super(message)
        this.name = 'SetContactDisplayNameValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'contactId', 'displayName'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new SetContactDisplayNameValidationError('INVALID_CONTRACT', message)
}

export function parseSetContactDisplayNameCommandV1(input: unknown): SetContactDisplayNameCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== SET_CONTACT_DISPLAY_NAME_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('contacts.SetContactDisplayNameCommand.')) {
            throw new SetContactDisplayNameValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${SET_CONTACT_DISPLAY_NAME_COMMAND_V1}`)
    }
    if (typeof input.contactId !== 'string' || input.contactId.trim() === '') invalid('contactId is required')
    if (typeof input.displayName !== 'string' || input.displayName.trim() === '') invalid('displayName is required')
    return input as unknown as SetContactDisplayNameCommandV1
}
