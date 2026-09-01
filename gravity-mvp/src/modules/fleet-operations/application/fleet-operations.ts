import { createUpdateDriverStateHandlerV1 } from '../public/v1/update-driver-state-handler'
import { legacyPrismaUpdateDriverStatePortV1 } from '../public/v1/legacy-prisma-driver-attention-adapter'
import { createUpdateScoringThresholdsHandlerV1 } from '../public/v1/update-scoring-thresholds-handler'
import { legacyPrismaUpdateScoringThresholdsPortV1 } from '../public/v1/legacy-prisma-scoring-threshold-adapter'
import { createRecordDriverDailyActivityHandlerV1 } from '../public/v1/record-driver-daily-activity-handler'
import { legacyPrismaRecordDriverDailyActivityPortV1 } from '../public/v1/legacy-prisma-driver-daily-activity-adapter'
import { createClearFleetCheckStatusHandlerV1 } from '../public/v1/clear-fleet-check-status-handler'
import { legacyPrismaClearFleetCheckStatusPortV1 } from '../public/v1/legacy-prisma-clear-fleet-check-status-adapter'
import { createDeleteApiLogsHandlerV1, createRecordApiLogHandlerV1 } from '../public/v1/api-log-handler'
import { legacyPrismaApiLogPortV1 } from '../public/v1/legacy-prisma-api-log-adapter'
import { createResolveImportedDriverHandlerV1 } from '../public/v1/resolve-imported-driver-handler'
import { legacyPrismaResolveImportedDriverPortV1 } from '../public/v1/legacy-prisma-resolve-imported-driver-adapter'
import { createCreateApiConnectionHandlerV1, createDeleteApiConnectionHandlerV1, createUpdateApiConnectionNameHandlerV1 } from '../public/v1/api-connection-handler'
import { legacyPrismaApiConnectionPortV1 } from '../public/v1/legacy-prisma-api-connection-adapter'
import { createMirrorDriverActionResultHandlerV1, createRecordDriverActionHandlerV1 } from '../public/v1/driver-action-handler'
import { legacyPrismaDriverActionPortV1 } from '../public/v1/legacy-prisma-driver-action-adapter'
import { createRunApiLogRetentionHandlerV1, createRunDriverEventRetentionHandlerV1 } from '../public/v1/event-retention-handler'
import { legacyPrismaFleetEventRetentionPortV1 } from '../public/v1/legacy-prisma-event-retention-adapter'
import { createFindDriverByExactPhoneHandlerV1 } from '../public/v1/find-driver-by-exact-phone-handler'
import { legacyPrismaFindDriverByExactPhonePortV1 } from '../public/v1/legacy-prisma-find-driver-by-exact-phone-adapter'
import { createGetDriverCallablePhoneHandlerV1 } from '../public/v1/get-driver-callable-phone-handler'
import { legacyPrismaGetDriverCallablePhonePortV1 } from '../public/v1/legacy-prisma-get-driver-callable-phone-adapter'
import { createSearchLocalDriversHandlerV1, normalizeDriverSearchQueryV1 } from '../public/v1/search-local-drivers-handler'
import { legacyPrismaSearchLocalDriversPortV1 } from '../public/v1/legacy-prisma-search-local-drivers-adapter'
import { createReconcileDriverProfileHandlerV1 } from '../public/v1/reconcile-driver-profile-handler'
import { legacyPrismaReconcileDriverProfilePortV1 } from '../public/v1/legacy-prisma-reconcile-driver-profile-adapter'
import { createRecordManagerDriverCommunicationHandlerV1 } from '../public/v1/record-manager-driver-communication-handler'
import { legacyPrismaRecordManagerDriverCommunicationPortV1 } from '../public/v1/legacy-prisma-record-manager-driver-communication-adapter'
import { createRunCommunicationEventRetentionHandlerV1 } from '../public/v1/communication-event-retention-handler'
import { legacyPrismaCommunicationEventRetentionPortV1 } from '../public/v1/legacy-prisma-communication-event-retention-adapter'
import { runScheduledYandexSyncV1 as runScheduledYandexSync } from '../public/v1/yandex-sync-runtime'
import { dispatchScheduledScraperChecksV1 as dispatchScheduledScraperChecks } from '../public/v1/scheduled-scraper-check-dispatch'
import {
    getParkLinkedDriverPhoneV1 as getParkLinkedDriverPhone,
    normalizeParkPhoneDigitsV1 as normalizeParkPhoneDigits,
    resolveDriverActionYandexIdentityV1 as resolveDriverActionYandexIdentity,
    resolveParkDriverProfilesByPhoneV1 as resolveParkDriverProfilesByPhone,
    searchYandexParksByDriverQueryV1 as searchYandexParksByDriverQuery,
    searchYandexParksByPhonesV1 as searchYandexParksByPhones,
    type ParkDriverSearchResultV1,
    upsertParkMatchedDriverV1 as upsertParkMatchedDriver,
} from '../public/v1/park-phone-search'

