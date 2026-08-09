import {
    CREATE_FLEET_CONTACT_RESULT_V1,
    PATCH_FLEET_CONTACT_RESULT_V1,
    parseCreateFleetContactCommandV1,
    parsePatchFleetContactCommandV1,
    type CreateFleetContactCommandV1,
    type CreateFleetContactResultV1,
    type FleetContactPatchV1,
    type PatchFleetContactCommandV1,
    type PatchFleetContactResultV1,
} from '../../../../contracts/contacts/v1'

export interface FleetContactPersistencePortV1 {
    patch(contactId: string, patch: FleetContactPatchV1): Promise<void>
    create(input: Omit<CreateFleetContactCommandV1, 'contract'>): Promise<{ id: string; primaryPhoneId: string | null }>
}

export function createPatchFleetContactHandlerV1(port: FleetContactPersistencePortV1) {
    return async function patchFleetContactV1(command: PatchFleetContactCommandV1 | unknown): Promise<PatchFleetContactResultV1> {
        const parsed = parsePatchFleetContactCommandV1(command)
        await port.patch(parsed.contactId, parsed.patch)
        return { contract: PATCH_FLEET_CONTACT_RESULT_V1 }
    }
}

export function createCreateFleetContactHandlerV1(port: FleetContactPersistencePortV1) {
    return async function createFleetContactV1(command: CreateFleetContactCommandV1 | unknown): Promise<CreateFleetContactResultV1> {
        const parsed = parseCreateFleetContactCommandV1(command)
        const contact = await port.create({ displayName: parsed.displayName, displayNameSource: parsed.displayNameSource, masterSource: parsed.masterSource, yandexDriverId: parsed.yandexDriverId })
        return { contract: CREATE_FLEET_CONTACT_RESULT_V1, contact }
    }
}
