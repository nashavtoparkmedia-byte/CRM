import {
    ATTACH_CONTACT_IDENTITY_RESULT_V1,
    parseAttachContactIdentityCommandV1,
    type AttachContactIdentityCommandV1,
    type AttachContactIdentityResultV1,
} from '../../../../contracts/contacts/v1'

export interface AttachContactIdentityPersistencePortV1 {
    replaceProfile(input: {
        identityId: string
        handle: string | null
        givenName: string | null
        familyName: string | null
    }): Promise<void>
}

export function createAttachContactIdentityHandlerV1(port: AttachContactIdentityPersistencePortV1) {
    return async function attachContactIdentityV1(command: AttachContactIdentityCommandV1 | unknown): Promise<AttachContactIdentityResultV1> {
        const parsed = parseAttachContactIdentityCommandV1(command)
        await port.replaceProfile({ identityId: parsed.identityId, ...parsed.profile })
        return { contract: ATTACH_CONTACT_IDENTITY_RESULT_V1, identityId: parsed.identityId }
    }
}
