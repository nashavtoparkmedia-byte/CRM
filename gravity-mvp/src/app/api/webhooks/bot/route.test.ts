import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findDriverTelegram: vi.fn(),
    findDriverTelegramFirst: vi.fn(),
    findDriver: vi.fn(),
    findDriverByYandex: vi.fn(),
    findDrivers: vi.fn(),
    confirmedDriverCluster: vi.fn(),
    findChat: vi.fn(),
    getYandexConnectionCredentials: vi.fn(),
    listYandexConnectionMetadata: vi.fn(),
    patchDriverTelegramLink: vi.fn(),
    upsertDriverTelegramLink: vi.fn(),
    recordBotUserProfile: vi.fn(),
    recordPendingBotLinkRequest: vi.fn(),
    sendMessage: vi.fn(),
    updateConversation: vi.fn(),
    mirrorDriverActionResult: vi.fn(),
    recordDriverAction: vi.fn(),
    authorizeDriverTelegram: vi.fn(),
    canonicalBotConnection: vi.fn(),
    providerFetch: vi.fn(),
    compensationPilotSection: vi.fn(),
    compensationPilotSubmit: vi.fn(),
    compensationPilotOrderCheck: vi.fn(),
    compensationPilotRefresh: vi.fn(),
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
            findMany: mocks.findDrivers,
        },
        chat: { findFirst: mocks.findChat },
    },
}))

vi.mock('@/modules/contacts/public/v1/driver-person-confirmation', () => ({
    getConfirmedContactForDriverClusterV1: mocks.confirmedDriverCluster,
}))

vi.mock('@/modules/fleet-operations/public/v1/yandex-connection-capability', () => ({
    getYandexConnectionCredentialsV1: mocks.getYandexConnectionCredentials,
    listYandexConnectionMetadataV1: mocks.listYandexConnectionMetadata,
}))

vi.mock('@/modules/telegram-channel/public/v1', () => ({
    patchDriverTelegramLinkV1: mocks.patchDriverTelegramLink,
    upsertDriverTelegramLinkV1: mocks.upsertDriverTelegramLink,
    prepareDriverTelegramConversationAuthorityV1: mocks.authorizeDriverTelegram,
    canonicalTelegramBotConnectionIdV1: mocks.canonicalBotConnection,
    recordBotUserProfileV1: mocks.recordBotUserProfile,
    recordPendingBotLinkRequestV1: mocks.recordPendingBotLinkRequest,
}))

const BOT_CONNECTION = 'driver-bot-primary'
/** The single production MTProto personal-account transport. */
const MTPROTO_CONNECTION = '1982527911'

vi.mock('@/modules/messaging/public/v1', () => ({
    sendMessageV1: mocks.sendMessage,
    updateConversationV1: mocks.updateConversation,
}))