const updateDriverState = createUpdateDriverStateHandlerV1(legacyPrismaUpdateDriverStatePortV1)
const updateScoringThresholds = createUpdateScoringThresholdsHandlerV1(legacyPrismaUpdateScoringThresholdsPortV1)
const recordDriverDailyActivity = createRecordDriverDailyActivityHandlerV1(legacyPrismaRecordDriverDailyActivityPortV1)
const clearFleetCheckStatus = createClearFleetCheckStatusHandlerV1(legacyPrismaClearFleetCheckStatusPortV1)
const deleteApiLogs = createDeleteApiLogsHandlerV1(legacyPrismaApiLogPortV1)
const recordApiLog = createRecordApiLogHandlerV1(legacyPrismaApiLogPortV1)
const resolveImportedDriver = createResolveImportedDriverHandlerV1(legacyPrismaResolveImportedDriverPortV1)
const createApiConnection = createCreateApiConnectionHandlerV1(legacyPrismaApiConnectionPortV1)
const updateApiConnectionName = createUpdateApiConnectionNameHandlerV1(legacyPrismaApiConnectionPortV1)
const deleteApiConnection = createDeleteApiConnectionHandlerV1(legacyPrismaApiConnectionPortV1)
const recordDriverAction = createRecordDriverActionHandlerV1(legacyPrismaDriverActionPortV1)
const mirrorDriverActionResult = createMirrorDriverActionResultHandlerV1(legacyPrismaDriverActionPortV1)
const runDriverEventRetention = createRunDriverEventRetentionHandlerV1(legacyPrismaFleetEventRetentionPortV1)
const runApiLogRetention = createRunApiLogRetentionHandlerV1(legacyPrismaFleetEventRetentionPortV1)
const findDriverByExactPhone = createFindDriverByExactPhoneHandlerV1(legacyPrismaFindDriverByExactPhonePortV1)
const getDriverCallablePhone = createGetDriverCallablePhoneHandlerV1(legacyPrismaGetDriverCallablePhonePortV1)
const searchLocalDrivers = createSearchLocalDriversHandlerV1(legacyPrismaSearchLocalDriversPortV1)
const reconcileDriverProfile = createReconcileDriverProfileHandlerV1(legacyPrismaReconcileDriverProfilePortV1)
const recordManagerDriverCommunication = createRecordManagerDriverCommunicationHandlerV1(legacyPrismaRecordManagerDriverCommunicationPortV1)
const runCommunicationEventRetention = createRunCommunicationEventRetentionHandlerV1(legacyPrismaCommunicationEventRetentionPortV1)

