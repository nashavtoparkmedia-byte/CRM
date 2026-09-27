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

export interface PreparedContactConversationIdentityV1 extends ContactConversationIdentityV1 {
    providerAccountId: string | null
    /** Exact provider aliases admitted by Contacts for the same account scope. */
    providerAliasValues?: string[]
}

export interface ResolveChannelContactResultV1 {
    contract: typeof RESOLVE_CHANNEL_CONTACT_RESULT_V1
    contact: ContactConversationContactV1
    identity: ContactConversationIdentityV1
    isNew: boolean
}

/**
 * What the caller is about to do with the prepared identity.
 *
 * `open_conversation` is first contact: nothing proves the peer is reachable,
 * so provider-confirmed reachability is required before a conversation is
 * created. `send_in_bound_conversation` is a reply inside a conversation that
 * already exists and is already bound to this identity; the conversation's own
 * history is the proof, and demanding a separate reachability confirmation
 * there would reject ordinary replies on long-running threads.
 */
export type ContactConversationPurposeV1 = 'open_conversation' | 'send_in_bound_conversation'

export interface PrepareContactConversationIdentityCommandV1 {
    contract: typeof PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1
    contactId: string
    channel: ContactConversationChannelV1
    identityId: string | null
    phoneId: string | null
    /**
     * Optional EXACT outbound selector: address the identity by the provider
     * identifier it carries instead of by its internal `identityId`.
     *
     * It exists for a caller that knows the peer only as a provider id and must
     * not learn Contacts-owned row ids to send. A conversation can legitimately
     * be linked to one identity while the peer speaking in it is a different
     * identity of the same Contact, so `identityId` alone cannot name that peer.
     *
     * It changes only HOW the exact identity is addressed. Every gate this
     * command already applies — same-Contact ownership, active, conflict,
     * reachability by `purpose` — is applied to the identity it selects, and it
     * adds no sendability policy of its own. Because `(channel, externalId)` is
     * globally unique it selects at most one row and never falls back to another
     * identity of the Contact.
     *
     * It is an exact selector, so it cannot be combined with the other selector
     * axes: supplying it together with `identityId` or `phoneId` is rejected as
     * ambiguous input rather than silently given a precedence.
     */
    identityExternalId?: string | null
    purpose: ContactConversationPurposeV1
}

export type PrepareContactConversationIdentityStatusV1 =
    | 'ready'
    | 'contact_not_found'
    | 'identity_not_found'
    | 'identity_ambiguous'
    | 'identity_conflicted'
    | 'identity_unreachable'
    | 'identity_reachability_unknown'
    | 'phone_not_found'
    | 'no_identity'

export type PrepareContactConversationIdentityResultV1 =
    | {
        contract: typeof PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1
        status: 'ready'
        contact: ContactConversationContactV1
        identity: PreparedContactConversationIdentityV1
    }
    | {
        contract: typeof PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1
        status:
            | 'contact_not_found'
            | 'identity_not_found'
            | 'identity_ambiguous'
            | 'identity_conflicted'
            | 'identity_unreachable'
            | 'identity_reachability_unknown'
            | 'phone_not_found'
            | 'no_identity'
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

export function parseEnvelope(
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

export function requireNonEmptyString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') invalid(`${field} is required`)
}

export function requireChannel(value: unknown): asserts value is ContactConversationChannelV1 {
    if (typeof value !== 'string' || !CHANNELS.has(value as ContactConversationChannelV1)) {
        invalid('channel is invalid')
    }
}

function requireNullableNonEmptyString(value: unknown, field: string): asserts value is string | null {
    if (value !== null) requireNonEmptyString(value, field)
}

export function requireLegacyIdentifier(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) invalid(`${field} is required`)
}

function requireNullableLegacyIdentifier(value: unknown, field: string): asserts value is string | null {
    if (value !== null) requireLegacyIdentifier(value, field)
}

/**
 * An optional field: absent and explicitly null both mean "not selected", and any
 * present value must be an exact trimmed provider identifier. Whitespace padding is
 * refused rather than trimmed, because the stored identifier is compared byte for byte.
 */
function requireAbsentOrExactString(
    value: unknown,
    field: string,
): asserts value is string | null | undefined {
    if (value === null || value === undefined) return
    requireNonEmptyString(value, field)
    // An identifier that needs trimming is not exact. Refusing it here is louder and
    // earlier than letting a padded value become an ordinary lookup miss, which reads
    // as "this Contact has no such identity" and hides a caller bug.
    if (value !== value.trim()) invalid(`${field} must be exact and unpadded`)
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
        ['contract', 'contactId', 'channel', 'identityId', 'identityExternalId', 'phoneId', 'purpose'],
    )
    requireLegacyIdentifier(value.contactId, 'contactId')
    requireChannel(value.channel)
    requireNullableLegacyIdentifier(value.identityId, 'identityId')
    requireNullableLegacyIdentifier(value.phoneId, 'phoneId')
    requireAbsentOrExactString(value.identityExternalId, 'identityExternalId')
    // Exactly one exact selector, or none. Two selectors would need a precedence
    // rule, and a precedence rule is how a caller ends up authorizing a send for
    // an identity it did not name.
    if (
        value.identityExternalId !== null
        && value.identityExternalId !== undefined
        && (value.identityId !== null || value.phoneId !== null)
    ) {
        invalid('identityExternalId cannot be combined with identityId or phoneId')
    }
    if (value.purpose !== 'open_conversation' && value.purpose !== 'send_in_bound_conversation') {
        throw new Error('contacts.PrepareContactConversationIdentityCommand.purpose must be exact')
    }
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