vi.mock('@/modules/fleet-operations/public/v1', () => ({
    compensationPilotOrderCheckV1: mocks.compensationPilotOrderCheck,
    compensationPilotRefreshV1: mocks.compensationPilotRefresh,
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
        mocks.findDrivers.mockResolvedValue([])
        mocks.upsertDriverTelegramLink.mockResolvedValue({ upserted: true })
        mocks.findChat.mockResolvedValue(null)
        mocks.recordBotUserProfile.mockResolvedValue({ recorded: true })
        mocks.recordPendingBotLinkRequest.mockResolvedValue({ recorded: true })
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    test('records verified self-contact evidence locally and pends a number that names no Driver, without a provider request', async () => {
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
        expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.listYandexConnectionMetadata).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    describe('automatic link from the driver\'s own verified number', () => {
        const working = (overrides: Record<string, unknown> = {}) => ({
            id: 'driver-yoko',
            fullName: 'Иванов Иван',
            phone: '+79990001122',
            externalParkId: 'park-yoko',
            yandexDriverId: 'park-profile:abc',
            externalDriverProfileId: 'a'.repeat(32),
            personResolutionStatus: 'vu_clustered',
            ...overrides,
        })
        const verified = { telegramId: '123456', contactUserId: 123456, username: 'driver', phone: '8 (999) 000-11-22' }

        test('a new driver whose number names exactly one working profile is linked at once, in that profile\'s park', async () => {
            mocks.findDrivers.mockResolvedValue([working()])

            const response = await POST(syncUserRequest(verified))

            expect(response.status).toBe(200)
            await expect(response.json()).resolves.toEqual({
                success: true,
                autoLinked: true,
                driverId: 'driver-yoko',
                driverName: 'Иванов Иван',
            })
            expect(mocks.findDrivers).toHaveBeenCalledWith(expect.objectContaining({
                where: { dismissedAt: null, phone: { endsWith: '9990001122' } },
            }))
            expect(mocks.findDriverTelegram).toHaveBeenCalledWith({ where: { driverId: 'driver-yoko' }, select: { driverId: true } })
            expect(mocks.upsertDriverTelegramLink).toHaveBeenCalledOnce()
            expect(mocks.upsertDriverTelegramLink).toHaveBeenCalledWith({
                contract: 'telegram_channel.UpsertDriverTelegramLinkCommand.v1',
                driverId: 'driver-yoko',
                telegramId: 123456n,
                username: 'driver',
                activeParkId: 'park-yoko',
            })
            expect(mocks.recordPendingBotLinkRequest).not.toHaveBeenCalled()
            expect(mocks.providerFetch).not.toHaveBeenCalled()
        })

        test('one person\'s profiles in two parks are not chosen between: the manager links', async () => {
            mocks.findDrivers.mockResolvedValue([
                working(),
                working({ id: 'driver-nash', externalParkId: 'park-nash', externalDriverProfileId: 'b'.repeat(32) }),
            ])

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({
                autoLinked: false,
                status: 'PENDING_MANAGER_LINK',
            })
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
            expect(mocks.recordPendingBotLinkRequest).toHaveBeenCalledOnce()
        })

        test('two people sharing a number never link to either of them', async () => {
            mocks.findDrivers.mockResolvedValue([
                working(),
                working({ id: 'driver-other-person', fullName: 'Петров Пётр', phone: '8 999 000 11 22' }),
            ])

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('a longer number that merely ends with the same digits is not the same number', async () => {
            mocks.findDrivers.mockResolvedValue([working({ phone: '+3809990001122' })])

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('a second profile with the same number is found however many rows end with those digits', async () => {
            const rows = [
                working(),
                ...Array.from({ length: 9 }, (_, i) => working({ id: `driver-foreign-${i}`, phone: `+38${i}9990001122` })),
                working({ id: 'driver-second', externalParkId: 'park-nash', externalDriverProfileId: 'b'.repeat(32) }),
            ]
            // The database honours any row limit the route asks for.
            mocks.findDrivers.mockImplementation(async ({ take }: { take?: number }) => rows.slice(0, take ?? rows.length))

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('a foreign number never links to a Russian profile with the same last digits', async () => {
            mocks.findDrivers.mockResolvedValue([working()])

            await expect((await POST(syncUserRequest({ ...verified, phone: '+380 999 000 11 22' }))).json())
                .resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.findDrivers).not.toHaveBeenCalled()
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('a profile another Telegram already holds is never moved', async () => {
            mocks.findDrivers.mockResolvedValue([working()])
            mocks.findDriverTelegram.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
                where.driverId === 'driver-yoko' ? { driverId: 'driver-yoko' } : null)

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test.each([
            ['no recorded park', { externalParkId: null }],
            ['no Yandex profile id', { yandexDriverId: 'park-profile:abc', externalDriverProfileId: null }],
            ['a person conflict', { personResolutionStatus: 'conflict' }],
        ])('a single profile with %s goes to the manager', async (_, overrides) => {
            mocks.findDrivers.mockResolvedValue([working(overrides)])

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('an unverified number never links, even when it names one profile', async () => {
            mocks.findDrivers.mockResolvedValue([working()])

            await expect((await POST(syncUserRequest({ telegramId: '123456', phone: '+7 999 000-11-22' }))).json())
                .resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.findDrivers).not.toHaveBeenCalled()
            expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('a link that cannot be saved still reaches the manager', async () => {
            mocks.findDrivers.mockResolvedValue([working()])
            mocks.upsertDriverTelegramLink.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))

            await expect((await POST(syncUserRequest(verified))).json()).resolves.toMatchObject({ status: 'PENDING_MANAGER_LINK' })
            expect(mocks.recordPendingBotLinkRequest).toHaveBeenCalledOnce()
        })
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

    test('sync_user cannot enumerate parks or call Yandex, and links only a unique verified local match', () => {
        const route = source('app/api/webhooks/bot/route.ts')
        const start = route.indexOf('async function handleSyncUser')
        const end = route.indexOf('// Inject a system message', start)
        const syncUser = route.slice(start, end)
        const matchStart = route.indexOf('async function uniqueUnlinkedDriverForPhone')
        const match = route.slice(matchStart, route.indexOf('async function handleChangeLimit', matchStart))

        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        expect(matchStart).toBeGreaterThanOrEqual(0)
        for (const source of [syncUser, match]) {
            expect(source).not.toContain('listYandexConnectionCredentialsV1')
            expect(source).not.toContain('fleet-api.taxi.yandex.net')
            expect(source).not.toMatch(/\bfetch\s*\(/)
        }
        // The one link sync_user may write: after an existing link was kept, only
        // for verified self-contact evidence, and only for the single match.
        expect(syncUser.match(/upsertDriverTelegramLinkV1\(/g)).toHaveLength(1)
        expect(syncUser.indexOf('existingLink?.driverId')).toBeLessThan(syncUser.indexOf('if (hasContactOwnershipEvidence)'))
        expect(syncUser.indexOf('if (hasContactOwnershipEvidence)')).toBeLessThan(syncUser.indexOf('uniqueUnlinkedDriverForPhone('))
        expect(syncUser.indexOf('uniqueUnlinkedDriverForPhone(')).toBeLessThan(syncUser.indexOf('upsertDriverTelegramLinkV1('))
        expect(match).toContain('if (matches.length !== 1) return null')
        expect(match).toContain('where: { driverId: row.id }')
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
        // The link proof: the exact Telegram → Driver link, read again.
        mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-1' })
        // Cash's own person proof: it names no transport.
        mocks.authorizeDriverTelegram.mockResolvedValue({
            chatId: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            driverId: 'driver-1',
            target: '123456',
        })
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
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
            expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
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

    test.each(mutationCases.flatMap(([action, payload]) => [
        [action, payload, 'relinked to another Driver', { driverId: 'driver-2' }],
        [action, payload, 'unlinked', null],
    ] as const))(
        '%s performs zero Driver mutation when the link was meanwhile %s',
        async (action, payload, _, link) => {
            mocks.findDriverTelegram.mockResolvedValue(link)
            const response = await POST(actionRequest(action, {
                ...payload,
                providerAccountId: '8447212640',
                connectionId: BOT_CONNECTION,
            }))

            expect(response.status).toBe(409)
            expect(mocks.findDriverTelegram).toHaveBeenCalledWith({
                where: { telegramId: 123456n },
                select: { driverId: true },
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

    // The complete non-production change_limit contract: the bot's action binding
    // (providerAccountId + connectionId) meets the Bot runtime authority, the
    // Telegram → Driver link is proven separately, and the Yandex side effect is
    // stubbed. No Chat.metadata transport ownership and no Contact anywhere in
    // the chain: a linked driver whose Contact is not confirmed is admitted.
    test('admits change_limit for a linked Driver with no confirmed Contact, on the canonical Bot transport', async () => {
        mocks.authorizeDriverTelegram.mockRejectedValue(new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'))
        mocks.getYandexConnectionCredentials.mockResolvedValue({
            clid: 'clid-1', apiKey: 'api-key-1', parkId: 'park-1',
        })
        mocks.findDriver.mockResolvedValue({ yandexDriverId: 'contractor-1', phone: '+70000000000' })
        const profile = { account: { balance_limit: '0' }, person: { id: 'contractor-1' } }
        mocks.providerFetch
            // probe, then GET profile, then PUT
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(profile) })
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(profile) })
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ...profile, account: { balance_limit: '5000' } }) })

        const response = await POST(actionRequest('change_limit', {
            telegramId: '123456',
            limitValue: 5_000,
            providerAccountId: '8447212640',
            connectionId: BOT_CONNECTION,
        }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ success: true, newLimit: 5_000 })
        // The link is proven twice: once before the read, once immediately before
        // the provider mutation. Contacts is never asked.
        expect(mocks.findDriverTelegram).toHaveBeenCalledWith({
            where: { telegramId: 123456n },
            select: { driverId: true },
        })
        expect(mocks.findDriverTelegram.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        const put = mocks.providerFetch.mock.calls.at(-1)
        expect(put?.[1]).toMatchObject({ method: 'PUT' })
    })

    test('rejects an action whose transport is not the canonical configured Bot connection', async () => {
        const response = await POST(actionRequest('change_limit', {
            telegramId: '123456',
            limitValue: 5_000,
            providerAccountId: '8447212640',
            // The MTProto personal-account transport may never drive a Driver Bot
            // action, even though a shared Chat legitimately carries it.
            connectionId: MTPROTO_CONNECTION,
        }))

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({
            error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
        })
        expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('rejects an action whose runtime provider account is not concrete', async () => {
        const response = await POST(actionRequest('change_limit', {
            telegramId: '123456',
            limitValue: 5_000,
            providerAccountId: 'legacy',
            connectionId: BOT_CONNECTION,
        }))

        expect(response.status).toBe(409)
        expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('fails closed when the canonical Bot transport is unconfigured', async () => {
        mocks.canonicalBotConnection.mockImplementation(() => {
            throw new Error('TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN')
        })

        const response = await POST(actionRequest('change_limit', {
            telegramId: '123456',
            limitValue: 5_000,
            providerAccountId: '8447212640',
            connectionId: BOT_CONNECTION,
        }))

        expect(response.status).toBe(409)
        expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('never compares the runtime transport against stored Chat metadata, and proves only the link', () => {
        const route = readFileSync(
            resolve(process.cwd(), 'src/app/api/webhooks/bot/route.ts'),
            'utf8',
        )
        // The one authority implementation: the resolver that proves it and the
        // thin 409 wrapper every Driver action and the compensation entry share.
        const authority = route
            .slice(
                route.indexOf('async function resolveCurrentBotDriverAuthority'),
                route.indexOf('// Check if a Telegram user is linked to a driver'),
            )
            // Assert on executable code only: the prose explains why stored Chat
            // metadata is excluded, so naming it in a comment must not fail this.
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
        expect(authority).toContain('canonicalTelegramBotConnectionIdV1()')
        // The link proof reads exactly the link row of this Telegram id, and
        // nothing of Contacts or of the shared Chat.
        expect(authority).toContain('prisma.driverTelegram.findUnique({\n            where: { telegramId: input.telegramId },')
        expect(authority.match(/prisma\./g)).toHaveLength(1)
        expect(authority).not.toContain('prepareDriverTelegramConversationAuthorityV1')
        expect(authority).not.toContain('metadata')
        expect(authority).not.toMatch(/\bchat\./)
        // One implementation: the wrapper delegates and proves nothing itself.
        // Contacts' person proof is asked once, by Cash alone.
        expect(route.match(/prepareDriverTelegramConversationAuthorityV1\(/g)).toHaveLength(1)
        expect(route.indexOf('prepareDriverTelegramConversationAuthorityV1(')).toBeGreaterThan(route.indexOf('async function proveCompensationTelegramPerson'))
        expect(route.match(/canonicalTelegramBotConnectionIdV1\(\)/g)).toHaveLength(1)
    })
})

describe('driver-bot cash compensation pilot', () => {
    // The live action binding the bot sends: its numeric provider account and the
    // canonical configured Bot transport. Neither is ever stored on the Chat.
    const binding = { providerAccountId: '8447212640', connectionId: BOT_CONNECTION }
    const submitPayload = {
        telegramId: '123456',
        externalOrderId: 'order-1',
        claimedRubles: 300,
        supportConfirmed: true,
        attachmentFileId: 'file-1',
        attachmentKind: 'photo',
        idempotencyKey: 'submit-key-1',
        scopeKey: 'scope-a',
        ...binding,
    }
    const proven = {
        telegramUserId: '123456',
        driverId: 'driver-1',
        contactId: 'contact-1',
        selectedExternalParkId: 'park-a',
    }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegramFirst.mockResolvedValue({ driverId: 'driver-1', activeParkId: 'park-a' })
        // The link proof every bot Driver action shares.
        mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-1' })
        // Cash's own person/conversation proof of a real chat: it names no transport,
        // because no production Chat carries chatKind or a provider account.
        mocks.authorizeDriverTelegram.mockResolvedValue({
            chatId: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            driverId: 'driver-1',
            target: '123456',
        })
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    function expectNoIdentityWrites() {
        expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
        expect(mocks.upsertDriverTelegramLink).not.toHaveBeenCalled()
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
        expect(mocks.compensationPilotSection).toHaveBeenCalledWith(proven, { search: null })
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
            ...proven,
            externalOrderId: 'order-1',
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'submit-key-1',
            scopeKey: 'scope-a',
        })
        expectNoIdentityWrites()
    })

    test('records the Telegram id in the canonical form authority proved', async () => {
        mocks.compensationPilotSection.mockResolvedValue({ available: false, reason: 'not_self_employed', applications: [] })

        await POST(actionRequest('compensation_section', { telegramId: '000123456', ...binding }))

        expect(mocks.authorizeDriverTelegram).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 123456n })
        expect(mocks.compensationPilotSection).toHaveBeenCalledWith(proven, { search: null })
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

    test('takes the selected park from the proven link and ignores any park the bot sends', async () => {
        mocks.compensationPilotSection.mockResolvedValue({ available: false, reason: 'catalogue_disabled', applications: [] })
        mocks.compensationPilotSubmit.mockResolvedValue({ submitted: false, refusal: 'stale_context' })
        const forged = { parkId: 'park-b', activeParkId: 'park-b', selectedExternalParkId: 'park-b', externalParkId: 'park-b' }

        await POST(actionRequest('compensation_section', { telegramId: '123456', ...forged, ...binding }))
        await POST(actionRequest('compensation_submit', { ...submitPayload, ...forged }))

        expect(mocks.compensationPilotSection).toHaveBeenCalledWith(proven, { search: null })
        expect(mocks.compensationPilotSubmit).toHaveBeenCalledWith(expect.objectContaining({ selectedExternalParkId: 'park-a' }))
    })

    test('passes a link with no selected park on as no selection', async () => {
        mocks.findDriverTelegramFirst.mockResolvedValue({ driverId: 'driver-1', activeParkId: null })
        mocks.compensationPilotSection.mockResolvedValue({ available: false, reason: 'park_not_selected', applications: [] })

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ available: false, reason: 'park_not_selected' })
        expect(mocks.compensationPilotSection).toHaveBeenCalledWith({ ...proven, selectedExternalParkId: null }, { search: null })
    })

    test('serializes the scoped list with its status, scope token and search candidates', async () => {
        const order = {
            externalOrderId: 'order-1',
            shortOrderIdDisplay: '4821',
            amountKopecks: 68_000,
            endedAt: new Date('2026-09-18T10:42:00.000Z'),
            dayKey: '2026-09-18',
            localTime: '15:42',
            localDate: '18.09',
            claimed: false,
        }
        mocks.compensationPilotSection.mockResolvedValue({
            available: true,
            scopeKey: 'scope-a',
            externalParkId: 'park-a',
            firstMonthKey: '2026-09',
            remainingBudgetKopecks: 500_000,
            catalogueStatus: 'partial',
            todayKey: '2026-09-18',
            orders: [order],
            search: { query: '4821', kind: 'number', truncated: false, matches: [order] },
            applications: [],
        })

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', search: ` 4821${'9'.repeat(60)}`, ...binding }))

        await expect(response.json()).resolves.toEqual({
            available: true,
            scopeKey: 'scope-a',
            monthKey: '2026-09',
            remainingBudgetKopecks: 500_000,
            catalogueStatus: 'partial',
            todayKey: '2026-09-18',
            orders: [{
                externalOrderId: 'order-1',
                shortOrderId: '4821',
                amountKopecks: 68_000,
                endedAt: '2026-09-18T10:42:00.000Z',
                dayKey: '2026-09-18',
                localTime: '15:42',
                localDate: '18.09',
                claimed: false,
            }],
            search: { query: '4821', kind: 'number', truncated: false, externalOrderIds: ['order-1'] },
            applications: [],
        })
        const [, options] = mocks.compensationPilotSection.mock.calls[0]
        expect(options.search).toHaveLength(40)
        expectNoIdentityWrites()
    })

    test('checks a chosen order with the scope token the bot echoes, and no provider call of its own', async () => {
        mocks.compensationPilotOrderCheck.mockResolvedValue({ state: 'checking', refusal: null, order: null })

        const response = await POST(actionRequest('compensation_order_check', {
            telegramId: '123456', externalOrderId: 'order-1', scopeKey: 'scope-a', retry: true, ...binding,
        }))

        await expect(response.json()).resolves.toEqual({ state: 'checking', refusal: null, order: null })
        expect(mocks.compensationPilotOrderCheck).toHaveBeenCalledWith({
            ...proven, externalOrderId: 'order-1', scopeKey: 'scope-a', retry: true,
        })
        expectNoIdentityWrites()
    })

    test('refuses an order check without an order before reading any identity', async () => {
        const response = await POST(actionRequest('compensation_order_check', { telegramId: '123456', ...binding }))
        expect(response.status).toBe(400)
        expect(mocks.findDriverTelegramFirst).not.toHaveBeenCalled()
        expect(mocks.compensationPilotOrderCheck).not.toHaveBeenCalled()
    })

    test('schedules a refresh of the proven link park and returns at once', async () => {
        mocks.compensationPilotRefresh.mockResolvedValue({ status: 'scheduled', refusal: null })

        const response = await POST(actionRequest('compensation_refresh', { telegramId: '123456', parkId: 'park-b', ...binding }))

        await expect(response.json()).resolves.toEqual({ status: 'scheduled', refusal: null })
        expect(mocks.compensationPilotRefresh).toHaveBeenCalledWith(proven)
        expectNoIdentityWrites()
    })

    const everyCompensationAction = () => [
        actionRequest('compensation_section', { telegramId: '123456', ...binding }),
        actionRequest('compensation_order_check', { telegramId: '123456', externalOrderId: 'order-1', scopeKey: 'scope-a', ...binding }),
        actionRequest('compensation_refresh', { telegramId: '123456', ...binding }),
        actionRequest('compensation_submit', submitPayload),
    ]

    function expectNoCompensationService() {
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
        expect(mocks.compensationPilotOrderCheck).not.toHaveBeenCalled()
        expect(mocks.compensationPilotRefresh).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSubmit).not.toHaveBeenCalled()
    }

    test('answers a link that no longer names the Driver with 409 on every compensation action, reaching no service', async () => {
        mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-2' })
        for (const request of everyCompensationAction()) {
            expect((await POST(request)).status).toBe(409)
        }
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expectNoCompensationService()
    })

    // A linked driver is never told the profile is not linked. Cash pays a
    // Contacts-proven person, so without one the driver is sent to a manager.
    test('tells a linked driver with no Contacts person to ask a manager, on every compensation action, reaching no service', async () => {
        mocks.authorizeDriverTelegram.mockRejectedValue(new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'))
        const answers = []
        for (const request of everyCompensationAction()) {
            const response = await POST(request)
            expect(response.status).toBe(200)
            answers.push(await response.json())
        }
        expect(answers).toEqual([
            { available: false, reason: 'identity_needs_review', applications: [] },
            { state: 'refused', refusal: 'identity_needs_review', order: null },
            { status: 'refused', refusal: 'identity_needs_review' },
            { submitted: false, refusal: 'identity_needs_review' },
        ])
        // The refusal came from Cash's person proof, after the link was proven.
        expect(mocks.authorizeDriverTelegram).toHaveBeenCalledTimes(4)
        expectNoCompensationService()
    })

    // The compensation entry shares the one Bot runtime authority of every Driver
    // action. These fail if either side of that composition is lost.
    test('serves a real chat on the link and person proofs alone: no stored chatKind or transport is required', async () => {
        mocks.compensationPilotSection.mockResolvedValue({ available: false, reason: 'not_self_employed', applications: [] })
        const proof = await mocks.authorizeDriverTelegram()
        expect(proof).not.toHaveProperty('providerAccountId')
        expect(proof).not.toHaveProperty('connectionId')
        mocks.authorizeDriverTelegram.mockClear()

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        expect(response.status).toBe(200)
        expect(mocks.authorizeDriverTelegram).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 123456n })
        expect(mocks.compensationPilotSection).toHaveBeenCalledWith(proven, { search: null })
    })

    test('never pays a Contacts person proven for a different Driver than the link', async () => {
        mocks.authorizeDriverTelegram.mockResolvedValue({
            chatId: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            driverId: 'driver-2',
            target: '123456',
        })

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toEqual({ available: false, reason: 'identity_needs_review', applications: [] })
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
    })

    test.each([
        ['a transport that is not the canonical Bot connection', { providerAccountId: '8447212640', connectionId: MTPROTO_CONNECTION }],
        ['a provider account that is not concrete', { providerAccountId: 'telegram-bot-1', connectionId: BOT_CONNECTION }],
        ['a missing action binding', {}],
    ])('refuses compensation from %s before any person proof', async (_label, actionBinding) => {
        const requests = [
            actionRequest('compensation_section', { telegramId: '123456', ...actionBinding }),
            actionRequest('compensation_order_check', { telegramId: '123456', externalOrderId: 'order-1', scopeKey: 'scope-a', ...actionBinding }),
            actionRequest('compensation_refresh', { telegramId: '123456', ...actionBinding }),
            actionRequest('compensation_submit', { ...submitPayload, providerAccountId: undefined, connectionId: undefined, ...actionBinding }),
        ]
        for (const request of requests) {
            const response = await POST(request)
            expect(response.status).toBe(409)
            await expect(response.json()).resolves.toEqual({ error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED' })
        }
        expect(mocks.findDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
        expect(mocks.compensationPilotOrderCheck).not.toHaveBeenCalled()
        expect(mocks.compensationPilotRefresh).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSubmit).not.toHaveBeenCalled()
    })

    test('refuses compensation when the canonical Bot transport is unconfigured', async () => {
        mocks.canonicalBotConnection.mockImplementation(() => {
            throw new Error('TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN')
        })

        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        expect(response.status).toBe(409)
        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
    })
})

describe('driver-bot Yandex profile id of a reconciled Driver', () => {
    const PROFILE = '0123456789abcdef0123456789abcdef'
    const LEGACY_PROFILE = 'fedcba9876543210fedcba9876543210'
    const binding = { providerAccountId: '8447212640', connectionId: BOT_CONNECTION }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegramFirst.mockResolvedValue({
            id: 'mapping-1',
            driverId: 'driver-1',
            telegramId: 123456n,
            activeParkId: 'park-1',
            carLabel: null,
        })
        mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-1' })
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
        mocks.recordDriverAction.mockResolvedValue({ action: { id: 'action-1' } })
        // No provider connection: the fired-profile guard is skipped and the only
        // fetch of a driver action is the scraper enqueue.
        mocks.getYandexConnectionCredentials.mockResolvedValue(null)
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    function scraperAccepts() {
        mocks.providerFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ taskId: 'task-1' }) })
    }
    function scraperBody() {
        const [url, init] = mocks.providerFetch.mock.calls[0]
        expect(String(url)).toMatch(/\/api\/driver-actions$/)
        return JSON.parse(init.body)
    }

    test.each([
        ['park-profile key of the multi-park reconciler', `park-profile:${'9'.repeat(32)}`],
        ['earlier park:<park>:<profile> key', `park:${'8'.repeat(32)}:${PROFILE}`],
    ])('get_order_price sends the real profile id, not the %s', async (_name, crmKey) => {
        mocks.findDriver.mockResolvedValue({
            id: 'driver-1', fullName: 'Test Driver', yandexDriverId: crmKey, externalDriverProfileId: PROFILE,
        })
        scraperAccepts()

        const response = await POST(actionRequest('get_order_price', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ ok: true, taskId: 'task-1', status: 'PENDING' })
        expect(scraperBody()).toMatchObject({ kind: 'GET_PRICE', driverYandexId: PROFILE, parkId: 'park-1' })
        expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ driverId: 'driver-1', status: 'PENDING', scraperTaskId: 'task-1' }),
        }))
    })

    test('a legacy Driver whose yandexDriverId is the profile id keeps working unchanged', async () => {
        mocks.findDriver.mockResolvedValue({
            id: 'driver-1', fullName: 'Test Driver', yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null,
        })
        scraperAccepts()

        const response = await POST(actionRequest('cancel_order', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ ok: true, status: 'PENDING' })
        expect(scraperBody()).toMatchObject({ kind: 'CANCEL_ORDER', driverYandexId: LEGACY_PROFILE })
    })

    test('a Driver with only a CRM key goes to the manager and never reaches the scraper', async () => {
        mocks.findDriver.mockResolvedValue({
            id: 'driver-1', fullName: 'Test Driver', yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: null,
        })

        const response = await POST(actionRequest('get_order_price', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'NO_YANDEX_ID' })
        expect(mocks.providerFetch).not.toHaveBeenCalled()
        expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'ESCALATED_TO_MANAGER' }),
        }))
    })

    test('change_limit reads and writes the real profile of a reconciled Driver', async () => {
        mocks.getYandexConnectionCredentials.mockResolvedValue({ clid: 'clid-1', apiKey: 'api-key-1', parkId: 'park-1' })
        mocks.findDriver.mockResolvedValue({
            yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: PROFILE, phone: '+70000000000',
        })
        const profile = { account: { balance_limit: '0' } }
        mocks.providerFetch
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(profile) })
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(profile) })
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(profile) })

        const response = await POST(actionRequest('change_limit', { telegramId: '123456', limitValue: 5_000, ...binding }))

        await expect(response.json()).resolves.toEqual({ success: true, newLimit: 5_000 })
        const urls = mocks.providerFetch.mock.calls.map(([url]) => String(url))
        expect(urls).toHaveLength(3)
        for (const url of urls) expect(url).toContain(`contractor_profile_id=${PROFILE}`)
        expect(urls.join('\n')).not.toContain('park-profile')
    })

    test('check_link looks up the real profile of a reconciled Driver', async () => {
        mocks.getYandexConnectionCredentials.mockResolvedValue({ clid: 'clid-1', apiKey: 'api-key-1', parkId: 'park-1' })
        mocks.findDriver.mockResolvedValue({
            yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: PROFILE, fullName: 'Test Driver',
        })
        mocks.providerFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ person: {} }) })

        const response = await POST(actionRequest('check_link', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ linked: true, driverId: 'driver-1' })
        expect(String(mocks.providerFetch.mock.calls[0][0])).toContain(`contractor_profile_id=${PROFILE}`)
    })

    describe('update_driver_car', () => {
        const carRequest = () => actionRequest('update_driver_car', { telegramId: '123456', carId: 'car-9', ...binding })
        const connection = { clid: 'clid-1', apiKey: 'api-key-1', parkId: 'park-1' }
        const yandexOk = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
        // The selected park's own cars, read before the car is bound.
        const parkCars = (...ids: string[]) => ({
            ok: true,
            status: 200,
            json: async () => ({ cars: ids.map((id) => ({ id, brand: 'Brand', model: 'Model', number: 'A000AA' })), total: ids.length }),
        })

        test('binds the car on the real profile of a Driver whose link names its CRM id', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({
                yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: PROFILE,
            })
            mocks.providerFetch
                .mockResolvedValueOnce(parkCars('car-9'))
                .mockResolvedValueOnce(yandexOk({ car_id: 'car-1', account: { balance_limit: '0' } }))
                .mockResolvedValueOnce(yandexOk({}))

            const response = await POST(carRequest())

            expect(response.status).toBe(200)
            await expect(response.json()).resolves.toEqual({ success: true, newCarId: 'car-9' })
            expect(mocks.findDriver).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'driver-1' } }))
            const calls = mocks.providerFetch.mock.calls
            expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'GET', 'PUT'])
            expect(String(calls[0][0])).toContain('/v1/parks/cars/list')
            for (const [url] of [calls[1], calls[2]]) {
                expect(String(url)).toContain(`contractor_profile_id=${PROFILE}`)
                expect(String(url)).not.toContain('driver-1')
                expect(String(url)).not.toContain('park-profile')
            }
            expect(JSON.parse(calls[2][1].body)).toMatchObject({ car_id: 'car-9', account: { balance_limit: '0' } })
            // The link is proven again immediately before the provider mutation.
            expect(mocks.findDriverTelegram.mock.calls.length).toBeGreaterThanOrEqual(2)
            expect(mocks.getYandexConnectionCredentials).toHaveBeenCalledWith(undefined, 'park-1')
        })

        test('a legacy Driver whose yandexDriverId is the profile id keeps its profile', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({ yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
            mocks.providerFetch
                .mockResolvedValueOnce(parkCars('car-9'))
                .mockResolvedValueOnce(yandexOk({ car_id: 'car-1' }))
                .mockResolvedValueOnce(yandexOk({}))

            const response = await POST(carRequest())

            await expect(response.json()).resolves.toEqual({ success: true, newCarId: 'car-9' })
            const calls = mocks.providerFetch.mock.calls
            for (const [url] of [calls[1], calls[2]]) {
                expect(String(url)).toContain(`contractor_profile_id=${LEGACY_PROFILE}`)
            }
        })

        test.each([
            ['a Driver with only a CRM key', { yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: null }],
            ['no Driver row for the link', null],
        ])('%s gets a plain refusal with no credential read, GET or PUT', async (_name, row) => {
            mocks.findDriver.mockResolvedValue(row)
            mocks.findDriverByYandex.mockResolvedValue(null)

            const response = await POST(carRequest())

            expect(response.status).toBe(404)
            await expect(response.json()).resolves.toEqual({
                error: 'Не нашли ваш профиль в Яндекс Флит. Обратитесь к менеджеру.',
            })
            expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
            expect(mocks.providerFetch).not.toHaveBeenCalled()
        })

        test('a Yandex error on reading the profile stops before any PUT', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({
                yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: PROFILE,
            })
            mocks.providerFetch
                .mockResolvedValueOnce(parkCars('car-9'))
                .mockResolvedValueOnce({ ok: false, status: 404, text: async () => JSON.stringify({ message: 'not found' }) })

            const response = await POST(carRequest())

            expect(response.status).toBe(502)
            await expect(response.json()).resolves.toMatchObject({ error: 'Failed to fetch driver profile' })
            expect(mocks.providerFetch).toHaveBeenCalledTimes(2)
            expect(mocks.providerFetch.mock.calls[1][1]).toMatchObject({ method: 'GET' })
        })

        test('a rate-limited car listing binds nothing and is not reported as a missing car', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({ yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
            mocks.providerFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })

            const response = await POST(carRequest())

            expect(response.status).toBe(503)
            await expect(response.json()).resolves.toEqual({ error: 'Не удалось проверить автомобиль в Яндексе. Попробуйте позже.' })
            expect(mocks.providerFetch).toHaveBeenCalledTimes(1)
        })

        test('a car listing that fails outright binds nothing and asks to try later', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({ yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
            mocks.providerFetch.mockRejectedValueOnce(new Error('socket hang up'))

            const response = await POST(carRequest())

            expect(response.status).toBe(503)
            await expect(response.json()).resolves.toEqual({ error: 'Не удалось проверить автомобиль в Яндексе. Попробуйте позже.' })
            expect(mocks.providerFetch).toHaveBeenCalledTimes(1)
        })

        test('a car on a later page of the park\'s listing is found and bound', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({ yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
            const page = (ids: string[], total: number) => ({ ok: true, status: 200, json: async () => ({ cars: ids.map((id) => ({ id })), total }) })
            mocks.providerFetch
                .mockResolvedValueOnce(page(Array.from({ length: 500 }, (_, index) => `other-${index}`), 501))
                .mockResolvedValueOnce(page(['car-9'], 501))
                .mockResolvedValueOnce(yandexOk({ car_id: 'car-1' }))
                .mockResolvedValueOnce(yandexOk({}))

            const response = await POST(carRequest())

            await expect(response.json()).resolves.toEqual({ success: true, newCarId: 'car-9' })
            expect(mocks.providerFetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'POST', 'GET', 'PUT'])
        })

        test('a car missing from the park\'s whole listing is refused before any profile read', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
            mocks.findDriver.mockResolvedValue({ yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
            mocks.providerFetch.mockResolvedValueOnce(parkCars('car-1'))

            const response = await POST(carRequest())

            expect(response.status).toBe(409)
            await expect(response.json()).resolves.toEqual({ error: 'Этот автомобиль не найден в выбранном парке. Найдите автомобиль заново.' })
            expect(mocks.providerFetch).toHaveBeenCalledTimes(1)
        })
    })
})

