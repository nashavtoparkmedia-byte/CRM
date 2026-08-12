export const RESOLVE_CHANNEL_CONTACT_COMMAND_V1 = 'contacts.ResolveChannelContactCommand.v1' as const
export const RESOLVE_CHANNEL_CONTACT_RESULT_V1 = 'contacts.ResolveChannelContactResult.v1' as const
export const PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1 =
    'contacts.PrepareContactConversationIdentityCommand.v1' as const
export const PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1 =
    'contacts.PrepareContactConversationIdentityResult.v1' as const
export const GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1 =
    'contacts.GetPreferredActiveContactPhoneQuery.v1' as const
export const GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1 =
    'contacts.GetPreferredActiveContactPhoneResult.v1' as const

export type ContactConversationChannelV1 = 'telegram' | 'whatsapp' | 'max'

export interface ResolveChannelContactCommandV1 {
    contract: typeof RESOLVE_CHANNEL_CONTACT_COMMAND_V1
    channel: ContactConversationChannelV1
    externalId: string
    phone: string | null
    displayName: string | null
}

export interface ContactConversationContactV1 {
    id: string
    displayName: string
}

export interface ContactConversationIdentityV1 {
    id: string
    channel: ContactConversationChannelV1
    externalId: string
}

export interface ResolveChannelContactResultV1 {
    contract: typeof RESOLVE_CHANNEL_CONTACT_RESULT_V1
    contact: ContactConversationContactV1
    identity: ContactConversationIdentityV1
    isNew: boolean
}

export interface PrepareContactConversationIdentityCommandV1 {
    contract: typeof PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1
    contactId: string
    channel: ContactConversationChannelV1
    identityId: string | null
    phoneId: string | null
}

export type PrepareContactConversationIdentityStatusV1 =
    | 'ready'
    | 'contact_not_found'
    | 'identity_not_found'
    | 'phone_not_found'
    | 'no_identity'

export type PrepareContactConversationIdentityResultV1 =
    | {
        contract: typeof PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1
        status: 'ready'
        contact: ContactConversationContactV1
        identity: ContactConversationIdentityV1
    }
    | {
        contract: typeof PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1
        status: 'contact_not_found' | 'identity_not_found' | 'phone_not_found' | 'no_identity'
    }

export interface GetPreferredActiveContactPhoneQueryV1 {
    contract: typeof GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1
    contactId: string
    phoneId: string | null
}

export interface GetPreferredActiveContactPhoneResultV1 {
    contract: typeof GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1
    phone: string | null
}

export class ContactConversationContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ContactConversationContractValidationError['code'], message: string) {
        super(message)
        this.name = 'ContactConversationContractValidationError'
        this.code = code
    }
}

const CHANNELS = new Set<ContactConversationChannelV1>(['telegram', 'whatsapp', 'max'])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
    throw new ContactConversationContractValidationError('INVALID_CONTRACT', message)
}

function parseEnvelope(
    input: unknown,
    expectedContract: string,
    contractPrefix: string,
    fields: readonly string[],
): Record<string, unknown> {
    if (!isRecord(input)) invalid('command must be an object')

    const unexpected = Object.keys(input).filter((key) => !fields.includes(key))
    if (unexpected.length > 0) invalid(`unsupported field(s): ${unexpected.sort().join(', ')}`)

    if (input.contract !== expectedContract) {
        if (typeof input.contract === 'string' && input.contract.startsWith(contractPrefix)) {
            throw new ContactConversationContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${expectedContract}`)
    }

    return input
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') invalid(`${field} is required`)
}

function requireChannel(value: unknown): asserts value is ContactConversationChannelV1 {
    if (typeof value !== 'string' || !CHANNELS.has(value as ContactConversationChannelV1)) {
        invalid('channel is invalid')
    }
}

function requireNullableNonEmptyString(value: unknown, field: string): asserts value is string | null {
    if (value !== null) requireNonEmptyString(value, field)
}

function requireLegacyIdentifier(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) invalid(`${field} is required`)
}

function requireNullableLegacyIdentifier(value: unknown, field: string): asserts value is string | null {
    if (value !== null) requireLegacyIdentifier(value, field)
}

export function parseResolveChannelContactCommandV1(input: unknown): ResolveChannelContactCommandV1 {
    const value = parseEnvelope(
        input,
        RESOLVE_CHANNEL_CONTACT_COMMAND_V1,
        'contacts.ResolveChannelContactCommand.',
        ['contract', 'channel', 'externalId', 'phone', 'displayName'],
    )
    requireChannel(value.channel)
    requireNonEmptyString(value.externalId, 'externalId')
    requireNullableNonEmptyString(value.phone, 'phone')
    requireNullableNonEmptyString(value.displayName, 'displayName')
    return value as unknown as ResolveChannelContactCommandV1
}

export function parsePrepareContactConversationIdentityCommandV1(
    input: unknown,
): PrepareContactConversationIdentityCommandV1 {
    const value = parseEnvelope(
        input,
        PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
        'contacts.PrepareContactConversationIdentityCommand.',
        ['contract', 'contactId', 'channel', 'identityId', 'phoneId'],
    )
    requireLegacyIdentifier(value.contactId, 'contactId')
    requireChannel(value.channel)
    requireNullableLegacyIdentifier(value.identityId, 'identityId')
    requireNullableLegacyIdentifier(value.phoneId, 'phoneId')
    return value as unknown as PrepareContactConversationIdentityCommandV1
}

export function parseGetPreferredActiveContactPhoneQueryV1(
    input: unknown,
): GetPreferredActiveContactPhoneQueryV1 {
    const value = parseEnvelope(
        input,
        GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
        'contacts.GetPreferredActiveContactPhoneQuery.',
        ['contract', 'contactId', 'phoneId'],
    )
    requireNonEmptyString(value.contactId, 'contactId')
    requireNullableLegacyIdentifier(value.phoneId, 'phoneId')
    return value as unknown as GetPreferredActiveContactPhoneQueryV1
}
