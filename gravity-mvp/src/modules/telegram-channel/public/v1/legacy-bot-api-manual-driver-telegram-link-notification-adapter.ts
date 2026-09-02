import { prisma } from '@/lib/prisma'

import { sendExactTelegramBotMessageV1 } from './bot-message-delivery'
import type { ManualDriverTelegramLinkNotificationPortV1 } from './manual-driver-telegram-link-notification-handler'
import { prepareManualDriverTelegramLinkAuthorityV1 } from './manual-driver-telegram-link-authority'

export const legacyBotApiManualDriverTelegramLinkNotificationPortV1:
ManualDriverTelegramLinkNotificationPortV1 = {
    async notify(input) {
        const mapping = await prisma.driverTelegram.findUnique({
            where: { telegramId: input.telegramId },
            select: { driverId: true },
        })
        if (!mapping) throw new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
        const authority = await prepareManualDriverTelegramLinkAuthorityV1({
            driverId: mapping.driverId,
            telegramId: input.telegramId,
        })
        const message = `✅ Ваш профиль водителя успешно привязан к Telegram!\n\nВодитель: *${input.driverName}*\n\nТеперь вы можете использовать кнопку «💳 Управление лимитом» в меню бота.`
        await sendExactTelegramBotMessageV1({
            peerId: authority.target,
            text: message,
            providerAccountId: authority.providerAccountId,
            connectionId: authority.connectionId,
        })
    },
}