describe('driver-bot acts only on the driver\'s own profile in its own park', () => {
    const PROFILE = '0123456789abcdef0123456789abcdef'
    const LEGACY_PROFILE = 'fedcba9876543210fedcba9876543210'
    const TWIN = '1111111111111111111111111111111a'
    const NAMESAKE = '2222222222222222222222222222222b'
    const PHONE = '+79030000001'
    const binding = { providerAccountId: '8447212640', connectionId: BOT_CONNECTION }
    const PARK_UNPROVEN = 'Ваш профиль в выбранном парке не подтверждён. Выберите парк заново или обратитесь к менеджеру.'
    const yandex = (body: unknown, status = 200) => ({
        ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    })
    const listing = (...profiles: Array<{ id: string; status: string; phones: string[] }>) => yandex({
        driver_profiles: profiles.map((p) => ({ driver_profile: { id: p.id, work_status: p.status, phones: p.phones } })),
    })

    function link(activeParkId: string | null) {
        mocks.findDriverTelegramFirst.mockResolvedValue({
            id: 'mapping-1', driverId: 'driver-1', telegramId: 123456n, activeParkId, carLabel: null,
        })
    }
    function card(externalParkId: string | null, overrides: Record<string, unknown> = {}) {
        mocks.findDriver.mockResolvedValue({
            id: 'driver-1', fullName: 'Test Driver', phone: PHONE,
            yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalDriverProfileId: PROFILE, externalParkId,
            ...overrides,
        })
    }
    function scraperBody() {
        const call = mocks.providerFetch.mock.calls.find(([url]) => String(url).endsWith('/api/driver-actions'))
        expect(call).toBeDefined()
        return JSON.parse(call![1].body)
    }
    const credentialParks = () => mocks.getYandexConnectionCredentials.mock.calls.map((args) => args[1])

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-1' })
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
        mocks.recordDriverAction.mockResolvedValue({ action: { id: 'action-1' } })
        mocks.findDriverByYandex.mockResolvedValue(null)
        mocks.getYandexConnectionCredentials.mockImplementation(async (_scope: unknown, parkId?: string) => ({
            clid: 'clid-1', apiKey: 'api-key-1', parkId: parkId ?? 'newest-connection',
        }))
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    test('an order action runs in the selected park when it is the profile\'s park', async () => {
        link('park-a')
        card('park-a')
        mocks.providerFetch
            .mockResolvedValueOnce(listing({ id: PROFILE, status: 'working', phones: [PHONE] }))
            .mockResolvedValueOnce(yandex({ taskId: 'task-1' }))

        const response = await POST(actionRequest('get_order_price', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ ok: true, taskId: 'task-1' })
        expect(scraperBody()).toMatchObject({ driverYandexId: PROFILE, parkId: 'park-a' })
        expect(credentialParks()).toEqual(['park-a'])
    })

    test('with no park selected an order action runs in the profile\'s own park, never a default one', async () => {
        link(null)
        card('park-b')
        mocks.providerFetch
            .mockResolvedValueOnce(listing({ id: PROFILE, status: 'working', phones: [PHONE] }))
            .mockResolvedValueOnce(yandex({ taskId: 'task-1' }))

        await POST(actionRequest('complete_order', { telegramId: '123456', ...binding }))

        expect(scraperBody()).toMatchObject({ kind: 'COMPLETE_ORDER', driverYandexId: PROFILE, parkId: 'park-b' })
        expect(credentialParks()).toEqual(['park-b'])
    })

    test('a legacy row with no recorded park acts in the park the driver selected', async () => {
        link('park-a')
        card(null, { yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
        mocks.providerFetch
            .mockResolvedValueOnce(listing({ id: LEGACY_PROFILE, status: 'working', phones: [PHONE] }))
            .mockResolvedValueOnce(yandex({ taskId: 'task-1' }))

        await POST(actionRequest('get_order_price', { telegramId: '123456', ...binding }))

        expect(scraperBody()).toMatchObject({ driverYandexId: LEGACY_PROFILE, parkId: 'park-a' })
    })

    test.each(['get_order_price', 'complete_order', 'cancel_order'])(
        '%s in a park that is not the profile\'s park goes to the manager and reaches nothing',
        async (action) => {
            link('park-a')
            card('park-b')

            const response = await POST(actionRequest(action, { telegramId: '123456', ...binding }))

            await expect(response.json()).resolves.toEqual({
                ok: false, error: 'YANDEX_PROFILE_PARK_UNPROVEN', status: 'ESCALATED_TO_MANAGER', message: PARK_UNPROVEN,
            })
            expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
            expect(mocks.providerFetch).not.toHaveBeenCalled()
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ driverId: 'driver-1', status: 'ESCALATED_TO_MANAGER' }),
            }))
        },
    )

    test('a legacy row with no recorded park and no selection is refused, not sent to a default park', async () => {
        link(null)
        card(null, { yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })

        const response = await POST(actionRequest('cancel_order', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'YANDEX_PROFILE_PARK_UNPROVEN' })
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test.each([
        ['change_limit', { limitValue: 5_000 }],
        ['update_driver_car', { carId: 'car-9' }],
    ])('%s in a park that is not the profile\'s park is refused in plain words, reading no credential', async (action, extra) => {
        link('park-a')
        card('park-b')

        const response = await POST(actionRequest(action, { telegramId: '123456', ...extra, ...binding }))

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({ error: PARK_UNPROVEN })
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('check_link in a park that is not the profile\'s park shows the link without asking Yandex', async () => {
        link('park-a')
        card('park-b')

        const response = await POST(actionRequest('check_link', { telegramId: '123456', ...binding }))

        await expect(response.json()).resolves.toMatchObject({ linked: true, driverId: 'driver-1', carInfo: null })
        expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    describe('a fired profile is swapped only for the driver\'s own working twin', () => {
        beforeEach(() => {
            link('park-a')
            card('park-a')
        })

        test('a namesake with another phone is never used', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(listing(
                    { id: PROFILE, status: 'fired', phones: [PHONE] },
                    { id: NAMESAKE, status: 'working', phones: ['+79035555555'] },
                ))
                .mockResolvedValueOnce(yandex({ taskId: 'task-1' }))

            await POST(actionRequest('cancel_order', { telegramId: '123456', ...binding }))

            expect(scraperBody()).toMatchObject({ driverYandexId: PROFILE })
        })

        test('the single working profile with the driver\'s phone is used', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(listing(
                    { id: PROFILE, status: 'fired', phones: [PHONE] },
                    { id: NAMESAKE, status: 'working', phones: ['+79035555555'] },
                    { id: TWIN, status: 'working', phones: ['8 (903) 000-00-01'] },
                ))
                .mockResolvedValueOnce(yandex({ taskId: 'task-1' }))

            await POST(actionRequest('cancel_order', { telegramId: '123456', ...binding }))

            expect(scraperBody()).toMatchObject({ driverYandexId: TWIN, parkId: 'park-a' })
        })

        test('two working profiles with the driver\'s phone are ambiguous and neither is used', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(listing(
                    { id: PROFILE, status: 'fired', phones: [PHONE] },
                    { id: TWIN, status: 'working', phones: [PHONE] },
                    { id: NAMESAKE, status: 'working', phones: [PHONE] },
                ))
                .mockResolvedValueOnce(yandex({ taskId: 'task-1' }))

            await POST(actionRequest('cancel_order', { telegramId: '123456', ...binding }))

            expect(scraperBody()).toMatchObject({ driverYandexId: PROFILE })
        })
    })

    describe('change_limit phone fallback picks only an exact, unique match', () => {
        beforeEach(() => {
            link(null)
            card(null, { yandexDriverId: LEGACY_PROFILE, externalDriverProfileId: null })
            mocks.findDriverTelegramFirst.mockResolvedValue({
                id: 'mapping-1', driverId: 'driver-1', telegramId: 123456n, activeParkId: 'park-a', carLabel: null,
            })
        })
        const limit = () => POST(actionRequest('change_limit', { telegramId: '123456', limitValue: 5_000, ...binding }))
        const urls = () => mocks.providerFetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)

        test('the single profile with exactly the driver\'s phone receives the limit', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(yandex({}, 404))
                .mockResolvedValueOnce(listing({ id: TWIN, status: 'working', phones: ['+7 903 000 00 01'] }))
                .mockResolvedValueOnce(yandex({ account: { balance_limit: '0' } }))
                .mockResolvedValueOnce(yandex({ account: { balance_limit: '5000' } }))

            const response = await limit()

            await expect(response.json()).resolves.toEqual({ success: true, newLimit: 5_000 })
            expect(urls().at(-1)).toBe(`PUT https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${TWIN}`)
        })

        test.each([
            ['two profiles share the driver\'s phone', [
                { id: TWIN, status: 'working', phones: [PHONE] },
                { id: NAMESAKE, status: 'working', phones: [PHONE] },
            ]],
            ['a longer number merely contains the driver\'s digits', [
                { id: NAMESAKE, status: 'working', phones: ['+7903000000177'] },
            ]],
        ])('nobody else receives the limit when %s', async (_name, profiles) => {
            mocks.providerFetch
                .mockResolvedValueOnce(yandex({}, 404))
                .mockResolvedValueOnce(listing(...profiles))
                .mockResolvedValueOnce(yandex({ message: 'not found' }, 404))

            const response = await limit()

            expect(response.status).toBe(502)
            expect(urls().some((url) => url.startsWith('PUT'))).toBe(false)
            expect(urls().join('\n')).not.toContain(TWIN)
            expect(urls().join('\n')).not.toContain(NAMESAKE)
        })
    })

    test('no driver handler reads credentials without a park or names a default park', () => {
        const route = readFileSync(resolve(process.cwd(), 'src/app/api/webhooks/bot/route.ts'), 'utf8')
        const body = (name: string) => {
            const start = route.indexOf(`async function ${name}(`)
            expect(start).toBeGreaterThanOrEqual(0)
            const next = route.indexOf('\nasync function ', start + 1)
            return route.slice(start, next === -1 ? undefined : next)
        }
        for (const handler of ['handleCheckLink', 'handleChangeLimit', 'handleUpdateDriverCar', 'handleDriverAction']) {
            expect(body(handler)).not.toContain('getYandexConnectionCredentialsV1()')
            expect(body(handler)).toContain('driverYandexTarget(driver, mapping.activeParkId)')
        }
        expect(route).not.toContain('DRIVER_ACTIONS_PARK_ID')
    })
})

