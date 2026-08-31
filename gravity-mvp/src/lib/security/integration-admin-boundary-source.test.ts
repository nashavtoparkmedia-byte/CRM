import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

function exportedFunction(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}`)
    expect(start, `${name} must remain exported`).toBeGreaterThanOrEqual(0)
    const next = source.indexOf('\nexport async function ', start + 1)
    return source.slice(start, next === -1 ? source.length : next)
}

function expectGuardBefore(source: string, name: string, firstProtectedOperation: RegExp): void {
    const fn = exportedFunction(source, name)
    const guardAt = fn.indexOf('await requireIntegrationAdminAccess()')
    const operationAt = fn.search(firstProtectedOperation)
    expect(guardAt, `${name} must require real integration-admin auth`).toBeGreaterThanOrEqual(0)
    expect(operationAt, `${name} protected operation anchor missing`).toBeGreaterThanOrEqual(0)
    expect(guardAt, `${name} must authorize before side effects/secret use`).toBeLessThan(operationAt)
}

describe('integration credential authorization source boundary', () => {
    test('API connection credentials, logs, and provider tests authorize first', () => {
        const source = read('src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts')
        expectGuardBefore(source, 'getApiConnections', /prisma\.apiConnection/)
        expectGuardBefore(source, 'addApiConnection', /formData\.get/)
        expectGuardBefore(source, 'updateApiConnectionName', /updateApiConnectionNameV1/)
        expectGuardBefore(source, 'deleteApiConnection', /deleteApiLogsV1/)
        expectGuardBefore(source, 'getApiLogs', /prisma\.apiLog/)
        expectGuardBefore(source, 'testApiRequest', /getYandexConnectionCredentialsV1/)
    })

    test('Telegram login and connection-management ceremonies authorize first', () => {
        const source = read('src/app/tg-actions.ts')
        expectGuardBefore(source, 'getTelegramAuthQR', /new StringSession/)
        expectGuardBefore(source, 'getTelegramAuthQRFromSavedConnection', /prisma\.telegramConnection/)
        expectGuardBefore(source, 'submitTelegram2FAPassword', /activeLogins\.get/)
        expectGuardBefore(source, 'checkTelegramAuthStatus', /activeLogins\.get/)
        expectGuardBefore(source, 'getTelegramConnections', /prisma\.telegramConnection/)
        expectGuardBefore(source, 'getTelegramRuntimeStatus', /registry\.getAllEntries/)
        expectGuardBefore(source, 'updateTelegramConnectionSettings', /telegramConnection\.update/)
        expectGuardBefore(source, 'disconnectTelegram', /telegramConnection\.findUnique/)
        expectGuardBefore(source, 'pauseTelegramConnection', /telegramConnection\.update/)
        expectGuardBefore(source, 'resumeTelegramConnection', /telegramConnection\.update/)
        expectGuardBefore(source, 'deleteConnectionMessages', /prisma\.chat/)
    })

    test('Telegram login ceremonies are opaque, bounded, and tear down clients', () => {
        const source = read('src/app/tg-actions.ts')
        expect(source).toContain('const loginId = randomUUID()')
        expect(source).toMatch(/TELEGRAM_LOGIN_TTL_MS = 10 \* 60 \* 1000/)
        expect(source).toMatch(/TELEGRAM_TERMINAL_STATUS_TTL_MS = 30 \* 1000/)
        expect(source).toMatch(/activeLogins\.delete\(loginId\)/)
        expect(source).toMatch(/pendingPasswordResolver\(''\)/)
        expect(source).toMatch(/await current\.client\.disconnect\(\)/)
        expect(source).toMatch(/terminalLogins\.delete\(loginId\)/)
        expect(source).toMatch(/Promise\.resolve\(\)\.then\(\(\) => client\.signInUserWithQrCode/)
        expect(source).not.toMatch(/Password requested by Telegram \(hint:/)
    })

    test('MAX connection-management actions authorize before credential or data access', () => {
        const source = read('src/app/max-actions.ts')
        expectGuardBefore(source, 'getMaxConnections', /prisma\.maxConnection/)
        expectGuardBefore(source, 'addMaxConnection', /botToken\.trim/)
        expectGuardBefore(source, 'disconnectMax', /prisma\.maxConnection/)
        expectGuardBefore(source, 'pauseMaxConnection', /prisma\.maxConnection/)
        expectGuardBefore(source, 'resumeMaxConnection', /prisma as any/)
        expectGuardBefore(source, 'deleteMaxMessages', /prisma\.chat/)
        expectGuardBefore(source, 'updateMaxConnectionSettings', /prisma\.maxConnection/)
    })

    test('WhatsApp QR and connection-management actions authorize first', () => {
        const source = read('src/app/settings/integrations/whatsapp/whatsapp-actions.ts')
        const cases: Array<[string, RegExp]> = [
            ['createWhatsAppConnection', /prisma\.whatsAppConnection/],
            ['renameWhatsAppConnection', /prisma\.whatsAppConnection/],
            ['initializeWhatsAppConnection', /initializeClient/],
            ['refreshWhatsAppQR', /destroyClient/],
            ['getWhatsAppConnections', /prisma\.whatsAppConnection/],
            ['getWhatsAppStatus', /import\('@\/lib\/whatsapp\/WhatsAppService'\)/],
            ['getWhatsAppQrCode', /prisma\.whatsAppConnection/],
            ['disconnectWhatsApp', /destroyClient/],
            ['forceResetWhatsAppSession', /import\('@\/lib\/whatsapp\/WhatsAppService'\)/],
            ['deleteWhatsAppConnection', /destroyClient/],
            ['pauseWhatsAppConnection', /import\('@\/lib\/whatsapp\/WhatsAppService'\)/],
            ['resumeWhatsAppConnection', /import\('@\/lib\/whatsapp\/WhatsAppService'\)/],
            ['deleteWhatsAppMessages', /prisma\.whatsAppMessage/],
        ]
        for (const [name, operation] of cases) expectGuardBefore(source, name, operation)
    })

    test('AI credential/configuration mutations no longer trust crm_user_id', () => {
        const source = read('src/app/settings/ai/actions.ts')
        const guardStart = source.indexOf('async function assertCanEditAi()')
        const guardEnd = source.indexOf('// ─── AiAgentConfig', guardStart)
        const guard = source.slice(guardStart, guardEnd)
        expect(guard).toContain('await requireIntegrationAdminAccess()')
        expect(guard).not.toContain("cookies()")
        expect(guard).not.toMatch(/get\(['"]crm_user_id/)
        expect(exportedFunction(source, 'saveAiConfig')).toMatch(/await assertCanEditAi\(\)/)
        expectGuardBefore(source, 'getAiConfig', /getAiAgentProviderConfigV1/)
        expect(exportedFunction(source, 'testSavedConnection')).toMatch(/await assertCanEditAi\(\)/)
        expect(exportedFunction(source, 'testAiConnection')).toMatch(/await assertCanEditAi\(\)/)
    })

    test('protected pages establish the login flow and sessions are hardened', () => {
        for (const path of [
            'src/app/settings/api/page.tsx',
            'src/app/settings/integrations/telegram/page.tsx',
            'src/app/settings/integrations/max/page.tsx',
            'src/app/settings/integrations/whatsapp/page.tsx',
            'src/app/settings/integrations/bot/page.tsx',
            'src/app/logs/page.tsx',
            'src/app/settings/ai/page.tsx',
        ]) {
            expect(read(path)).toContain('requireIntegrationAdminPageAccess(')
        }
        const runtime = read('src/modules/identity-access/public/v1/integration-admin-auth.ts')
        expect(runtime).toContain('httpOnly: true')
        expect(runtime).toContain("sameSite: 'strict'")
        expect(runtime).toContain("secure: process.env.NODE_ENV === 'production'")
        expect(runtime).not.toMatch(/get\(['"]crm_user_id/)
    })
})
