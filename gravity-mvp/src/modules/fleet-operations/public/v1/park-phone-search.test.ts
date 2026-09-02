import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
    normalizeParkPhoneDigitsV1,
    parkDriverMatchesQueryV1,
    parkDriverProfileFromYandexV1,
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
        const reconciler = source('src/modules/fleet-operations/internal/legacy-prisma-yandex-fleet-reconciler-adapter.ts')
        expect(capability).toContain('listYandexConnectionCredentialsV1()')
        expect(capability).toContain('reconcileYandexFleetV1({')
        expect(capability).toContain("mode: 'manual'")
        expect(capability).toContain('query: normalizedQuery')
        expect(reconciler).toContain('const connections = await listYandexConnectionCredentialsV1()')
        expect(reconciler).toContain('for (const connection of connections)')
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
