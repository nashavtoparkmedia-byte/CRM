import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
    normalizeParkPhoneDigitsV1,
    parkDriverMatchesQueryV1,
    parkDriverProfileFromYandexV1,
    selectDriverActionYandexIdentityV1,
    selectParkDriverProfilesByPhoneV1,
    type ParkDriverSearchResultV1,
} from './park-phone-search'

const gravityRoot = resolve(__dirname, '../../../../../')
const source = (path: string) => readFileSync(resolve(gravityRoot, path), 'utf8')

describe('Fleet park phone normalization', () => {
    test.each([
        ['+7 (999) 123-45-67', '79991234567'],
        ['8 999 123 45 67', '79991234567'],
        ['9991234567', '79991234567'],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeParkPhoneDigitsV1(input)).toBe(expected)
    })
})

describe('Fleet multi-park driver name search', () => {
    const profile = parkDriverProfileFromYandexV1({
        driver_profile: {
            id: 'driver-bashkov',
            last_name: 'Башков',
            first_name: 'Максим',
            middle_name: 'Михайлович',
            phones: ['+7 999 000-11-22'],
            work_status: 'working',
        },
        current_status: { status: 'free' },
    })!

    test('keeps the patronymic and provider statuses', () => {
        expect(profile).toEqual({
            id: 'driver-bashkov',
            fullName: 'Башков Максим Михайлович',
            phones: ['+7 999 000-11-22'],
            workStatus: 'working',
            currentStatus: 'free',
        })
    })

    test.each([
        'Башков Максим Михайлович',
        'Максим Башков',
        '9990001122',
    ])('matches %s without depending on name token order', query => {
        expect(parkDriverMatchesQueryV1(profile, query)).toBe(true)
    })

    test('rejects a different surname', () => {
        expect(parkDriverMatchesQueryV1(profile, 'Максим Иванов')).toBe(false)
    })
})

describe('manual Telegram link multi-park wiring', () => {
    test('searches every configured Yandex park through the fleet owner capability', () => {
        const capability = source('src/modules/fleet-operations/public/v1/park-phone-search.ts')
        const application = source('src/modules/fleet-operations/application/fleet-operations.ts')
        const route = source('src/app/api/bot-link/route.ts')
        const contactDrawer = source('src/app/messages/components/ContactProfileDrawer.tsx')
        expect(capability).toContain('listYandexConnectionCredentialsV1()')
        expect(capability).toContain('searchDriverQueryInPark(connection, normalizedQuery, options)')
        expect(capability).toContain('Promise.all(connections.map')
        expect(application).toContain('normalizeDriverSearchQueryV1(query)')
        expect(application).toContain('return searchYandexParksByDriverQuery(normalized.query)')
        expect(route).toContain('searchYandexParksByDriverQueryV1(query)')
        expect(route).toContain('checkedParks: yandex.checkedParks')
        expect(route).toContain('searchLocalDriversV1(body.query)')
        expect(contactDrawer).toContain('yandexDriverId: driver.yandexDriverId')
        expect(contactDrawer).toContain('driverName: driver.fullName')
        expect(contactDrawer).toContain('parkId: driver.parkId')
        expect(contactDrawer).toContain("key={`${driver.parkId || 'crm'}:${driver.yandexDriverId || driver.id}`}")
        expect(route).toContain('if (matchingYandexPhones && localPhone && matchingYandexPhones.has(localPhone)) continue')
    })

    test('revalidates and persists a selected Yandex profile before linking', () => {
        const route = source('src/app/api/bot-link/route.ts')
        expect(route).toContain('candidate.id === yandexDriverId')
        expect(route).toContain('upsertParkMatchedDriverV1({')
        expect(route).toContain('upsertDriverTelegramLinkV1({')
        expect(route).toContain('activeParkId: parkId')
    })

    test('does not remove a pending request when linking fails', () => {
        const ui = source('src/app/settings/integrations/bot/BotPageClient.tsx')
        const successGuard = ui.indexOf('if (!response.ok || !data.success)')
        const dismiss = ui.indexOf("await deleteBotUserMutation({ action: 'dismiss'", successGuard)
        expect(successGuard).toBeGreaterThan(-1)
        expect(dismiss).toBeGreaterThan(successGuard)
    })

    test('does not delete the durable Telegram profile when dismissing a legacy request', () => {
        const adapter = source('src/modules/telegram-channel/public/v1/legacy-prisma-bot-chat-message-adapter.ts')
        expect(adapter).not.toContain('botUserRegistry')
    })
})

