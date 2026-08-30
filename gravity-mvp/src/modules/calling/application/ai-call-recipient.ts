import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
    type GetPreferredActiveContactPhoneQueryV1,
    type GetPreferredActiveContactPhoneResultV1,
} from '@/contracts/contacts/v1'
import { getPreferredActiveContactPhoneV1 } from '@/modules/contacts/public/v1'
import {
    GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
    type GetDriverCallablePhoneQueryV1,
    type GetDriverCallablePhoneResultV1,
} from '@/contracts/fleet-operations/v1'
import { getDriverCallablePhoneV1 } from '@/modules/fleet-operations/public/v1'

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

export interface AiCallDriverRecipientInput {
    driverId: unknown
    contactId?: unknown
    phoneNumber?: unknown
}

export type AiCallDriverRecipientResolution =
    | {
        status: 'resolved'
        driverId: string
        phone: string
    }
    | {
        status: 'invalid_input'
        reason: 'invalid_driver_id' | 'ambiguous_driver_recipient'
    }
    | {
        status: 'unreachable'
        reason: 'driver_not_found' | 'driver_has_no_callable_phone'
    }

type GetDriverCallablePhone = (
    query: GetDriverCallablePhoneQueryV1,
) => Promise<GetDriverCallablePhoneResultV1>

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

/**
 * Resolve the Driver branch through Fleet's narrow public view. Calling owns
 * neither Driver persistence nor the choice of which stored phone is callable.
 */
export function createAiCallDriverRecipientResolver(
    getDriverCallablePhone: GetDriverCallablePhone,
) {
    return async function resolveAiCallDriverRecipient(
        input: AiCallDriverRecipientInput,
    ): Promise<AiCallDriverRecipientResolution> {
        if (typeof input.driverId !== 'string' || input.driverId.trim() === '') {
            return { status: 'invalid_input', reason: 'invalid_driver_id' }
        }
        if (hasRecipientValue(input.contactId) || hasRecipientValue(input.phoneNumber)) {
            return { status: 'invalid_input', reason: 'ambiguous_driver_recipient' }
        }

        const result = await getDriverCallablePhone({
            contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
            driverId: input.driverId,
        })
        if (result.status === 'resolved') {
            return { status: 'resolved', driverId: result.driverId, phone: result.phone }
        }
        return result.status === 'not_found'
            ? { status: 'unreachable', reason: 'driver_not_found' }
            : { status: 'unreachable', reason: 'driver_has_no_callable_phone' }
    }
}

export const resolveAiCallDriverRecipient = createAiCallDriverRecipientResolver(
    getDriverCallablePhoneV1,
)
