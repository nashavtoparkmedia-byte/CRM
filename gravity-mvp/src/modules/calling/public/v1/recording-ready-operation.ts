import type { RecordingReadyEventV1 } from '../../../../contracts/calling/v1'

/**
 * Provider-neutral input accepted by Calling's ready-to-use recording
 * persistence operation. Public callers cannot supply a transaction, Prisma
 * client, repository, or other write capability.
 */
export interface PersistRecordingReadyInputV1 {
    callId: string
    recordingPath: string
    correlationId?: string | null
    causationId?: string | null
}

export type PersistRecordingReadyV1 = (
    input: PersistRecordingReadyInputV1,
) => Promise<RecordingReadyEventV1>
