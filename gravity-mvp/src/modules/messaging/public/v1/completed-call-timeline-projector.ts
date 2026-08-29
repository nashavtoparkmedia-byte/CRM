import {
  SYNC_CALL_TIMELINE_COMMAND_V1,
  type SyncCallTimelineCommandV1,
  type SyncCallTimelineResultV1,
} from '../../../../contracts/messaging/v1'
import type {
  CompletedCallTimelineProjectionV1,
  CompletedCallTimelineProjectorV1,
} from '../../../calling/public/v1/completed-call-timeline-projection'

export interface CompletedCallTimelineMessagingDependenciesV1 {
  sync(command: SyncCallTimelineCommandV1): Promise<SyncCallTimelineResultV1>
  broadcast(chatId: string, message: Extract<SyncCallTimelineResultV1, { action: 'updated' | 'created' }>['message']): void
}

export function createCompletedCallTimelineMessagingProjectorV1(
  dependencies: CompletedCallTimelineMessagingDependenciesV1,
): CompletedCallTimelineProjectorV1 {
  return async (projection: CompletedCallTimelineProjectionV1) => {
    const result = await dependencies.sync({
      contract: SYNC_CALL_TIMELINE_COMMAND_V1,
      ...projection,
    })
    if (result.action !== 'unchanged') dependencies.broadcast(result.chatId, result.message)
  }
}
