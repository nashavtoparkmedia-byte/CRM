import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Diagnostic endpoint: test car assignment for a driver
export async function GET(request: Request) {
    const url = new URL(request.url)
    const telegramId = url.searchParams.get('telegramId') || '316425068'

    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: BigInt(telegramId) }
    })

    if (!mapping?.driverId) {
        return NextResponse.json({ error: 'No driver mapping found', telegramId })
    }

    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
    if (!connection) {
        return NextResponse.json({ error: 'No API connection' })
    }

    const headers: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'X-Park-ID': connection.parkId,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    // 1. Get v2 contractor profile (reliable car_id source)
    const v2Url = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${mapping.driverId}`
    const v2Res = await fetch(v2Url, { method: 'GET', headers, cache: 'no-store' })
    const v2Data = v2Res.ok ? await v2Res.json() : { error: `${v2Res.status} ${await v2Res.text()}` }

    // 2. Get v1 driver-profiles/list (check if car is returned here)
    const v1Res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
        method: 'POST',
        headers: {
            'X-Client-ID': connection.clid,
            'X-Api-Key': connection.apiKey,
            'Accept-Language': 'ru',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query: {
                park: { id: connection.parkId },
                driver_profile: { id: [mapping.driverId] }
            },
            fields: {
                driver_profile: ['id', 'first_name', 'last_name'],
                car: ['id', 'brand', 'model', 'number']
            },
            limit: 1,
            offset: 0
        })
    })
    const v1Data = v1Res.ok ? await v1Res.json() : { error: `${v1Res.status}` }

    // Extract relevant data
    const v2CarId = v2Data?.car_id || null
    const v1CarId = v1Data?.driver_profiles?.[0]?.car?.id || null
    const v1CarBrand = v1Data?.driver_profiles?.[0]?.car?.brand || null
    const v1CarNumber = v1Data?.driver_profiles?.[0]?.car?.number || null

    const driverName = (() => {
        const fn = v2Data?.person?.full_name || {}
        return [fn.last_name, fn.first_name, fn.middle_name].filter(Boolean).join(' ')
    })()

    return NextResponse.json({
        driverId: mapping.driverId,
        driverName,
        v2_car_id: v2CarId,
        v1_car_id: v1CarId,
        v1_car_brand: v1CarBrand,
        v1_car_number: v1CarNumber,
        v2_full_profile_keys: v2Data ? Object.keys(v2Data) : [],
        v2_car_id_from_profile: v2Data?.car_id,
        v2_profile_snippet: JSON.stringify(v2Data).substring(0, 800)
    })
}
