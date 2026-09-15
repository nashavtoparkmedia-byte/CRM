import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import { listYandexConnectionCredentialsV1 } from './yandex-connection-capability'
import {
    RECONCILE_YANDEX_FLEET_COMMAND_V1,
    type ReconciledDriverClusterV1,
} from './yandex-fleet-reconciler'
import { legacyPrismaYandexFleetReconcilerPortV1 } from '../../internal/legacy-prisma-yandex-fleet-reconciler-adapter'

const reconcileYandexFleetV1 = legacyPrismaYandexFleetReconcilerPortV1.reconcile

export type ParkPhoneProfileV1 = {
    id: string
    driverId?: string
    profileClusterKey?: string
    contactId?: string | null
    clusterWarnings?: string[]
    contactMergeCandidateIds?: string[]
    fullName: string
    phones: string[]
    workStatus: string | null
    currentStatus: string | null
    legalRole?: string | null
    city?: string | null
    profileType?: string | null
    vu?: string | null
    freshness?: 'fresh' | 'stale' | 'unknown'
    sourceState?: 'current' | 'stale' | 'failed' | 'unknown'
}

export type ParkPhoneSearchResultV1 = {
    checkedParks: number
    results: Array<{
        parkId: string
        parkName: string
        profiles: Array<ParkPhoneProfileV1 & { matchedPhones: string[] }>
    }>
    errors: Array<{ parkId: string; parkName: string; message: string }>
}

export type ParkDriverSearchResultV1 = {
    checkedParks: number
    results: Array<{
        parkId: string
        parkName: string
        profiles: ParkPhoneProfileV1[]
    }>
    errors: Array<{ parkId: string; parkName: string; message: string }>
    clusters?: ReconciledDriverClusterV1[]
}

export function normalizeParkPhoneDigitsV1(value: unknown): string {
    const digits = String(value || '').replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
    if (digits.length === 10) return `7${digits}`
    return digits
}

function samePhone(left: unknown, right: unknown): boolean {
    const a = normalizeParkPhoneDigitsV1(left)
    const b = normalizeParkPhoneDigitsV1(right)
    return Boolean(a && b && (a === b || (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10))))
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
    const digits = normalizeParkPhoneDigitsV1(normalizedQuery)
    if (digits.length >= 3 && profile.phones.some(phone => normalizeParkPhoneDigitsV1(phone).includes(digits))) {
        return true
    }
    const name = profile.fullName.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim()
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every(token => name.includes(token))
}

async function searchDriverQueryInPark(
    connection: { parkId: string; clid: string; apiKey: string },
    query: string,
): Promise<ParkPhoneProfileV1[]> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)
        try {
            const response = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                method: 'POST',
                cache: 'no-store',
                signal: controller.signal,
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: { park: { id: connection.parkId }, text: query },
                    fields: {
                        driver_profile: ['id', 'first_name', 'last_name', 'middle_name', 'phones', 'work_status'],
                        current_status: ['status'],
                        car: [],
                        account: [],
                    },
                    limit: 50,
                    offset: 0,
                }),
            })
            if (!response.ok) {
                const error = new Error(`Yandex Fleet HTTP ${response.status}`)
                if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
                    lastError = error
                    await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
                    continue
                }
                throw error
            }
            const body = await response.json()
            const rawProfiles: unknown[] = Array.isArray(body?.driver_profiles) ? body.driver_profiles : []
            return rawProfiles
                .map(parkDriverProfileFromYandexV1)
                .filter((profile: ParkPhoneProfileV1 | null): profile is ParkPhoneProfileV1 => Boolean(profile))
        } catch (error) {
            lastError = error
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
                continue
            }
        } finally {
            clearTimeout(timeout)
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Yandex Fleet request failed')
}

// Retained as the bounded provider-search primitive used by boundary probes
// and available for a future non-persisting phone lookup path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function searchPhoneInPark(
    connection: { parkId: string; clid: string; apiKey: string },
    phone: string,
): Promise<ParkPhoneProfileV1[]> {
    const profiles = await searchDriverQueryInPark(connection, phone)
    return profiles.filter(profile => profile.phones.some(candidate => samePhone(candidate, phone)))
}