describe('R-OWNER-28: one Telegram account acts on the same person\'s own Driver row in each park', () => {
    const YOKO = 'park-yoko'
    const NASH = 'park-nash'
    const YOKO2 = 'park-yoko2'
    const KEY = 'vu:1234567890'
    const CONTACT = 'contact-1'
    const PROFILE: Record<string, string> = {
        [YOKO]: 'a'.repeat(32),
        [NASH]: 'b'.repeat(32),
        [YOKO2]: 'c'.repeat(32),
    }
    const binding = { providerAccountId: '8447212640', connectionId: BOT_CONNECTION }

    type Row = {
        id: string
        fullName: string
        phone: string | null
        yandexDriverId: string
        externalDriverProfileId: string | null
        externalParkId: string | null
        externalPersonKey: string | null
        contactId: string | null
        personResolutionStatus: string
        dismissedAt: Date | null
    }
    const row = (park: string, over: Partial<Row> = {}): Row => ({
        id: `driver-${park}`,
        fullName: 'Test Driver',
        phone: '+79030000001',
        yandexDriverId: `park-profile:${park}`,
        externalDriverProfileId: PROFILE[park],
        externalParkId: park,
        externalPersonKey: KEY,
        contactId: CONTACT,
        personResolutionStatus: 'operator_confirmed',
        dismissedAt: null,
        ...over,
    })

    let anchor: Row
    let drivers: Row[]
    let selectedPark: string
    let carLabel: string | null
    let calls: Array<{ url: string; method: string; park: string | null; body: any }>
    let hooks: { onProfileGet?: () => void | Promise<void>; onDispatch?: () => void | Promise<void> }
    let taskCounter: number
    let missingProfiles: Set<string>

    const reply = (status: number, body?: unknown) => {
        const text = body === undefined ? '' : JSON.stringify(body)
        return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text || 'null'), text: async () => text }
    }

    /** Yandex and the scraper as the route sees them: profiles and cars belong to one park each. */
    async function fakeFetch(input: unknown, init: any = {}) {
        const url = String(input)
        const method = init.method ?? 'GET'
        const clid = init.headers?.['X-Client-ID'] ?? null
        const park = typeof clid === 'string' ? clid.replace(/^clid-/, '') : null
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ url, method, park, body })
        // Let concurrent requests interleave at every provider call.
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (url.includes('/v2/parks/contractors/driver-profile')) {
            const profile = new URL(url).searchParams.get('contractor_profile_id')
            const owner = Object.keys(PROFILE).find((key) => PROFILE[key] === profile)
            if (!owner || owner !== park || missingProfiles.has(profile as string)) return reply(404, { message: 'driver not found' })
            if (method === 'GET') {
                await hooks.onProfileGet?.()
                return reply(200, { car_id: `car-${owner}`, account: { balance_limit: '0' }, person: { full_name: { last_name: 'Test', first_name: 'Driver' } } })
            }
            if (method === 'PUT') return reply(204)
        }
        if (url.endsWith('/v1/parks/cars/list')) {
            const listed = body?.query?.park?.id
            if (listed !== park) return reply(403, { message: 'park mismatch' })
            return reply(200, { cars: [{ id: `car-${listed}`, brand: 'Brand', model: listed, number: `N-${listed}` }], total: 1 })
        }
        if (url.endsWith('/v1/parks/driver-profiles/list')) return reply(200, { driver_profiles: [] })
        if (url.endsWith('/api/driver-actions') && method === 'POST') {
            await hooks.onDispatch?.()
            taskCounter += 1
            return reply(202, { taskId: `task-${taskCounter}`, status: 'PENDING' })
        }
        if (url.includes('/api/driver-actions/')) return reply(200, { status: 'DONE', result: { priceRub: 450, shortOrderId: '100' } })
        throw new Error(`unexpected fetch ${method} ${url}`)
    }

    /** prisma.driver.findMany over the fixture rows, honouring every condition the route asks for. */
    async function findDriverRows({ where, take }: { where: Record<string, any>; take?: number }) {
        const rows = drivers.filter((candidate) => Object.entries(where).every(([field, condition]) => {
            if (field === 'id') return condition?.not === undefined ? candidate.id === condition : candidate.id !== condition.not
            if (field === 'dismissedAt') return condition === null ? candidate.dismissedAt === null : candidate.dismissedAt !== null
            return (candidate as any)[field] === condition
        }))
        return rows.slice(0, take ?? rows.length).map((found) => ({ ...found }))
    }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        anchor = row(YOKO, { id: 'driver-1' })
        drivers = [anchor, row(NASH), row(YOKO2)]
        selectedPark = YOKO
        carLabel = null
        calls = []
        hooks = {}
        taskCounter = 0
        missingProfiles = new Set()
        mocks.findDriverTelegramFirst.mockImplementation(async () => ({
            id: 'mapping-1',
            driverId: 'driver-1',
            telegramId: 123456n,
            activeParkId: selectedPark,
            carLabel,
        }))
        mocks.findDriverTelegram.mockImplementation(async () => ({ driverId: 'driver-1' }))
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
        // Reads return copies, as the database would: a later change is never seen through an earlier read.
        mocks.findDriver.mockImplementation(async ({ where }: any) => {
            const found = drivers.find((candidate) => candidate.id === where.id)
            return found ? { ...found } : null
        })
        mocks.findDriverByYandex.mockImplementation(async () => ({ ...anchor }))
        mocks.findDrivers.mockImplementation(findDriverRows)
        mocks.confirmedDriverCluster.mockImplementation(async (key: string) => (
            key === KEY ? { contactId: CONTACT, confirmationId: 'confirmation-1', evidenceRoot: 'root-1' } : null
        ))
        mocks.getYandexConnectionCredentials.mockImplementation(async (_unused: unknown, parkId: string) => (
            { clid: `clid-${parkId}`, apiKey: `key-${parkId}`, parkId, name: parkId }
        ))
        mocks.patchDriverTelegramLink.mockResolvedValue({ updated: true })
        mocks.recordDriverAction.mockResolvedValue({ action: { id: 'action-1' } })
        mocks.mirrorDriverActionResult.mockResolvedValue({ mirrored: true })
        vi.stubGlobal('fetch', vi.fn(fakeFetch))
    })

    const act = (action: string, extra: Record<string, unknown> = {}) =>
        POST(actionRequest(action, { telegramId: '123456', ...binding, ...extra }))
    const puts = () => calls.filter((call) => call.method === 'PUT')
    const touches = (profile: string) => calls.some((call) => call.url.includes(profile) || JSON.stringify(call.body ?? '').includes(profile))
    const scraperBodies = () => calls.filter((call) => call.url.endsWith('/api/driver-actions') && call.method === 'POST').map((call) => call.body)

    describe('cash, car and current order in each park', () => {
        test('Yoko, the link row\'s own park, works exactly as before', async () => {
            const cash = await act('change_limit', { limitValue: 5 })
            await expect(cash.json()).resolves.toEqual({ success: true, newLimit: 5 })
            expect(puts()).toEqual([expect.objectContaining({ park: YOKO, url: expect.stringContaining(PROFILE[YOKO]) })])

            const car = await act('check_link')
            await expect(car.json()).resolves.toMatchObject({ linked: true, carInfo: `Brand ${YOKO} N-${YOKO}` })
            // The link row's own park keeps its car cache.
            expect(mocks.patchDriverTelegramLink).toHaveBeenCalledWith(expect.objectContaining({ patch: { carLabel: `Brand ${YOKO} N-${YOKO}` } }))

            const order = await act('get_order_price')
            await expect(order.json()).resolves.toMatchObject({ ok: true, status: 'PENDING' })
            expect(scraperBodies()).toEqual([expect.objectContaining({ driverYandexId: PROFILE[YOKO], parkId: YOKO })])
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ driverId: 'driver-1', status: 'PENDING' }),
            }))
            // No other park was asked about: the link row acts itself.
            expect(mocks.findDrivers).not.toHaveBeenCalled()
            expect(touches(PROFILE[NASH]) || touches(PROFILE[YOKO2])).toBe(false)
        })

        test.each([[NASH], [YOKO2]])('%s acts on its own confirmed Driver row, never on Yoko\'s', async (park) => {
            selectedPark = park

            const cash = await act('change_limit', { limitValue: 5 })
            await expect(cash.json()).resolves.toEqual({ success: true, newLimit: 5 })
            expect(puts()).toEqual([expect.objectContaining({ park, url: expect.stringContaining(PROFILE[park]) })])
            expect(JSON.parse(JSON.stringify(puts()[0].body))).toMatchObject({ account: { balance_limit: '5' } })

            const car = await act('check_link')
            await expect(car.json()).resolves.toMatchObject({ linked: true, carInfo: `Brand ${park} N-${park}` })

            const order = await act('get_order_price')
            await expect(order.json()).resolves.toMatchObject({ ok: true, status: 'PENDING' })
            expect(scraperBodies()).toEqual([expect.objectContaining({ driverYandexId: PROFILE[park], parkId: park })])
            // Audit records name the Driver row the action ran on.
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ driverId: `driver-${park}`, kind: 'GET_PRICE', status: 'PENDING' }),
            }))

            // Every provider call used that park's credentials, and Yoko's profile was never touched.
            for (const call of calls.filter((entry) => entry.park !== null)) expect(call.park).toBe(park)
            expect(touches(PROFILE[YOKO])).toBe(false)
            // A car found outside the link row's park is never cached, and no phone search ran.
            expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
            expect(calls.some((call) => call.url.endsWith('/v1/parks/driver-profiles/list'))).toBe(false)
        })

        test.each([
            ['complete_order', NASH], ['cancel_order', NASH], ['complete_order', YOKO2], ['cancel_order', YOKO2],
        ])('%s in %s stays in the link row\'s own park: nothing is sent to the scraper', async (action, park) => {
            selectedPark = park

            const response = await act(action)

            await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'YANDEX_PROFILE_PARK_UNPROVEN' })
            expect(scraperBodies()).toEqual([])
            expect(mocks.findDrivers).not.toHaveBeenCalled()
            expect(touches(PROFILE[park]) || touches(PROFILE[YOKO])).toBe(false)
        })

        test('complete and cancel in the link row\'s own park work exactly as before', async () => {
            const done = await act('complete_order')
            await expect(done.json()).resolves.toMatchObject({ ok: true, status: 'PENDING' })
            const cancelled = await act('cancel_order')
            await expect(cancelled.json()).resolves.toMatchObject({ ok: true, status: 'PENDING' })
            expect(scraperBodies()).toEqual([
                expect.objectContaining({ kind: 'COMPLETE_ORDER', driverYandexId: PROFILE[YOKO], parkId: YOKO }),
                expect.objectContaining({ kind: 'CANCEL_ORDER', driverYandexId: PROFILE[YOKO], parkId: YOKO }),
            ])
        })

        test('the proof asks for exactly the proven person\'s confirmed row in the selected park', async () => {
            selectedPark = NASH

            await act('change_limit', { limitValue: 5 })

            expect(mocks.confirmedDriverCluster).toHaveBeenCalledWith(KEY)
            expect(mocks.findDrivers).toHaveBeenCalledWith({
                where: {
                    externalPersonKey: KEY,
                    externalParkId: NASH,
                    contactId: CONTACT,
                    personResolutionStatus: 'operator_confirmed',
                    dismissedAt: null,
                    id: { not: 'driver-1' },
                },
                select: expect.objectContaining({ externalDriverProfileId: true, externalParkId: true }),
                take: 2,
            })
        })

        test('a proven row Yandex no longer knows is never replaced by a phone or name search', async () => {
            selectedPark = NASH
            missingProfiles.add(PROFILE[NASH])

            const cash = await act('change_limit', { limitValue: 5 })
            expect(cash.status).toBe(502)
            const car = await act('check_link')
            await expect(car.json()).resolves.toMatchObject({ linked: true, carInfo: null })

            expect(calls.some((call) => call.url.endsWith('/v1/parks/driver-profiles/list'))).toBe(false)
            expect(puts()).toHaveLength(0)
            expect(touches(PROFILE[YOKO])).toBe(false)
        })

        test('the car of one park is bound only to that park\'s own profile', async () => {
            selectedPark = NASH

            const response = await act('update_driver_car', { carId: `car-${NASH}` })

            await expect(response.json()).resolves.toEqual({ success: true, newCarId: `car-${NASH}` })
            expect(puts()).toEqual([expect.objectContaining({ park: NASH, url: expect.stringContaining(PROFILE[NASH]) })])
            expect(puts()[0].body).toMatchObject({ car_id: `car-${NASH}` })
        })

        test('the Telegram link is never rewritten by any action in any park', async () => {
            for (const park of [YOKO, NASH, YOKO2, YOKO]) {
                selectedPark = park
                await act('change_limit', { limitValue: 5 })
                await act('check_link')
                await act('update_driver_car', { carId: `car-${park}` })
                await act('get_order_price')
            }
            for (const [command] of mocks.patchDriverTelegramLink.mock.calls) {
                expect(Object.keys(command.patch)).toEqual(['carLabel'])
            }
            // Every authority check read this account's own link row, and nothing of Contacts' chat proof.
            expect(mocks.findDriverTelegram.mock.calls.every(([input]) => input.where.telegramId === 123456n)).toBe(true)
            expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        })
    })

    describe('a car of one park is never shown as the car of another', () => {
        test('a cached Yoko car is not shown while another park is selected', async () => {
            selectedPark = NASH
            carLabel = 'Brand park-yoko N-park-yoko'

            const response = await act('check_link')

            await expect(response.json()).resolves.toMatchObject({ carInfo: `Brand ${NASH} N-${NASH}` })
        })

        test('a cached Yoko car is shown while Yoko is selected, without asking Yandex', async () => {
            carLabel = 'Brand park-yoko N-park-yoko'

            const response = await act('check_link')

            await expect(response.json()).resolves.toMatchObject({ carInfo: carLabel })
            expect(calls).toHaveLength(0)
        })

        test('a link row with no recorded park neither caches its car nor shows a cached one', async () => {
            drivers = [anchor = row(YOKO, { id: 'driver-1', externalParkId: null, externalPersonKey: null, yandexDriverId: PROFILE[YOKO], externalDriverProfileId: null })]
            carLabel = 'Brand park-nash N-park-nash'

            const response = await act('check_link')

            // The selected park's own car is looked up; the stale label is ignored and nothing is cached.
            await expect(response.json()).resolves.toMatchObject({ carInfo: `Brand ${YOKO} N-${YOKO}` })
            expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
        })

        test('a Yoko lookup that finishes after a switch caches only Yoko\'s car, which the next park never shows', async () => {
            hooks.onProfileGet = () => { selectedPark = NASH }

            const first = await act('check_link')
            await expect(first.json()).resolves.toMatchObject({ carInfo: `Brand ${YOKO} N-${YOKO}` })
            const written = mocks.patchDriverTelegramLink.mock.calls.at(-1)?.[0]?.patch?.carLabel
            expect(written).toBe(`Brand ${YOKO} N-${YOKO}`)

            carLabel = written
            hooks.onProfileGet = undefined
            const next = await act('check_link')

            await expect(next.json()).resolves.toMatchObject({ carInfo: `Brand ${NASH} N-${NASH}` })
        })
    })

    describe('a park switch never moves a running action', () => {
        test('a switch between the profile GET and the PUT keeps the PUT on the park the action started in', async () => {
            selectedPark = NASH
            hooks.onProfileGet = () => { selectedPark = YOKO }

            const response = await act('change_limit', { limitValue: 5 })

            await expect(response.json()).resolves.toEqual({ success: true, newLimit: 5 })
            expect(puts()).toEqual([expect.objectContaining({ park: NASH, url: expect.stringContaining(PROFILE[NASH]) })])
            expect(touches(PROFILE[YOKO])).toBe(false)
            // The selected park is read once, when the action starts.
            expect(mocks.findDriverTelegramFirst).toHaveBeenCalledTimes(1)
        })

        test('a switch during dispatch leaves the task on the profile and park it was proven for', async () => {
            selectedPark = YOKO2
            mocks.findDriverTelegram.mockImplementation(async () => {
                selectedPark = YOKO
                return { driverId: 'driver-1' }
            })

            const response = await act('get_order_price')

            await expect(response.json()).resolves.toMatchObject({ ok: true, status: 'PENDING' })
            expect(scraperBodies()).toEqual([expect.objectContaining({ driverYandexId: PROFILE[YOKO2], parkId: YOKO2 })])
        })

        test('an old task\'s result after a switch is mirrored onto the row that dispatched it', async () => {
            selectedPark = NASH
            const dispatched = await act('get_order_price')
            const { taskId } = await dispatched.json()
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ driverId: `driver-${NASH}`, scraperTaskId: taskId, status: 'PENDING' }),
            }))

            selectedPark = YOKO
            const polled = await act('poll_driver_action', { taskId })

            await expect(polled.json()).resolves.toMatchObject({ ok: true, taskId, status: 'DONE' })
            // The result is keyed by the task, so it lands on the Наш Автопарк row, not Yoko's.
            expect(mocks.mirrorDriverActionResult).toHaveBeenCalledWith(expect.objectContaining({ scraperTaskId: taskId, status: 'DONE' }))
        })

        test('a car found before a switch is never bound to the newly selected park\'s profile', async () => {
            selectedPark = NASH

            const response = await act('update_driver_car', { carId: `car-${YOKO}` })

            expect(response.status).toBe(409)
            await expect(response.json()).resolves.toEqual({ error: 'Этот автомобиль не найден в выбранном парке. Найдите автомобиль заново.' })
            expect(puts()).toHaveLength(0)
        })

        test.each([
            ['Contacts confirms the cluster to someone else', () => {
                mocks.confirmedDriverCluster.mockResolvedValue({ contactId: 'contact-2', confirmationId: 'c', evidenceRoot: 'r' })
            }],
            ['the confirmation is revoked', () => { mocks.confirmedDriverCluster.mockResolvedValue(null) }],
            ['the row is dismissed', () => { drivers.find((candidate) => candidate.id === `driver-${NASH}`)!.dismissedAt = new Date() }],
            ['the row moves to another Contact', () => { drivers.find((candidate) => candidate.id === `driver-${NASH}`)!.contactId = 'contact-2' }],
            ['the row is replaced by another row of the same profile', () => { drivers.find((candidate) => candidate.id === `driver-${NASH}`)!.id = 'driver-park-nash-new' }],
            ['the row now names another Yandex profile', () => { drivers.find((candidate) => candidate.id === `driver-${NASH}`)!.externalDriverProfileId = 'e'.repeat(32) }],
            ['the link row\'s licence cluster changes', () => { anchor.externalPersonKey = 'vu:9999999999' }],
            ['the link row moves to another Contact', () => { anchor.contactId = 'contact-2' }],
        ])('no PUT when, between the GET and the PUT, %s', async (_name, change) => {
            for (const action of [['change_limit', { limitValue: 5 }], ['update_driver_car', { carId: `car-${NASH}` }]] as const) {
                drivers = [anchor = row(YOKO, { id: 'driver-1' }), row(NASH), row(YOKO2)]
                mocks.confirmedDriverCluster.mockImplementation(async (key: string) => (
                    key === KEY ? { contactId: CONTACT, confirmationId: 'confirmation-1', evidenceRoot: 'root-1' } : null
                ))
                mocks.findDriverTelegram.mockImplementation(async () => ({ driverId: 'driver-1' }))
                calls = []
                selectedPark = NASH
                hooks.onProfileGet = change

                const response = await act(action[0], action[1])

                expect(response.status).toBe(409)
                await expect(response.json()).resolves.toEqual({ error: 'Ваш профиль в выбранном парке не подтверждён. Выберите парк заново или обратитесь к менеджеру.' })
                expect(puts()).toHaveLength(0)
                // The action did start in Наш Автопарк: its profile was read there.
                expect(calls.some((call) => call.method === 'GET' && call.url.includes(PROFILE[NASH]))).toBe(true)
            }
        })

        test.each([
            ['relinked to another Driver', { driverId: 'driver-other' }],
            ['removed', null],
        ])('no PUT when, between the GET and the PUT, the Telegram link is %s', async (_name, link) => {
            for (const action of [['change_limit', { limitValue: 5 }], ['update_driver_car', { carId: `car-${NASH}` }]] as const) {
                drivers = [anchor = row(YOKO, { id: 'driver-1' }), row(NASH), row(YOKO2)]
                mocks.confirmedDriverCluster.mockImplementation(async (key: string) => (
                    key === KEY ? { contactId: CONTACT, confirmationId: 'confirmation-1', evidenceRoot: 'root-1' } : null
                ))
                mocks.findDriverTelegram.mockImplementation(async () => ({ driverId: 'driver-1' }))
                calls = []
                selectedPark = NASH
                hooks.onProfileGet = () => { mocks.findDriverTelegram.mockResolvedValue(link) }

                const response = await act(action[0], action[1])

                expect(response.status).toBe(409)
                await expect(response.json()).resolves.toEqual({ error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED' })
                expect(puts()).toHaveLength(0)
                expect(calls.some((call) => call.method === 'GET' && call.url.includes(PROFILE[NASH]))).toBe(true)
            }
        })

        test('no PUT when the link changes after the last authority check, while the cross-park proof is re-read', async () => {
            for (const action of [['change_limit', { limitValue: 5 }], ['update_driver_car', { carId: `car-${NASH}` }]] as const) {
                drivers = [anchor = row(YOKO, { id: 'driver-1' }), row(NASH), row(YOKO2)]
                mocks.confirmedDriverCluster.mockImplementation(async (key: string) => (
                    key === KEY ? { contactId: CONTACT, confirmationId: 'confirmation-1', evidenceRoot: 'root-1' } : null
                ))
                mocks.findDriverTelegram.mockImplementation(async () => ({ driverId: 'driver-1' }))
                calls = []
                selectedPark = NASH
                // After the profile GET the action's own authority check still sees
                // the link; the read the cross-park proof makes next does not.
                hooks.onProfileGet = () => {
                    let reads = 0
                    mocks.findDriverTelegram.mockImplementation(async () => (++reads >= 2 ? { driverId: 'driver-other' } : { driverId: 'driver-1' }))
                }

                const response = await act(action[0], action[1])

                expect(response.status).toBe(409)
                await expect(response.json()).resolves.toEqual({ error: 'Ваш профиль в выбранном парке не подтверждён. Выберите парк заново или обратитесь к менеджеру.' })
                expect(puts()).toHaveLength(0)
            }
        })

        test.each([
            ['change_limit', { limitValue: 5 }],
            ['update_driver_car', { carId: 'car-park-nash' }],
        ])('%s: no PUT once the proof is older than 12 seconds, shorter than the bot\'s 15 s wait', async (action, extra) => {
            selectedPark = NASH
            let now = 1_700_000_000_000
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
            hooks.onProfileGet = () => { now += 12_001 }
            try {
                const response = await act(action, extra)

                expect(response.status).toBe(409)
                expect(puts()).toHaveLength(0)
            } finally {
                clock.mockRestore()
            }
        })

        test('a proof still inside its window, with time left for the change, lets the PUT through', async () => {
            selectedPark = NASH
            let now = 1_700_000_000_000
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
            hooks.onProfileGet = () => { now += 5_000 }
            try {
                const response = await act('change_limit', { limitValue: 5 })

                expect(response.status).toBe(200)
                expect(puts()).toHaveLength(1)
            } finally {
                clock.mockRestore()
            }
        })

        test('a failed re-read of the link row refuses the change and the dispatch, never as a provider failure', async () => {
            selectedPark = NASH
            let reads = 0
            mocks.findDriver.mockImplementation(async ({ where }: any) => {
                reads += 1
                if (reads > 1) throw new Error('connection reset')
                const found = drivers.find((candidate) => candidate.id === where.id)
                return found ? { ...found } : null
            })

            const cash = await act('change_limit', { limitValue: 5 })
            expect(cash.status).toBe(409)
            await expect(cash.json()).resolves.toEqual({ error: 'Ваш профиль в выбранном парке не подтверждён. Выберите парк заново или обратитесь к менеджеру.' })
            expect(puts()).toHaveLength(0)

            reads = 0
            const order = await act('get_order_price')
            await expect(order.json()).resolves.toMatchObject({ ok: false, error: 'YANDEX_PROFILE_PARK_UNPROVEN', status: 'ESCALATED_TO_MANAGER' })
            expect(scraperBodies()).toHaveLength(0)
            expect(mocks.recordDriverAction).not.toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ status: 'FAILED' }),
            }))
        })

        test('no task is dispatched when the proof stops holding before dispatch', async () => {
            selectedPark = NASH
            let proofs = 0
            mocks.confirmedDriverCluster.mockImplementation(async () => (
                ++proofs === 1 ? { contactId: CONTACT, confirmationId: 'c', evidenceRoot: 'r' } : null
            ))

            const response = await act('get_order_price')

            await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'YANDEX_PROFILE_PARK_UNPROVEN', status: 'ESCALATED_TO_MANAGER' })
            expect(scraperBodies()).toHaveLength(0)
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ status: 'ESCALATED_TO_MANAGER', errorMessage: 'proof of the selected park no longer held at dispatch' }),
            }))
        })

        test('concurrent actions in different parks each act only in their own park', async () => {
            const parks = [NASH, YOKO, YOKO2, NASH, YOKO2, YOKO, NASH, YOKO2]
            let next = 0
            mocks.findDriverTelegramFirst.mockImplementation(async () => ({
                id: 'mapping-1', driverId: 'driver-1', telegramId: 123456n, activeParkId: parks[next++], carLabel: null,
            }))

            const responses = await Promise.all(parks.map(() => act('change_limit', { limitValue: 5 })))

            for (const response of responses) expect(response.status).toBe(200)
            const putParks = puts().map((call) => {
                const profile = new URL(call.url).searchParams.get('contractor_profile_id')
                // The profile written always belongs to the park whose key wrote it.
                expect(profile).toBe(PROFILE[call.park as string])
                return call.park
            })
            expect(putParks.sort()).toEqual([...parks].sort())
        })
    })

    describe('refusals: anything short of one proven row of the same person keeps the park guard', () => {
        const refusal = 'Ваш профиль в выбранном парке не подтверждён. Выберите парк заново или обратитесь к менеджеру.'

        async function expectRefused() {
            const cash = await act('change_limit', { limitValue: 5 })
            expect(cash.status).toBe(409)
            await expect(cash.json()).resolves.toEqual({ error: refusal })
            const car = await act('update_driver_car', { carId: `car-${NASH}` })
            expect(car.status).toBe(409)
            const order = await act('get_order_price')
            await expect(order.json()).resolves.toMatchObject({ ok: false, error: 'YANDEX_PROFILE_PARK_UNPROVEN' })
            const link = await act('check_link')
            await expect(link.json()).resolves.toMatchObject({ linked: true, carInfo: null })
            // Nothing reached a credential, Yandex or the scraper.
            expect(calls).toHaveLength(0)
            expect(mocks.getYandexConnectionCredentials).not.toHaveBeenCalled()
            // The refusal is audited on the link row, as before.
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ driverId: 'driver-1', errorMessage: 'selected park is not the park of the Yandex profile' }),
            }))
        }

        beforeEach(() => { selectedPark = NASH })

        test('another person with the same phone in that park', async () => {
            drivers = [anchor, row(NASH, { externalPersonKey: 'vu:9999999999' })]
            await expectRefused()
        })

        test('the same licence cluster but another Contact', async () => {
            drivers = [anchor, row(NASH, { contactId: 'contact-2' })]
            await expectRefused()
        })

        test('the cluster confirmed to another Contact', async () => {
            mocks.confirmedDriverCluster.mockResolvedValue({ contactId: 'contact-2', confirmationId: 'c', evidenceRoot: 'r' })
            await expectRefused()
        })

        test('no confirmed Contact for the cluster (none, or more than one)', async () => {
            mocks.confirmedDriverCluster.mockResolvedValue(null)
            await expectRefused()
        })

        test('no row of the person in that park', async () => {
            drivers = [anchor, row(YOKO2)]
            await expectRefused()
        })

        test('two rows of the person in that park', async () => {
            drivers = [anchor, row(NASH), row(NASH, { id: 'driver-park-nash-2', externalDriverProfileId: 'd'.repeat(32) })]
            await expectRefused()
        })

        test('a dismissed row', async () => {
            drivers = [anchor, row(NASH, { dismissedAt: new Date('2026-10-01T00:00:00Z') })]
            await expectRefused()
        })

        test.each([
            ['no profile id', null],
            ['only a reconciler key', `park-profile:${'9'.repeat(32)}`],
            ['a malformed id', 'not-a-yandex-id'],
        ])('a row with %s', async (_name, profile) => {
            drivers = [anchor, row(NASH, { externalDriverProfileId: profile })]
            await expectRefused()
        })

        test.each([['vu_clustered'], ['phone_linked'], ['conflict'], ['unlinked']])('a row the reconciler marked %s', async (status) => {
            drivers = [anchor, row(NASH, { personResolutionStatus: status })]
            await expectRefused()
        })

        test('a link row whose cluster is one park only (no licence key)', async () => {
            anchor.externalPersonKey = `profile:${YOKO}:${PROFILE[YOKO]}`
            await expectRefused()
            expect(mocks.findDrivers).not.toHaveBeenCalled()
            expect(mocks.confirmedDriverCluster).not.toHaveBeenCalled()
        })

        test('a link row whose own Contact projection is not the Contact confirming its cluster', async () => {
            anchor.contactId = 'contact-2'
            await expectRefused()
        })

        test('a Telegram account whose link was removed: the bot authority refuses before anything', async () => {
            mocks.findDriverTelegram.mockResolvedValue(null)

            const response = await act('change_limit', { limitValue: 5 })

            expect(response.status).toBe(409)
            await expect(response.json()).resolves.toEqual({ error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED' })
            expect(calls).toHaveLength(0)
            expect(mocks.findDrivers).not.toHaveBeenCalled()
        })

        test('a stale link whose proof names another Driver is refused before anything', async () => {
            mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-old' })

            const response = await act('get_order_price')

            expect(response.status).toBe(409)
            await expect(response.json()).resolves.toEqual({ error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED' })
            expect(calls).toHaveLength(0)
        })
    })

    test('the cross-park proof selects by person proof alone: no phone, name or first match', () => {
        const route = readFileSync(resolve(process.cwd(), 'src/app/api/webhooks/bot/route.ts'), 'utf8')
        const proof = route.slice(route.indexOf('async function botActingDriver('), route.indexOf('// Helper: find car by ID'))
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
        expect(proof).toContain('getConfirmedContactForDriverClusterV1(clusterKey)')
        expect(proof).toContain("personResolutionStatus: 'operator_confirmed'")
        expect(proof).toContain('rows.length !== 1')
        expect(proof).not.toMatch(/phone|fullName|\.find\(|\[0\]|findFirst/)
    })
})

describe('B4: every provider call is bounded and nothing changes after the bot gave up', () => {
    const PROFILE = '0123456789abcdef0123456789abcdef'
    const binding = { providerAccountId: '8447212640', connectionId: BOT_CONNECTION }
    const connection = { clid: 'clid-1', apiKey: 'api-key-1', parkId: 'park-1' }
    let mapping: Record<string, unknown>
    let telegramId: string
    let accounts = 0

    const reply = (body: unknown, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    })
    /** A provider call that never answers until its abort signal fires. */
    const hanging = () => (_url: unknown, init: any = {}) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    /** A provider call that answers after `ms` (unless aborted first). */
    const slow = (ms: number, body: unknown, status = 200) => (_url: unknown, init: any = {}) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply(body, status)), ms)
        init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
    })
    const calls = () => mocks.providerFetch.mock.calls.map(([url, init]: any[]) => `${init?.method ?? 'GET'} ${String(url)}`)
    const puts = () => calls().filter((call) => call.startsWith('PUT'))
    const act = (action: string, extra: Record<string, unknown> = {}) =>
        POST(actionRequest(action, { telegramId, ...binding, ...extra }))
    /** Runs a request on fake timers to completion and returns it with the time it took. */
    async function timed(request: Promise<Response>) {
        const started = Date.now()
        let settled: Response | undefined
        request.then((response) => { settled = response })
        for (let step = 0; step < 200 && !settled; step += 1) await vi.advanceTimersByTimeAsync(100)
        expect(settled).toBeDefined()
        return { response: settled as Response, elapsed: Date.now() - started }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        // Queued one-off provider answers must not leak from one case into the next.
        mocks.providerFetch.mockReset()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        accounts += 1
        telegramId = String(700_000 + accounts)
        mapping = { id: 'mapping-1', driverId: 'driver-1', telegramId: BigInt(telegramId), activeParkId: 'park-1', carLabel: null }
        mocks.findDriverTelegramFirst.mockImplementation(async () => mapping)
        mocks.findDriverTelegram.mockImplementation(async () => ({ driverId: String(mapping.driverId) }))
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
        mocks.findDriver.mockResolvedValue({
            id: 'driver-1', fullName: 'Test Driver', phone: '+70000000000', yandexDriverId: `park-profile:${'9'.repeat(32)}`,
            externalDriverProfileId: PROFILE, externalParkId: 'park-1', externalPersonKey: null, contactId: 'contact-1',
        })
        mocks.findDriverByYandex.mockResolvedValue(null)
        mocks.getYandexConnectionCredentials.mockResolvedValue(connection)
        mocks.recordDriverAction.mockResolvedValue({ action: { id: 'action-1' } })
        mocks.patchDriverTelegramLink.mockResolvedValue({ updated: true })
        vi.stubGlobal('fetch', mocks.providerFetch)
    })
    afterEach(() => vi.useRealTimers())

    describe('cash switch (change_limit)', () => {
        test('the link row\'s own park keeps its three calls: probe, GET, PUT', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({}, 204))

            const { response } = await timed(act('change_limit', { limitValue: 5 }))

            await expect(response.json()).resolves.toEqual({ success: true, newLimit: 5 })
            expect(calls().map((call) => call.split(' ')[0])).toEqual(['GET', 'GET', 'PUT'])
        })

        test('a profile read that never answers ends after 4 s with "unavailable" and no PUT', async () => {
            mocks.providerFetch.mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('change_limit', { limitValue: 5 }))

            expect(response.status).toBe(503)
            await expect(response.json()).resolves.toEqual({ error: 'Яндекс сейчас не отвечает. Попробуйте позже.' })
            expect(puts()).toHaveLength(0)
            expect(elapsed).toBeLessThanOrEqual(4_100)
        })

        test.each([[429], [500], [503]])('a profile read answered %s is "unavailable" with no PUT', async (status) => {
            mocks.providerFetch
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({ message: 'busy' }, status))

            const { response } = await timed(act('change_limit', { limitValue: 5 }))

            expect(response.status).toBe(503)
            expect(puts()).toHaveLength(0)
        })

        test('a PUT that never answers is reported as an unknown outcome, never as success', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('change_limit', { limitValue: 5 }))

            expect(response.status).toBe(502)
            await expect(response.json()).resolves.toEqual({
                error: 'Яндекс не подтвердил изменение. Проверьте результат позже и не повторяйте сразу.',
                outcome: 'UNKNOWN',
            })
            expect(elapsed).toBeLessThan(12_000)
        })

        test('a rate-limited PUT is "not applied", a failing PUT is "unknown"; neither is success', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({}, 429))
            const limited = (await timed(act('change_limit', { limitValue: 5 }))).response
            expect(limited.status).toBe(503)
            await expect(limited.json()).resolves.toEqual({ error: 'Яндекс временно ограничил запросы. Изменение не применено, попробуйте позже.' })

            mocks.providerFetch
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({ account: {} }))
                .mockResolvedValueOnce(reply({}, 502))
            const failing = (await timed(act('change_limit', { limitValue: 5 }))).response
            expect(failing.status).toBe(502)
            await expect(failing.json()).resolves.toMatchObject({ outcome: 'UNKNOWN' })
        })

        test('when slow answers leave too little time, the PUT is not started', async () => {
            mocks.providerFetch
                .mockImplementationOnce(slow(3_900, { account: {} }))
                .mockImplementationOnce(slow(3_900, { account: {} }))

            const { response, elapsed } = await timed(act('change_limit', { limitValue: 5 }))

            expect(response.status).toBe(503)
            expect(puts()).toHaveLength(0)
            expect(elapsed).toBeLessThan(12_000)
        })
    })

    describe('car change (update_driver_car) and its search', () => {
        const parkCars = (ids: string[], total = ids.length) => reply({ cars: ids.map((id) => ({ id, number: `A${id}`, brand: 'B', model: 'M' })), total })

        test('binding a car the same link just found in the same park needs no second listing', async () => {
            mocks.providerFetch.mockResolvedValueOnce(parkCars(['car-9']))
            const search = (await timed(act('search_car_by_plate', { platePrefix: 'ACAR' }))).response
            await expect(search.json()).resolves.toMatchObject({ found: true })

            mocks.providerFetch
                .mockResolvedValueOnce(reply({ car_id: 'car-1' }))
                .mockResolvedValueOnce(reply({}, 204))
            const bound = (await timed(act('update_driver_car', { carId: 'car-9' }))).response

            await expect(bound.json()).resolves.toEqual({ success: true, newCarId: 'car-9' })
            // One listing page for the search; the bind itself is GET + PUT, as before the car check.
            expect(calls().map((call) => call.split(' ')[0])).toEqual(['POST', 'GET', 'PUT'])
        })

        test.each([
            ['another park', () => { mapping = { ...mapping, activeParkId: 'park-2' } }],
            ['another link row', () => { mapping = { ...mapping, driverId: 'driver-2' } }],
            ['more than 10 minutes', () => { vi.advanceTimersByTime(10 * 60_000 + 1) }],
        ])('a search remembered for %s is not reused: the car is listed again', async (_name, change) => {
            mocks.providerFetch.mockResolvedValueOnce(parkCars(['car-9']))
            await timed(act('search_car_by_plate', { platePrefix: 'ACAR' }))
            change()
            // The bind's own row and park: a row of park-2 when park-2 is selected.
            mocks.findDriver.mockResolvedValue({
                id: String(mapping.driverId), fullName: 'Test Driver', phone: null, yandexDriverId: PROFILE,
                externalDriverProfileId: PROFILE, externalParkId: String(mapping.activeParkId), externalPersonKey: null, contactId: 'contact-1',
            })
            mocks.getYandexConnectionCredentials.mockResolvedValue({ ...connection, parkId: String(mapping.activeParkId) })
            mocks.providerFetch
                .mockResolvedValueOnce(parkCars(['car-9']))
                .mockResolvedValueOnce(reply({ car_id: 'car-1' }))
                .mockResolvedValueOnce(reply({}, 204))

            await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(calls().filter((call) => call.endsWith('/v1/parks/cars/list'))).toHaveLength(2)
        })

        test('a car listing that never answers ends with "try later", no GET and no PUT', async () => {
            mocks.providerFetch.mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(response.status).toBe(503)
            expect(calls()).toHaveLength(1)
            expect(elapsed).toBeLessThanOrEqual(4_100)
        })

        test('a PUT that never answers is an unknown outcome, never success', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(parkCars(['car-9']))
                .mockResolvedValueOnce(reply({ car_id: 'car-1' }))
                .mockImplementationOnce(hanging())

            const { response } = await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(response.status).toBe(502)
            await expect(response.json()).resolves.toMatchObject({ outcome: 'UNKNOWN' })
        })

        test('worst case: a slow multi-page listing still answers inside the budget, without a PUT', async () => {
            for (let page = 0; page < 10; page += 1) {
                mocks.providerFetch.mockImplementationOnce(slow(3_900, { cars: [{ id: `other-${page}` }], total: 5_000 }))
            }

            const { response, elapsed } = await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(response.status).toBe(503)
            expect(puts()).toHaveLength(0)
            expect(elapsed).toBeLessThanOrEqual(12_100)
            expect(calls().length).toBeLessThanOrEqual(4)
        })

        test('a listing longer than the page budget proves nothing: "try later", never "not found"', async () => {
            for (let page = 0; page < 10; page += 1) {
                mocks.providerFetch.mockResolvedValueOnce(parkCars([`other-${page}`], 6_000))
            }

            const { response } = await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(response.status).toBe(503)
            await expect(response.json()).resolves.toEqual({ error: 'Не удалось проверить автомобиль в Яндексе. Попробуйте позже.' })
            expect(puts()).toHaveLength(0)
        })

        test('a search whose first page Yandex does not answer is "unavailable", not "no such car"', async () => {
            mocks.providerFetch.mockResolvedValueOnce(reply({ message: 'busy' }, 429))

            const { response } = await timed(act('search_car_by_plate', { platePrefix: 'ACAR' }))

            expect(response.status).toBe(503)
            await expect(response.json()).resolves.toEqual({ error: 'Яндекс сейчас не отвечает. Попробуйте позже.' })
        })

        test('when the listing and profile read leave too little time, the car PUT is not started', async () => {
            mocks.providerFetch
                .mockImplementationOnce(slow(3_900, { cars: [{ id: 'car-9' }], total: 1 }))
                .mockImplementationOnce(slow(3_900, { car_id: 'car-1' }))

            const { response } = await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(response.status).toBe(503)
            expect(puts()).toHaveLength(0)
        })

        test('a car PUT answered 5xx is an unknown outcome, never success', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(parkCars(['car-9']))
                .mockResolvedValueOnce(reply({ car_id: 'car-1' }))
                .mockResolvedValueOnce(reply({ message: 'oops' }, 500))

            const { response } = await timed(act('update_driver_car', { carId: 'car-9' }))

            expect(response.status).toBe(502)
            await expect(response.json()).resolves.toMatchObject({ outcome: 'UNKNOWN' })
        })

        test('a search that runs out of time answers with what it found so far', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(reply({ cars: [{ id: 'car-9', number: 'ACAR9' }], total: 5_000 }))
                .mockImplementationOnce(hanging())

            const { response } = await timed(act('search_car_by_plate', { platePrefix: 'ACAR' }))

            await expect(response.json()).resolves.toMatchObject({ found: true, cars: [{ id: 'car-9' }] })
        })
    })

    describe('car display (check_link)', () => {
        test('a profile read that never answers shows the link without a car, inside the budget', async () => {
            mocks.providerFetch.mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('check_link'))

            await expect(response.json()).resolves.toMatchObject({ linked: true, carInfo: null })
            expect(elapsed).toBeLessThanOrEqual(4_100)
        })

        test('the phone fallback of the link row\'s park is bounded too', async () => {
            mocks.providerFetch
                .mockResolvedValueOnce(reply({ message: 'not found' }, 404))
                .mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('check_link'))

            await expect(response.json()).resolves.toMatchObject({ linked: true, carInfo: null })
            expect(elapsed).toBeLessThanOrEqual(4_100)
        })

        test('worst case: a slow car listing stops at the budget and shows no car', async () => {
            mocks.providerFetch.mockResolvedValueOnce(reply({ car_id: 'car-9' }))
            for (let page = 0; page < 10; page += 1) {
                mocks.providerFetch.mockImplementationOnce(slow(3_900, { cars: [{ id: `other-${page}` }], total: 5_000 }))
            }

            const { response, elapsed } = await timed(act('check_link'))

            await expect(response.json()).resolves.toMatchObject({ linked: true, carInfo: null })
            expect(elapsed).toBeLessThanOrEqual(12_100)
            expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
        })
    })

    describe('current order (dispatch and poll)', () => {
        test('a dispatch that never answers is recorded as failed with an unknown outcome', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue(null)
            mocks.providerFetch.mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('get_order_price'))

            await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'SCRAPER_DOWN' })
            expect(elapsed).toBeLessThanOrEqual(4_100)
            expect(mocks.recordDriverAction).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ status: 'FAILED', errorMessage: 'scraper unreachable: dispatch timed out, outcome unknown' }),
            }))
        })

        test('a dispatch with too little time left (slow authority checks) is not sent', async () => {
            mocks.findDriverTelegram.mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 4_000))
                return { driverId: 'driver-1' }
            })
            mocks.providerFetch.mockResolvedValueOnce(reply({ driver_profiles: [] }))

            const { response } = await timed(act('get_order_price'))

            await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'PROVIDER_SLOW' })
            expect(calls().some((call) => call.endsWith('/api/driver-actions'))).toBe(false)
        })

        test('a poll the scraper never answers ends after 4 s without a mirror', async () => {
            mocks.providerFetch.mockImplementationOnce(() => new Promise(() => {}))

            const { response, elapsed } = await timed(act('poll_driver_action', { taskId: 'task-1' }))

            await expect(response.json()).resolves.toMatchObject({ ok: false })
            expect(elapsed).toBeLessThanOrEqual(4_100)
            expect(mocks.mirrorDriverActionResult).not.toHaveBeenCalled()
        })
    })

    describe('park switch (set_active_park)', () => {
        const OTHER = 'park-2'
        const listed = (...phones: string[]) => reply({ driver_profiles: phones.map((phone) => ({ driver_profile: { id: 'p', phones: [phone] } })) })
        const switched = () => mocks.patchDriverTelegramLink.mock.calls.length

        beforeEach(() => {
            mocks.findDriver.mockResolvedValue({ phone: '+70000000000', externalParkId: 'park-1', dismissedAt: null })
            mocks.getYandexConnectionCredentials.mockResolvedValue({ ...connection, parkId: OTHER, name: 'Other park' })
        })

        test('a phone check that never answers ends after 4 s and does not switch the park', async () => {
            mocks.providerFetch.mockImplementationOnce(hanging())

            const { response, elapsed } = await timed(act('set_active_park', { parkId: OTHER }))

            expect(response.status).toBe(503)
            await expect(response.json()).resolves.toEqual({ error: 'PARK_MEMBERSHIP_UNKNOWN' })
            expect(switched()).toBe(0)
            expect(elapsed).toBeLessThanOrEqual(4_100)
        })

        test.each([429, 500, 502, 401, 403])('a phone check answered %i does not switch the park', async (status) => {
            mocks.providerFetch.mockResolvedValueOnce(reply({ message: 'no' }, status))

            const { response } = await timed(act('set_active_park', { parkId: OTHER }))

            expect(response.status).toBe(503)
            expect(switched()).toBe(0)
        })

        test('a refused connection, a malformed body or a body that cannot be read does not switch the park', async () => {
            mocks.providerFetch.mockRejectedValueOnce(new Error('ECONNRESET'))
            expect((await timed(act('set_active_park', { parkId: OTHER }))).response.status).toBe(503)

            mocks.providerFetch.mockResolvedValueOnce(reply({ profiles: [] }))
            expect((await timed(act('set_active_park', { parkId: OTHER }))).response.status).toBe(503)

            mocks.providerFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
            expect((await timed(act('set_active_park', { parkId: OTHER }))).response.status).toBe(503)

            mocks.providerFetch.mockResolvedValueOnce(reply({ driver_profiles: [{ driver_profile: null }] }))
            expect((await timed(act('set_active_park', { parkId: OTHER }))).response.status).toBe(403)
            expect(switched()).toBe(0)
        })

        test('a driver with no phone cannot enter another park unproven', async () => {
            mocks.findDriver.mockResolvedValue({ phone: null, externalParkId: 'park-1', dismissedAt: null })

            const { response } = await timed(act('set_active_park', { parkId: OTHER }))

            expect(response.status).toBe(503)
            expect(calls()).toHaveLength(0)
            expect(switched()).toBe(0)
        })

        test('a definite "not in this park" still answers NOT_IN_PARK', async () => {
            mocks.providerFetch.mockResolvedValueOnce(listed('+79999999999'))

            const { response } = await timed(act('set_active_park', { parkId: OTHER }))

            expect(response.status).toBe(403)
            await expect(response.json()).resolves.toEqual({ error: 'NOT_IN_PARK', parkName: 'Other park' })
            expect(switched()).toBe(0)
        })

        test.each(['   ', '0000', '+1 (555) 01'])('a stored phone that is no phone number (%j) proves nothing, whatever Yandex lists', async (phone) => {
            mocks.findDriver.mockResolvedValue({ phone, externalParkId: 'park-1', dismissedAt: null })
            mocks.providerFetch.mockResolvedValue(listed('+70000000000', '+79990000000'))

            const { response } = await timed(act('set_active_park', { parkId: OTHER }))

            expect(response.status).toBe(503)
            expect(calls()).toHaveLength(0)
            expect(switched()).toBe(0)
        })

        test('the same number in another format is a match; a number that only contains it is not', async () => {
            mocks.providerFetch.mockResolvedValueOnce(listed('8 (000) 000-00-00'))
            await expect((await timed(act('set_active_park', { parkId: OTHER }))).response.json()).resolves.toMatchObject({ success: true })

            mocks.providerFetch.mockResolvedValueOnce(listed('+7 (000) 000-00-001'))
            expect((await timed(act('set_active_park', { parkId: OTHER }))).response.status).toBe(403)
            expect(switched()).toBe(1)
        })

        test('a definite match switches the park', async () => {
            mocks.providerFetch.mockResolvedValueOnce(listed('+7 (000) 000-00-00'))

            const { response } = await timed(act('set_active_park', { parkId: OTHER }))

            await expect(response.json()).resolves.toEqual({ success: true, parkName: 'Other park' })
            expect(mocks.patchDriverTelegramLink).toHaveBeenCalledWith(expect.objectContaining({
                mappingId: 'mapping-1', patch: { activeParkId: OTHER, carLabel: null, carId: null },
            }))
        })

        test('the link row\'s own park switches without a provider call, even while Yandex is down', async () => {
            mocks.getYandexConnectionCredentials.mockResolvedValue({ ...connection, name: 'Own park' })

            const { response } = await timed(act('set_active_park', { parkId: 'park-1' }))

            await expect(response.json()).resolves.toEqual({ success: true, parkName: 'Own park' })
            expect(calls()).toHaveLength(0)
            expect(switched()).toBe(1)
        })

        test('a dismissed link row is not a member of its own park without a match', async () => {
            mocks.findDriver.mockResolvedValue({ phone: '+70000000000', externalParkId: 'park-1', dismissedAt: new Date() })
            mocks.providerFetch.mockImplementationOnce(hanging())

            const { response } = await timed(act('set_active_park', { parkId: 'park-1' }))

            expect(response.status).toBe(503)
            expect(switched()).toBe(0)
        })

        describe('a link row with no recorded park', () => {
            const OWN = 'fedcba9876543210fedcba9876543210'
            const listedAs = (id: string, phone: string) => reply({ driver_profiles: [{ driver_profile: { id, phones: [phone] } }] })

            beforeEach(() => {
                mocks.findDriver.mockResolvedValue({ phone: '+70000000000', externalParkId: null, dismissedAt: null, yandexDriverId: OWN, externalDriverProfileId: null })
            })

            test('enters a park only where Yandex lists its own profile with its phone', async () => {
                mocks.providerFetch.mockResolvedValueOnce(listedAs(OWN, '+7 (000) 000-00-00'))

                const { response } = await timed(act('set_active_park', { parkId: OTHER }))

                await expect(response.json()).resolves.toEqual({ success: true, parkName: 'Other park' })
                expect(switched()).toBe(1)
            })

            test('its phone under another profile does not make the park its own', async () => {
                mocks.providerFetch.mockResolvedValueOnce(listedAs(PROFILE, '+70000000000'))

                const { response } = await timed(act('set_active_park', { parkId: OTHER }))

                expect(response.status).toBe(403)
                await expect(response.json()).resolves.toEqual({ error: 'NOT_IN_PARK', parkName: 'Other park' })
                expect(switched()).toBe(0)
            })

            test('its own profile listed with another phone does not make the park its own', async () => {
                mocks.providerFetch.mockResolvedValueOnce(listedAs(OWN, '+79999999999'))

                const { response } = await timed(act('set_active_park', { parkId: OTHER }))

                expect(response.status).toBe(403)
                expect(switched()).toBe(0)
            })

            test.each([
                ['no Yandex profile id of its own', { yandexDriverId: `park-profile:${'9'.repeat(32)}`, externalParkId: '  ' }],
                ['no Driver row at all', null],
            ])('with %s it cannot select any park', async (_case, override) => {
                mocks.findDriver.mockResolvedValue(override && { phone: '+70000000000', dismissedAt: null, externalDriverProfileId: null, ...override })
                mocks.providerFetch.mockResolvedValue(listedAs(OWN, '+70000000000'))

                const { response } = await timed(act('set_active_park', { parkId: OTHER }))

                expect(response.status).toBe(503)
                await expect(response.json()).resolves.toEqual({ error: 'PARK_MEMBERSHIP_UNKNOWN' })
                expect(calls()).toHaveLength(0)
                expect(switched()).toBe(0)
            })

            test('a check that never answers does not switch it', async () => {
                mocks.providerFetch.mockImplementationOnce(hanging())

                const { response } = await timed(act('set_active_park', { parkId: OTHER }))

                expect(response.status).toBe(503)
                expect(switched()).toBe(0)
            })
        })
    })
})

