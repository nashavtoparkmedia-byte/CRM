import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
    type GetPreferredActiveContactPhoneQueryV1,
    type GetPreferredActiveContactPhoneResultV1,
} from '@/contracts/contacts/v1'
import {
    GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
    GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
    type GetDriverCallablePhoneQueryV1,
    type GetDriverCallablePhoneResultV1,
} from '@/contracts/fleet-operations/v1'

vi.mock('@/modules/contacts/public/v1', () => ({
    getPreferredActiveContactPhoneV1: vi.fn(),
}))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
    getDriverCallablePhoneV1: vi.fn(),
}))

import {
    createAiCallContactRecipientResolver,
    createAiCallDriverRecipientResolver,
} from './ai-call-recipient'

const getPreferredPhone = vi.fn(
    async (query: GetPreferredActiveContactPhoneQueryV1): Promise<GetPreferredActiveContactPhoneResultV1> => {
        void query
        return {
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
            phone: '+79990000000',
        }
    },
)

const resolveContact = createAiCallContactRecipientResolver(getPreferredPhone)

const getDriverPhone = vi.fn(
    async (query: GetDriverCallablePhoneQueryV1): Promise<GetDriverCallablePhoneResultV1> => {
        void query
        return {
            contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
            status: 'resolved',
            driverId: 'driver-1',
            phone: '+78880000000',
        }
    },
)

const resolveDriver = createAiCallDriverRecipientResolver(getDriverPhone)

beforeEach(() => {
    vi.clearAllMocks()
    getPreferredPhone.mockResolvedValue({
        contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
        phone: '+79990000000',
    })
    getDriverPhone.mockResolvedValue({
        contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
        status: 'resolved',
        driverId: 'driver-1',
        phone: '+78880000000',
    })
})

describe('Calling single-Driver recipient resolution', () => {
    it('resolves the Fleet-selected callable phone through the exact public query', async () => {
        await expect(resolveDriver({ driverId: 'driver-1' })).resolves.toEqual({
            status: 'resolved',
            driverId: 'driver-1',
            phone: '+78880000000',
        })
        expect(getDriverPhone).toHaveBeenCalledWith({
            contract: GET_DRIVER_CALLABLE_PHONE_QUERY_V1,
            driverId: 'driver-1',
        })
    })

    it('maps Fleet not-found to a bounded unreachable state', async () => {
        getDriverPhone.mockResolvedValue({
            contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
            status: 'not_found',
            driverId: 'missing-driver',
        })
        await expect(resolveDriver({ driverId: 'missing-driver' })).resolves.toEqual({
            status: 'unreachable',
            reason: 'driver_not_found',
        })
    })

    it('maps Fleet no-callable-phone to a distinct bounded unreachable state', async () => {
        getDriverPhone.mockResolvedValue({
            contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
            status: 'no_callable_phone',
            driverId: 'driver-without-phone',
        })
        await expect(resolveDriver({ driverId: 'driver-without-phone' })).resolves.toEqual({
            status: 'unreachable',
            reason: 'driver_has_no_callable_phone',
        })
    })

    it.each([null, undefined, '', '   ', 17, {}, []])(
        'rejects invalid driverId %j before owner access',
        async (driverId) => {
            await expect(resolveDriver({ driverId })).resolves.toEqual({
                status: 'invalid_input',
                reason: 'invalid_driver_id',
            })
            expect(getDriverPhone).not.toHaveBeenCalled()
        },
    )

    it.each([
        ['Contact', { contactId: 'contact-1' }],
        ['raw phone', { phoneNumber: '+79990000000' }],
        ['malformed Contact', { contactId: 42 }],
        ['malformed raw phone', { phoneNumber: {} }],
    ])('rejects a Driver combined with a %s recipient', async (_name, alternative) => {
        await expect(resolveDriver({ driverId: 'driver-1', ...alternative })).resolves.toEqual({
            status: 'invalid_input',
            reason: 'ambiguous_driver_recipient',
        })
        expect(getDriverPhone).not.toHaveBeenCalled()
    })

    it('does not normalize or reinterpret the phone selected by Fleet', async () => {
        getDriverPhone.mockResolvedValue({
            contract: GET_DRIVER_CALLABLE_PHONE_RESULT_V1,
            status: 'resolved',
            driverId: 'driver-1',
            phone: '8 (888) 000-00-00',
        })
        await expect(resolveDriver({ driverId: 'driver-1' })).resolves.toEqual({
            status: 'resolved',
            driverId: 'driver-1',
            phone: '8 (888) 000-00-00',
        })
    })

    it('leaves Fleet owner failures visible', async () => {
        getDriverPhone.mockRejectedValue(new Error('fleet unavailable'))
        await expect(resolveDriver({ driverId: 'driver-1' })).rejects.toThrow('fleet unavailable')
    })
})

describe('Calling single-Contact recipient resolution', () => {
    it('resolves the owner-selected preferred active phone through the exact Contacts query', async () => {
        await expect(resolveContact({ contactId: 'contact-1' })).resolves.toEqual({
            status: 'resolved',
            contactId: 'contact-1',
            phone: '+79990000000',
        })
        expect(getPreferredPhone).toHaveBeenCalledWith({
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
            contactId: 'contact-1',
            phoneId: null,
        })
    })

    it('returns a bounded unreachable result when the Contact owner cannot find the contact', async () => {
        getPreferredPhone.mockResolvedValue({
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
            phone: null,
        })
        await expect(resolveContact({ contactId: 'missing-contact' })).resolves.toEqual({
            status: 'unreachable',
            reason: 'contact_not_found_or_no_callable_phone',
        })
    })

    it('returns the same bounded result when the contact has no callable active phone', async () => {
        getPreferredPhone.mockResolvedValue({
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
            phone: null,
        })
        await expect(resolveContact({ contactId: 'contact-without-phone' })).resolves.toEqual({
            status: 'unreachable',
            reason: 'contact_not_found_or_no_callable_phone',
        })
    })

    it.each([null, undefined, '', '   ', 17, {}, []])(
        'rejects invalid contactId %j before owner access',
        async (contactId) => {
            await expect(resolveContact({ contactId })).resolves.toEqual({
                status: 'invalid_input',
                reason: 'invalid_contact_id',
            })
            expect(getPreferredPhone).not.toHaveBeenCalled()
        },
    )

    it.each([
        ['driver', { driverId: 'driver-1' }],
        ['raw phone', { phoneNumber: '+78880000000' }],
        ['malformed driver', { driverId: 42 }],
        ['malformed phone', { phoneNumber: {} }],
    ])('rejects a Contact combined with an alternative %s recipient', async (_name, alternative) => {
        await expect(resolveContact({ contactId: 'contact-1', ...alternative })).resolves.toEqual({
            status: 'invalid_input',
            reason: 'ambiguous_contact_recipient',
        })
        expect(getPreferredPhone).not.toHaveBeenCalled()
    })

    it('does not normalize or reinterpret the phone selected by Contacts', async () => {
        getPreferredPhone.mockResolvedValue({
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
            phone: '8 (999) 000-00-00',
        })
        await expect(resolveContact({ contactId: 'contact-1' })).resolves.toEqual({
            status: 'resolved',
            contactId: 'contact-1',
            phone: '8 (999) 000-00-00',
        })
    })

    it('leaves Contacts owner failures visible', async () => {
        getPreferredPhone.mockRejectedValue(new Error('contacts unavailable'))
        await expect(resolveContact({ contactId: 'contact-1' })).rejects.toThrow('contacts unavailable')
    })
})
