import { prisma } from '@/lib/prisma'
import type { UpdateScoringThresholdsPersistencePortV1 } from './update-scoring-thresholds-handler'

export const legacyPrismaUpdateScoringThresholdsPortV1: UpdateScoringThresholdsPersistencePortV1 = {
    async upsertThresholds(entries) {
        for (const [key, value] of entries) {
            await prisma.scoringThreshold.upsert({
                where: { key },
                update: { value },
                create: { key, value },
            })
        }
    },
}
