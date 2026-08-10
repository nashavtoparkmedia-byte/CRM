export const PATCH_MESSAGE_METADATA_COMMAND_V1 = 'messaging.PatchMessageMetadataCommand.v1' as const
export const PATCH_MESSAGE_METADATA_RESULT_V1 = 'messaging.PatchMessageMetadataResult.v1' as const
export interface PatchMessageMetadataCommandV1 { contract: typeof PATCH_MESSAGE_METADATA_COMMAND_V1; messageId: string; metadata: unknown }
export interface PatchMessageMetadataResultV1 { contract: typeof PATCH_MESSAGE_METADATA_RESULT_V1; updated: true }
export function parsePatchMessageMetadataCommandV1(input: unknown): PatchMessageMetadataCommandV1 {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('command must be an object')
    const value = input as Record<string, unknown>
    const extra = Object.keys(value).filter((key) => !['contract', 'messageId', 'metadata'].includes(key))
    if (extra.length) throw new Error(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (value.contract !== PATCH_MESSAGE_METADATA_COMMAND_V1) throw new Error(`contract must equal ${PATCH_MESSAGE_METADATA_COMMAND_V1}`)
    if (typeof value.messageId !== 'string' || value.messageId.trim() === '') throw new Error('messageId is required')
    return value as unknown as PatchMessageMetadataCommandV1
}