/** Fleet-owned provider capability; credential-bearing rows never cross the owner boundary. */
export async function searchYandexParksByPhonesV1(phones: string[]): Promise<ParkPhoneSearchResultV1> {
    const normalizedPhones = [...new Set(phones.map(normalizePhoneE164).filter((phone): phone is string => Boolean(phone)))]
    const reconciliations = []
    for (const phone of normalizedPhones) {
        reconciliations.push(await reconcileYandexFleetV1({
            contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
            mode: 'contact_refresh',
            query: phone,
        }))
    }
    const parkNames = new Map((await listYandexConnectionCredentialsV1())
        .map(connection => [connection.parkId, connection.name || connection.parkId]))
    const byPark = new Map<string, Map<string, ParkPhoneProfileV1 & { matchedPhones: string[] }>>()
    for (const reconciliation of reconciliations) {
        for (const cluster of reconciliation.clusters) {
            for (const profile of cluster.profiles) {
                const matchedPhones = normalizedPhones.filter(phone => profile.phones.some(candidate => samePhone(candidate, phone)))
                if (matchedPhones.length === 0) continue
                const park = byPark.get(profile.externalParkId) ?? new Map()
                park.set(profile.externalDriverProfileId, {
                    id: profile.externalDriverProfileId,
                    driverId: profile.driverId,
                    profileClusterKey: cluster.profileClusterKey,
                    contactId: cluster.contactId,
                    clusterWarnings: cluster.warnings,
                    contactMergeCandidateIds: cluster.contactMergeCandidateIds,
                    fullName: profile.fullName,
                    phones: profile.phones,
                    workStatus: profile.workStatus ?? profile.status ?? null,
                    currentStatus: profile.currentStatus ?? profile.status ?? null,
                    legalRole: profile.legalRole ?? null,
                    city: profile.city ?? null,
                    profileType: profile.profileType ?? null,
                    vu: profile.rawVu ?? profile.normalizedVu,
                    freshness: profile.sourceFreshness,
                    sourceState: 'current',
                    matchedPhones,
                })
                byPark.set(profile.externalParkId, park)
            }
        }
    }
    const errorMap = new Map<string, { parkId: string; parkName: string; message: string }>()
    for (const reconciliation of reconciliations) {
        for (const error of reconciliation.errors) errorMap.set(`${error.parkId}:${error.message}`, error)
    }
    return {
        checkedParks: reconciliations[0]?.checkedParks ?? 0,
        results: [...byPark.entries()].map(([parkId, profiles]) => ({
            parkId,
            parkName: parkNames.get(parkId) || parkId,
            profiles: [...profiles.values()],
        })),
        errors: [...errorMap.values()],
    }
}

/** Fleet-owned multi-park driver search; credential-bearing rows remain inside the owner. */
export async function searchYandexParksByDriverQueryV1(query: string): Promise<ParkDriverSearchResultV1> {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 3) return { checkedParks: 0, results: [], errors: [] }
    const reconciliation = await reconcileYandexFleetV1({
        contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
        mode: 'manual',
        query: normalizedQuery,
    })
    const parkNames = new Map((await listYandexConnectionCredentialsV1())
        .map(connection => [connection.parkId, connection.name || connection.parkId]))
    const byPark = new Map<string, ParkPhoneProfileV1[]>()
    for (const cluster of reconciliation.clusters) {
        for (const profile of cluster.profiles) {
            const profiles = byPark.get(profile.externalParkId) ?? []
            profiles.push({
                id: profile.externalDriverProfileId,
                driverId: profile.driverId,
                profileClusterKey: cluster.profileClusterKey,
                contactId: cluster.contactId,
                clusterWarnings: cluster.warnings,
                contactMergeCandidateIds: cluster.contactMergeCandidateIds,
                fullName: profile.fullName,
                phones: profile.phones,
                workStatus: profile.workStatus ?? profile.status ?? null,
                currentStatus: profile.currentStatus ?? profile.status ?? null,
                legalRole: profile.legalRole ?? null,
                city: profile.city ?? null,
                profileType: profile.profileType ?? null,
                vu: profile.rawVu ?? profile.normalizedVu,
                freshness: profile.sourceFreshness,
                sourceState: 'current',
            })
            byPark.set(profile.externalParkId, profiles)
        }
    }
    return {
        checkedParks: reconciliation.checkedParks,
        results: [...byPark.entries()].map(([parkId, profiles]) => ({
            parkId,
            parkName: parkNames.get(parkId) || parkId,
            profiles,
        })),
        errors: reconciliation.errors,
        clusters: reconciliation.clusters,
    }
}

export async function getParkLinkedDriverPhoneV1(yandexDriverId: string | null): Promise<string | null> {
    if (!yandexDriverId) return null
    const driver = await prisma.driver.findUnique({
        where: { yandexDriverId },
        select: { phone: true },
    })
    return driver?.phone ?? null
}

/** Exact Fleet-owned write capability used only after a unique park match. */
export async function upsertParkMatchedDriverV1(input: {
    yandexDriverId: string
    fullName: string
    phone: string | null
}): Promise<{ id: string; fullName: string }> {
    return prisma.driver.upsert({
        where: { yandexDriverId: input.yandexDriverId },
        update: {
            fullName: input.fullName,
            phone: input.phone || undefined,
        },
        create: { yandexDriverId: input.yandexDriverId, fullName: input.fullName, phone: input.phone },
        select: { id: true, fullName: true },
    })
}