export const updateDriverStateV1 = (...args: Parameters<typeof updateDriverState>) => updateDriverState(...args)
export const updateScoringThresholdsV1 = (...args: Parameters<typeof updateScoringThresholds>) => updateScoringThresholds(...args)
export const recordDriverDailyActivityV1 = (...args: Parameters<typeof recordDriverDailyActivity>) => recordDriverDailyActivity(...args)
export const clearFleetCheckStatusV1 = (...args: Parameters<typeof clearFleetCheckStatus>) => clearFleetCheckStatus(...args)
export const deleteApiLogsV1 = (...args: Parameters<typeof deleteApiLogs>) => deleteApiLogs(...args)
export const recordApiLogV1 = (...args: Parameters<typeof recordApiLog>) => recordApiLog(...args)
export const resolveImportedDriverV1 = (...args: Parameters<typeof resolveImportedDriver>) => resolveImportedDriver(...args)
export const createApiConnectionV1 = (...args: Parameters<typeof createApiConnection>) => createApiConnection(...args)
export const updateApiConnectionNameV1 = (...args: Parameters<typeof updateApiConnectionName>) => updateApiConnectionName(...args)
export const deleteApiConnectionV1 = (...args: Parameters<typeof deleteApiConnection>) => deleteApiConnection(...args)
export const recordDriverActionV1 = (...args: Parameters<typeof recordDriverAction>) => recordDriverAction(...args)
export const mirrorDriverActionResultV1 = (...args: Parameters<typeof mirrorDriverActionResult>) => mirrorDriverActionResult(...args)
export const runDriverEventRetentionV1 = (...args: Parameters<typeof runDriverEventRetention>) => runDriverEventRetention(...args)
export const runApiLogRetentionV1 = (...args: Parameters<typeof runApiLogRetention>) => runApiLogRetention(...args)
export const findDriverByExactPhoneV1 = (...args: Parameters<typeof findDriverByExactPhone>) => findDriverByExactPhone(...args)
export const getDriverCallablePhoneV1 = (...args: Parameters<typeof getDriverCallablePhone>) => getDriverCallablePhone(...args)
export const searchLocalDriversV1 = (...args: Parameters<typeof searchLocalDrivers>) => searchLocalDrivers(...args)
export async function searchYandexParksByDriverQueryV1(query: unknown): Promise<ParkDriverSearchResultV1> {
    const normalized = normalizeDriverSearchQueryV1(query)
    if (normalized.status === 'invalid') return { checkedParks: 0, results: [], errors: [] }
    return searchYandexParksByDriverQuery(normalized.query)
}
export const reconcileDriverProfileV1 = (...args: Parameters<typeof reconcileDriverProfile>) => reconcileDriverProfile(...args)
export const recordManagerDriverCommunicationV1 = (...args: Parameters<typeof recordManagerDriverCommunication>) => recordManagerDriverCommunication(...args)
export const runCommunicationEventRetentionV1 = (...args: Parameters<typeof runCommunicationEventRetention>) => runCommunicationEventRetention(...args)
export const runScheduledYandexSyncV1 = (...args: Parameters<typeof runScheduledYandexSync>) => runScheduledYandexSync(...args)
export const dispatchScheduledScraperChecksV1 = (...args: Parameters<typeof dispatchScheduledScraperChecks>) => dispatchScheduledScraperChecks(...args)
export const getParkLinkedDriverPhoneV1 = (...args: Parameters<typeof getParkLinkedDriverPhone>) => getParkLinkedDriverPhone(...args)
export const normalizeParkPhoneDigitsV1 = (...args: Parameters<typeof normalizeParkPhoneDigits>) => normalizeParkPhoneDigits(...args)
export const resolveDriverActionYandexIdentityV1 = (...args: Parameters<typeof resolveDriverActionYandexIdentity>) => resolveDriverActionYandexIdentity(...args)
export const resolveParkDriverProfilesByPhoneV1 = (...args: Parameters<typeof resolveParkDriverProfilesByPhone>) => resolveParkDriverProfilesByPhone(...args)
export const searchYandexParksByPhonesV1 = (...args: Parameters<typeof searchYandexParksByPhones>) => searchYandexParksByPhones(...args)
export const upsertParkMatchedDriverV1 = (...args: Parameters<typeof upsertParkMatchedDriver>) => upsertParkMatchedDriver(...args)
