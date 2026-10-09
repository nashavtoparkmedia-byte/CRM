import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { channelConversationWorkflowV1 } from './channel-conversation-workflow'
import { broadcastChatMessageV1 } from './message-stream'
import type { DeliveryEvidenceRowV1, MessageDeliveryEvidencePortV1 } from './message-delivery-evidence-handler'

const EVIDENCE_ROW_SELECT = {
    id: true,
    chatId: true,
    direction: true,
    channel: true,
    type: true,
    content: true,
    status: true,
    externalId: true,
    metadata: true,
    sentAt: true,
    updatedAt: true,
} as const

// Enough for any burst of one text; the handler re-checks every candidate.
const CANDIDATE_LIMIT = 20

function isUniqueConstraintViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002')
}

export const legacyPrismaMessageDeliveryEvidencePortV1: MessageDeliveryEvidencePortV1 = {
    async findByProviderId(providerMessageId) {
        return await prisma.message.findUnique({
            where: { externalId: providerMessageId },
            select: EVIDENCE_ROW_SELECT,
        }) as DeliveryEvidenceRowV1 | null
    },
    async findUnsettledByContent(input) {
        return await prisma.message.findMany({
            where: {
                chatId: input.chatId,
                channel: input.channel as Prisma.MessageWhereInput['channel'],
                direction: 'outbound',
                type: 'text',
                content: input.content,
                externalId: null,
                sentAt: { gte: input.sentFrom, lte: input.sentTo },
                OR: [
                    { status: 'sent' },
                    { status: 'failed', metadata: { path: ['deliveryOutcome'], equals: 'unknown' } },
                ],
            },
            orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            take: CANDIDATE_LIMIT,
            select: EVIDENCE_ROW_SELECT,
        }) as DeliveryEvidenceRowV1[]
    },
    async apply(row, write) {
        try {
            const updated = await prisma.message.updateMany({
                where: { id: row.id, updatedAt: row.updatedAt },
                data: {
                    status: write.status,
                    externalId: write.externalId,
                    metadata: write.metadata as Prisma.InputJsonValue,
                },
            })
            return updated.count === 1 ? 'applied' : 'stale'
        } catch (error: unknown) {
            if (isUniqueConstraintViolation(error)) return 'provider_id_taken'
            throw error
        }
    },
    async afterApplied(input) {
        if (input.promotedFromFailure) await channelConversationWorkflowV1.onOutboundMessage(input.chatId, input.at)
        try {
            const row = await prisma.message.findUnique({ where: { id: input.messageId } })
            if (row) broadcastChatMessageV1(input.chatId, row)
        } catch { /* the stream must never break the evidence command */ }
    },
    now: () => new Date(),
}
