import { prisma } from '@/lib/prisma'
import type { LegacyKnowledgeEntryPersistencePortV1 } from './legacy-knowledge-entry-handler'

export const legacyPrismaLegacyKnowledgeEntryPortV1: LegacyKnowledgeEntryPersistencePortV1 = {
    async create(entryId, data) {
        const now = new Date()
        await prisma.knowledgeBaseEntry.create({
            data: {
                id: entryId,
                title: data.title,
                category: data.category,
                sampleQuestions: data.sampleQuestions,
                answer: data.answer,
                tags: data.tags,
                channels: data.channels,
                active: true,
                priority: data.priority,
                createdAt: now,
                updatedAt: now,
            },
        })
    },

    async update(entryId, patch) {
        if (Object.keys(patch).length === 0) return
        const now = new Date()
        await prisma.knowledgeBaseEntry.updateMany({
            where: { id: entryId },
            data: { ...patch, lastReviewedAt: now, updatedAt: now },
        })
    },

    async delete(entryId) {
        await prisma.knowledgeBaseEntry.deleteMany({ where: { id: entryId } })
    },
}
