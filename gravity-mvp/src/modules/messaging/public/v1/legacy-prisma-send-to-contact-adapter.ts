import { prisma } from '@/lib/prisma'

// SendToContact persistence, Messaging-owned. The intent table is only ever
// inserted into if absent and read: no update or delete exists, so a claimed
// requestId names its first payload forever.
export const legacyPrismaSendToContactPortV1 = {
    async claimIntent(requestId: string, semanticPayloadSha256: string): Promise<string> {
        await prisma.$executeRaw`
            INSERT INTO "MessagingSendIntent" ("requestId", "semanticPayloadSha256")
            VALUES (${requestId}, ${semanticPayloadSha256})
            ON CONFLICT ("requestId") DO NOTHING
        `
        const rows = await prisma.$queryRaw<Array<{ semanticPayloadSha256: string }>>`
            SELECT "semanticPayloadSha256" FROM "MessagingSendIntent" WHERE "requestId" = ${requestId}
        `
        if (rows.length !== 1) throw new Error('MESSAGING_SEND_INTENT_UNAVAILABLE')
        return rows[0].semanticPayloadSha256
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
