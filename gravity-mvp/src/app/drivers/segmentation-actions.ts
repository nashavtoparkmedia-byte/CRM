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

/**
 * Trigger bulk recalculation
 */
export async function triggerRecalculation(): Promise<{ count: number }> {
    const thresholds = await getThresholds()
    
    // 1. First sync recent data from Yandex based on analysis period (e.g. 45 days)
    try {
        await YandexFleetService.syncTrips(thresholds.analysis_period)
    } catch (e) {
        console.error('[triggerRecalculation] Sync failed, continuing with local data:', e)
    }

    // 2. Then recalculate all segments in DB
    const result = await recalculateAllSegments()
    revalidatePath('/drivers')
    return result
}

