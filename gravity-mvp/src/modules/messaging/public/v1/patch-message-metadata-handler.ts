import { PATCH_MESSAGE_METADATA_RESULT_V1, parsePatchMessageMetadataCommandV1, type PatchMessageMetadataCommandV1, type PatchMessageMetadataResultV1 } from '../../../../contracts/messaging/v1/patch-message-metadata-command'
export interface PatchMessageMetadataPersistencePortV1 { patchMetadata(messageId: string, metadata: unknown): Promise<void> }
export function createPatchMessageMetadataHandlerV1(port: PatchMessageMetadataPersistencePortV1) {
    return async function patchMessageMetadataV1(command: PatchMessageMetadataCommandV1 | unknown): Promise<PatchMessageMetadataResultV1> {
        const parsed = parsePatchMessageMetadataCommandV1(command)
        await port.patchMetadata(parsed.messageId, parsed.metadata)
        return { contract: PATCH_MESSAGE_METADATA_RESULT_V1, updated: true }
    }
}
