import { headers } from 'next/headers'
import CallsStatsClient, { type StatsPayload } from '@/app/calls/stats/CallsStatsClient'

export const dynamic = 'force-dynamic'

/**
 * /calls/stats — analytics dashboard.
 *
 * SSR fetches the initial payload (last 30 days, all managers) so the page is
 * useful immediately. The client component re-fetches when the user changes
 * filters; default load is the only one that hits the DB during render.
 *
 * We go through fetch() rather than calling the API handler directly because
 * the same endpoint is reused for client-side filter updates — keeping one
 * code path avoids drift between SSR data shape and subsequent CSR payloads.
 */
export default async function CallsStatsPage() {
    const h = await headers()
    const host = h.get('host') ?? 'localhost:3002'
    const proto = h.get('x-forwarded-proto') ?? 'http'
    const baseUrl = `${proto}://${host}`

    let initial: StatsPayload | null = null
    let error: string | null = null
    try {
        const res = await fetch(`${baseUrl}/api/calls/stats`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`stats endpoint returned ${res.status}`)
        initial = await res.json()
    } catch (err: any) {
        error = err.message ?? 'не удалось загрузить статистику'
    }

    return <CallsStatsClient initial={initial} error={error} />
}
