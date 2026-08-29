import {
    REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
    SAVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
    parseRemoveManualDriverTelegramLinkCommandV1,
    parseSaveManualDriverTelegramLinkCommandV1,
    type RemoveManualDriverTelegramLinkCommandV1,
    type RemoveManualDriverTelegramLinkResultV1,
    type SaveManualDriverTelegramLinkCommandV1,
    type SaveManualDriverTelegramLinkResultV1,
} from '../../../../contracts/telegram-channel/v1'

export interface ManualDriverTelegramLinkPersistencePortV1 {
    save(input: { driverId: string; telegramId: bigint }): Promise<void>
    remove(driverId: string): Promise<void>
}

export function createSaveManualDriverTelegramLinkHandlerV1(
    port: ManualDriverTelegramLinkPersistencePortV1,
) {
    return async function saveManualDriverTelegramLinkV1(
        command: SaveManualDriverTelegramLinkCommandV1 | unknown,
    ): Promise<SaveManualDriverTelegramLinkResultV1> {
        const parsed = parseSaveManualDriverTelegramLinkCommandV1(command)
        await port.save({ driverId: parsed.driverId, telegramId: parsed.telegramId })
        return { contract: SAVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1, saved: true }
    }
}

export function createRemoveManualDriverTelegramLinkHandlerV1(
    port: ManualDriverTelegramLinkPersistencePortV1,
) {
    return async function removeManualDriverTelegramLinkV1(
        command: RemoveManualDriverTelegramLinkCommandV1 | unknown,
    ): Promise<RemoveManualDriverTelegramLinkResultV1> {
        const parsed = parseRemoveManualDriverTelegramLinkCommandV1(command)
        await port.remove(parsed.driverId)
        return { contract: REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1, removed: true }
    }
}
