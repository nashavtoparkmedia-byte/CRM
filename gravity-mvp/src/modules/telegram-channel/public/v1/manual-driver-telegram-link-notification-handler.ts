import {
    NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
    parseNotifyManualDriverTelegramLinkCommandV1,
    type NotifyManualDriverTelegramLinkCommandV1,
    type NotifyManualDriverTelegramLinkResultV1,
} from '../../../../contracts/telegram-channel/v1'

export interface ManualDriverTelegramLinkNotificationPortV1 {
    notify(input: { telegramId: bigint; driverName: string }): Promise<void>
}

export function createNotifyManualDriverTelegramLinkHandlerV1(
    port: ManualDriverTelegramLinkNotificationPortV1,
) {
    return async function notifyManualDriverTelegramLinkV1(
        command: NotifyManualDriverTelegramLinkCommandV1 | unknown,
    ): Promise<NotifyManualDriverTelegramLinkResultV1> {
        const parsed = parseNotifyManualDriverTelegramLinkCommandV1(command)
        await port.notify({ telegramId: parsed.telegramId, driverName: parsed.driverName })
        return { contract: NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1, notified: true }
    }
}
