import { prisma } from '@/lib/prisma'
import type { BotUserProfilePersistencePortV1 } from './bot-user-profile-handler'

export const legacyPrismaBotUserProfilePortV1: BotUserProfilePersistencePortV1 = {
    async record(input) {
        const profile = {
            ...(input.username ? { username: input.username } : {}),
            ...(input.firstName ? { firstName: input.firstName } : {}),
            ...(input.lastName ? { lastName: input.lastName } : {}),
        }
        const phone = input.phone?.trim() || null
        await prisma.botUserRegistry.upsert({
            where: { telegramId: input.telegramId },
            update: {
                ...profile,
                ...(Object.keys(profile).length > 0 ? { profileCheckedAt: input.observedAt } : {}),
                ...(phone ? { phone } : {}),
                ...(input.phoneVerified ? { phoneVerified: true } : {}),
                lastSeenAt: input.observedAt,
            },
            create: {
                telegramId: input.telegramId,
                username: input.username,
                firstName: input.firstName,
                lastName: input.lastName,
                phone,
                phoneVerified: input.phoneVerified,
                profileCheckedAt: input.observedAt,
            },
        })
    },
}