describe('Owner scenarios: the simple Telegram → Driver link is the authority', () => {
    const binding = { providerAccountId: '8447212640', connectionId: BOT_CONNECTION }
    const link = { id: 'mapping-1', driverId: 'driver-1', telegramId: 123456n, activeParkId: 'park-1', carLabel: 'Kia Rio A001AA' }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BOT_CRM_SECRET = 'test-bot-secret'
        mocks.findDriverTelegramFirst.mockResolvedValue(link)
        mocks.findDriverTelegram.mockResolvedValue({ driverId: 'driver-1' })
        // No Contact confirms this driver: the state of 43 of 47 production links.
        mocks.authorizeDriverTelegram.mockRejectedValue(new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'))
        mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
        mocks.findDriverByYandex.mockResolvedValue({ fullName: 'Иванов Иван', externalParkId: 'park-1' })
        mocks.findDriver.mockResolvedValue({ phone: '+79990001122', externalParkId: 'park-1', dismissedAt: null, yandexDriverId: 'a'.repeat(32), externalDriverProfileId: 'a'.repeat(32) })
        mocks.getYandexConnectionCredentials.mockResolvedValue({ clid: 'clid-1', apiKey: 'api-key-1', parkId: 'park-1', name: 'Yoko' })
        mocks.patchDriverTelegramLink.mockResolvedValue({ updated: true })
        vi.stubGlobal('fetch', mocks.providerFetch)
    })

    test('a linked driver with no confirmed Contact is recognised by get_park_info, check_link and the park switch alike', async () => {
        const park = await POST(actionRequest('get_park_info', { telegramId: '123456' }))
        await expect(park.json()).resolves.toEqual({ linked: true, activeParkId: 'park-1', parkName: 'Yoko' })

        const linked = await POST(actionRequest('check_link', { telegramId: '123456', ...binding }))
        expect(linked.status).toBe(200)
        await expect(linked.json()).resolves.toEqual({ linked: true, driverId: 'driver-1', driverName: 'Иванов Иван', carInfo: 'Kia Rio A001AA' })

        const switched = await POST(actionRequest('set_active_park', { telegramId: '123456', parkId: 'park-1', ...binding }))
        expect(switched.status).toBe(200)
        await expect(switched.json()).resolves.toEqual({ success: true, parkName: 'Yoko' })

        expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('Cash tells the same linked driver to ask a manager, never that the profile is not linked', async () => {
        const response = await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ available: false, reason: 'identity_needs_review', applications: [] })
        expect(mocks.compensationPilotSection).not.toHaveBeenCalled()
    })

    test('an unknown visitor stays a guest on every surface', async () => {
        mocks.findDriverTelegramFirst.mockResolvedValue(null)
        mocks.findDriverTelegram.mockResolvedValue(null)

        await expect((await POST(actionRequest('get_park_info', { telegramId: '123456' }))).json()).resolves.toEqual({ linked: false })
        await expect((await POST(actionRequest('check_link', { telegramId: '123456', ...binding }))).json()).resolves.toEqual({ linked: false })
        await expect((await POST(actionRequest('compensation_section', { telegramId: '123456', ...binding }))).json())
            .resolves.toEqual({ available: false, reason: 'identity_not_proven', applications: [] })
        const switched = await POST(actionRequest('set_active_park', { telegramId: '123456', parkId: 'park-1', ...binding }))
        expect(switched.status).toBe(404)
        expect(mocks.patchDriverTelegramLink).not.toHaveBeenCalled()
        expect(mocks.providerFetch).not.toHaveBeenCalled()
    })

    test('a driver linked automatically a moment ago is recognised at once', async () => {
        mocks.findDriverTelegram.mockResolvedValueOnce(null) // sync_user: no link yet
        mocks.findDriverTelegram.mockResolvedValueOnce(null) // the profile is held by no Telegram
        mocks.findDrivers.mockResolvedValue([{
            id: 'driver-1', fullName: 'Иванов Иван', phone: '+79990001122', externalParkId: 'park-1',
            yandexDriverId: 'a'.repeat(32), externalDriverProfileId: 'a'.repeat(32), personResolutionStatus: 'vu_clustered',
        }])
        mocks.upsertDriverTelegramLink.mockResolvedValue({ upserted: true })
        mocks.recordBotUserProfile.mockResolvedValue({ recorded: true })

        const synced = await POST(syncUserRequest({ telegramId: '123456', contactUserId: 123456, phone: '+79990001122' }))
        await expect(synced.json()).resolves.toMatchObject({ autoLinked: true, driverId: 'driver-1' })

        const linked = await POST(actionRequest('check_link', { telegramId: '123456', ...binding }))
        await expect(linked.json()).resolves.toMatchObject({ linked: true, driverId: 'driver-1' })
    })
})
