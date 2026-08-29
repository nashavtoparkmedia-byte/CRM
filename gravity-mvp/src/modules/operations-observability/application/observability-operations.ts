import {
    createCreateInterventionActionHandlerV1,
    createEnsureInterventionActionsRepositoryHandlerV1,
    createListCompletedInterventionTimesHandlerV1,
    createListInterventionOutcomeCountsHandlerV1,
    createListLatestInterventionActionsHandlerV1,
    createListPendingInterventionActionsHandlerV1,
    createSetInterventionOutcomeHandlerV1,
} from '../public/v1/intervention-actions-repository-handler'
import { legacyPrismaInterventionActionsRepositoryPortV1 } from '../public/v1/legacy-prisma-intervention-actions-repository'
import {
    createEnsureManagerHealthRepositoryHandlerV1,
    createListManagerHealthHistoryHandlerV1,
    createListManagerHealthSnapshotsHandlerV1,
    createSaveManagerHealthScoresHandlerV1,
} from '../public/v1/manager-health-repository-handler'
import { legacyPrismaManagerHealthRepositoryPortV1 } from '../public/v1/legacy-prisma-manager-health-repository'
import {
    runScheduledScraperDispatchCronV1 as runScheduledScraperDispatchCron,
    runScheduledYandexSyncCronV1 as runScheduledYandexSyncCron,
} from '../public/v1/scheduled-fleet-cron-routes'

const ensureInterventionActionsRepository = createEnsureInterventionActionsRepositoryHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const createInterventionAction = createCreateInterventionActionHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const listPendingInterventionActions = createListPendingInterventionActionsHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const setInterventionOutcome = createSetInterventionOutcomeHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const listLatestInterventionActions = createListLatestInterventionActionsHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const listInterventionOutcomeCounts = createListInterventionOutcomeCountsHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const listCompletedInterventionTimes = createListCompletedInterventionTimesHandlerV1(legacyPrismaInterventionActionsRepositoryPortV1)
const ensureManagerHealthRepository = createEnsureManagerHealthRepositoryHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
const listManagerHealthSnapshots = createListManagerHealthSnapshotsHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
const saveManagerHealthScores = createSaveManagerHealthScoresHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)
const listManagerHealthHistory = createListManagerHealthHistoryHandlerV1(legacyPrismaManagerHealthRepositoryPortV1)

export const ensureInterventionActionsRepositoryV1 = (...args: Parameters<typeof ensureInterventionActionsRepository>) => ensureInterventionActionsRepository(...args)
export const createInterventionActionV1 = (...args: Parameters<typeof createInterventionAction>) => createInterventionAction(...args)
export const listPendingInterventionActionsV1 = (...args: Parameters<typeof listPendingInterventionActions>) => listPendingInterventionActions(...args)
export const setInterventionOutcomeV1 = (...args: Parameters<typeof setInterventionOutcome>) => setInterventionOutcome(...args)
export const listLatestInterventionActionsV1 = (...args: Parameters<typeof listLatestInterventionActions>) => listLatestInterventionActions(...args)
export const listInterventionOutcomeCountsV1 = (...args: Parameters<typeof listInterventionOutcomeCounts>) => listInterventionOutcomeCounts(...args)
export const listCompletedInterventionTimesV1 = (...args: Parameters<typeof listCompletedInterventionTimes>) => listCompletedInterventionTimes(...args)
export const ensureManagerHealthRepositoryV1 = (...args: Parameters<typeof ensureManagerHealthRepository>) => ensureManagerHealthRepository(...args)
export const listManagerHealthSnapshotsV1 = (...args: Parameters<typeof listManagerHealthSnapshots>) => listManagerHealthSnapshots(...args)
export const saveManagerHealthScoresV1 = (...args: Parameters<typeof saveManagerHealthScores>) => saveManagerHealthScores(...args)
export const listManagerHealthHistoryV1 = (...args: Parameters<typeof listManagerHealthHistory>) => listManagerHealthHistory(...args)
export const runScheduledScraperDispatchCronV1 = (...args: Parameters<typeof runScheduledScraperDispatchCron>) => runScheduledScraperDispatchCron(...args)
export const runScheduledYandexSyncCronV1 = (...args: Parameters<typeof runScheduledYandexSyncCron>) => runScheduledYandexSyncCron(...args)
