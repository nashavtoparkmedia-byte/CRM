import { prisma } from '@/lib/prisma'

import type { ManualDriverTelegramLinkPersistencePortV1 } from './manual-driver-telegram-link-handler'

export const legacyPrismaManualDriverTelegramLinkPortV1: ManualDriverTelegramLinkPersistencePortV1 = {
    async save(input) {
        await prisma.driverTelegram.upsert({
            where: { driverId: input.driverId },
            update: { telegramId: input.telegramId },
            create: { driverId: input.driverId, telegramId: input.telegramId },
        })
    },
    async remove(driverId) {
        await prisma.driverTelegram.delete({ where: { driverId } })
    },
}
