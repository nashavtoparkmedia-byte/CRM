import { NextResponse } from 'next/server'
import { runScheduledScraperDispatchCronV1 } from '@/modules/operations-observability/public/v1'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    // Ensure this is called by an authorized cron jobs runner (e.g. Vercel Cron, GitHub Actions)
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return runScheduledScraperDispatchCronV1()
}
