import { RESOLVE_CONTACT_RESULT_V2, parseResolveContactCommandV2, type ResolveContactCommandV2, type ResolveContactResultV2, type ResolveContactStatusV2 } from '../../../../contracts/contacts/v2'

export interface ResolveContactPersistencePortV2 {
    promoteChannelDisplayName(input: { contactId: string; candidateDisplayName: string }): Promise<ResolveContactStatusV2>
}

export function createResolveContactHandlerV2(port: ResolveContactPersistencePortV2) {
    return async function resolveContactV2(command: ResolveContactCommandV2 | unknown): Promise<ResolveContactResultV2> {
        const parsed = parseResolveContactCommandV2(command)
        const status = await port.promoteChannelDisplayName({ contactId: parsed.contactId, candidateDisplayName: parsed.candidateDisplayName })
        return { contract: RESOLVE_CONTACT_RESULT_V2, status }
    }
}
