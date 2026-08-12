import type { ExternalMessageRecordV1 } from '@/contracts/messaging/v1'
import { emitMessageReceived } from '@/lib/messageEvents'

/**
 * Publishes an already-persisted Messaging-owned record to realtime subscribers
 * and, for inbound records only, starts the existing AI event-log pipeline.
 */
export async function publishPersistedMessageV1(message: ExternalMessageRecordV1): Promise<void> {
    return emitMessageReceived(message)
}
