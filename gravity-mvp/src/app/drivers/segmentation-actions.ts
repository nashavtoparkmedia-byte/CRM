'use server'

import { prisma } from '@/lib/prisma'
import { getThresholds, Thresholds, recalculateAllSegments, getSharedSegmentationStats } from '@/lib/scoring'
import { revalidatePath } from 'next/cache'

/**
 * Fetch current segmentation settings
 */
export async function getSegmentationSettings(): Promise<Thresholds> {
    return await getThresholds()
}

/**
 * Save new segmentation settings to DB
 */
export async function saveSegmentationSettings(settings: Thresholds): Promise<{ success: boolean }> {
    const keys = Object.keys(settings) as Array<keyof Thresholds>
    
    // Use transaction to ensure all or nothing
    await prisma.$transaction(
        keys.map(key => prisma.scoringThreshold.upsert({
            where: { key: String(key) },
            update: { value: settings[key] },
            create: { key: String(key), value: settings[key] }
        }))
    )
    
    return { success: true }
}

/**
 * Get current segment distribution for preview
 * Note: Performs calculation in-memory without saving
 */
export async function getSegmentationPreview(settings: Thresholds): Promise<Record<string, number>> {
    const { counts } = await getSharedSegmentationStats(settings, { excludeGone: true })
    
    // Preview modal specifically wants these 4 segments
    return {
        profitable: counts.profitable,
        medium: counts.medium,
        small: counts.small,
        dropped: counts.dropped
    }
}

import { YandexFleetService } from '@/lib/YandexFleetService'
import { runYandexSync, getYandexSyncStatus as getYandexSyncStatusInternal, type SyncStatusView } from '@/lib/yandexSync'

/**
 * Trigger bulk recalculation.
 * Returns recalculated driver count plus an optional syncError so the UI
 * can warn the user when Yandex Fleet sync silently fails (and the local
 * data being recalculated is stale).
 */
export async function triggerRecalculation(): Promise<{ count: number; syncError?: string }> {
    const thresholds = await getThresholds()
    let syncError: string | undefined

    // 1. First sync recent data from Yandex based on analysis period (e.g. 45 days)
    try {
        await YandexFleetService.syncTrips(thresholds.analysis_period)
    } catch (e: any) {
        syncError = e?.message || String(e)
        console.error('[triggerRecalculation] Sync failed, continuing with local data:', e)
    }

    // 2. Then recalculate all segments in DB
    const result = await recalculateAllSegments()
    revalidatePath('/drivers')
    return { ...result, syncError }
}

// ─── Yandex Fleet sync (drivers + trips, daily cron + manual button) ──────

/**
 * Get the current Yandex Fleet sync status — used by the UI status bar
 * ("Обновлено 25 апр в 03:15 ✓") and by the manual refresh button to know
 * whether it is allowed to fire (cooldown + already-running guards).
 */
export async function getYandexSyncStatus(): Promise<SyncStatusView> {
    return await getYandexSyncStatusInternal()
}

export interface ManualSyncResult {
    ok: boolean
    reason?: 'already_running' | 'cooldown' | 'error'
    cooldownRemainingMs?: number
    errorMessage?: string
    driversUpdated?: number
    ordersProcessed?: number
}

/**
 * Manually trigger a Yandex Fleet sync (the "Обновить" button).
 *
 * Refuses to run if:
 *   • another sync is already in flight ('already_running')
 *   • the last successful run was less than 5 minutes ago ('cooldown')
 *
 * On error, returns reason='error' with errorMessage so the UI can show a
 * red toast with the actual cause (auth issue, network timeout, etc).
 */
export async function triggerYandexSync(): Promise<ManualSyncResult> {
    const result = await runYandexSync()
    if (result.ok) {
        revalidatePath('/drivers')
    }
    return result
}
