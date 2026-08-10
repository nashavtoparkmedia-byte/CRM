import type { ManualDriverTelegramLinkNotificationPortV1 } from './manual-driver-telegram-link-notification-handler'

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:4000/api/bot'

export const legacyBotApiManualDriverTelegramLinkNotificationPortV1:
ManualDriverTelegramLinkNotificationPortV1 = {
    async notify(input) {
        const message = `✅ Ваш профиль водителя успешно привязан к Telegram!\n\nВодитель: *${input.driverName}*\n\nТеперь вы можете использовать кнопку «💳 Управление лимитом» в меню бота.`
        await fetch(`${BOT_API_URL}/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: input.telegramId.toString(), text: message }),
        })
    },
}
