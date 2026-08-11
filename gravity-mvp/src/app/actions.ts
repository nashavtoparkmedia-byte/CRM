'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { CREATE_API_CONNECTION_COMMAND_V1, DELETE_API_CONNECTION_COMMAND_V1, DELETE_API_LOGS_COMMAND_V1, RECORD_API_LOG_COMMAND_V1, UPDATE_API_CONNECTION_NAME_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import { createApiConnectionV1, deleteApiConnectionV1, deleteApiLogsV1, recordApiLogV1, updateApiConnectionNameV1 } from '@/modules/fleet-operations/public/v1'
import { projectApiConnectionMetadata } from '@/modules/fleet-operations/public/v1/api-connection-public-metadata'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'

// Provider calls are the only server-side consumers that require the API key.
// Keep this selector narrow so a future field cannot cross this boundary by
// accident through an unbounded Prisma row.
const yandexCredentialsSelect = {
    clid: true,
    apiKey: true,
    parkId: true,
} as const

export async function getApiConnections() {
    await requireIntegrationAdminAccess()
    const connections = await prisma.apiConnection.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            clid: true,
            parkId: true,
            name: true,
            createdAt: true,
        },
    })
    return connections.map(connection => projectApiConnectionMetadata({
        id: connection.id,
        clid: connection.clid,
        parkId: connection.parkId,
        name: connection.name,
        createdAt: connection.createdAt,
        // apiKey is required and validated non-empty on creation. Do not
        // select its value merely to derive a browser-facing status flag.
        credentialConfigured: true,
    }))
}

export async function addApiConnection(formData: FormData) {
    await requireIntegrationAdminAccess()
    const clid = formData.get('clid') as string
    const apiKey = formData.get('apiKey') as string
    const parkId = formData.get('parkId') as string
    const name = (formData.get('name') as string) || ''

    if (!clid || !apiKey || !parkId) {
        throw new Error('Missing required fields')
    }

    try {
        await createApiConnectionV1({ contract: CREATE_API_CONNECTION_COMMAND_V1, clid, apiKey, parkId, name: name || null })
    } catch {
        // Credential-bearing persistence inputs must never be reflected through
        // framework error logging or a server-action response.
        console.error('[API-CONNECTION] Failed to create connection')
        throw new Error('Failed to create API connection')
    }

    revalidatePath('/')
}

export async function updateApiConnectionName(id: string, name: string) {
    await requireIntegrationAdminAccess()
    await updateApiConnectionNameV1({ contract: UPDATE_API_CONNECTION_NAME_COMMAND_V1, connectionId: id, name: name || null })
    revalidatePath('/')
}

export async function deleteApiConnection(id: string) {
    await requireIntegrationAdminAccess()
    await deleteApiLogsV1({ contract: DELETE_API_LOGS_COMMAND_V1, connectionId: id })
    await deleteApiConnectionV1({ contract: DELETE_API_CONNECTION_COMMAND_V1, connectionId: id })
    revalidatePath('/')
}

export async function getApiLogs() {
    await requireIntegrationAdminAccess()
    return await prisma.apiLog.findMany({
        orderBy: { createdAt: 'desc' },
        include: { connection: { select: { clid: true, parkId: true } } },
        take: 100 // pagination placeholder
    })
}

export async function testApiRequest(connectionId: string, testPayload?: string) {
    await requireIntegrationAdminAccess()
    const connection = await prisma.apiConnection.findUnique({
        where: { id: connectionId },
        select: yandexCredentialsSelect,
    })

    if (!connection) throw new Error('Connection not found')

    const startTime = Date.now()
    let statusCode = 0
    let responseBody = ''
    let errorMsg = null

    // Yandex Fleet API (Таксопарк) — список профилей водителей
    const yandexEndpoint = `https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list`

    const finalPayload = testPayload ? JSON.parse(testPayload) : {
        query: {
            park: {
                id: connection.parkId
            }
        },
        fields: {
            car: [],
            driver_profile: ["id", "first_name", "last_name", "phones"],
            account: []
        },
        limit: 10,
        offset: 0
    }

    try {
        const res = await fetch(yandexEndpoint, {
            method: 'POST',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(finalPayload)
        })

        statusCode = res.status
        responseBody = await res.text() // Read as text to safely store raw response

        if (!res.ok) {
            errorMsg = `HTTP Error: ${res.status} ${res.statusText}`
        }
    } catch (err: any) {
        errorMsg = err.message || 'Network request failed'
    }

    const durationMs = Date.now() - startTime

    // Save log
    const result = await recordApiLogV1({
        contract: RECORD_API_LOG_COMMAND_V1,
        data: {
            connectionId,
            method: testPayload ? 'POST' : 'GET',
            requestUrl: yandexEndpoint,
            requestBody: testPayload || null,
            responseBody,
            statusCode,
            error: errorMsg,
            durationMs
        },
    })

    revalidatePath('/')
    revalidatePath('/logs')

    return result.log
}

export type DriverStatus = 'working' | 'ready' | 'offline' | 'busy'

export interface Driver {
    id: string
    first_name: string
    last_name: string
    phones: string[]
    status: DriverStatus
    car_id?: string
    balance?: string
    balance_limit?: string
}

