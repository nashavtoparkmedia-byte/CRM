import { createUpdateDriverStateHandlerV1 } from './update-driver-state-handler'
import { legacyPrismaUpdateDriverStatePortV1 } from './legacy-prisma-driver-attention-adapter'
export { createUpdateDriverStateHandlerV1 } from './update-driver-state-handler'
export type { UpdateDriverStatePersistencePortV1 } from './update-driver-state-handler'
export const updateDriverStateV1=createUpdateDriverStateHandlerV1(legacyPrismaUpdateDriverStatePortV1)