describe('Telegram driver-action park resolution', () => {
    const profile = (id: string, phone: string, workStatus = 'working') => ({
        id,
        fullName: 'Трубицын Юрий Олегович',
        phones: [phone],
        workStatus,
        currentStatus: 'offline',
    })

    test('recovers the park of a legacy link by its exact stored Yandex profile id', () => {
        const result = selectDriverActionYandexIdentityV1({
            yandexDriverId: 'driver-yoko',
            phone: '+7 966 700-66-66',
            fullName: 'Трубицын Юрий Олегович',
            preferredParkId: null,
        }, {
            checkedParks: 2,
            errors: [],
            results: [
                { parkId: 'default-park', parkName: 'Наш Автопарк', profiles: [] },
                { parkId: 'yoko', parkName: 'Yoko', profiles: [profile('driver-yoko', '+79667006666')] },
            ],
        })

        expect(result).toEqual({
            parkId: 'yoko',
            yandexDriverId: 'driver-yoko',
            resolution: 'linked-profile',
        })
    })

    test('uses the selected-park profile when the same phone has another Yandex id', () => {
        const result = selectDriverActionYandexIdentityV1({
            yandexDriverId: 'driver-old-park',
            phone: '8 (966) 700-66-66',
            fullName: 'Трубицын Юрий Олегович',
            preferredParkId: 'selected-park',
        }, {
            checkedParks: 1,
            errors: [],
            results: [{
                parkId: 'selected-park',
                parkName: 'Yoko',
                profiles: [profile('driver-selected-park', '+79667006666')],
            }],
        })

        expect(result).toEqual({
            parkId: 'selected-park',
            yandexDriverId: 'driver-selected-park',
            resolution: 'preferred-phone',
        })
    })

    test('does not guess when the exact phone belongs to multiple working profiles', () => {
        const result = selectDriverActionYandexIdentityV1({
            yandexDriverId: 'missing-profile',
            phone: '+79667006666',
            fullName: 'Трубицын Юрий Олегович',
            preferredParkId: null,
        }, {
            checkedParks: 2,
            errors: [],
            results: [
                { parkId: 'park-1', parkName: 'Парк 1', profiles: [profile('driver-1', '+79667006666')] },
                { parkId: 'park-2', parkName: 'Парк 2', profiles: [profile('driver-2', '+79667006666')] },
            ],
        })

        expect(result).toBeNull()
    })

    test('ignores a fired linked profile and selects the unique working phone match', () => {
        const result = selectDriverActionYandexIdentityV1({
            yandexDriverId: 'driver-fired',
            phone: '+79667006666',
            fullName: 'Трубицын Юрий Олегович',
            preferredParkId: null,
        }, {
            checkedParks: 2,
            errors: [],
            results: [
                { parkId: 'old-park', parkName: 'Старый парк', profiles: [profile('driver-fired', '+79667006666', 'fired')] },
                { parkId: 'new-park', parkName: 'Новый парк', profiles: [profile('driver-working', '+79667006666')] },
            ],
        })

        expect(result).toEqual({
            parkId: 'new-park',
            yandexDriverId: 'driver-working',
            resolution: 'unique-phone',
        })
    })

    test('wires the resolved park into the scraper task and self-heals the Telegram link', () => {
        const route = source('src/app/api/webhooks/bot/route.ts')
        expect(route).toContain('resolveDriverActionYandexIdentityV1({')
        expect(route).toContain('patch: { activeParkId: effectiveParkId }')
        expect(route).toContain('parkId: effectiveParkId')
    })
})

