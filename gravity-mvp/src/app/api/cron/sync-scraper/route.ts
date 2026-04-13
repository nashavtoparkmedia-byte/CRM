import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logCronHealth } from '@/lib/cron-health'

export const dynamic = 'force-dynamic'

const SCRAPER_API_URL = process.env.SCRAPER_API_URL || 'http://localhost:3003/api/checks'

export async function GET(request: Request) {
    const start = Date.now()

    // Ensure this is called by an authorized cron jobs runner (e.g. Vercel Cron, GitHub Actions)
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
    if (!connection) {
        return NextResponse.json({ error: 'No active Yandex API connection in CRM' }, { status: 503 })
    }

    const headers: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    let offset = 0
    let total = 1
    const licenses: string[] = []

    try {
        console.log('[Cron] Fetching all driver profiles from Yandex...')
        while (offset < total) {
            const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                method: 'POST',
                cache: 'no-store',
                headers,
                body: JSON.stringify({
                    query: { park: { id: connection.parkId } },
                    fields: { driver_profile: ['id', 'license_info'] },
                    limit: 500,
                    offset
                })
            })

            if (!res.ok) {
                console.error('[Cron] Failed to fetch drivers:', await res.text())
                break
            }

            const data = await res.json()
            total = data.total || 0

            const profiles = data.driver_profiles || []
            for (const p of profiles) {
                const license = p.driver_profile?.license_info?.number
                if (license) {
                    const normalized = license.replace(/\s+/g, '').toUpperCase()
                    if (normalized) licenses.push(normalized)
                }
            }

            offset += 500
        }

        console.log(`[Cron] Found ${licenses.length} drivers with licenses. Dispatching to Scraper (${SCRAPER_API_URL})...`)

        let successCount = 0
        let errorCount = 0

        // Send sequentially or in chunks. Sequential is fine if it's async and we don't block UI.
        for (const license of licenses) {
            try {
                const res = await fetch(SCRAPER_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ license, priority: 'NORMAL' })
                })

                if (res.ok) successCount++
                else errorCount++
            } catch (err) {
                errorCount++
            }
        }

        const durationMs = Date.now() - start
        logCronHealth({
            cronName: 'sync-scraper',
            status: 'ok',
            durationMs,
            metadata: { dispatched: licenses.length, successCount, errorCount },
        }).catch(() => {})

        return NextResponse.json({
            success: true,
            dispatched: licenses.length,
            successCount,
            errorCount
        })

    } catch (err: any) {
        const durationMs = Date.now() - start
        console.error('[Cron] Exception:', err.message)
        logCronHealth({
            cronName: 'sync-scraper',
            status: 'error',
            durationMs,
            errorMessage: err.message,
        }).catch(() => {})
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
