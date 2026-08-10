import {
    GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
    PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
    RESOLVE_CHANNEL_CONTACT_RESULT_V1,
    parseGetPreferredActiveContactPhoneQueryV1,
    parsePrepareContactConversationIdentityCommandV1,
    parseResolveChannelContactCommandV1,
    type ContactConversationChannelV1,
    type ContactConversationContactV1,
    type ContactConversationIdentityV1,
    type GetPreferredActiveContactPhoneQueryV1,
    type GetPreferredActiveContactPhoneResultV1,
    type PrepareContactConversationIdentityCommandV1,
    type PrepareContactConversationIdentityResultV1,
    type ResolveChannelContactCommandV1,
    type ResolveChannelContactResultV1,
} from '../../../../contracts/contacts/v1'

export type PrepareContactConversationIdentityPersistenceResultV1 =
    | {
        status: 'ready'
        contact: ContactConversationContactV1
        identity: ContactConversationIdentityV1
    }
    | { status: 'contact_not_found' | 'identity_not_found' | 'no_identity' }

export interface ContactConversationPersistencePortV1 {
    resolveChannelContact(input: {
        channel: ContactConversationChannelV1
        externalId: string
        phone: string | null
        displayName: string | null
    }): Promise<{
        contact: ContactConversationContactV1
        identity: ContactConversationIdentityV1
        isNew: boolean
    }>
    prepareContactConversationIdentity(input: {
        contactId: string
        channel: ContactConversationChannelV1
        identityId: string | null
    }): Promise<PrepareContactConversationIdentityPersistenceResultV1>
    getPreferredActiveContactPhone(contactId: string): Promise<string | null>
}

export function createResolveChannelContactHandlerV1(port: ContactConversationPersistencePortV1) {
    return async function resolveChannelContactV1(
        command: ResolveChannelContactCommandV1 | unknown,
    ): Promise<ResolveChannelContactResultV1> {
        const parsed = parseResolveChannelContactCommandV1(command)
        const resolved = await port.resolveChannelContact({
            channel: parsed.channel,
            externalId: parsed.externalId,
            phone: parsed.phone,
            displayName: parsed.displayName,
        })
        return {
            contract: RESOLVE_CHANNEL_CONTACT_RESULT_V1,
            contact: resolved.contact,
            identity: resolved.identity,
            isNew: resolved.isNew,
        }
    }
}

export function createPrepareContactConversationIdentityHandlerV1(port: ContactConversationPersistencePortV1) {
    return async function prepareContactConversationIdentityV1(
        command: PrepareContactConversationIdentityCommandV1 | unknown,
    ): Promise<PrepareContactConversationIdentityResultV1> {
        const parsed = parsePrepareContactConversationIdentityCommandV1(command)
        const prepared = await port.prepareContactConversationIdentity({
            contactId: parsed.contactId,
            channel: parsed.channel,
            identityId: parsed.identityId,
        })

        if (prepared.status !== 'ready') {
            return {
                contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
                status: prepared.status,
            }
        }

        return {
            contract: PREPARE_CONTACT_CONVERSATION_IDENTITY_RESULT_V1,
            status: 'ready',
            contact: prepared.contact,
            identity: prepared.identity,
        }
    }
}

export function createGetPreferredActiveContactPhoneHandlerV1(port: ContactConversationPersistencePortV1) {
    return async function getPreferredActiveContactPhoneV1(
        query: GetPreferredActiveContactPhoneQueryV1 | unknown,
    ): Promise<GetPreferredActiveContactPhoneResultV1> {
        const parsed = parseGetPreferredActiveContactPhoneQueryV1(query)
        return {
            contract: GET_PREFERRED_ACTIVE_CONTACT_PHONE_RESULT_V1,
            phone: await port.getPreferredActiveContactPhone(parsed.contactId),
        }
    }
}
