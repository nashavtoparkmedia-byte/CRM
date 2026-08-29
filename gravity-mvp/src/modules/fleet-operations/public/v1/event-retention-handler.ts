import {
  RUN_API_LOG_RETENTION_RESULT_V1,
  RUN_DRIVER_EVENT_RETENTION_RESULT_V1,
  parseRunApiLogRetentionCommandV1,
  parseRunDriverEventRetentionCommandV1,
  type RunApiLogRetentionCommandV1,
  type RunApiLogRetentionResultV1,
  type RunDriverEventRetentionCommandV1,
  type RunDriverEventRetentionResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface FleetEventRetentionPersistencePortV1 {
  runDriverEventRetention(input: { dryRun: boolean }): Promise<{ selectedCount: number }>
  runApiLogRetention(input: { dryRun: boolean }): Promise<{ selectedCount: number }>
}

export function createRunDriverEventRetentionHandlerV1(port: FleetEventRetentionPersistencePortV1) {
  return async function runDriverEventRetentionV1(
    command: RunDriverEventRetentionCommandV1 | unknown,
  ): Promise<RunDriverEventRetentionResultV1> {
    const parsed = parseRunDriverEventRetentionCommandV1(command)
    const result = await port.runDriverEventRetention({ dryRun: parsed.dryRun })
    return {
      contract: RUN_DRIVER_EVENT_RETENTION_RESULT_V1,
      selectedCount: result.selectedCount,
    }
  }
}

export function createRunApiLogRetentionHandlerV1(port: FleetEventRetentionPersistencePortV1) {
  return async function runApiLogRetentionV1(
    command: RunApiLogRetentionCommandV1 | unknown,
  ): Promise<RunApiLogRetentionResultV1> {
    const parsed = parseRunApiLogRetentionCommandV1(command)
    const result = await port.runApiLogRetention({ dryRun: parsed.dryRun })
    return {
      contract: RUN_API_LOG_RETENTION_RESULT_V1,
      selectedCount: result.selectedCount,
    }
  }
}
