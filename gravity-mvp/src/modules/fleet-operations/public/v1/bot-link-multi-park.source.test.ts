import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const gravityRoot = resolve(__dirname, '../../../../../')
const source = (path: string) => readFileSync(resolve(gravityRoot, path), 'utf8')

describe('manual Telegram link multi-park wiring', () => {
    test('searches every configured Yandex park through the fleet owner capability', () => {
        const capability = source('src/modules/fleet-operations/public/v1/park-phone-search.ts')
        const route = source('src/app/api/bot-link/route.ts')
        expect(capability).toContain('listYandexConnectionCredentialsV1()')
        expect(capability).toContain('Promise.all(connections.map')
        expect(route).toContain('searchYandexParksByDriverQueryV1(query)')
        expect(route).toContain('checkedParks: yandex.checkedParks')
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
        const dismiss = ui.indexOf('const dismissResponse = await fetch', successGuard)
        expect(successGuard).toBeGreaterThan(-1)
        expect(dismiss).toBeGreaterThan(successGuard)
    })

    test('keeps the Telegram registry profile after a successful link', () => {
        const adapter = source('src/modules/telegram-channel/public/v1/legacy-prisma-bot-chat-message-adapter.ts')
        expect(adapter).toContain('tx.driverTelegram.findUnique({ where: { telegramId }')
        expect(adapter).toContain('if (!linked) await tx.botUserRegistry.deleteMany')
    })
})
