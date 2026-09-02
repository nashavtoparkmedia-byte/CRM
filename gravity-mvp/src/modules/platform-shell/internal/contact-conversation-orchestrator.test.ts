import { describe, expect, test, vi } from 'vitest'
import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
    PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
    RESOLVE_CHANNEL_CONTACT_RESULT_V1,
    type PreparedContactConversationIdentityV1,
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
const identity = {
    id: 'identity-1',
    channel: 'telegram' as const,
    externalId: 'opaque-provider-user-42',
    providerAccountId: 'telegram-account-b',
}
const conversation: ContactConversationV1 = {
    id: 'chat-1',
    channel: 'telegram',
    externalChatId: 'telegram:opaque-provider-user-42',
    status: 'new',
    contactId: contact.id,
    contactIdentityId: identity.id,
    providerAccountId: identity.providerAccountId,
    transportConnectionId: 'telegram-connection-b',
}

function ownerApis(
    calls: string[],
    options: {
        linked?: ContactConversationV1 | null
        phone?: string | null
        driverId?: string | null
        prepareStatus?:
            | 'ready'
            | 'contact_not_found'
            | 'identity_not_found'
            | 'identity_ambiguous'
            | 'identity_conflicted'
            | 'identity_unreachable'
            | 'identity_reachability_unknown'
            | 'phone_not_found'
            | 'no_identity'
        preparedIdentity?: PreparedContactConversationIdentityV1
        fallbackIsNew?: boolean
        opened?: ContactConversationV1
        fallbackStatus?:
            | 'provider_account_unproven'
            | 'transport_unbound'
            | 'conversation_target_unproven'
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
                identity: options.preparedIdentity ?? identity,
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
            if (options.fallbackStatus) {
                return {
                    contract: OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
                    status: options.fallbackStatus,
                }
            }
            return {
                contract: OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
                status: 'ready' as const,
                conversation: options.opened ?? conversation,
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

    test.each([
        'identity_conflicted' as const,
        'identity_unreachable' as const,
        'identity_reachability_unknown' as const,
    ])('does not read or write Messaging when reachability is %s', async (prepareStatus) => {
        const calls: string[] = []
        const owners = ownerApis(calls, { prepareStatus })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).resolves.toEqual({ status: prepareStatus })
        expect(calls).toEqual(['prepare-identity'])
    })

    test('passes identity ownership and provider account without inventing transport evidence', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, { phone: '+79990000000' })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })

        expect(owners.openFallbackContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                identityExternalId: 'opaque-provider-user-42',
                contactId: 'contact-1',
                contactIdentityId: 'identity-1',
                providerAccountId: 'telegram-account-b',
            }),
        )
        expect(owners.openFallbackContactConversationV1).not.toHaveBeenCalledWith(
            expect.objectContaining({ identityExternalId: expect.stringContaining('79990000000') }),
        )
        expect(owners.getPreferredActiveContactPhoneV1).not.toHaveBeenCalled()
        expect(owners.findDriverByExactPhoneV1).not.toHaveBeenCalled()
        expect(owners.findAndBackfillContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                identityExternalId: 'opaque-provider-user-42',
                providerAccountId: 'telegram-account-b',
                allowContactFallback: true,
            }),
        )
    })

    test('passes only provider-canonical WhatsApp phone and LID targets to Messaging', async () => {
        const calls: string[] = []
        const waIdentity: PreparedContactConversationIdentityV1 = {
            id: 'identity-wa',
            channel: 'whatsapp',
            externalId: 'opaque-peer@lid',
            providerAccountId: 'wa-connection-1',
            providerAliasValues: ['79990001122@c.us', 'bare-legacy-value'],
        }
        const waConversation: ContactConversationV1 = {
            id: 'chat-wa',
            channel: 'whatsapp',
            externalChatId: 'whatsapp:79990001122',
            status: 'new',
            contactId: contact.id,
            contactIdentityId: waIdentity.id,
            providerAccountId: 'wa-connection-1',
            transportConnectionId: 'wa-connection-1',
        }
        const owners = ownerApis(calls, {
            preparedIdentity: waIdentity,
            linked: waConversation,
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: contact.id,
            channel: 'whatsapp',
            identityId: waIdentity.id,
            phoneId: null,
        })).resolves.toMatchObject({ status: 'ready' })

        expect(owners.findAndBackfillContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                identityExternalId: 'opaque-peer@lid',
                exactExternalChatIds: ['opaque-peer@lid', 'whatsapp:79990001122'],
            }),
        )
    })

    test.each([
        { contactIdentityId: 'identity-2' },
        { channel: 'max' as const },
        { contactId: null },
        { contactIdentityId: null },
        { providerAccountId: 'telegram-account-a' },
    ])('fails closed when Messaging returns a conversation outside the exact identity binding: %j', async (mismatch) => {
        const calls: string[] = []
        const owners = ownerApis(calls, { linked: { ...conversation, ...mismatch } })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).rejects.toThrow('CONTACT_CONVERSATION_BINDING_MISMATCH')

        expect(owners.findAndBackfillContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({ allowContactFallback: true }),
        )
        expect(owners.openFallbackContactConversationV1).not.toHaveBeenCalled()
    })

    test('fails closed when fallback creation returns a different identity binding', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, {
            opened: { ...conversation, contactIdentityId: 'identity-2' },
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).rejects.toThrow('CONTACT_CONVERSATION_BINDING_MISMATCH')

        expect(owners.openFallbackContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                legacyDriverId: null,
                identityExternalId: 'opaque-provider-user-42',
                contactIdentityId: 'identity-1',
            }),
        )
    })

    test.each([
        { id: 'identity-2' },
        { channel: 'max' as const },
        { externalId: ' ' },
        { providerAccountId: ' ' },
    ])('rejects a prepared identity outside the explicit selection before Messaging: %j', async (mismatch) => {
        const calls: string[] = []
        const owners = ownerApis(calls, { preparedIdentity: { ...identity, ...mismatch } })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')

        expect(calls).toEqual(['prepare-identity'])
    })

    test('a selected phone permits only exact-key contact fallback and disables legacy-driver fallback', async () => {
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
            expect.objectContaining({ allowContactFallback: true }),
        )
        expect(owners.getPreferredActiveContactPhoneV1).not.toHaveBeenCalled()
        expect(owners.findDriverByExactPhoneV1).not.toHaveBeenCalled()
        expect(owners.openFallbackContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({ legacyDriverId: null }),
        )
    })

    test('an explicitly selected identity can adopt an exact-key legacy null identity link', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, { linked: conversation })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })).resolves.toMatchObject({
            status: 'ready',
            conversation,
            isNewConversation: false,
        })

        expect(owners.findAndBackfillContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                contactId: 'contact-1',
                contactIdentityId: 'identity-1',
                identityExternalId: 'opaque-provider-user-42',
                providerAccountId: 'telegram-account-b',
                allowContactFallback: true,
            }),
        )
        expect(owners.openFallbackContactConversationV1).not.toHaveBeenCalled()
    })

    test('reuses a live-shaped MAX conversation target without deriving it from sender identity', async () => {
        const calls: string[] = []
        const maxIdentity: PreparedContactConversationIdentityV1 = {
            id: 'identity-max',
            channel: 'max',
            externalId: 'sender-42',
            providerAccountId: 'max-default',
        }
        const maxConversation: ContactConversationV1 = {
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max-conversation-900',
            status: 'new',
            contactId: contact.id,
            contactIdentityId: maxIdentity.id,
            providerAccountId: 'max-default',
            transportConnectionId: 'max_scraper',
        }
        const owners = ownerApis(calls, {
            preparedIdentity: maxIdentity,
            linked: maxConversation,
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: contact.id,
            channel: 'max',
            identityId: maxIdentity.id,
            phoneId: null,
        })).resolves.toMatchObject({ status: 'ready', conversation: maxConversation })

        expect(owners.findAndBackfillContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                identityExternalId: 'sender-42',
                providerAccountId: 'max-default',
            }),
        )
        expect(maxConversation.externalChatId).not.toBe('max:sender-42')
        expect(owners.openFallbackContactConversationV1).not.toHaveBeenCalled()
    })

    test('fails closed for a live-shaped Telegram bot chat without transport proof', async () => {
        const calls: string[] = []
        const botIdentity: PreparedContactConversationIdentityV1 = {
            id: 'identity-bot',
            channel: 'telegram',
            externalId: '4242',
            providerAccountId: 'telegram-default',
        }
        const botConversation: ContactConversationV1 = {
            id: 'chat-bot',
            channel: 'telegram',
            externalChatId: 'telegram:4242',
            status: 'new',
            contactId: contact.id,
            contactIdentityId: botIdentity.id,
            providerAccountId: 'telegram-default',
            transportConnectionId: null,
        }
        const owners = ownerApis(calls, {
            preparedIdentity: botIdentity,
            linked: botConversation,
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: contact.id,
            channel: 'telegram',
            identityId: botIdentity.id,
            phoneId: null,
        })).resolves.toEqual({ status: 'transport_unbound' })

        expect(owners.openFallbackContactConversationV1).not.toHaveBeenCalled()
    })

    test('propagates an unproven MAX target without creating a synthesized conversation key', async () => {
        const calls: string[] = []
        const maxIdentity: PreparedContactConversationIdentityV1 = {
            id: 'identity-max',
            channel: 'max',
            externalId: 'sender-42',
            providerAccountId: 'max-default',
        }
        const owners = ownerApis(calls, {
            preparedIdentity: maxIdentity,
            fallbackStatus: 'conversation_target_unproven',
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: contact.id,
            channel: 'max',
            identityId: maxIdentity.id,
            phoneId: null,
        })).resolves.toEqual({ status: 'conversation_target_unproven' })

        expect(owners.openFallbackContactConversationV1).toHaveBeenCalledWith(
            expect.objectContaining({
                identityExternalId: 'sender-42',
            }),
        )
    })

    test('accepts concrete account evidence from an exact existing Chat for a legacy identity', async () => {
        const calls: string[] = []
        const legacyIdentity: PreparedContactConversationIdentityV1 = {
            ...identity,
            providerAccountId: null,
        }
        const owners = ownerApis(calls, {
            preparedIdentity: legacyIdentity,
            linked: conversation,
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: contact.id,
            channel: 'telegram',
            identityId: identity.id,
            phoneId: null,
        })).resolves.toMatchObject({ status: 'ready', conversation })
    })

    test('propagates missing provider-account proof instead of treating legacy as an account', async () => {
        const calls: string[] = []
        const owners = ownerApis(calls, {
            preparedIdentity: { ...identity, providerAccountId: null },
            fallbackStatus: 'provider_account_unproven',
        })
        const orchestrator = createContactConversationOrchestratorV1(owners)

        await expect(orchestrator.openContactConversationForContactV1({
            contactId: contact.id,
            channel: 'telegram',
            identityId: identity.id,
            phoneId: null,
        })).resolves.toEqual({ status: 'provider_account_unproven' })
    })
})
