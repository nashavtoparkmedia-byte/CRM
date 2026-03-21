'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function getThresholdSettings() {
    const rows = await prisma.scoringThreshold.findMany()
    const map: Record<string, number> = {}
    for (const row of rows) {
        map[row.key] = row.value
    }
    return {
        profitable_min: map.profitable_min ?? 20,
        medium_min: map.medium_min ?? 10,
        small_min: map.small_min ?? 1,
        sleeping_days: map.sleeping_days ?? 3,
        risk_days: map.risk_days ?? 3,
        gone_days: map.gone_days ?? 30,
    }
}

export async function updateThresholdSettings(data: Record<string, number>) {
    for (const [key, value] of Object.entries(data)) {
        await prisma.scoringThreshold.upsert({
            where: { key },
            update: { value },
            create: { key, value },
        })
    }
    revalidatePath('/settings/scoring')
    revalidatePath('/drivers')
}
