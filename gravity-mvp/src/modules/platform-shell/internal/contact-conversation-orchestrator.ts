import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
    PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
    type ContactConversationChannelV1,
    type GetPreferredActiveContactPhoneQueryV1,
    type GetPreferredActiveContactPhoneResultV1,
    type PrepareContactConversationIdentityCommandV1,
    type PrepareContactConversationIdentityResultV1,
    type ResolveChannelContactCommandV1,
    type ResolveChannelContactResultV1,
} from '@/contracts/contacts/v1'
import {
    FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1,
    type FindDriverByExactPhoneQueryV1,
    type FindDriverByExactPhoneResultV1,
} from '@/contracts/fleet-operations/v1'
import {
    FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1,
    OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1,
    type ContactConversationV1,
    type FindAndBackfillContactConversationCommandV1,
    type FindAndBackfillContactConversationResultV1,
    type OpenFallbackContactConversationCommandV1,
    type OpenFallbackContactConversationResultV1,
} from '@/contracts/messaging/v1'
import {
    getPreferredActiveContactPhoneV1,
    prepareContactConversationIdentityV1,
    resolveChannelContactV1,
} from '@/modules/contacts/public/v1'
import { findDriverByExactPhoneV1 } from '@/modules/fleet-operations/public/v1'
import {
    findAndBackfillContactConversationV1,
    openFallbackContactConversationV1,
} from '@/modules/messaging/public/v1'
import { canonicalWhatsAppConversationTargetV1 } from '@/modules/whatsapp-channel/public/v1/identity-canonicalization'

export type PlatformContactConversationChannelV1 = ContactConversationChannelV1

export interface ContactConversationOwnerApisV1 {
    resolveChannelContactV1(command: ResolveChannelContactCommandV1): Promise<ResolveChannelContactResultV1>
    prepareContactConversationIdentityV1(
        command: PrepareContactConversationIdentityCommandV1,
    ): Promise<PrepareContactConversationIdentityResultV1>
    getPreferredActiveContactPhoneV1(
        query: GetPreferredActiveContactPhoneQueryV1,
    ): Promise<GetPreferredActiveContactPhoneResultV1>
    findDriverByExactPhoneV1(query: FindDriverByExactPhoneQueryV1): Promise<FindDriverByExactPhoneResultV1>
    findAndBackfillContactConversationV1(
        command: FindAndBackfillContactConversationCommandV1,
    ): Promise<FindAndBackfillContactConversationResultV1>
    openFallbackContactConversationV1(
        command: OpenFallbackContactConversationCommandV1,
    ): Promise<OpenFallbackContactConversationResultV1>
}

export interface StartContactConversationByPhoneInputV1 {
    normalizedPhone: string
    channel: PlatformContactConversationChannelV1
}

export interface ReadyContactConversationV1 {
    contact: ResolveChannelContactResultV1['contact']
    identity: Extract<PrepareContactConversationIdentityResultV1, { status: 'ready' }>['identity']
    conversation: ContactConversationV1
    isNewContact: boolean
    isNewConversation: boolean
}

export type StartContactConversationByPhoneResultV1 =
    | ({ status: 'ready' } & ReadyContactConversationV1)
    | { status: 'provider_identity_required' }

export interface OpenContactConversationForContactInputV1 {
    contactId: string
    channel: PlatformContactConversationChannelV1
    identityId: string | null
    phoneId: string | null
}

export type OpenContactConversationForContactResultV1 =
    | {
        status:
            | 'contact_not_found'
            | 'identity_not_found'
            | 'identity_ambiguous'
            | 'identity_conflicted'
            | 'identity_unreachable'
            | 'identity_reachability_unknown'
            | 'phone_not_found'
            | 'no_identity'
            | 'provider_account_unproven'
            | 'transport_unbound'
            | 'conversation_target_unproven'
    }
    | ({ status: 'ready' } & ReadyContactConversationV1)

const defaultOwnerApisV1: ContactConversationOwnerApisV1 = {
    resolveChannelContactV1,
    prepareContactConversationIdentityV1,
    getPreferredActiveContactPhoneV1,
    findDriverByExactPhoneV1,
    findAndBackfillContactConversationV1,
    openFallbackContactConversationV1,
}

function assertExactConversationBinding(
    conversation: ContactConversationV1,
    expected: {
        contactId: string
        contactIdentityId: string
        channel: PlatformContactConversationChannelV1
        providerAccountId: string | null
    },
): void {
    if (
        conversation.contactId !== expected.contactId
        || conversation.contactIdentityId !== expected.contactIdentityId
        || conversation.channel !== expected.channel
        || (
            expected.providerAccountId !== null
            && conversation.providerAccountId !== expected.providerAccountId
        )
        || conversation.providerAccountId.trim() === ''
        || conversation.providerAccountId === 'legacy'
    ) {
        throw new Error('CONTACT_CONVERSATION_BINDING_MISMATCH')
    }
}

