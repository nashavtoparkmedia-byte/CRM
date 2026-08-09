import {
    RESOLVE_CONTACT_RESULT_V1,
    parseResolveContactCommandV1,
    type ResolveContactCommandV1,
    type ResolveContactResultV1,
    type ResolveContactStatusV1,
} from '../../../../contracts/contacts/v1'

export interface ResolveContactPersistencePortV1 {
    promotePlaceholderDisplayName(input: {
        contactId: string
        candidateDisplayName: string
    }): Promise<ResolveContactStatusV1>
}

export function createResolveContactHandlerV1(port: ResolveContactPersistencePortV1) {
    return async function resolveContactV1(command: ResolveContactCommandV1 | unknown): Promise<ResolveContactResultV1> {
        const parsed = parseResolveContactCommandV1(command)
        const status = await port.promotePlaceholderDisplayName({
            contactId: parsed.contactId,
            candidateDisplayName: parsed.candidateDisplayName,
        })
        return { contract: RESOLVE_CONTACT_RESULT_V1, status }
    }
}
