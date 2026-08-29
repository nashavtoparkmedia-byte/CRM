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
    searchYandexParksByPhonesV1 as searchYandexParksByPhones,
    type ParkPhoneProfileV1,
    upsertParkMatchedDriverV1 as upsertParkMatchedDriver,
} from '../public/v1/park-phone-search'
import { getApiConnections, testApiRequest } from '../public/v1/yandex-fleet-operations'

export type ParkDriverSearchResultV1 = {
    checkedParks: number
    results: Array<{
        parkId: string
        parkName: string
        profiles: ParkPhoneProfileV1[]
    }>
    errors: Array<{ parkId: string; parkName: string; message: string }>
}

export function parkDriverProfileFromYandexV1(value: unknown): ParkPhoneProfileV1 | null {
    const envelope = value as {
        driver_profile?: {
            id?: unknown
            first_name?: unknown
            last_name?: unknown
            middle_name?: unknown
            phones?: unknown
            work_status?: unknown
        }
        current_status?: { status?: unknown }
    }
    const profile = envelope?.driver_profile
    if (!profile?.id) return null
    const fullName = [profile.last_name, profile.first_name, profile.middle_name]
        .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
        .join(' ')
        .trim()
    return {
        id: String(profile.id),
        fullName: fullName || 'Без имени',
        phones: Array.isArray(profile.phones) ? profile.phones.map(String) : [],
        workStatus: profile.work_status ? String(profile.work_status) : null,
        currentStatus: envelope?.current_status?.status ? String(envelope.current_status.status) : null,
    }
}

export function parkDriverMatchesQueryV1(profile: ParkPhoneProfileV1, query: string): boolean {
    const normalizedQuery = query.toLocaleLowerCase('ru-RU').trim()
    if (!normalizedQuery) return false
    const digits = normalizeParkPhoneDigits(normalizedQuery)
    if (digits.length >= 3 && profile.phones.some(phone => normalizeParkPhoneDigits(phone).includes(digits))) {
        return true
    }
    const name = profile.fullName.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim()
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every(token => name.includes(token))
}

async function searchDriverQueryInPark(
    connection: { id: string; parkId: string },
    query: string,
): Promise<ParkPhoneProfileV1[]> {
    const log = await testApiRequest(connection.id, JSON.stringify({
        query: { park: { id: connection.parkId }, text: query },
        fields: {
            driver_profile: ['id', 'first_name', 'last_name', 'middle_name', 'phones', 'work_status'],
            current_status: ['status'],
            car: [],
            account: [],
        },
        limit: 50,
        offset: 0,
    }))
    if (log.statusCode < 200 || log.statusCode >= 300) {
        throw new Error(log.error || `Yandex Fleet HTTP ${log.statusCode}`)
    }
    const body = JSON.parse(log.responseBody || '{}')
    const rawProfiles: unknown[] = Array.isArray(body?.driver_profiles) ? body.driver_profiles : []
    return rawProfiles
        .map(parkDriverProfileFromYandexV1)
        .filter((profile: ParkPhoneProfileV1 | null): profile is ParkPhoneProfileV1 => Boolean(profile))
        .filter(profile => parkDriverMatchesQueryV1(profile, query))
}

/** Fleet-owned multi-park driver search; credentials never leave this capability. */
export async function searchYandexParksByDriverQueryV1(query: string): Promise<ParkDriverSearchResultV1> {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 3) return { checkedParks: 0, results: [], errors: [] }

    const connections = await getApiConnections()
    const checks = await Promise.all(connections.map(async connection => {
        try {
            const profiles = await searchDriverQueryInPark(connection, normalizedQuery)
            return {
                parkId: connection.parkId,
                parkName: connection.name || connection.parkId,
                profiles,
                error: null as string | null,
            }
        } catch (error) {
            return {
                parkId: connection.parkId,
                parkName: connection.name || connection.parkId,
                profiles: [] as ParkPhoneProfileV1[],
                error: error instanceof Error ? error.message : 'Парк не ответил',
            }
        }
    }))

    return {
        checkedParks: connections.length,
        results: checks.filter(check => check.profiles.length > 0).map(check => ({
            parkId: check.parkId,
            parkName: check.parkName,
            profiles: check.profiles,
        })),
        errors: checks.filter(check => check.error).map(check => ({
            parkId: check.parkId,
            parkName: check.parkName,
            message: check.error!,
        })),
    }
}

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
export const reconcileDriverProfileV1 = (...args: Parameters<typeof reconcileDriverProfile>) => reconcileDriverProfile(...args)
export const recordManagerDriverCommunicationV1 = (...args: Parameters<typeof recordManagerDriverCommunication>) => recordManagerDriverCommunication(...args)
export const runCommunicationEventRetentionV1 = (...args: Parameters<typeof runCommunicationEventRetention>) => runCommunicationEventRetention(...args)
export const runScheduledYandexSyncV1 = (...args: Parameters<typeof runScheduledYandexSync>) => runScheduledYandexSync(...args)
export const dispatchScheduledScraperChecksV1 = (...args: Parameters<typeof dispatchScheduledScraperChecks>) => dispatchScheduledScraperChecks(...args)
export const getParkLinkedDriverPhoneV1 = (...args: Parameters<typeof getParkLinkedDriverPhone>) => getParkLinkedDriverPhone(...args)
export const normalizeParkPhoneDigitsV1 = (...args: Parameters<typeof normalizeParkPhoneDigits>) => normalizeParkPhoneDigits(...args)
export const searchYandexParksByPhonesV1 = (...args: Parameters<typeof searchYandexParksByPhones>) => searchYandexParksByPhones(...args)
export const upsertParkMatchedDriverV1 = (...args: Parameters<typeof upsertParkMatchedDriver>) => upsertParkMatchedDriver(...args)
