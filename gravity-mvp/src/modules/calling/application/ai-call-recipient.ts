import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
    type GetPreferredActiveContactPhoneQueryV1,
    type GetPreferredActiveContactPhoneResultV1,
} from '@/contracts/contacts/v1'
import { getPreferredActiveContactPhoneV1 } from '@/modules/contacts/public/v1'

export interface AiCallContactRecipientInput {
    contactId: unknown
    driverId?: unknown
    phoneNumber?: unknown
}

export type AiCallContactRecipientResolution =
    | {
        status: 'resolved'
        contactId: string
        phone: string
    }
    | {
        status: 'invalid_input'
        reason: 'invalid_contact_id' | 'ambiguous_contact_recipient'
    }
    | {
        status: 'unreachable'
        reason: 'contact_not_found_or_no_callable_phone'
    }

type GetPreferredActiveContactPhone = (
    query: GetPreferredActiveContactPhoneQueryV1,
) => Promise<GetPreferredActiveContactPhoneResultV1>

function hasRecipientValue(value: unknown): boolean {
    if (value === null || value === undefined) return false
    return typeof value !== 'string' || value.trim() !== ''
}

/**
 * Resolve the Contact branch of a single-recipient AI call through the
 * Contacts-owned preferred-active-phone query. Calling deliberately does not
 * inspect Contact/ContactPhone storage or reproduce phone-selection rules.
 */
export function createAiCallContactRecipientResolver(
    getPreferredActiveContactPhone: GetPreferredActiveContactPhone,
) {
    return async function resolveAiCallContactRecipient(
        input: AiCallContactRecipientInput,
    ): Promise<AiCallContactRecipientResolution> {
        if (typeof input.contactId !== 'string' || input.contactId.trim() === '') {
            return { status: 'invalid_input', reason: 'invalid_contact_id' }
        }
        if (hasRecipientValue(input.driverId) || hasRecipientValue(input.phoneNumber)) {
            return { status: 'invalid_input', reason: 'ambiguous_contact_recipient' }
        }

        const contactId = input.contactId
        const result = await getPreferredActiveContactPhone({
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
            contactId,
            phoneId: null,
        })
        if (typeof result.phone !== 'string' || result.phone.trim() === '') {
            return {
                status: 'unreachable',
                reason: 'contact_not_found_or_no_callable_phone',
            }
        }

        return { status: 'resolved', contactId, phone: result.phone }
    }
}

export const resolveAiCallContactRecipient = createAiCallContactRecipientResolver(
    getPreferredActiveContactPhoneV1,
)
