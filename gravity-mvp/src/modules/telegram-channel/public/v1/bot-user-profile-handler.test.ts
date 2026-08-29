import { describe, expect, test, vi } from 'vitest'
import { RECORD_BOT_USER_PROFILE_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { createRecordBotUserProfileHandlerV1 } from './bot-user-profile-handler'

describe('Telegram bot user profile capability', () => {
    test('maps the exact observed profile to one owner write', async () => {
        const observedAt = new Date('2026-08-11T00:00:00.000Z')
        const record = vi.fn(async () => undefined)
        const handler = createRecordBotUserProfileHandlerV1({ record })
        await expect(handler({
            contract: RECORD_BOT_USER_PROFILE_COMMAND_V1,
            telegramId: 123n,
            username: 'driver',
            firstName: 'Ivan',
            lastName: null,
            phone: '+79990001122',
            phoneVerified: true,
            observedAt,
        })).resolves.toMatchObject({ recorded: true })
        expect(record).toHaveBeenCalledWith({
            telegramId: 123n,
            username: 'driver',
            firstName: 'Ivan',
            lastName: null,
            phone: '+79990001122',
            phoneVerified: true,
            observedAt,
        })
    })

    test('rejects unrelated writer fields before the owner port', async () => {
        const record = vi.fn(async () => undefined)
        const handler = createRecordBotUserProfileHandlerV1({ record })
        await expect(handler({
            contract: RECORD_BOT_USER_PROFILE_COMMAND_V1,
            telegramId: 123n,
            username: null,
            firstName: null,
            lastName: null,
            phone: null,
            phoneVerified: false,
            observedAt: new Date(),
            driverId: 'foreign',
        })).rejects.toThrow('unsupported field')
        expect(record).not.toHaveBeenCalled()
    })
})
