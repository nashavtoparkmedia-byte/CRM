import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
    const url = new URL(req.url)
    const driverId = url.searchParams.get('id') || 'f55fbc217bc8db76e06e6fa79894c607'

    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
    if (!connection) return NextResponse.json({ error: 'No connection' })

    const headers = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'X-Park-ID': connection.parkId,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    const contractorUrl = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${driverId}`
    const contractorRes = await fetch(contractorUrl, { method: 'GET', headers })
    const contractorData = safeJson(await contractorRes.text())
    const carId = contractorData?.car_id

    const carsUrl = 'https://fleet-api.taxi.yandex.net/v1/parks/cars/list'
    const carFields = { car: ['id', 'brand', 'model', 'color', 'year', 'number', 'status'] }

    // Try 3 different filter formats
    const [r1, r2, r3, r4] = await Promise.all([
        fetch(carsUrl, { method: 'POST', headers, body: JSON.stringify({ query: { park: { id: connection.parkId }, car: { id: [carId] } }, fields: carFields, limit: 2 }) }),
        fetch(carsUrl, { method: 'POST', headers, body: JSON.stringify({ query: { park: { id: connection.parkId }, car: { ids: [carId] } }, fields: carFields, limit: 2 }) }),
        fetch(carsUrl, { method: 'POST', headers, body: JSON.stringify({ query: { park: { id: connection.parkId }, driver: { driver_profile_id: [driverId] } }, fields: carFields, limit: 2 }) }),
        fetch(carsUrl, { method: 'POST', headers, body: JSON.stringify({ query: { park: { id: connection.parkId }, driver_profile: { id: [driverId] } }, fields: carFields, limit: 2 }) })
    ])

    const results = await Promise.all([r1, r2, r3, r4].map(async (r, i) => ({
        format: ['car.id', 'car.ids', 'driver.driver_profile_id', 'driver_profile.id'][i],
        status: r.status,
        data: safeJson(await r.text())
    })))

    return NextResponse.json({
        contractor_car_id: carId,
        expected_car_id: carId,
        car_filter_tests: results.map(r => ({
            format: r.format,
            status: r.status,
            returned_car_id: r.data?.cars?.[0]?.id,
            returned_plate: r.data?.cars?.[0]?.number,
            matches: r.data?.cars?.[0]?.id === carId
        }))
    })
}

function safeJson(text: string) {
    try { return JSON.parse(text) } catch { return text }
}

