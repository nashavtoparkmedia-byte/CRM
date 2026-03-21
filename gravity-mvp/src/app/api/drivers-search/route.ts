import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') || ''

    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' }
    })

    if (!connection) {
        return NextResponse.json({ error: 'No Yandex API connection configured' }, { status: 500 })
    }

    try {
        const payload: any = {
            query: {
                park: { id: connection.parkId }
            },
            fields: {
                car: ["id"],
                driver_profile: ["id", "first_name", "last_name", "phones"],
                account: [],
                current_status: ["status"]
            },
            limit: 20,
            offset: 0
        }

        if (q) {
            payload.query.text = q
        }

        const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
            method: 'POST',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })

        if (!res.ok) {
            const errText = await res.text()
            console.error('Yandex API error:', errText)
            return NextResponse.json({ error: `Yandex API error: ${res.status}`, details: errText }, { status: 502 })
        }

        const data = await res.json()
        const drivers = (data.driver_profiles || []).map((p: any) => ({
            id: p.driver_profile.id,
            first_name: p.driver_profile.first_name,
            last_name: p.driver_profile.last_name,
            phones: p.driver_profile.phones,
            status: p.current_status?.status
        }))

        return NextResponse.json({ drivers, total: data.total || drivers.length })
    } catch (err: any) {
        console.error('drivers-search error:', err)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
