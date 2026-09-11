import { NextResponse } from 'next/server'
import { runScheduledScraperDispatchCronV1 } from '@/modules/operations-observability/public/v1'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    // Ensure this is called by an authorized cron jobs runner (e.g. Vercel Cron, GitHub Actions).
    // Fail closed: an unset CRON_SECRET denies every caller rather than disabling the check.
    const cronSecret = process.env.CRON_SECRET
    const authHeader = request.headers.get('authorization')
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return runScheduledScraperDispatchCronV1()
}
