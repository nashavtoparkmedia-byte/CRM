import { revalidatePath } from 'next/cache'

import {
    REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
    SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
    NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
    type NotifyManualDriverTelegramLinkCommandV1,
    type NotifyManualDriverTelegramLinkResultV1,
    type RemoveManualDriverTelegramLinkCommandV1,
    type RemoveManualDriverTelegramLinkResultV1,
    type SaveManualDriverTelegramLinkCommandV1,
    type SaveManualDriverTelegramLinkResultV1,
} from '@/contracts/telegram-channel/v1'
import {
    removeManualDriverTelegramLinkV1,
    saveManualDriverTelegramLinkV1,
    notifyManualDriverTelegramLinkV1,
} from '@/modules/telegram-channel/public/v1'

export interface DriverTelegramLinkOwnerApiV1 {
    saveManualDriverTelegramLinkV1(
        command: SaveManualDriverTelegramLinkCommandV1,
    ): Promise<SaveManualDriverTelegramLinkResultV1>
    removeManualDriverTelegramLinkV1(
        command: RemoveManualDriverTelegramLinkCommandV1,
    ): Promise<RemoveManualDriverTelegramLinkResultV1>
    notifyManualDriverTelegramLinkV1(
        command: NotifyManualDriverTelegramLinkCommandV1,
    ): Promise<NotifyManualDriverTelegramLinkResultV1>
}

export interface DriverTelegramDeliveryAdaptersV1 {
    revalidateDriver(driverId: string): void | Promise<void>
    logError(message: string, error: unknown): void
}

export interface SaveDriverTelegramLinkInputV1 {
    driverId: string
    telegramId: unknown
    driverName?: string
}

export interface DriverTelegramLinkActionResultV1 {
    success: boolean
    error?: string
    mutated?: boolean
}

const defaultOwnerApiV1: DriverTelegramLinkOwnerApiV1 = {
    saveManualDriverTelegramLinkV1,
    removeManualDriverTelegramLinkV1,
    notifyManualDriverTelegramLinkV1,
}

const defaultDeliveryAdaptersV1: DriverTelegramDeliveryAdaptersV1 = {
    revalidateDriver(driverId) {
        revalidatePath(`/drivers/${driverId}`)
    },
    logError(message, error) {
        console.error(message, error)
    },
}

function toLegacyTelegramId(value: unknown): bigint {
    if (
        typeof value !== 'string'
        && typeof value !== 'number'
        && typeof value !== 'bigint'
        && typeof value !== 'boolean'
    ) {
        throw new TypeError('telegramId cannot be converted to bigint')
    }
    return BigInt(value)
}

function errorRecord(error: unknown): Record<string, unknown> | null {
    return typeof error === 'object' && error !== null
        ? error as Record<string, unknown>
        : null
}

function errorCode(error: unknown): string | null {
    const code = errorRecord(error)?.code
    return typeof code === 'string' ? code : null
}

function isAuthorityFailure(error: unknown): boolean {
    const message = errorRecord(error)?.message
    return errorCode(error) === 'DRIVER_TELEGRAM_LINK_CONTRADICTION'
        || (typeof message === 'string' && message.startsWith('DRIVER_TELEGRAM_'))
}

function errorTargetIncludes(error: unknown, expected: string): boolean {
    const meta = errorRecord(errorRecord(error)?.meta)
    const target = meta?.target
    if (typeof target === 'string') return target.includes(expected)
    return Array.isArray(target) && target.includes(expected)
}

export function createDriverTelegramLinkOrchestratorV1(
    owners: DriverTelegramLinkOwnerApiV1,
    delivery: DriverTelegramDeliveryAdaptersV1,
) {
    async function saveDriverTelegramLink(
        input: SaveDriverTelegramLinkInputV1,
    ): Promise<DriverTelegramLinkActionResultV1> {
        try {
            const telegramId = toLegacyTelegramId(input.telegramId)
            await owners.saveManualDriverTelegramLinkV1({
                contract: SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
                driverId: input.driverId,
                telegramId,
            })

            if (input.driverName) {
                try {
                    await owners.notifyManualDriverTelegramLinkV1({
                        contract: NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
                        telegramId,
                        driverName: input.driverName,
                    })
                } catch (error: unknown) {
                    delivery.logError('[notifyDriverLinked] Failed to send notification:', error)
                }
            }

            await delivery.revalidateDriver(input.driverId)
            return { success: true, mutated: true }
        } catch (error: unknown) {
            delivery.logError('Failed to link telegram driver:', error)
            if (errorCode(error) === 'P2002' && errorTargetIncludes(error, 'telegramId')) {
                return { success: false, error: 'Этот Telegram ID уже привязан к другому водителю' }
            }
            if (isAuthorityFailure(error)) {
                return {
                    success: false,
                    error: 'Нужны подтверждённые контакт, личный Telegram-чат и основной водитель',
                }
            }
            return { success: false, error: 'Ошибка базы данных' }
        }
    }

    async function removeDriverTelegramLink(driverId: string): Promise<DriverTelegramLinkActionResultV1> {
        try {
            await owners.removeManualDriverTelegramLinkV1({
                contract: REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
                driverId,
            })
            await delivery.revalidateDriver(driverId)
            return { success: true, mutated: true }
        } catch (error: unknown) {
            if (errorCode(error) === 'P2025') return { success: true, mutated: false }
            delivery.logError('Failed to unlink telegram driver:', error)
            if (isAuthorityFailure(error)) {
                return {
                    success: false,
                    error: 'Нужны подтверждённые контакт, личный Telegram-чат и основной водитель',
                }
            }
            return { success: false, error: 'Ошибка базы данных' }
        }
    }

    return { saveDriverTelegramLink, removeDriverTelegramLink }
}

export const {
    saveDriverTelegramLink,
    removeDriverTelegramLink,
} = createDriverTelegramLinkOrchestratorV1(defaultOwnerApiV1, defaultDeliveryAdaptersV1)
