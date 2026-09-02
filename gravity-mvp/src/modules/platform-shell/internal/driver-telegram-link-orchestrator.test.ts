import { describe, expect, it, vi } from 'vitest'

import {
    NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
    REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
    SAVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
} from '@/contracts/telegram-channel/v1'

import {
    createDriverTelegramLinkOrchestratorV1,
    type DriverTelegramDeliveryAdaptersV1,
    type DriverTelegramLinkOwnerApiV1,
} from './driver-telegram-link-orchestrator'

function fixture(options: {
    saveError?: unknown
    removeError?: unknown
    notifyError?: unknown
    revalidateError?: unknown
} = {}) {
    const order: string[] = []
    const owners: DriverTelegramLinkOwnerApiV1 = {
        saveManualDriverTelegramLinkV1: vi.fn(async () => {
            order.push('save-owner')
            if (options.saveError) throw options.saveError
            return { contract: SAVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1, saved: true as const }
        }),
        removeManualDriverTelegramLinkV1: vi.fn(async () => {
            order.push('remove-owner')
            if (options.removeError) throw options.removeError
            return { contract: REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1, removed: true as const }
        }),
        notifyManualDriverTelegramLinkV1: vi.fn(async () => {
            order.push('notify')
            if (options.notifyError) throw options.notifyError
            return {
                contract: NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_RESULT_V1,
                notified: true as const,
            }
        }),
    }
    const delivery: DriverTelegramDeliveryAdaptersV1 = {
        revalidateDriver: vi.fn(async () => {
            order.push('revalidate')
            if (options.revalidateError) throw options.revalidateError
        }),
        logError: vi.fn((message) => order.push(`log:${message}`)),
    }
    return {
        order,
        owners,
        delivery,
        orchestrator: createDriverTelegramLinkOrchestratorV1(owners, delivery),
    }
}

