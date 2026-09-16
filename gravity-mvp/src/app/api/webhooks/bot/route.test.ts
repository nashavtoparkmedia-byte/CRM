import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findDriverTelegram: vi.fn(),
    findDriverTelegramFirst: vi.fn(),
    findDriver: vi.fn(),
    findDriverByYandex: vi.fn(),
    findChat: vi.fn(),
    getYandexConnectionCredentials: vi.fn(),
    listYandexConnectionMetadata: vi.fn(),
    patchDriverTelegramLink: vi.fn(),
    recordBotUserProfile: vi.fn(),
    recordPendingBotLinkRequest: vi.fn(),
    sendMessage: vi.fn(),
    updateConversation: vi.fn(),
    mirrorDriverActionResult: vi.fn(),
    recordDriverAction: vi.fn(),
    authorizeDriverTelegram: vi.fn(),
    providerFetch: vi.fn(),
    compensationPilotSection: vi.fn(),
    compensationPilotSubmit: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        driverTelegram: {
            findUnique: mocks.findDriverTelegram,
            findFirst: mocks.findDriverTelegramFirst,
        },
        driver: {
            findUnique: mocks.findDriver,
            findFirst: mocks.findDriverByYandex,
        },
        chat: { findFirst: mocks.findChat },
    },
}))

vi.mock('@/modules/fleet-operations/public/v1/yandex-connection-capability', () => ({
    getYandexConnectionCredentialsV1: mocks.getYandexConnectionCredentials,
    listYandexConnectionMetadataV1: mocks.listYandexConnectionMetadata,
}))

vi.mock('@/modules/telegram-channel/public/v1', () => ({
    patchDriverTelegramLinkV1: mocks.patchDriverTelegramLink,
    prepareManualDriverTelegramLinkAuthorityV1: mocks.authorizeDriverTelegram,
    recordBotUserProfileV1: mocks.recordBotUserProfile,
    recordPendingBotLinkRequestV1: mocks.recordPendingBotLinkRequest,
}))

vi.mock('@/modules/messaging/public/v1', () => ({
    sendMessageV1: mocks.sendMessage,
    updateConversationV1: mocks.updateConversation,
}))

vi.mock('@/modules/fleet-operations/public/v1', () => ({
    compensationPilotSectionV1: mocks.compensationPilotSection,
    compensationPilotSubmitV1: mocks.compensationPilotSubmit,
    mirrorDriverActionResultV1: mocks.mirrorDriverActionResult,
    recordDriverActionV1: mocks.recordDriverAction,
}))

import { POST } from './route'

const originalBotCrmSecret = process.env.BOT_CRM_SECRET

afterEach(() => vi.unstubAllGlobals())
afterAll(() => {
    if (originalBotCrmSecret === undefined) delete process.env.BOT_CRM_SECRET
    else process.env.BOT_CRM_SECRET = originalBotCrmSecret
})

function syncUserRequest(payload: Record<string, unknown>) {
    return new Request('https://crm.example/api/webhooks/bot', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-bot-signature': 'test-bot-secret',
        },
        body: JSON.stringify({ action: 'sync_user', payload }),
    })
}

function actionRequest(action: string, payload: Record<string, unknown>) {
    return new Request('https://crm.example/api/webhooks/bot', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-bot-signature': 'test-bot-secret',
        },
        body: JSON.stringify({ action, payload }),
    })
}

