import { prisma } from '@/lib/prisma'
import { listYandexConnectionCredentialsV1 } from './yandex-connection-capability'

export type ParkPhoneProfileV1 = {
    id: string
    fullName: string
    phones: string[]
    workStatus: string | null
    currentStatus: string | null
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
}

export type DriverActionYandexIdentityV1 = {
    parkId: string
    yandexDriverId: string
    resolution: 'preferred-profile' | 'preferred-phone' | 'linked-profile' | 'unique-phone'
}

export type DriverActionIdentityInputV1 = {
    yandexDriverId: string
    phone: string | null
    fullName: string | null
    preferredParkId: string | null
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

/**
 * Select the exact Yandex profile/park used by a driver action.
 *
 * Old Telegram links may not contain activeParkId. In that case the stored
 * Yandex profile id is the strongest identity signal; an exact, unique phone
 * match is the safe fallback. Ambiguous matches deliberately return null.
 */
export function selectDriverActionYandexIdentityV1(
    input: DriverActionIdentityInputV1,
    search: ParkDriverSearchResultV1,
): DriverActionYandexIdentityV1 | null {
    const candidates = search.results.flatMap(park => park.profiles.map(profile => ({
        parkId: park.parkId,
        profile,
    })))
    const working = candidates.filter(candidate => candidate.profile.workStatus !== 'fired')
    const exactPhone = input.phone
        ? working.filter(candidate => candidate.profile.phones.some(phone => samePhone(phone, input.phone)))
        : []

    if (input.preferredParkId) {
        const preferred = working.filter(candidate => candidate.parkId === input.preferredParkId)
        const preferredProfile = preferred.find(candidate => candidate.profile.id === input.yandexDriverId)
        if (preferredProfile) {
            return {
                parkId: preferredProfile.parkId,
                yandexDriverId: preferredProfile.profile.id,
                resolution: 'preferred-profile',
            }
        }

        const preferredPhones = exactPhone.filter(candidate => candidate.parkId === input.preferredParkId)
        if (preferredPhones.length === 1) {
            return {
                parkId: preferredPhones[0].parkId,
                yandexDriverId: preferredPhones[0].profile.id,
                resolution: 'preferred-phone',
            }
        }
        return null
    }

    const linkedProfiles = working.filter(candidate => candidate.profile.id === input.yandexDriverId)
    if (linkedProfiles.length === 1) {
        return {
            parkId: linkedProfiles[0].parkId,
            yandexDriverId: linkedProfiles[0].profile.id,
            resolution: 'linked-profile',
        }
    }

    if (exactPhone.length === 1) {
        return {
            parkId: exactPhone[0].parkId,
            yandexDriverId: exactPhone[0].profile.id,
            resolution: 'unique-phone',
        }
    }
    return null
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
    options: { attempts?: number; timeoutMs?: number } = {},
): Promise<ParkPhoneProfileV1[]> {
    const attempts = Math.max(1, options.attempts ?? 3)
    const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000)
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
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
                if ([429, 500, 502, 503, 504].includes(response.status) && attempt < attempts - 1) {
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
            if (attempt < attempts - 1) {
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
                continue
            }
        } finally {
            clearTimeout(timeout)
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Yandex Fleet request failed')
}

async function searchPhoneInPark(
    connection: { parkId: string; clid: string; apiKey: string },
    phone: string,
): Promise<ParkPhoneProfileV1[]> {
    const profiles = await searchDriverQueryInPark(connection, phone)
    return profiles.filter(profile => profile.phones.some(candidate => samePhone(candidate, phone)))
}

/** Fleet-owned provider capability; credential-bearing rows never cross the owner boundary. */
export async function searchYandexParksByPhonesV1(phones: string[]): Promise<ParkPhoneSearchResultV1> {
    const connections = await listYandexConnectionCredentialsV1()
    const checks: Array<{
        parkId: string
        parkName: string
        profiles: ParkPhoneProfileV1[]
        error: string | null
    }> = []

    for (const connection of connections) {
        const profilesById = new Map<string, ParkPhoneProfileV1>()
        let failedCount = 0
        for (const phone of phones) {
            try {
                const profiles = await searchPhoneInPark(connection, phone)
                for (const profile of profiles) profilesById.set(profile.id, profile)
            } catch {
                failedCount += 1
            }
        }
        checks.push({
            parkId: connection.parkId,
            parkName: connection.name || connection.parkId,
            profiles: [...profilesById.values()],
            error: failedCount === phones.length
                ? 'Парк не ответил'
                : failedCount > 0
                    ? 'Не все телефоны удалось проверить'
                    : null,
        })
    }

    return {
        checkedParks: connections.length,
        results: checks.filter(check => check.profiles.length > 0).map(check => ({
            parkId: check.parkId,
            parkName: check.parkName,
            profiles: check.profiles.map(profile => ({
                ...profile,
                matchedPhones: phones.filter(phone => profile.phones.some(candidate => samePhone(candidate, phone))),
            })),
        })),
        errors: checks.filter(check => check.error).map(check => ({
            parkId: check.parkId,
            parkName: check.parkName,
            message: check.error!,
        })),
    }
}

/** Fleet-owned multi-park driver search; credential-bearing rows remain inside the owner. */
export async function searchYandexParksByDriverQueryV1(
    query: string,
    options: { preferredParkId?: string | null; attempts?: number; timeoutMs?: number } = {},
): Promise<ParkDriverSearchResultV1> {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 3) return { checkedParks: 0, results: [], errors: [] }

    const allConnections = await listYandexConnectionCredentialsV1()
    const connections = options.preferredParkId
        ? allConnections.filter(connection => connection.parkId === options.preferredParkId)
        : allConnections
    const checks = await Promise.all(connections.map(async connection => {
        try {
            const profiles = (await searchDriverQueryInPark(connection, normalizedQuery, options))
                .filter(profile => parkDriverMatchesQueryV1(profile, normalizedQuery))
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

/** Fleet-owned provider lookup for Telegram driver actions. */
export async function resolveDriverActionYandexIdentityV1(
    input: DriverActionIdentityInputV1,
): Promise<DriverActionYandexIdentityV1 | null> {
    const query = input.phone?.trim() || input.fullName?.trim() || ''
    if (query.length < 3) return null
    const search = await searchYandexParksByDriverQueryV1(query, {
        preferredParkId: input.preferredParkId,
        attempts: 1,
        timeoutMs: 8_000,
    })
    return selectDriverActionYandexIdentityV1(input, search)
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
