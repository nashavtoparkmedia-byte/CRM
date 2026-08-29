import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ProposedReplyPersistencePortV1 } from './proposed-reply-handler'

export const legacyPrismaProposedReplyPortV1: ProposedReplyPersistencePortV1 = {
    async upsert(input) {
        return prisma.aiProposedReply.upsert({
            where: { messageId: input.messageId },
            create: {
                messageId: input.messageId,
                chatId: input.chatId,
                text: input.text,
                confidence: input.confidence,
                decisionMode: input.decisionMode,
                reasoning: input.reasoning,
                sources: input.sources as Prisma.InputJsonValue,
                expiresAt: input.expiresAt,
            },
            update: {
                text: input.text,
                confidence: input.confidence,
                decisionMode: input.decisionMode,
                reasoning: input.reasoning,
                sources: input.sources as Prisma.InputJsonValue,
                expiresAt: input.expiresAt,
                generatedAt: new Date(),
                dismissedAt: null,
                takenAt: null,
                sentMessageId: null,
            },
        })
    },
    async patch(proposalId, patch) {
        await prisma.aiProposedReply.update({ where: { id: proposalId }, data: patch })
    },
}
