import { NextResponse } from 'next/server'

import {
    dispatchScheduledScraperChecksV1,
    runScheduledYandexSyncV1,
} from '@/modules/fleet-operations/public/v1'
import { logCronHealth } from '@/lib/cron-health'

function messageFrom(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('message' in error)) return undefined
    return typeof error.message === 'string' ? error.message : undefined
}

export async function runScheduledScraperDispatchCronV1(): Promise<NextResponse> {
    const start = Date.now()
    const result = await dispatchScheduledScraperChecksV1()

    if (result.status === 'connection_missing') {
        return NextResponse.json(
            { error: 'No active Yandex API connection in CRM' },
            { status: 503 },
        )
    }

    const durationMs = Date.now() - start
    if (result.status === 'error') {
        logCronHealth({
            cronName: 'sync-scraper',
            status: 'error',
            durationMs,
            errorMessage: result.errorMessage,
        }).catch(() => {})
        return NextResponse.json({ error: result.errorMessage }, { status: 500 })
    }

    logCronHealth({
        cronName: 'sync-scraper',
        status: 'ok',
        durationMs,
        metadata: {
            dispatched: result.dispatched,
            successCount: result.successCount,
            errorCount: result.errorCount,
        },
    }).catch(() => {})

    return NextResponse.json({
        success: true,
        dispatched: result.dispatched,
        successCount: result.successCount,
        errorCount: result.errorCount,
    })
}

export async function runScheduledYandexSyncCronV1(): Promise<NextResponse> {
    const start = Date.now()
    try {
        const result = await runScheduledYandexSyncV1()
        const durationMs = Date.now() - start

        if (!result.ok) {
            logCronHealth({
                cronName: 'sync-trips',
                status: 'error',
                durationMs,
                errorMessage: result.errorMessage || result.reason || 'unknown',
            }).catch(() => {})
            return NextResponse.json(
                { ok: false, reason: result.reason, error: result.errorMessage },
                { status: result.reason === 'error' ? 500 : 409 },
            )
        }

        logCronHealth({
            cronName: 'sync-trips',
            status: 'ok',
            durationMs,
            metadata: {
                driversUpdated: result.driversUpdated,
                ordersProcessed: result.ordersProcessed,
                recalculatedCount: result.recalculatedCount,
            },
        }).catch(() => {})
        return NextResponse.json(result)
    } catch (error: unknown) {
        const durationMs = Date.now() - start
        const errorMessage = messageFrom(error)
        console.error('[sync-trips] Unexpected error:', errorMessage)
        logCronHealth({
            cronName: 'sync-trips',
            status: 'error',
            durationMs,
            errorMessage,
        }).catch(() => {})
        return NextResponse.json({ error: errorMessage }, { status: 500 })
    }
}
