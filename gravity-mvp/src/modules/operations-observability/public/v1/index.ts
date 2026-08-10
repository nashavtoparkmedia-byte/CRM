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
import {
    createEnsureManagerHealthRepositoryHandlerV1,
    createListManagerHealthHistoryHandlerV1,
    createListManagerHealthSnapshotsHandlerV1,
    createSaveManagerHealthScoresHandlerV1,
} from './manager-health-repository-handler'
import { legacyPrismaManagerHealthRepositoryPortV1 } from './legacy-prisma-manager-health-repository'

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
export {
    createEnsureManagerHealthRepositoryHandlerV1,
    createListManagerHealthHistoryHandlerV1,
    createListManagerHealthSnapshotsHandlerV1,
    createSaveManagerHealthScoresHandlerV1,
} from './manager-health-repository-handler'
export type { ManagerHealthRepositoryPortV1 } from './manager-health-repository-handler'

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

export const ensureManagerHealthRepositoryV1 =
    createEnsureManagerHealthRepositoryHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
export const listManagerHealthSnapshotsV1 =
    createListManagerHealthSnapshotsHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
export const saveManagerHealthScoresV1 =
    createSaveManagerHealthScoresHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
export const listManagerHealthHistoryV1 =
    createListManagerHealthHistoryHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
