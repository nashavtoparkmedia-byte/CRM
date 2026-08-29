import {
    MIRROR_DRIVER_ACTION_RESULT_RESULT_V1,
    RECORD_DRIVER_ACTION_RESULT_V1,
    parseMirrorDriverActionResultCommandV1,
    parseRecordDriverActionCommandV1,
    type DriverActionCreateV1,
    type MirrorDriverActionResultCommandV1,
    type MirrorDriverActionResultResultV1,
    type RecordDriverActionCommandV1,
    type RecordDriverActionResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface DriverActionPersistencePortV1 {
    create(data: DriverActionCreateV1): Promise<{ id: string }>
    mirrorResult(input: Omit<MirrorDriverActionResultCommandV1, 'contract'>): Promise<{ updatedCount: number }>
}

export function createRecordDriverActionHandlerV1(port: DriverActionPersistencePortV1) {
    return async function recordDriverActionV1(command: RecordDriverActionCommandV1 | unknown): Promise<RecordDriverActionResultV1> {
        const parsed = parseRecordDriverActionCommandV1(command)
        const action = await port.create(parsed.data)
        return { contract: RECORD_DRIVER_ACTION_RESULT_V1, action: { id: action.id } }
    }
}

export function createMirrorDriverActionResultHandlerV1(port: DriverActionPersistencePortV1) {
    return async function mirrorDriverActionResultV1(command: MirrorDriverActionResultCommandV1 | unknown): Promise<MirrorDriverActionResultResultV1> {
        const parsed = parseMirrorDriverActionResultCommandV1(command)
        const { contract: _contract, ...input } = parsed
        void _contract
        const result = await port.mirrorResult(input)
        return { contract: MIRROR_DRIVER_ACTION_RESULT_RESULT_V1, updatedCount: result.updatedCount }
    }
}
