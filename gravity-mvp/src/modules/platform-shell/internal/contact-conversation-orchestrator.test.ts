import { describe, expect, test, vi } from 'vitest'
import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
    PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
    RESOLVE_CHANNEL_CONTACT_RESULT_V1,
} from '@/contracts/contacts/v1'
import { FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1 } from '@/contracts/fleet-operations/v1'
import {
    FIND_AND_BACKFILL_CONTACT_CONVERSATION_RESULT_V1,
    OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
    type ContactConversationV1,
} from '@/contracts/messaging/v1'
import {
    createContactConversationOrchestratorV1,
    type ContactConversationOwnerApisV1,
} from './contact-conversation-orchestrator'

const contact = { id: 'contact-1', displayName: 'Контакт' }
const identity = { id: 'identity-1', channel: 'telegram' as const, externalId: '79990000000' }
const conversation: ContactConversationV1 = {
    id: 'chat-1',
    channel: 'telegram',
    externalChatId: 'telegram:79990000000',
    status: 'new',
    contactId: contact.id,
    contactIdentityId: identity.id,
}

function ownerApis(
    calls: string[],
    options: {
        linked?: ContactConversationV1 | null
        phone?: string | null
        driverId?: string | null
        prepareStatus?: 'ready' | 'contact_not_found' | 'identity_not_found' | 'phone_not_found' | 'no_identity'
        fallbackIsNew?: boolean
    } = {},
) {
    const owners = {
        resolveChannelContactV1: vi.fn(async () => {
            calls.push('resolve-contact')
            return {
                contract: RESOLVE_CHANNEL_CONTACT_RESULT_V1,
                contact,
                identity,
                isNew: true,
            }
        }),
        prepareContactConversationIdentityV1: vi.fn(async () => {
            calls.push('prepare-identity')
            const status = options.prepareStatus ?? 'ready'
            if (status !== 'ready') {
                return { contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1, status }
            }
            return {
                contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
                status,
                contact,
                identity,
            }
        }),
        getPreferredActiveContactPhoneV1: vi.fn(async () => {
            calls.push('get-phone')
            return {
                contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
                phone: options.phone === undefined ? '+79990000000' : options.phone,
            }
        }),
        findDriverByExactPhoneV1: vi.fn(async () => {
            calls.push('find-driver')
            return {
                contract: FIND_DRIVER_BY_EXACT_PHONE_RESULT_V1,
                driverId: options.driverId === undefined ? 'driver-1' : options.driverId,
            }
        }),
        findAndBackfillContactConversationV1: vi.fn(async () => {
            calls.push('find-contact-conversation')
            return {
                contract: FIND_AND_BACKFILL_CONTACT_CONVERSATION_RESULT_V1,
                conversation: options.linked ?? null,
            }
        }),
        openFallbackContactConversationV1: vi.fn(async () => {
            calls.push('open-fallback')
            return {
                contract: OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
                conversation,
                isNew: options.fallbackIsNew ?? false,
            }
        }),
    } satisfies ContactConversationOwnerApisV1
    return owners
}

describe('Platform contact-conversation orchestration', () => {
    test('phone-only starts cannot fabricate a provider identity', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, { fallbackIsNew: true })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        const result = await orchestrator.startContactConversationByPhoneV1({
            normalizedPhone: '+79990000000',
            channel: 'telegram',
        })

        expect(calls).toEqual([])
        expect(result).toEqual({ status: 'provider_identity_required' })
    })

    test('phone-only starts do not reuse a contact-wide conversation without identity proof', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, { linked: conversation })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        const result = await orchestrator.startContactConversationByPhoneV1({
            normalizedPhone: '+79990000000',
            channel: 'telegram',
        })

        expect(calls).toEqual([])
        expect(result).toEqual({ status: 'provider_identity_required' })
    })

    test('contact-id fallback reads phone before conditionally querying Fleet', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls)
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: null,
            phoneId: null,
        })

        expect(calls).toEqual([
            'prepare-identity',
            'find-contact-conversation',
            'get-phone',
            'find-driver',
            'open-fallback',
        ])
    })

    test('missing fallback phone skips Fleet but still checks the external conversation key', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, { phone: null })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: null,
            phoneId: null,
        })

        expect(calls).toEqual(['prepare-identity', 'find-contact-conversation', 'get-phone', 'open-fallback'])
        expect(owners.openFallbackContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({ legacyDriverId: null }),
        )
    })

    test('identity preparation failures preserve the early return boundary', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, { prepareStatus: 'identity_not_found' })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'missing',
            phoneId: null,
        })).resolves.toEqual({ status: 'identity_not_found' })
        expect(calls).toEqual(['prepare-identity'])
    })

    test('a selected phone disables contact-wide and legacy-driver fallbacks', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls)
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: null,
            phoneId: 'phone-2',
        })

        expect(owners.prepareContactConversationIdentityV1).toHaveBeenCalledWith(
            expect.objectContaining({ phoneId: 'phone-2' }),
        )
        expect(owners.findAndBackfillContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({ allowContactFallback: false }),
        )
        expect(owners.getPreferredActiveContactPhoneV1).toHaveBeenCalledWith(
            expect.objectContaining({ phoneId: 'phone-2' }),
        )
        expect(owners.openFallbackContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({ legacyDriverId: null }),
        )
    })
})
