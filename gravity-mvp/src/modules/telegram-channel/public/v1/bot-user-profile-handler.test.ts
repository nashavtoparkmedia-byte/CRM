import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { RECORD_BOT_USER_PROFILE_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { buildPendingBotLinkRequests, createRecordBotUserProfileHandlerV1 } from './bot-user-profile-handler'

const gravityRoot = resolve(__dirname, '../../../../../')
const repositoryRoot = resolve(gravityRoot, '..')
const gravitySource = (path: string) => readFileSync(resolve(gravityRoot, path), 'utf8')
const botSource = (path: string) => readFileSync(resolve(repositoryRoot, 'tg-bot', path), 'utf8')

describe('Telegram bot user profile capability', () => {
    test('maps the exact observed profile to one owner write', async () => {
        const observedAt = new Date('2026-08-11T00:00:00.000Z')
        const record = vi.fn(async () => undefined)
        const handler = createRecordBotUserProfileHandlerV1({ record, findLinkStatus: vi.fn() })
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
        const handler = createRecordBotUserProfileHandlerV1({ record, findLinkStatus: vi.fn() })
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

describe('pending Telegram driver links', () => {
    const max8q = {
        id: 'registry-max8q',
        telegramId: 88000001n,
        phone: '+79990001122',
        username: 'Max8q',
        firstName: 'Максим',
        lastName: null,
        firstSeenAt: new Date('2026-08-29T12:00:00.000Z'),
        lastSeenAt: new Date('2026-08-29T12:05:00.000Z'),
    }

    test('shows an unlinked registered user once with the submitted phone', () => {
        const requests = buildPendingBotLinkRequests({
            registryRows: [max8q],
            legacyRequests: [{
                id: 'legacy-max8q',
                telegramId: max8q.telegramId,
                text: '[Запрос привязки] Телефон: +79990001122, @Max8q',
                createdAt: new Date('2026-08-29T12:03:00.000Z'),
            }],
            linkedTelegramIds: new Set(),
            chatMap: { '88000001': 'chat-max8q' },
        })

        expect(requests).toEqual([expect.objectContaining({
            id: 'legacy-max8q',
            telegramId: '88000001',
            username: 'Max8q',
            phone: '+79990001122',
            chatId: 'chat-max8q',
        })])
    })

    test('does not show a registered user after the driver link exists', () => {
        expect(buildPendingBotLinkRequests({
            registryRows: [max8q],
            legacyRequests: [],
            linkedTelegramIds: new Set(['88000001']),
            chatMap: {},
        })).toEqual([])
    })
})

describe('driver bot pending-link registry wiring', () => {
    test('CRM accepts bot registrations through the Telegram owner capability', () => {
        const webhook = gravitySource('src/app/api/webhook/telegram/route.ts')
        expect(webhook).toContain("body?.action === 'register_bot_user'")
        expect(webhook).toContain('recordBotUserProfileV1({')
        expect(webhook).toContain('getBotUserLinkStatusV1(telegramIdBigInt)')
        expect(webhook).toContain('status: \'PENDING_MANAGER_LINK\'')
    })

    test('pending-link list is projected from the durable registry and legacy requests', () => {
        const route = gravitySource('src/app/api/bot-users/route.ts')
        const projector = gravitySource('src/modules/telegram-channel/public/v1/bot-user-profile-handler.ts')
        expect(route).toContain('prisma.botUserRegistry.findMany')
        expect(route).toContain('buildPendingBotLinkRequests({')
        expect(projector).toContain('pendingByTelegramId')
        expect(projector).toContain('linkedTelegramIds.has(telegramId)')
        expect(projector).toContain('row.firstSeenAt.toISOString()')
    })

    test('the bot registers on start and retries unsynced local users', () => {
        const start = botSource('src/handlers/start.js')
        const userService = botSource('src/services/userService.js')
        const bot = botSource('src/bot.js')
        expect(start).toContain('userService.registerUser(from)')
        expect(userService).toContain("action: 'register_bot_user'")
        expect(userService).toContain('attemptAutoLink: false')
        expect(userService).toContain('/api/webhook/telegram')
        expect(bot).toContain('userService.syncPendingCrmUsers()')
        expect(bot).toContain('userService.startPeriodicCrmSync()')
    })

    test('phone linking requires Telegram contact ownership evidence', () => {
        const bot = botSource('src/bot.js')
        const carManagement = botSource('src/handlers/carManagement.js')
        expect(bot).toContain('contact.user_id !== ctx.from.id')
        expect(carManagement).toContain('contactUserId: ctx.message.contact.user_id')
    })
})
