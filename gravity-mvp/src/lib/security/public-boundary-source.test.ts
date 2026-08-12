import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('browser-facing credential boundaries', () => {
    test('connection readers use explicit public projections', () => {
        const api = read('src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts')
        const telegram = read('src/app/tg-actions.ts')
        const max = read('src/app/max-actions.ts')
        const whatsapp = read('src/app/settings/integrations/whatsapp/whatsapp-actions.ts')
        const ai = read('src/app/settings/ai/actions.ts')

        expect(api).toContain('projectApiConnectionMetadata')
        expect(api.split('export async function addApiConnection', 1)[0]).not.toContain('apiKey: true')
        expect(telegram).toContain('projectTelegramConnectionMetadata')
        expect(max).toContain('projectMaxConnectionMetadata')
        expect(whatsapp).toContain('projectWhatsAppConnectionMetadata')
        expect(ai).toContain('projectAiAgentConfigMetadata')
        expect(ai).not.toMatch(/SELECT\s+\*\s+FROM\s+"AiAgentConfig"/i)
    })

    test('client components cannot read persistence credential properties', () => {
        const apiClient = read('src/modules/fleet-operations/public/v1/client-ui/ApiListClient.tsx')
        const telegramClient = read('src/app/settings/integrations/telegram/TelegramLoginClient.tsx')
        const maxClient = read('src/app/settings/integrations/max/MaxLoginClient.tsx')
        const whatsappClient = read('src/app/settings/integrations/whatsapp/WhatsAppDashboard.tsx')
        const aiClient = read('src/app/settings/ai/AiControlCenterClient.tsx')

        expect(apiClient).not.toContain('from "@prisma/client"')
        expect(apiClient).not.toMatch(/conn\.apiKey\b/)
        expect(telegramClient).not.toMatch(/initialConnections\[[^\]]+\]\.apiHash\b/)
        expect(telegramClient).not.toMatch(/checkTelegramAuthStatus\([^)]*apiHash/)
        expect(maxClient).not.toMatch(/conn\.botToken\b/)
        expect(whatsappClient).not.toMatch(/\.sessionData\b/)
        expect(aiClient).not.toMatch(/\.apiKeyEncrypted\b/)
    })

    test('WhatsApp QR is an explicit ceremony output, not a connection DTO field', () => {
        const actions = read('src/app/settings/integrations/whatsapp/whatsapp-actions.ts')
        const client = read('src/app/settings/integrations/whatsapp/WhatsAppDashboard.tsx')
        const service = read('src/lib/whatsapp/WhatsAppService.ts')
        const qrAction = actions.slice(
            actions.indexOf('export async function getWhatsAppQrCode'),
            actions.indexOf('export async function disconnectWhatsApp'),
        )

        expect(qrAction).toContain('readPendingWhatsAppQr(connectionId)')
        expect(qrAction).not.toContain('sessionData')
        expect(actions.split('export async function createWhatsAppConnection', 1)[0])
            .not.toContain('sessionData: true')
        expect(service).toContain('publishPendingWhatsAppQr(connectionId, instanceId, qrDataUrl)')
        expect(service).toContain("{ status: 'qr', sessionData: null }")
        expect(client).toContain('getWhatsAppQrCode(conn.id)')
    })

    test('Telegram login polling uses only an opaque login ID', () => {
        const actions = read('src/app/tg-actions.ts')
        expect(actions).toContain('export async function checkTelegramAuthStatus(loginId: string)')
        expect(actions).toContain('apiId: data.apiId')
        expect(actions).toContain('apiHash: data.apiHash')
        expect(actions).toContain('getTelegramAuthQRFromSavedConnection')
    })

    test('Telegram login ceremonies expire and tear down clients', () => {
        const actions = read('src/app/tg-actions.ts')
        expect(actions).toContain('TELEGRAM_LOGIN_TTL_MS')
        expect(actions).toContain('scheduleLoginExpiry(loginId)')
        expect(actions).toContain("disposeActiveLogin(loginId, 'expired')")
        expect(actions).toContain('activeLogins.delete(loginId)')
        expect(actions).toContain('await current.client.disconnect()')
        expect(actions).toContain('const loginId = randomUUID()')
    })

    test('public projections are context-owned instead of a shared Platform Shell helper', () => {
        expect(existsSync(join(root, 'src/lib/security/public-credential-metadata.ts'))).toBe(false)
        const imports = [
            read('src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts'),
            read('src/app/max-actions.ts'),
            read('src/app/tg-actions.ts'),
            read('src/app/settings/integrations/whatsapp/whatsapp-actions.ts'),
            read('src/app/settings/ai/actions.ts'),
        ].join('\n')
        expect(imports).not.toContain('@/lib/security/public-credential-metadata')
        expect(imports).toContain('@/modules/fleet-operations/public/v1/api-connection-public-metadata')
        expect(imports).toContain('@/modules/max-channel/public/v1/max-connection-public-metadata')
        expect(imports).toContain('@/modules/telegram-channel/public/v1/telegram-connection-public-metadata')
        expect(imports).toContain('@/modules/whatsapp-channel/public/v1/whatsapp-connection-public-metadata')
        expect(imports).toContain('@/modules/calling/public/v1/ai-agent-config-public-metadata')
    })

    test('Gravity never injects bot-admin credentials into the iframe URL', () => {
        const page = read('src/app/settings/integrations/bot/page.tsx')
        expect(page).not.toContain('ADMIN_PASS')
        expect(page).not.toContain('ADMIN_USER')
        expect(page).not.toContain('#auth=')
        expect(page).not.toContain('Buffer.from')
    })

    test('credential-bearing persistence failures do not emit invocation objects', () => {
        const api = read('src/modules/fleet-operations/public/v1/yandex-fleet-operations.ts')
        const max = read('src/app/max-actions.ts')
        const telegram = read('src/app/tg-actions.ts')
        const whatsapp = read('src/lib/whatsapp/WhatsAppService.ts')
        expect(api).toContain("console.error('[API-CONNECTION] Failed to create connection')")
        expect(max).toContain('console.error("Failed to add MAX connection")')
        expect(max).not.toContain('console.error("Failed to add MAX connection:", error)')
        expect(telegram).not.toContain('Database error saving session:`, dbErr')
        expect(whatsapp).not.toContain('Failed to save session for ${connectionId}:`, err')
    })
})
