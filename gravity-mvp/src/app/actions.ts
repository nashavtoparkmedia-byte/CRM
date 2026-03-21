'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function getApiConnections() {
    return await prisma.apiConnection.findMany({
        orderBy: { createdAt: 'desc' },
    })
}

export async function addApiConnection(formData: FormData) {
    const clid = formData.get('clid') as string
    const apiKey = formData.get('apiKey') as string
    const parkId = formData.get('parkId') as string

    if (!clid || !apiKey || !parkId) {
        throw new Error('Missing required fields')
    }

    await prisma.apiConnection.create({
        data: { clid, apiKey, parkId },
    })

    revalidatePath('/')
}

export async function deleteApiConnection(id: string) {
    await prisma.apiLog.deleteMany({ where: { connectionId: id } })
    await prisma.apiConnection.delete({ where: { id } })
    revalidatePath('/')
}

export async function getApiLogs() {
    return await prisma.apiLog.findMany({
        orderBy: { createdAt: 'desc' },
        include: { connection: { select: { clid: true, parkId: true } } },
        take: 100 // pagination placeholder
    })
}

export async function testApiRequest(connectionId: string, testPayload?: string) {
    const connection = await prisma.apiConnection.findUnique({
        where: { id: connectionId }
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
    const log = await prisma.apiLog.create({
        data: {
            connectionId,
            method: testPayload ? 'POST' : 'GET',
            requestUrl: yandexEndpoint,
            requestBody: testPayload || null,
            responseBody,
            statusCode,
            error: errorMsg,
            durationMs
        }
    })

    revalidatePath('/')
    revalidatePath('/logs')

    return log
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
    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
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
    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
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
    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
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