function assertPreparedIdentityBinding(
    input: OpenContactConversationForContactInputV1,
    prepared: Extract<PrepareContactConversationIdentityResultV1, { status: 'ready' }>,
): void {
    if (
        prepared.contact.id !== input.contactId
        || prepared.identity.channel !== input.channel
        || (input.identityId !== null && prepared.identity.id !== input.identityId)
        || prepared.identity.externalId.trim() === ''
        || (
            prepared.identity.providerAccountId !== null
            && (
                prepared.identity.providerAccountId.trim() === ''
                || prepared.identity.providerAccountId === 'legacy'
            )
        )
    ) {
        throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    }
}

function exactExternalChatIds(
    identity: Extract<PrepareContactConversationIdentityResultV1, { status: 'ready' }>['identity'],
): string[] {
    if (identity.channel === 'max') return []
    if (identity.channel === 'telegram') return [`telegram:${identity.externalId}`]
    return [...new Set([identity.externalId, ...(identity.providerAliasValues ?? [])]
        .map(canonicalWhatsAppConversationTargetV1)
        .filter((value): value is string => value !== null))].sort()
}

export function createContactConversationOrchestratorV1(owners: ContactConversationOwnerApisV1) {
    async function startContactConversationByPhoneV1(
        input: StartContactConversationByPhoneInputV1,
    ): Promise<StartContactConversationByPhoneResultV1> {
        void input
        // A phone number is evidence about a person, not an opaque provider
        // identifier. Existing Contacts must be opened through their persisted
        // channel identity; a phone-only request cannot create one safely.
        return { status: 'provider_identity_required' }
    }

    async function openContactConversationForContactV1(
        input: OpenContactConversationForContactInputV1,
    ): Promise<OpenContactConversationForContactResultV1> {
        const prepared = await owners.prepareContactConversationIdentityV1({
            contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_COMMAND_V1,
            contactId: input.contactId,
            channel: input.channel,
            identityId: input.identityId,
            phoneId: input.phoneId,
        })
        if (prepared.status !== 'ready') return { status: prepared.status }
        assertPreparedIdentityBinding(input, prepared)

        // Messaging owns the provider conversation target. In particular, a
        // MAX identity externalId is a sender id, not the Chat externalChatId.
        // Contacts supplies ownership/account evidence; Messaging may reuse a
        // channel-proven target and transport, but neither may be fabricated.
        const allowContactFallback = true
        const allowLegacyDriverFallback = input.identityId === null && input.phoneId === null

        const linked = await owners.findAndBackfillContactConversationV1({
            contract: FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1,
            contactId: input.contactId,
            contactIdentityId: prepared.identity.id,
            channel: input.channel,
            identityExternalId: prepared.identity.externalId,
            exactExternalChatIds: exactExternalChatIds(prepared.identity),
            providerAccountId: prepared.identity.providerAccountId,
            allowContactFallback,
        })
        if (linked.conversation) {
            assertExactConversationBinding(linked.conversation, {
                contactId: input.contactId,
                contactIdentityId: prepared.identity.id,
                channel: input.channel,
                providerAccountId: prepared.identity.providerAccountId,
            })
            if (!linked.conversation.transportConnectionId) {
                return { status: 'transport_unbound' }
            }
            return {
                status: 'ready',
                contact: prepared.contact,
                identity: prepared.identity,
                conversation: linked.conversation,
                isNewContact: false,
                isNewConversation: false,
            }
        }

        let legacyDriverId: string | null = null
        if (allowLegacyDriverFallback) {
            const phone = await owners.getPreferredActiveContactPhoneV1({
                contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1,
                contactId: input.contactId,
                phoneId: null,
            })
            if (phone.phone) {
                const driver = await owners.findDriverByExactPhoneV1({
                    contract: FIND_DRIVER_BY_EXACT_PHONE_QUERY_V1,
                    phone: phone.phone,
                })
                legacyDriverId = driver.driverId
            }
        }

        const opened = await owners.openFallbackContactConversationV1({
            contract: OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1,
            legacyDriverId,
            channel: input.channel,
            identityExternalId: prepared.identity.externalId,
            exactExternalChatIds: exactExternalChatIds(prepared.identity),
            name: prepared.contact.displayName,
            contactId: input.contactId,
            contactIdentityId: prepared.identity.id,
            providerAccountId: prepared.identity.providerAccountId,
        })
        if (opened.status !== 'ready') return { status: opened.status }
        assertExactConversationBinding(opened.conversation, {
            contactId: input.contactId,
            contactIdentityId: prepared.identity.id,
            channel: input.channel,
            providerAccountId: prepared.identity.providerAccountId,
        })
        if (!opened.conversation.transportConnectionId) {
            return { status: 'transport_unbound' }
        }
        return {
            status: 'ready',
            contact: prepared.contact,
            identity: prepared.identity,
            conversation: opened.conversation,
            isNewContact: false,
            isNewConversation: opened.isNew,
        }
    }

    return { startContactConversationByPhoneV1, openContactConversationForContactV1 }
}

export const {
    startContactConversationByPhoneV1,
    openContactConversationForContactV1,
} = createContactConversationOrchestratorV1(defaultOwnerApisV1)