describe('driver Telegram link Platform orchestration', () => {
    it('maps save exactly and revalidates only after the owner write', async () => {
        const current = fixture()
        await expect(current.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
        })).resolves.toEqual({ success: true, mutated: true })
        expect(current.owners.saveManualDriverTelegramLinkV1).toHaveBeenCalledWith({
            contract: 'telegram_channel.SaveManualDriverTelegramLinkCommand.v1',
            driverId: 'driver-1',
            telegramId: 42n,
        })
        expect(current.order).toEqual(['save-owner', 'revalidate'])
    })

    it('keeps the optional notification before revalidation', async () => {
        const current = fixture()
        await current.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
            driverName: 'Driver One',
        })
        expect(current.owners.notifyManualDriverTelegramLinkV1).toHaveBeenCalledWith({
            contract: 'telegram_channel.NotifyManualDriverTelegramLinkCommand.v1',
            telegramId: 42n,
            driverName: 'Driver One',
        })
        expect(current.order).toEqual(['save-owner', 'notify', 'revalidate'])
    })

    it('logs and swallows notification failure before revalidating', async () => {
        const failure = new Error('bot down')
        const current = fixture({ notifyError: failure })
        await expect(current.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
            driverName: 'Driver One',
        })).resolves.toEqual({ success: true, mutated: true })
        expect(current.delivery.logError).toHaveBeenCalledWith(
            '[notifyDriverLinked] Failed to send notification:',
            failure,
        )
        expect(current.order).toEqual([
            'save-owner',
            'notify',
            'log:[notifyDriverLinked] Failed to send notification:',
            'revalidate',
        ])
    })

    it('maps only the exact Telegram unique conflict and skips later effects', async () => {
        const failure = { code: 'P2002', meta: { target: ['telegramId'] } }
        const current = fixture({ saveError: failure })
        await expect(current.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
            driverName: 'Driver One',
        })).resolves.toEqual({
            success: false,
            error: 'Этот Telegram ID уже привязан к другому водителю',
        })
        expect(current.delivery.logError).toHaveBeenCalledWith('Failed to link telegram driver:', failure)
        expect(current.order).toEqual(['save-owner', 'log:Failed to link telegram driver:'])
    })

    it('maps other conflicts and invalid BigInt input to the generic legacy result', async () => {
        const conflict = fixture({ saveError: { code: 'P2002', meta: { target: ['driverId'] } } })
        await expect(conflict.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
        })).resolves.toEqual({ success: false, error: 'Ошибка базы данных' })

        const invalid = fixture()
        await expect(invalid.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: undefined,
        })).resolves.toEqual({ success: false, error: 'Ошибка базы данных' })
        expect(invalid.owners.saveManualDriverTelegramLinkV1).not.toHaveBeenCalled()
        expect(invalid.order).toEqual(['log:Failed to link telegram driver:'])
    })

    it('maps missing authority without notification or revalidation', async () => {
        const failure = new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
        const current = fixture({ saveError: failure })

        await expect(current.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
            driverName: 'Driver One',
        })).resolves.toEqual({
            success: false,
            error: 'Нужны подтверждённые контакт, личный Telegram-чат и основной водитель',
        })
        expect(current.owners.notifyManualDriverTelegramLinkV1).not.toHaveBeenCalled()
        expect(current.delivery.revalidateDriver).not.toHaveBeenCalled()
    })

    it('keeps revalidation failure visible after the persisted save', async () => {
        const failure = new Error('revalidate down')
        const current = fixture({ revalidateError: failure })
        await expect(current.orchestrator.saveDriverTelegramLink({
            driverId: 'driver-1',
            telegramId: '42',
        })).resolves.toEqual({ success: false, error: 'Ошибка базы данных' })
        expect(current.delivery.logError).toHaveBeenCalledWith('Failed to link telegram driver:', failure)
        expect(current.order).toEqual(['save-owner', 'revalidate', 'log:Failed to link telegram driver:'])
    })

    it('maps remove exactly and revalidates after deletion', async () => {
        const current = fixture()
        await expect(current.orchestrator.removeDriverTelegramLink('driver-1'))
            .resolves.toEqual({ success: true, mutated: true })
        expect(current.owners.removeManualDriverTelegramLinkV1).toHaveBeenCalledWith({
            contract: 'telegram_channel.RemoveManualDriverTelegramLinkCommand.v1',
            driverId: 'driver-1',
        })
        expect(current.order).toEqual(['remove-owner', 'revalidate'])
    })

    it('keeps P2025 idempotent without logging or revalidation', async () => {
        const current = fixture({ removeError: { code: 'P2025' } })
        await expect(current.orchestrator.removeDriverTelegramLink('driver-1'))
            .resolves.toEqual({ success: true, mutated: false })
        expect(current.delivery.logError).not.toHaveBeenCalled()
        expect(current.delivery.revalidateDriver).not.toHaveBeenCalled()
        expect(current.order).toEqual(['remove-owner'])
    })

    it('maps an unauthorized delete with zero revalidation', async () => {
        const failure = new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
        const current = fixture({ removeError: failure })

        await expect(current.orchestrator.removeDriverTelegramLink('driver-1'))
            .resolves.toEqual({
                success: false,
                error: 'Нужны подтверждённые контакт, личный Telegram-чат и основной водитель',
            })
        expect(current.delivery.revalidateDriver).not.toHaveBeenCalled()
    })

    it('logs and maps other remove and post-delete revalidation failures', async () => {
        const ownerFailure = new Error('delete down')
        const failed = fixture({ removeError: ownerFailure })
        await expect(failed.orchestrator.removeDriverTelegramLink('driver-1'))
            .resolves.toEqual({ success: false, error: 'Ошибка базы данных' })
        expect(failed.delivery.logError).toHaveBeenCalledWith('Failed to unlink telegram driver:', ownerFailure)

        const revalidateFailure = new Error('revalidate down')
        const partial = fixture({ revalidateError: revalidateFailure })
        await expect(partial.orchestrator.removeDriverTelegramLink('driver-1'))
            .resolves.toEqual({ success: false, error: 'Ошибка базы данных' })
        expect(partial.order).toEqual([
            'remove-owner',
            'revalidate',
            'log:Failed to unlink telegram driver:',
        ])
    })
})
