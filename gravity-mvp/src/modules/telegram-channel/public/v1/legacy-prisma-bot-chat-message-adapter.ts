import { prisma } from '@/lib/prisma'
import type { BotChatMessagePersistencePortV1 } from './bot-chat-message-handler'

export const legacyPrismaBotChatMessagePortV1: BotChatMessagePersistencePortV1 = {
    async dismiss(requestId) {
        await prisma.$transaction(async tx => {
            const [message, registry] = await Promise.all([
                tx.botChatMessage.findUnique({ where: { id: requestId }, select: { telegramId: true } }),
                tx.botUserRegistry.findUnique({ where: { id: requestId }, select: { telegramId: true } }),
            ])
            const telegramId = message?.telegramId || registry?.telegramId

            await tx.botChatMessage.deleteMany({ where: { id: requestId } })
            if (telegramId) {
                await tx.botChatMessage.deleteMany({
                    where: {
                        telegramId,
                        driverId: null,
                        direction: 'INCOMING',
                        text: { startsWith: '[Запрос привязки]' },
                    },
                })
                const linked = await tx.driverTelegram.findUnique({ where: { telegramId }, select: { id: true } })
                if (!linked) await tx.botUserRegistry.deleteMany({ where: { telegramId } })
            }
        })
    },
    async recordPending(input) {
        const telegramId = BigInt(input.telegramId)
        const existing = await prisma.botChatMessage.findFirst({
            where: {
                telegramId,
                driverId: null,
                direction: 'INCOMING',
                text: { startsWith: '[Запрос привязки]' },
            },
            select: { id: true },
        })
        if (existing) {
            await prisma.botChatMessage.update({ where: { id: existing.id }, data: { text: input.text } })
            return
        }
        await prisma.botChatMessage.create({
            data: { telegramId, text: input.text, direction: 'INCOMING', driverId: null },
        })
    },
}