describe('driver-bot generic phone ingress', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegram.mockResolvedValue(null)
        mocks.findChat.mockResolvedValue(null)
        mocks.recordBotUserProfile.mockResolvedValue({ recorded: true })
        mocks.recordPendingBotLinkRequest.mockResolvedValue({ recorded: true })
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    test('records verified self-contact evidence locally and pends without a provider request', async () => {
        const response = await POST(syncUserRequest({
            telegramId: '123456',
            contactUserId: 123456,
            username: 'driver',
            firstName: 'Иван',
            phone: '8 (999) 000-11-22',
        }))
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toMatchObject({
            success: true,
            autoLinked: false,
            status: 'PENDING_MANAGER_LINK',
        })
        expect(mocks.recordBotUserProfile).toHaveBeenCalledWith(expect.objectContaining({
            telegramId: 123456n,
            phone: '+79990001122',
            phoneVerified: true,
        }))
        expect(mocks.recordPendingBotLinkRequest).toHaveBeenCalledWith(expect.objectContaining({
            telegramId: '123456',
            text: expect.stringContaining('+79990001122'),
        }))
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.listYandexConnectionMetadata).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('keeps an existing stable Telegram owner and never rebinds it from the new phone', async () => {
        mocks.findDriverTelegram.mockResolvedValue({
            driverId: 'driver-existing',
            username: 'Existing Driver',
        })

        const response = await POST(syncUserRequest({
            telegramId: '123456',
            contactUserId: '123456',
            phone: '+7 999 555-44-33',
        }))

        await expect(response.json()).resolves.toMatchObject({
            success: true,
            autoLinked: true,
            alreadyLinked: true,
            driverId: 'driver-existing',
        })
        expect(mocks.recordPendingBotLinkRequest).not.toHaveBeenCalled()
        expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('rejects a forwarded contact before persisting identity or link evidence', async () => {
        const response = await POST(syncUserRequest({
            telegramId: '123456',
            contactUserId: '654321',
            phone: '+7 999 000-11-22',
        }))

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toMatchObject({ error: 'CONTACT_OWNER_MISMATCH' })
        expect(mocks.recordBotUserProfile).not.toHaveBeenCalled()
        expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.recordPendingBotLinkRequest).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('keeps legacy retry phones unverified and pending', async () => {
        const response = await POST(syncUserRequest({
            telegramId: '123456',
            phone: '+7 999 000-11-22',
        }))

        await expect(response.json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
        expect(mocks.recordBotUserProfile).toHaveBeenCalledWith(expect.objectContaining({
            phone: null,
            phoneVerified: false,
        }))
        expect(mocks.recordPendingBotLinkRequest).toHaveBeenCalledOnce()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })
})

describe('generic messaging ingress provider boundary', () => {
    const sourceRoot = resolve(__dirname, '../../../../')
    const source = (relativePath: string) => readFileSync(resolve(sourceRoot, relativePath), 'utf8')

    test('sync_user cannot enumerate parks, call Yandex, or create a first-result link', () => {
        const route = source('app/api/webhooks/bot/route.ts')
        const start = route.indexOf('async function handleSyncUser')
        const end = route.indexOf('// Inject a system message', start)
        const syncUser = route.slice(start, end)

        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        expect(syncUser).not.toContain('listYandexConnectionCredentialsV1')
        expect(syncUser).not.toContain('fleet-api.taxi.yandex.net')
        expect(syncUser).not.toMatch(/\bfetch\s*\(/)
        expect(syncUser).not.toContain('upsertDriverTelegramLinkV1')
        expect(syncUser).toContain("status: 'PENDING_MANAGER_LINK'")
    })

    test('TG, MAX, and WhatsApp generic ingress contain no all-park lookup', () => {
        const genericIngress = [
            'app/api/webhook/telegram/route.ts',
            'app/api/webhook/max/route.ts',
            'app/api/webhooks/max/route.ts',
            'lib/whatsapp/WhatsAppService.ts',
        ].map(source).join('\n')

        expect(genericIngress).not.toContain('listYandexConnectionCredentialsV1')
        expect(genericIngress).not.toContain('searchYandexParksByPhonesV1')
        expect(genericIngress).not.toContain('fleet-api.taxi.yandex.net')
    })
})

describe('driver-bot current Telegram authority', () => {
    const mutationCases = [
        ['check_link', { telegramId: '123456' }],
        ['change_limit', { telegramId: '123456', limitValue: 5_000 }],
        ['update_driver_car', { telegramId: '123456', carId: 'car-1' }],
        ['get_order_price', { telegramId: '123456' }],
        ['poll_driver_action', { telegramId: '123456', taskId: 'task-1' }],
        ['set_active_park', { telegramId: '123456', parkId: 'park-1' }],
        ['compensation_section', { telegramId: '123456' }],
        ['compensation_submit', {
            telegramId: '123456',
            externalOrderId: 'order-1',
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'submit-key-1',
        }],
    ] as const

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegramFirst.mockResolvedValue({
            id: 'mapping-1',
            driverId: 'driver-1',
            telegramId: 123456n,
            activeParkId: 'park-1',
        })
        mocks.authorizeDriverTelegram.mockResolvedValue({
            chatId: 'chat-1',
            providerAccountId: 'telegram-bot-1',
            connectionId: 'telegram-connection-1',
            target: '123456',
        })
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    test.each(mutationCases)(
        '%s fails closed when the action ingress omits the exact account binding',
        async (action, payload) => {
            const response = await POST(actionRequest(action, payload))

            expect(response.status).toBe(409)
            await expect(response.json()).resolves.toEqual({
                error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
            })
            expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
            expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
            expect(mocks.findDriver).not.toHaveBeenCalled()
            expect(mocks.findDriverByYandex).not.toHaveBeenCalled()
            expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
            expect(mocks.recordDriverAction).not.toHaveBeenCalled()
            expect(mocks.providerFetch).not.toHaveBeenCalled()
            expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
            expect(mocks.compensationPilotSubmit).not.toHaveBeenCalled()
        },
    )

    test.each(mutationCases)(
        '%s performs zero Driver mutation when the canonical mapping is stale or conflicted',
        async (action, payload) => {
            mocks.authorizeDriverTelegram.mockRejectedValue(
                new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
            )
            const response = await POST(actionRequest(action, {
                ...payload,
                providerAccountId: 'telegram-bot-1',
                connectionId: 'telegram-connection-1',
            }))

            expect(response.status).toBe(409)
            expect(mocks.authorizeDriverTelegram).toHaveBeenCalledWith({
                driverId: 'driver-1',
                telegramId: 123456n,
            })
            expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
            expect(mocks.findDriver).not.toHaveBeenCalled()
            expect(mocks.findDriverByYandex).not.toHaveBeenCalled()
            expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
            expect(mocks.recordDriverAction).not.toHaveBeenCalled()
            expect(mocks.providerFetch).not.toHaveBeenCalled()
            expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
            expect(mocks.compensationPilotSubmit).not.toHaveBeenCalled()
        },
    )

    test('rejects an action whose incoming bot account differs from the admitted Chat', async () => {
        mocks.authorizeDriverTelegram.mockResolvedValue({
            chatId: 'chat-1',
            providerAccountId: 'different-telegram-bot',
            connectionId: 'telegram-connection-1',
            target: '123456',
        })

        const response = await POST(actionRequest('change_limit', {
            telegramId: '123456',
            limitValue: 5_000,
            providerAccountId: 'telegram-bot-1',
            connectionId: 'telegram-connection-1',
        }))

        expect(response.status).toBe(409)
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })
})

describe('driver-bot cash compensation pilot', () => {
    const binding = { providerAccountId: 'telegram-bot-1', connectionId: 'telegram-connection-1' }
    const submitPayload = {
        telegramId: '123456',
        externalOrderId: 'order-1',
        claimedRubles: 300,
        supportConfirmed: true,
        attachmentFileId: 'file-1',
        attachmentKind: 'photo',
        idempotencyKey: 'submit-key-1',
        ...binding,
    }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegramFirst.mockResolvedValue({ driverId: 'driver-1' })
        mocks.authorizeDriverTelegram.mockResolvedValue({
            chatId: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            providerAccountId: 'telegram-bot-1',
            connectionId: 'telegram-connection-1',
            target: '123456',
            identityTarget: '123456',
        })
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    function expectNoIdentityWrites() {
        expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
        expect(mocks.recordBotUserProfile).not.toHaveBeenCalled()
        expect(mocks.recordPendingBotLinkRequest).not.toHaveBeenCalled()
        expect(mocks.findDriver).not.toHaveBeenCalled()
        expect(mocks.findDriverByYandex).not.toHaveBeenCalled()
        expect(mocks.listYandexConnectionMetadata).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    }

    test('hands the section the person Telegram authority proved, not a phone or a caller id', async () => {
        mocks.compensationPilotSection.mockResolvedValue({
            available: false,
            reason: 'not_self_employed',
            applications: [],
        })

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            available: false,
            reason: 'not_self_employed',
            applications: [],
        })
        expect(mocks.authorizeDriverTelegram).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 123456n })
        expect(mocks.compensationPilotSection).toHaveBeenCalledWith({
            telegramUserId: '123456',
            driverId: 'driver-1',
            contactId: 'contact-1',
        })
        expectNoIdentityWrites()
    })

    test('answers an account with no manager link in band, without asking authority or the pilot', async () => {
        mocks.findDriverTelegramFirst.mockResolvedValue(null)

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            available: false,
            reason: 'identity_not_proven',
            applications: [],
        })
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
        expectNoIdentityWrites()
    })

    test('submits with the proven person and the driver evidence', async () => {
        mocks.compensationPilotSubmit.mockResolvedValue({
            submitted: true,
            applicationId: 'application-1',
            amountKopecks: 30_000,
            status: 'created',
        })

        const response = await POST(actionRequest('compensation_submit', submitPayload))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            submitted: true,
            applicationId: 'application-1',
            amountKopecks: 30_000,
            status: 'created',
        })
        expect(mocks.compensationPilotSubmit).toHaveBeenCalledWith({
            telegramUserId: '123456',
            driverId: 'driver-1',
            contactId: 'contact-1',
            externalOrderId: 'order-1',
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'submit-key-1',
        })
        expectNoIdentityWrites()
    })

    test('records the Telegram id in the canonical form authority proved', async () => {
        mocks.compensationPilotSection.mockResolvedValue({ available: false, reason: 'not_self_employed', applications: [] })

        await POST(actionRequest('compensation_section', { telegramId: '000123456', ...binding }))

        expect(mocks.authorizeDriverTelegram).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 123456n })
        expect(mocks.compensationPilotSection).toHaveBeenCalledWith({
            telegramUserId: '123456',
            driverId: 'driver-1',
            contactId: 'contact-1',
        })
    })

    test('refuses a submit with no idempotency key before reading any identity', async () => {
        const response = await POST(actionRequest('compensation_submit', { ...submitPayload, idempotencyKey: '' }))

        expect(response.status).toBe(400)
        expect(mocks.findDriverTelegramFirst).not.toHaveBeenCalled()
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSubmit).not.toHaveBeenCalled()
    })

    test('refuses a Telegram id that is not a positive integer', async () => {
        for (const telegramId of ['0', '12ab', '-5']) {
            const response = await POST(actionRequest('compensation_section', { telegramId, ...binding }))
            expect(response.status).toBe(400)
        }
        expect(mocks.findDriverTelegramFirst).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
    })
})
