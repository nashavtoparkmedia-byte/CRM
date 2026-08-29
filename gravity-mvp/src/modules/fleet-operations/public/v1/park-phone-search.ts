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

async function searchPhoneInPark(
    connection: { parkId: string; clid: string; apiKey: string },
    phone: string,
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
                    query: { park: { id: connection.parkId }, text: phone },
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
                .filter(profile => profile.phones.some(candidate => samePhone(candidate, phone)))
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
                .filter(profile => parkDriverMatchesQueryV1(profile, query))
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

/** Fleet-owned multi-park driver search; credentials never leave this capability. */
export async function searchYandexParksByDriverQueryV1(query: string): Promise<ParkDriverSearchResultV1> {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 3) return { checkedParks: 0, results: [], errors: [] }

    const connections = await listYandexConnectionCredentialsV1()
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
        update: { fullName: input.fullName, ...(input.phone ? { phone: input.phone } : {}) },
        create: { yandexDriverId: input.yandexDriverId, fullName: input.fullName, phone: input.phone },
        select: { id: true, fullName: true },
    })
}
