import { prisma } from '@/lib/prisma'

const SCRAPER_API_URL = process.env.SCRAPER_API_URL || 'http://localhost:3003/api/checks'
const YANDEX_DRIVER_PROFILES_URL =
    'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list'

export type ScheduledScraperCheckDispatchResultV1 =
    | { status: 'connection_missing' }
    | { status: 'error', errorMessage?: string }
    | {
        status: 'success'
        dispatched: number
        successCount: number
        errorCount: number
    }

type YandexDriverProfilePageV1 = {
    total?: number
    driver_profiles?: Array<{
        driver_profile?: {
            license_info?: { number?: string | null } | null
        } | null
    }>
}

function messageFrom(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('message' in error)) return undefined
    return typeof error.message === 'string' ? error.message : undefined
}

/**
 * Fixed Fleet-owned scheduled operation. Credentials and provider payloads never
 * cross the boundary; callers receive only aggregate dispatch outcomes.
 */
export async function dispatchScheduledScraperChecksV1():
Promise<ScheduledScraperCheckDispatchResultV1> {
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
    })
    if (!connection) return { status: 'connection_missing' }

    const headers: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json',
    }

    let offset = 0
    let total = 1
    const licenses: string[] = []

    try {
        console.log('[Cron] Fetching all driver profiles from Yandex...')
        while (offset < total) {
            const response = await fetch(YANDEX_DRIVER_PROFILES_URL, {
                method: 'POST',
                cache: 'no-store',
                headers,
                body: JSON.stringify({
                    query: { park: { id: connection.parkId } },
                    fields: { driver_profile: ['id', 'license_info'] },
                    limit: 500,
                    offset,
                }),
            })

            if (!response.ok) {
                console.error('[Cron] Failed to fetch drivers:', await response.text())
                break
            }

            const data = await response.json() as YandexDriverProfilePageV1
            total = data.total || 0

            for (const profile of data.driver_profiles || []) {
                const license = profile.driver_profile?.license_info?.number
                if (!license) continue
                const normalized = license.replace(/\s+/g, '').toUpperCase()
                if (normalized) licenses.push(normalized)
            }

            offset += 500
        }

        console.log(
            `[Cron] Found ${licenses.length} drivers with licenses. Dispatching to Scraper (${SCRAPER_API_URL})...`,
        )

        let successCount = 0
        let errorCount = 0
        for (const license of licenses) {
            try {
                const response = await fetch(SCRAPER_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ license, priority: 'NORMAL' }),
                })
                if (response.ok) successCount++
                else errorCount++
            } catch {
                errorCount++
            }
        }

        return {
            status: 'success',
            dispatched: licenses.length,
            successCount,
            errorCount,
        }
    } catch (error: unknown) {
        const errorMessage = messageFrom(error)
        console.error('[Cron] Exception:', errorMessage)
        return { status: 'error', errorMessage }
    }
}
