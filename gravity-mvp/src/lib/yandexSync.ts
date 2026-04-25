// Yandex Fleet sync coordinator.
//
// Single entry point for all Yandex Fleet synchronization. Tracks status in the
// SyncStatus table so the UI can show "last sync at HH:MM ✓" / "✗ error".
//
// Used by:
//   • /api/cron/sync-trips  — daily 03:00 cron
//   • triggerYandexSync()   — manual UI button
//
// Concurrency guard: while a sync is running, we mark status = 'running'.
// If a second invocation arrives, it can check this and refuse to start.

import { prisma } from '@/lib/prisma'
import { YandexFleetService } from '@/lib/YandexFleetService'
import { syncActiveDrivers, syncArchivedDrivers } from '@/app/drivers/actions'
import { getThresholds, recalculateAllSegments } from '@/lib/scoring'

export const YANDEX_SYNC_SERVICE = 'yandex_fleet'
const COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes between manual triggers
const RUNNING_STALE_MS = 30 * 60 * 1000  // a "running" lock older than 30min is stale

export interface SyncStatusRow {
    service: string
    lastRunAt: Date
    status: 'success' | 'error' | 'running'
    errorMessage: string | null
    driversUpdated: number | null
    ordersProcessed: number | null
    updatedAt: Date
}

export interface SyncStatusView {
    lastRunAt: string | null     // ISO
    status: 'success' | 'error' | 'running' | 'never'
    errorMessage: string | null
    driversUpdated: number | null
    ordersProcessed: number | null
    cooldownRemainingMs: number  // > 0 → too soon to manual-trigger
}

export async function getYandexSyncStatus(): Promise<SyncStatusView> {
    const row = await prisma.syncStatus.findUnique({
        where: { service: YANDEX_SYNC_SERVICE },
    }) as SyncStatusRow | null

    if (!row) {
        return {
            lastRunAt: null,
            status: 'never',
            errorMessage: null,
            driversUpdated: null,
            ordersProcessed: null,
            cooldownRemainingMs: 0,
        }
    }

    // Compute cooldown for the manual button. We DON'T cooldown after errors —
    // user might want to retry immediately.
    const sinceLastRun = Date.now() - row.lastRunAt.getTime()
    const cooldownRemainingMs = row.status === 'success'
        ? Math.max(0, COOLDOWN_MS - sinceLastRun)
        : 0

    return {
        lastRunAt: row.lastRunAt.toISOString(),
        status: row.status as any,
        errorMessage: row.errorMessage,
        driversUpdated: row.driversUpdated,
        ordersProcessed: row.ordersProcessed,
        cooldownRemainingMs,
    }
}

/**
 * Check if a sync is currently in flight. Stale "running" rows (older than
 * RUNNING_STALE_MS) are treated as not running — protects against process
 * crashes that leave the lock dangling.
 */
async function isSyncRunning(): Promise<boolean> {
    const row = await prisma.syncStatus.findUnique({
        where: { service: YANDEX_SYNC_SERVICE },
    })
    if (!row || row.status !== 'running') return false
    const age = Date.now() - row.lastRunAt.getTime()
    return age < RUNNING_STALE_MS
}

async function setStatus(
    status: 'success' | 'error' | 'running',
    extras?: Partial<Pick<SyncStatusRow, 'errorMessage' | 'driversUpdated' | 'ordersProcessed'>>
) {
    await prisma.syncStatus.upsert({
        where: { service: YANDEX_SYNC_SERVICE },
        update: {
            lastRunAt: new Date(),
            status,
            errorMessage: extras?.errorMessage ?? null,
            driversUpdated: extras?.driversUpdated ?? null,
            ordersProcessed: extras?.ordersProcessed ?? null,
        },
        create: {
            service: YANDEX_SYNC_SERVICE,
            lastRunAt: new Date(),
            status,
            errorMessage: extras?.errorMessage ?? null,
            driversUpdated: extras?.driversUpdated ?? null,
            ordersProcessed: extras?.ordersProcessed ?? null,
        },
    })
}

export interface RunYandexSyncOptions {
    /** Skip cooldown check (used by automatic cron). */
    bypassCooldown?: boolean
}

export interface RunYandexSyncResult {
    ok: boolean
    /** Reason for refusal when ok = false. */
    reason?: 'already_running' | 'cooldown' | 'error'
    cooldownRemainingMs?: number
    errorMessage?: string
    driversUpdated?: number
    ordersProcessed?: number
    recalculatedCount?: number
}

/**
 * Full Yandex Fleet sync:
 *   1. Pull active driver profiles (creates new drivers, updates name/phone)
 *   2. Pull dismissed driver profiles (marks dismissedAt)
 *   3. Pull trips for the analysis period (updates DriverDaySummary)
 *   4. Recalculate segments
 *
 * Updates SyncStatus row at start ('running') and end ('success'|'error').
 */
export async function runYandexSync(
    options: RunYandexSyncOptions = {}
): Promise<RunYandexSyncResult> {
    // Guard 1: concurrency
    if (await isSyncRunning()) {
        return { ok: false, reason: 'already_running' }
    }

    // Guard 2: cooldown for manual triggers
    if (!options.bypassCooldown) {
        const status = await getYandexSyncStatus()
        if (status.cooldownRemainingMs > 0) {
            return {
                ok: false,
                reason: 'cooldown',
                cooldownRemainingMs: status.cooldownRemainingMs,
            }
        }
    }

    await setStatus('running')

    let driversUpdated = 0
    let ordersProcessed = 0

    try {
        const thresholds = await getThresholds()

        // 1. Active drivers
        const active = await syncActiveDrivers()
        driversUpdated += active.count

        // 2. Archived (dismissed) drivers — non-fatal if it fails
        try {
            const archived = await syncArchivedDrivers()
            driversUpdated += archived.count
        } catch (e) {
            console.error('[runYandexSync] archived drivers sync failed (non-fatal):', e)
        }

        // 3. Trips for the analysis period
        const trips = await YandexFleetService.syncTrips(thresholds.analysis_period)
        ordersProcessed = trips.ordersProcessed

        // 4. Recalculate segments
        const recalc = await recalculateAllSegments()

        await setStatus('success', { driversUpdated, ordersProcessed })

        return {
            ok: true,
            driversUpdated,
            ordersProcessed,
            recalculatedCount: recalc.count,
        }
    } catch (err: any) {
        const errorMessage = err?.message || String(err)
        await setStatus('error', { errorMessage, driversUpdated, ordersProcessed })
        return { ok: false, reason: 'error', errorMessage }
    }
}
