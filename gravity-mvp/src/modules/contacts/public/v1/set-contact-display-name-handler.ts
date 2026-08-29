import {
    SET_CONTACT_DISPLAY_NAME_RESULT_V1,
    parseSetContactDisplayNameCommandV1,
    type SetContactDisplayNameCommandV1,
    type SetContactDisplayNameResultV1,
    type SetContactDisplayNameStatusV1,
} from '../../../../contracts/contacts/v1'

export interface SetContactDisplayNamePersistencePortV1 {
    setDisplayName(input: { contactId: string; displayName: string }): Promise<SetContactDisplayNameStatusV1>
}

export function createSetContactDisplayNameHandlerV1(port: SetContactDisplayNamePersistencePortV1) {
    return async function setContactDisplayNameV1(
        command: SetContactDisplayNameCommandV1 | unknown,
    ): Promise<SetContactDisplayNameResultV1> {
        const parsed = parseSetContactDisplayNameCommandV1(command)
        const status = await port.setDisplayName({ contactId: parsed.contactId, displayName: parsed.displayName })
        return { contract: SET_CONTACT_DISPLAY_NAME_RESULT_V1, status }
    }
}