describe('Telegram onboarding park resolution', () => {
    const search = (
        parks: ParkDriverSearchResultV1['results'],
        errors: ParkDriverSearchResultV1['errors'] = [],
        checkedParks = parks.length + errors.length,
    ): ParkDriverSearchResultV1 => ({ checkedParks, results: parks, errors })
    const profile = (id: string, phone: string, workStatus = 'working') => ({
        id,
        fullName: 'Трубицын Юрий Олегович',
        phones: [phone],
        workStatus,
        currentStatus: 'free',
    })

    test('resolves the only exact working phone profile', () => {
        const result = selectParkDriverProfilesByPhoneV1('+7 966 700-66-66', search([{
            parkId: 'yoko',
            parkName: 'Yoko',
            profiles: [profile('driver-yoko', '8 (966) 700-66-66')],
        }]))

        expect(result).toMatchObject({
            status: 'resolved',
            candidate: { parkId: 'yoko', yandexDriverId: 'driver-yoko' },
        })
    })

    test('requires the driver to choose when the exact phone exists in two parks', () => {
        const result = selectParkDriverProfilesByPhoneV1('+79667006666', search([
            { parkId: 'park-1', parkName: 'Наш Автопарк', profiles: [profile('driver-1', '+79667006666')] },
            { parkId: 'park-2', parkName: 'Yoko', profiles: [profile('driver-2', '+79667006666')] },
        ]))

        expect(result.status).toBe('select_park')
        if (result.status === 'select_park') {
            expect(result.candidates.map(candidate => candidate.parkId)).toEqual(['park-1', 'park-2'])
        }
    })

    test('does not guess between duplicate working profiles inside one park', () => {
        const result = selectParkDriverProfilesByPhoneV1('+79667006666', search([{
            parkId: 'park-1',
            parkName: 'Наш Автопарк',
            profiles: [
                profile('driver-1', '+79667006666'),
                profile('driver-2', '8 966 700 66 66'),
            ],
        }]))

        expect(result.status).toBe('ambiguous')
    })

    test('does not use a fired profile', () => {
        const result = selectParkDriverProfilesByPhoneV1('+79667006666', search([{
            parkId: 'old-park',
            parkName: 'Старый парк',
            profiles: [profile('driver-fired', '+79667006666', 'fired')],
        }]))

        expect(result).toEqual({ status: 'not_found' })
    })

    test('rejects a partial phone-number overlap', () => {
        const result = selectParkDriverProfilesByPhoneV1('9947134', search([{
            parkId: 'park-1',
            parkName: 'Наш Автопарк',
            profiles: [profile('driver-1', '+7 977 994-71-34')],
        }]))

        expect(result).toEqual({ status: 'not_found' })
    })

    test('fails closed when any park lookup is unavailable', () => {
        const result = selectParkDriverProfilesByPhoneV1('+79667006666', search(
            [{ parkId: 'park-1', parkName: 'Наш Автопарк', profiles: [profile('driver-1', '+79667006666')] }],
            [{ parkId: 'park-2', parkName: 'Yoko', message: 'timeout' }],
        ))

        expect(result).toEqual({ status: 'unavailable' })
    })

    test('reports unavailable when no park can be checked', () => {
        expect(selectParkDriverProfilesByPhoneV1('+79667006666', search([], [], 0)))
            .toEqual({ status: 'unavailable' })
    })
})

describe('Telegram onboarding and park-change wiring', () => {
    test('does not auto-assign the first park and never saves a park after a failed check', () => {
        const route = source('src/app/api/webhooks/bot/route.ts')
        const syncUser = route.slice(route.indexOf('async function handleSyncUser'), route.indexOf('async function notifyManagerPendingLink'))
        const setActivePark = route.slice(route.indexOf('async function handleSetActivePark'), route.indexOf('async function handleGetParkInfo'))

        expect(syncUser).toContain('resolveParkDriverProfilesByPhoneV1({')
        expect(syncUser).toContain("resolution.status === 'select_park'")
        expect(syncUser).toContain('parkSelectionRequired: true')
        expect(syncUser).toContain('upsertParkMatchedDriverV1({')
        expect(syncUser).not.toContain('listYandexConnectionCredentialsV1')

        expect(setActivePark).toContain("resolution.status === 'unavailable'")
        expect(setActivePark).toContain("resolution.status !== 'resolved'")
        expect(setActivePark).not.toContain("Don't block if Yandex check fails")
        expect(setActivePark.indexOf("resolution.status !== 'resolved'")).toBeLessThan(
            setActivePark.indexOf('patchDriverTelegramLinkV1({'),
        )

        const boundary = source('../tools/architecture/check-telegram-driver-link-boundary.mjs')
        expect(boundary).toContain('auto-link exact park resolution retained')
        expect(boundary).toContain("autoLink.includes('activeParkId: resolution.candidate.parkId')")
        expect(boundary).not.toContain("webhook.includes('driverId, telegramId: BigInt(telegramId), username: username || null, activeParkId: connection.parkId')")
    })

    test('routes a multi-park onboarding match through the park selection scene', () => {
        const carManagement = source('../tg-bot/src/handlers/carManagement.js')
        const parkSelect = source('../tg-bot/src/handlers/parkSelect.js')

        expect(carManagement).toContain('result.data.parkSelectionRequired')
        expect(carManagement).toContain("ctx.scene.enter('parkSelect', {")
        expect(parkSelect).toContain("action: 'sync_user'")
        expect(parkSelect).toContain('parkId: selected.parkId')
        expect(parkSelect).toContain("data?.error === 'PARK_CHECK_UNAVAILABLE'")
        expect(parkSelect).toContain('Парк не изменён')
    })
})
