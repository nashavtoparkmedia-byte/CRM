import { createUpdateDriverStateHandlerV1 } from './update-driver-state-handler'
import { legacyPrismaUpdateDriverStatePortV1 } from './legacy-prisma-driver-attention-adapter'
import { createUpdateScoringThresholdsHandlerV1 } from './update-scoring-thresholds-handler'
import { legacyPrismaUpdateScoringThresholdsPortV1 } from './legacy-prisma-scoring-threshold-adapter'
export { createUpdateDriverStateHandlerV1 } from './update-driver-state-handler'
export type { UpdateDriverStatePersistencePortV1 } from './update-driver-state-handler'
export const updateDriverStateV1=createUpdateDriverStateHandlerV1(legacyPrismaUpdateDriverStatePortV1)
export { createUpdateScoringThresholdsHandlerV1 } from './update-scoring-thresholds-handler'
export type { UpdateScoringThresholdsPersistencePortV1 } from './update-scoring-thresholds-handler'
export const updateScoringThresholdsV1 = createUpdateScoringThresholdsHandlerV1(legacyPrismaUpdateScoringThresholdsPortV1)
