import {
    createCreateInterventionActionHandlerV1,
    createEnsureInterventionActionsRepositoryHandlerV1,
    createListCompletedInterventionTimesHandlerV1,
    createListInterventionOutcomeCountsHandlerV1,
    createListLatestInterventionActionsHandlerV1,
    createListPendingInterventionActionsHandlerV1,
    createSetInterventionOutcomeHandlerV1,
} from './intervention-actions-repository-handler'
import { legacyPrismaInterventionActionsRepositoryPortV1 } from './legacy-prisma-intervention-actions-repository'

export {
    createCreateInterventionActionHandlerV1,
    createEnsureInterventionActionsRepositoryHandlerV1,
    createListCompletedInterventionTimesHandlerV1,
    createListInterventionOutcomeCountsHandlerV1,
    createListLatestInterventionActionsHandlerV1,
    createListPendingInterventionActionsHandlerV1,
    createSetInterventionOutcomeHandlerV1,
} from './intervention-actions-repository-handler'
export type { InterventionActionsRepositoryPortV1 } from './intervention-actions-repository-handler'

export const ensureInterventionActionsRepositoryV1 =
    createEnsureInterventionActionsRepositoryHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
export const createInterventionActionV1 =
    createCreateInterventionActionHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
export const listPendingInterventionActionsV1 =
    createListPendingInterventionActionsHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
export const setInterventionOutcomeV1 =
    createSetInterventionOutcomeHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
export const listLatestInterventionActionsV1 =
    createListLatestInterventionActionsHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
export const listInterventionOutcomeCountsV1 =
    createListInterventionOutcomeCountsHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
export const listCompletedInterventionTimesV1 =
    createListCompletedInterventionTimesHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
