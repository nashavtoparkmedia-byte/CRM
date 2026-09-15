import { prisma } from '@/lib/prisma'
import type { BotUserProfilePersistencePortV1 } from './bot-user-profile-handler'

export const legacyPrismaBotUserProfilePortV1: BotUserProfilePersistencePortV1 = {
    async record(input) {
        const phone = input.phone?.trim() || null
        const hasProfile = Boolean(input.username || input.firstName || input.lastName)
        const hasPhoneObservation = phone !== null
        await prisma.botUserRegistry.upsert({
            where: { telegramId: input.telegramId },
            update: {
                username: input.username || undefined,
                firstName: input.firstName || undefined,
                lastName: input.lastName || undefined,
                profileCheckedAt: hasProfile || hasPhoneObservation ? input.observedAt : undefined,
                phone: phone || undefined,
                // Phone trust belongs to this exact observation. Updating a
                // phone without updating its verification bit could lend a
                // previous phone's trust to an unrelated retry value.
                phoneVerified: hasPhoneObservation ? input.phoneVerified : undefined,
                lastSeenAt: input.observedAt,
            },
            create: {
                telegramId: input.telegramId,
                username: input.username,
                firstName: input.firstName,
                lastName: input.lastName,
                phone,
                phoneVerified: hasPhoneObservation ? input.phoneVerified : false,
                profileCheckedAt: input.observedAt,
            },
        })
    },
}
