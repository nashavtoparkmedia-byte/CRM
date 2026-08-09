import { createUpdateDriverStateHandlerV1 } from './update-driver-state-handler'
import { legacyPrismaUpdateDriverStatePortV1 } from './legacy-prisma-driver-attention-adapter'
import { createUpdateScoringThresholdsHandlerV1 } from './update-scoring-thresholds-handler'
import { legacyPrismaUpdateScoringThresholdsPortV1 } from './legacy-prisma-scoring-threshold-adapter'
import { createRecordDriverDailyActivityHandlerV1 } from './record-driver-daily-activity-handler'
import { legacyPrismaRecordDriverDailyActivityPortV1 } from './legacy-prisma-driver-daily-activity-adapter'
import { createClearFleetCheckStatusHandlerV1 } from './clear-fleet-check-status-handler'
import { legacyPrismaClearFleetCheckStatusPortV1 } from './legacy-prisma-clear-fleet-check-status-adapter'
import { createDeleteApiLogsHandlerV1, createRecordApiLogHandlerV1 } from './api-log-handler'
import { legacyPrismaApiLogPortV1 } from './legacy-prisma-api-log-adapter'
import { createResolveImportedDriverHandlerV1 } from './resolve-imported-driver-handler'
import { legacyPrismaResolveImportedDriverPortV1 } from './legacy-prisma-resolve-imported-driver-adapter'
import { createCreateApiConnectionHandlerV1,createDeleteApiConnectionHandlerV1,createUpdateApiConnectionNameHandlerV1 } from './api-connection-handler'
import { legacyPrismaApiConnectionPortV1 } from './legacy-prisma-api-connection-adapter'
import { createMirrorDriverActionResultHandlerV1,createRecordDriverActionHandlerV1 } from './driver-action-handler'
import { legacyPrismaDriverActionPortV1 } from './legacy-prisma-driver-action-adapter'
export { createUpdateDriverStateHandlerV1 } from './update-driver-state-handler'
export type { UpdateDriverStatePersistencePortV1 } from './update-driver-state-handler'
export const updateDriverStateV1=createUpdateDriverStateHandlerV1(legacyPrismaUpdateDriverStatePortV1)
export { createUpdateScoringThresholdsHandlerV1 } from './update-scoring-thresholds-handler'
export type { UpdateScoringThresholdsPersistencePortV1 } from './update-scoring-thresholds-handler'
export const updateScoringThresholdsV1 = createUpdateScoringThresholdsHandlerV1(legacyPrismaUpdateScoringThresholdsPortV1)
export { createRecordDriverDailyActivityHandlerV1 } from './record-driver-daily-activity-handler'
export type { RecordDriverDailyActivityPersistencePortV1 } from './record-driver-daily-activity-handler'
export const recordDriverDailyActivityV1 = createRecordDriverDailyActivityHandlerV1(legacyPrismaRecordDriverDailyActivityPortV1)
export { createClearFleetCheckStatusHandlerV1 } from './clear-fleet-check-status-handler'
export type { ClearFleetCheckStatusPersistencePortV1 } from './clear-fleet-check-status-handler'
export const clearFleetCheckStatusV1 = createClearFleetCheckStatusHandlerV1(legacyPrismaClearFleetCheckStatusPortV1)
export { createDeleteApiLogsHandlerV1, createRecordApiLogHandlerV1 } from './api-log-handler'
export type { ApiLogPersistencePortV1 } from './api-log-handler'
export const deleteApiLogsV1=createDeleteApiLogsHandlerV1(legacyPrismaApiLogPortV1)
export const recordApiLogV1=createRecordApiLogHandlerV1(legacyPrismaApiLogPortV1)
export { createResolveImportedDriverHandlerV1,makeImportedDriverIdV1 } from './resolve-imported-driver-handler'
export type { ResolveImportedDriverPersistencePortV1,ImportedDriverIdFactoryV1 } from './resolve-imported-driver-handler'
export const resolveImportedDriverV1=createResolveImportedDriverHandlerV1(legacyPrismaResolveImportedDriverPortV1)
export { createCreateApiConnectionHandlerV1,createDeleteApiConnectionHandlerV1,createUpdateApiConnectionNameHandlerV1 } from './api-connection-handler'
export type { ApiConnectionPersistencePortV1 } from './api-connection-handler'
export const createApiConnectionV1=createCreateApiConnectionHandlerV1(legacyPrismaApiConnectionPortV1)
export const updateApiConnectionNameV1=createUpdateApiConnectionNameHandlerV1(legacyPrismaApiConnectionPortV1)
export const deleteApiConnectionV1=createDeleteApiConnectionHandlerV1(legacyPrismaApiConnectionPortV1)
export { createMirrorDriverActionResultHandlerV1,createRecordDriverActionHandlerV1 } from './driver-action-handler'
export type { DriverActionPersistencePortV1 } from './driver-action-handler'
export const recordDriverActionV1=createRecordDriverActionHandlerV1(legacyPrismaDriverActionPortV1)
export const mirrorDriverActionResultV1=createMirrorDriverActionResultHandlerV1(legacyPrismaDriverActionPortV1)
