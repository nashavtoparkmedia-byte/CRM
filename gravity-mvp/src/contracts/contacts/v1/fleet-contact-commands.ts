export const PATCH_FLEET_CONTACT_COMMAND_V1 = 'contacts.PatchFleetContactCommand.v1' as const
export const PATCH_FLEET_CONTACT_RESULT_V1 = 'contacts.PatchFleetContactResult.v1' as const
export const CREATE_FLEET_CONTACT_COMMAND_V1 = 'contacts.CreateFleetContactCommand.v1' as const
export const CREATE_FLEET_CONTACT_RESULT_V1 = 'contacts.CreateFleetContactResult.v1' as const

export interface FleetContactPatchV1 {
    displayName?: string
    displayNameSource?: 'yandex'
    masterSource?: 'yandex'
    yandexDriverId?: string
    primaryPhoneId?: string
}

export interface PatchFleetContactCommandV1 {
    contract: typeof PATCH_FLEET_CONTACT_COMMAND_V1
    contactId: string
    patch: FleetContactPatchV1
}
export interface PatchFleetContactResultV1 { contract: typeof PATCH_FLEET_CONTACT_RESULT_V1 }
export interface CreateFleetContactCommandV1 {
    contract: typeof CREATE_FLEET_CONTACT_COMMAND_V1
    displayName: string
    displayNameSource: 'yandex'
    masterSource: 'yandex'
    yandexDriverId: string
}
export interface CreateFleetContactResultV1 {
    contract: typeof CREATE_FLEET_CONTACT_RESULT_V1
    contact: { id: string; primaryPhoneId: string | null }
}

export class FleetContactCommandValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: FleetContactCommandValidationError['code'], message: string) {
        super(message)
        this.name = 'FleetContactCommandValidationError'
        this.code = code
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never { throw new FleetContactCommandValidationError('INVALID_CONTRACT', message) }
function nonEmpty(value: unknown, field: string) { if (typeof value !== 'string' || value.trim() === '') invalid(`${field} is required`) }
function envelope(input: unknown, expected: string, prefix: string, fields: string[]) {
    if (!isRecord(input)) invalid('command must be an object')
    const extra = Object.keys(input).filter(key => !fields.includes(key))
    if (extra.length) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new FleetContactCommandValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

export function parsePatchFleetContactCommandV1(input: unknown): PatchFleetContactCommandV1 {
    const value = envelope(input, PATCH_FLEET_CONTACT_COMMAND_V1, 'contacts.PatchFleetContactCommand.', ['contract', 'contactId', 'patch'])
    nonEmpty(value.contactId, 'contactId')
    if (!isRecord(value.patch)) invalid('patch must be an object')
    const fields = ['displayName', 'displayNameSource', 'masterSource', 'yandexDriverId', 'primaryPhoneId']
    const extra = Object.keys(value.patch).filter(key => !fields.includes(key))
    if (extra.length) invalid(`unsupported patch field(s): ${extra.sort().join(', ')}`)
    for (const field of ['displayName', 'yandexDriverId', 'primaryPhoneId']) {
        if (value.patch[field] !== undefined) nonEmpty(value.patch[field], `patch.${field}`)
    }
    if (value.patch.displayNameSource !== undefined && value.patch.displayNameSource !== 'yandex') invalid('patch.displayNameSource is invalid')
    if (value.patch.masterSource !== undefined && value.patch.masterSource !== 'yandex') invalid('patch.masterSource is invalid')
    return value as unknown as PatchFleetContactCommandV1
}

export function parseCreateFleetContactCommandV1(input: unknown): CreateFleetContactCommandV1 {
    const value = envelope(input, CREATE_FLEET_CONTACT_COMMAND_V1, 'contacts.CreateFleetContactCommand.', ['contract', 'displayName', 'displayNameSource', 'masterSource', 'yandexDriverId'])
    nonEmpty(value.displayName, 'displayName')
    nonEmpty(value.yandexDriverId, 'yandexDriverId')
    if (value.displayNameSource !== 'yandex') invalid('displayNameSource is invalid')
    if (value.masterSource !== 'yandex') invalid('masterSource is invalid')
    return value as unknown as CreateFleetContactCommandV1
}
