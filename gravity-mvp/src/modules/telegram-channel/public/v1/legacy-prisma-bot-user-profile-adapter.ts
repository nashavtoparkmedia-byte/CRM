import { prisma } from '@/lib/prisma'
import type { BotUserProfilePersistencePortV1 } from './bot-user-profile-handler'

export const legacyPrismaBotUserProfilePortV1: BotUserProfilePersistencePortV1 = {
    async record(input) {
        const phone = input.phone?.trim() || null
        const hasProfile = Boolean(input.username || input.firstName || input.lastName)
        await prisma.botUserRegistry.upsert({
            where: { telegramId: input.telegramId },
            update: {
                username: input.username || undefined,
                firstName: input.firstName || undefined,
                lastName: input.lastName || undefined,
                profileCheckedAt: hasProfile ? input.observedAt : undefined,
                phone: phone || undefined,
                phoneVerified: input.phoneVerified ? true : undefined,
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
    async findLinkStatus(telegramId) {
        const mapping = await prisma.driverTelegram.findFirst({
            where: { telegramId },
            select: { driverId: true, username: true },
        })
        if (!mapping?.driverId) return null
        return { driverId: mapping.driverId, username: mapping.username }
    },
}
