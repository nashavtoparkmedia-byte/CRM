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

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { YandexFleetService } from '@/lib/YandexFleetService'
import { getThresholds, recalculateAllSegments } from '@/lib/scoring'
import {
    RECONCILE_YANDEX_FLEET_COMMAND_V1,
    reconcileYandexFleetV1,
} from '@/modules/fleet-operations/public/v1'

export const YANDEX_SYNC_SERVICE = 'yandex_fleet'
const COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes between manual triggers
export const YANDEX_SYNC_RUNNING_STALE_MS = 30 * 60 * 1000
export const YANDEX_SYNC_LEASE_HEARTBEAT_MS = 60 * 1000
const LEASE_PREFIX = 'lease:'

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
        status: row.status as SyncStatusView['status'],
        errorMessage: row.status === 'running' && row.errorMessage?.startsWith(LEASE_PREFIX)
            ? null
            : row.errorMessage,
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
async function finishStatus(
    leaseMarker: string,
    status: 'success' | 'error' | 'running',
    extras?: Partial<Pick<SyncStatusRow, 'errorMessage' | 'driversUpdated' | 'ordersProcessed'>>
) : Promise<boolean> {
    const result = await prisma.syncStatus.updateMany({
        where: {
            service: YANDEX_SYNC_SERVICE,
            status: 'running',
            errorMessage: leaseMarker,
        },
        data: {
            lastRunAt: new Date(),
            status,
            errorMessage: extras?.errorMessage ?? null,
            driversUpdated: extras?.driversUpdated ?? null,
            ordersProcessed: extras?.ordersProcessed ?? null,
        },
    })
    return result.count === 1
}

async function renewLease(leaseMarker: string): Promise<boolean> {
    const result = await prisma.syncStatus.updateMany({
        where: { service: YANDEX_SYNC_SERVICE, status: 'running', errorMessage: leaseMarker },
        data: { lastRunAt: new Date() },
    })
    return result.count === 1
}

async function runWithLeaseHeartbeat<T>(
    leaseMarker: string,
    operation: () => Promise<T>,
): Promise<{ leaseHeld: true; value: T } | { leaseHeld: false }> {
    let leaseLost = false
    let renewal = Promise.resolve()
    const heartbeat = () => {
        renewal = renewal.then(async () => {
            if (!leaseLost && !await renewLease(leaseMarker)) leaseLost = true
        }).catch(() => {
            leaseLost = true
        })
    }
    const timer = setInterval(heartbeat, YANDEX_SYNC_LEASE_HEARTBEAT_MS)
    try {
        const value = await operation()
        await renewal
        if (leaseLost || !await renewLease(leaseMarker)) return { leaseHeld: false }
        return { leaseHeld: true, value }
    } finally {
        clearInterval(timer)
    }
}

async function acquireLease(bypassCooldown: boolean): Promise<{
    acquired: boolean
    leaseMarker: string
}> {
    const now = new Date()
    const staleBefore = new Date(now.getTime() - YANDEX_SYNC_RUNNING_STALE_MS)
    const cooldownBefore = new Date(now.getTime() - COOLDOWN_MS)
    const leaseMarker = `${LEASE_PREFIX}${randomUUID()}`
    // The statement is deliberately a fixed SQL literal. `$executeRawUnsafe`
    // is used only to pass PostgreSQL positional parameters; no identifier or
    // value is interpolated into the SQL text.
    const acquired = await prisma.$executeRawUnsafe(
        `
        INSERT INTO "SyncStatus" (
            service, "lastRunAt", status, "errorMessage", "driversUpdated", "ordersProcessed", "updatedAt"
        ) VALUES (
            $1, $2, 'running', $3, NULL, NULL, $2
        )
        ON CONFLICT (service) DO UPDATE SET
            "lastRunAt" = EXCLUDED."lastRunAt",
            status = EXCLUDED.status,
            "errorMessage" = EXCLUDED."errorMessage",
            "driversUpdated" = NULL,
            "ordersProcessed" = NULL,
            "updatedAt" = EXCLUDED."updatedAt"
        WHERE (
            "SyncStatus".status <> 'running'
            OR "SyncStatus"."lastRunAt" <= $4
        ) AND (
            $5::boolean
            OR "SyncStatus".status <> 'success'
            OR "SyncStatus"."lastRunAt" <= $6
        )
        `,
        YANDEX_SYNC_SERVICE,
        now,
        leaseMarker,
        staleBefore,
        bypassCooldown,
        cooldownBefore,
    )
    return { acquired: acquired === 1, leaseMarker }
}

export interface RunYandexSyncOptions {
    /** Skip cooldown check (used by automatic cron). */
    bypassCooldown?: boolean
}

export interface RunYandexSyncResult {
    ok: boolean
    /** Reason for refusal when ok = false. */
    reason?: 'already_running' | 'cooldown' | 'error' | 'lease_lost'
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
    // One compare-and-set both enforces the cooldown and acquires a unique
    // fenced lease. Parallel invocations cannot both pass this boundary.
    const lease = await acquireLease(Boolean(options.bypassCooldown))
    if (!lease.acquired) {
        const status = await getYandexSyncStatus()
        if (status.status === 'running') return { ok: false, reason: 'already_running' }
        if (status.cooldownRemainingMs > 0) {
            return {
                ok: false,
                reason: 'cooldown',
                cooldownRemainingMs: status.cooldownRemainingMs,
            }
        }
        return { ok: false, reason: 'already_running' }
    }

    let driversUpdated = 0
    let ordersProcessed = 0

    try {
        const thresholdsPhase = await runWithLeaseHeartbeat(lease.leaseMarker, getThresholds)
        if (!thresholdsPhase.leaseHeld) return { ok: false, reason: 'lease_lost' }
        const thresholds = thresholdsPhase.value

        // 1. One shared, park-qualified reconciler owns profile ingestion for
        // nightly, manual, Contact refresh and confirmation follow-up modes.
        const reconciliationPhase = await runWithLeaseHeartbeat(lease.leaseMarker, () => (
            reconcileYandexFleetV1({
                contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
                mode: 'nightly',
            })
        ))
        if (!reconciliationPhase.leaseHeld) return { ok: false, reason: 'lease_lost' }
        const reconciliation = reconciliationPhase.value
        driversUpdated += reconciliation.profilesUpserted

        // 2. Trips for the analysis period
        const tripsPhase = await runWithLeaseHeartbeat(lease.leaseMarker, () => (
            YandexFleetService.syncTrips(thresholds.analysis_period)
        ))
        if (!tripsPhase.leaseHeld) return { ok: false, reason: 'lease_lost' }
        const trips = tripsPhase.value
        ordersProcessed = trips.ordersProcessed

        // 3. Recalculate segments
        const recalcPhase = await runWithLeaseHeartbeat(lease.leaseMarker, recalculateAllSegments)
        if (!recalcPhase.leaseHeld) return { ok: false, reason: 'lease_lost' }
        const recalc = recalcPhase.value

        if (!await finishStatus(lease.leaseMarker, 'success', { driversUpdated, ordersProcessed })) {
            return { ok: false, reason: 'lease_lost' }
        }

        return {
            ok: true,
            driversUpdated,
            ordersProcessed,
            recalculatedCount: recalc.count,
        }
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        if (!await finishStatus(lease.leaseMarker, 'error', { errorMessage, driversUpdated, ordersProcessed })) {
            return { ok: false, reason: 'lease_lost', errorMessage }
        }
        return { ok: false, reason: 'error', errorMessage }
    }
}
