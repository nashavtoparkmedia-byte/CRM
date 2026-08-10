import {
  RUN_COMMUNICATION_EVENT_RETENTION_RESULT_V1,
  parseRunCommunicationEventRetentionCommandV1,
  type RunCommunicationEventRetentionCommandV1,
  type RunCommunicationEventRetentionResultV1,
} from '../../../../contracts/messaging/v1'

export interface CommunicationEventRetentionPersistencePortV1 {
  runCommunicationEventRetention(input: { dryRun: boolean }): Promise<{ selectedCount: number }>
}

export function createRunCommunicationEventRetentionHandlerV1(
  port: CommunicationEventRetentionPersistencePortV1,
) {
  return async function runCommunicationEventRetentionV1(
    command: RunCommunicationEventRetentionCommandV1 | unknown,
  ): Promise<RunCommunicationEventRetentionResultV1> {
    const parsed = parseRunCommunicationEventRetentionCommandV1(command)
    const result = await port.runCommunicationEventRetention({ dryRun: parsed.dryRun })
    return {
      contract: RUN_COMMUNICATION_EVENT_RETENTION_RESULT_V1,
      selectedCount: result.selectedCount,
    }
  }
}
