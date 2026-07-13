import { NextResponse } from 'next/server'
import {
    NIGHTLY_DRIVER_PROFILE_SYNC_CRON,
    NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
    NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
} from '@/lib/driver-profiles/nightly-sync'

/**
 * Legacy external cron entry point.
 *
 * Production scheduling is owned exclusively by the startup-registered
 * multi-park job. Keeping this route non-executable prevents an old external
 * cron configuration or an unauthenticated request from starting a second
 * DriverProfile sync path.
 */
export async function GET() {
    return NextResponse.json(
        {
            ok: false,
            reason: 'legacy_scheduler_disabled',
            scheduler: {
                jobId: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
                cron: NIGHTLY_DRIVER_PROFILE_SYNC_CRON,
                timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
            },
        },
        { status: 410 },
    )
}
