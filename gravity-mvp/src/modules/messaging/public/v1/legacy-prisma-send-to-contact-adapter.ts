import { prisma } from '@/lib/prisma'

// SendToContact persistence, Messaging-owned. The intent table is only ever
// inserted into if absent and read: no update or delete exists, so a claimed
// requestId names its first payload forever.
export const legacyPrismaSendToContactPortV1 = {
    async claimIntent(requestId: string, semanticPayloadSha256: string): Promise<string> {
        // Insert if absent (ON CONFLICT DO NOTHING), then read whichever row holds the id.
        await prisma.messagingSendIntent.createMany({ data: [{ requestId, semanticPayloadSha256 }], skipDuplicates: true })
        const bound = await prisma.messagingSendIntent.findUnique({
            where: { requestId },
            select: { semanticPayloadSha256: true },
        })
        if (!bound) throw new Error('MESSAGING_SEND_INTENT_UNAVAILABLE')
        return bound.semanticPayloadSha256
    },
    async findAdmittedMessage(clientMessageId: string) {
        return prisma.message.findUnique({
            where: { clientMessageId },
            select: { id: true, channel: true, direction: true, status: true, metadata: true },
        })
    },
    /** The persisted conversation exactly as the route proof reads it for a send. */
    async readConversationSnapshot(conversationId: string) {
        return prisma.chat.findUnique({
            where: { id: conversationId },
            select: {
                id: true,
                channel: true,
                externalChatId: true,
                chatType: true,
                metadata: true,
                contactId: true,
                contactIdentityId: true,
            },
        })
    },
}
