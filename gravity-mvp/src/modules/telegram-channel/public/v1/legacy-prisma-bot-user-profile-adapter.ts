import { prisma } from '@/lib/prisma'
import type { BotUserProfilePersistencePortV1 } from './bot-user-profile-handler'

export const legacyPrismaBotUserProfilePortV1: BotUserProfilePersistencePortV1 = {
    async record(input) {
        await prisma.botUserRegistry.upsert({
            where: { telegramId: input.telegramId },
            update: {
                username: input.username,
                firstName: input.firstName,
                lastName: input.lastName,
                profileCheckedAt: input.observedAt,
                lastSeenAt: input.observedAt,
            },
            create: {
                telegramId: input.telegramId,
                username: input.username,
                firstName: input.firstName,
                lastName: input.lastName,
                profileCheckedAt: input.observedAt,
            },
        })
    },
}