export async function getDrivers(page: number = 1, limit: number = 20, search?: string, status?: string) {
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
        select: yandexCredentialsSelect,
    })

    if (!connection) return { drivers: [], total: 0, stats: { online: 0, offline: 0, total: 0 } }

    const yandexEndpoint = `https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list`

    const offset = (page - 1) * limit

    const payload: any = {
        query: {
            park: {
                id: connection.parkId
            }
        },
        fields: {
            car: ["id"],
            driver_profile: ["id", "first_name", "last_name", "phones"],
            account: [],
            current_status: ["status"]
        },
        limit: limit,
        offset: offset
    }

    if (search) {
        payload.query.text = search
    }

    if (status && status !== 'all') {
        payload.query.current_status = { status: [status] }
    }

    try {
        const res = await fetch(yandexEndpoint, {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })

        if (!res.ok) {
            const errorText = await res.text()
            throw new Error(`Yandex API Error: ${res.status} ${errorText}`)
        }

        const data = await res.json()

        const drivers: Driver[] = data.driver_profiles.map((p: any) => ({
            id: p.driver_profile.id,
            first_name: p.driver_profile.first_name,
            last_name: p.driver_profile.last_name,
            phones: p.driver_profile.phones,
            status: p.current_status.status,
            car_id: p.car?.id
        }))

        const total = data.total || 0

        return {
            drivers,
            total,
            stats: {
                online: drivers.filter(d => d.status !== 'offline').length,
                offline: drivers.filter(d => d.status === 'offline').length,
                total: total
            }
        }
    } catch (err: any) {
        console.error('getDrivers error:', err)
        throw err
    }
}

/**
 * Get a single driver's profile from Yandex Fleet API by driver_profile.id
 * Uses GET /v2/parks/contractors/driver-profile which correctly filters by ID
 */
export async function getDriverById(driverProfileId: string): Promise<Driver | null> {
    console.log('[getDriverById] Requesting driver Profile ID:', driverProfileId)
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
        select: yandexCredentialsSelect,
    })
    if (!connection) return null

    try {
        const url = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${driverProfileId}`
        const res = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'X-Park-ID': connection.parkId,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json'
            }
        })

        if (!res.ok) {
            console.error('[getDriverById] Yandex error:', res.status, await res.text())
            return null
        }

        const p = await res.json()
        console.log('[getDriverById] contractor profile:', JSON.stringify(p).substring(0, 400))

        const fn = p.person?.full_name || {}
        const phones = p.person?.contact_info?.phone ? [p.person.contact_info.phone] : []
        const acct = p.account || {}

        return {
            id: driverProfileId,
            first_name: fn.first_name || '',
            last_name: fn.last_name || '',
            phones,
            status: p.profile?.work_status || 'offline',
            car_id: p.car_id,
            balance: acct.balance !== undefined ? String(acct.balance) : undefined,
            balance_limit: acct.balance_limit !== undefined ? String(acct.balance_limit) : undefined
        }
    } catch (err: any) {
        console.error('[getDriverById] Error:', err.message)
        return null
    }
}

export interface Car {
    id: string
    brand?: string
    model?: string
    color?: string
    year?: number
    plate?: string
    status?: string
}

/**
 * Get car details from Yandex Fleet API by car_id.
 * The cars/list filter is ignored by Yandex, so we paginate and find the car in memory.
 */
export async function getCarById(carId: string, _driverProfileId?: string): Promise<Car | null> {
    console.log('[getCarById] Searching for car ID:', carId)
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
        select: yandexCredentialsSelect,
    })
    if (!connection) return null

    try {
        const PAGE = 500
        const MAX_PAGES = 10   // 10 × 500 = 5000 cars max

        for (let page = 0; page < MAX_PAGES; page++) {
            const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/cars/list', {
                method: 'POST',
                cache: 'no-store',
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: { park: { id: connection.parkId } },
                    fields: { car: ['id', 'brand', 'model', 'color', 'year', 'number', 'status'] },
                    limit: PAGE,
                    offset: page * PAGE
                })
            })

            if (!res.ok) {
                console.error('[getCarById] Yandex error:', res.status)
                return null
            }

            const data = await res.json()
            const cars: any[] = data.cars || []
            console.log(`[getCarById] Page ${page}: got ${cars.length} cars, total=${data.total}`)

            const found = cars.find((c: any) => c.id === carId)
            if (found) {
                console.log('[getCarById] Found! plate:', found.number)
                return {
                    id: found.id,
                    brand: found.brand,
                    model: found.model,
                    color: found.color,
                    year: found.year,
                    plate: found.number,
                    status: found.status
                }
            }

            // If we've seen all cars, stop
            if (page * PAGE + cars.length >= data.total) {
                console.warn('[getCarById] Car not found in all', data.total, 'cars')
                break
            }
        }
        return null
    } catch (err: any) {
        console.error('[getCarById] Error:', err.message)
        return null
    }
}

/**
 * Change driver balance limit via Yandex Fleet API.
 * TODO: implement actual Yandex API call
 */
export async function changeDriverLimit(driverProfileId: string, newLimit: number): Promise<{ success: boolean; error?: string }> {
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
        select: yandexCredentialsSelect,
    })
    if (!connection) return { success: false, error: 'No API connection' }

    try {
        const url = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile`
        const res = await fetch(url, {
            method: 'PATCH',
            cache: 'no-store',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'X-Park-ID': connection.parkId,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contractor_profile_id: driverProfileId,
                account: { balance_limit: String(newLimit) }
            })
        })

        if (!res.ok) {
            const errText = await res.text()
            console.error('[changeDriverLimit] Yandex error:', res.status, errText)
            return { success: false, error: `Yandex API: ${res.status}` }
        }

        return { success: true }
    } catch (err: any) {
        console.error('[changeDriverLimit] Error:', err.message)
        return { success: false, error: err.message }
    }
}
