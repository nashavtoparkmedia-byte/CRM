import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const gravityRoot = resolve(__dirname, '../../../../../')
const repositoryRoot = resolve(gravityRoot, '..')
const gravitySource = (path: string) => readFileSync(resolve(gravityRoot, path), 'utf8')
const botSource = (path: string) => readFileSync(resolve(repositoryRoot, 'tg-bot', path), 'utf8')

describe('driver bot pending-link registry wiring', () => {
    test('CRM accepts bot registrations through the Telegram owner capability', () => {
        const webhook = gravitySource('src/app/api/webhooks/bot/route.ts')
        expect(webhook).toContain("case 'register_bot_user':")
        expect(webhook).toContain('recordBotUserProfileV1({')
        expect(webhook).toContain('status: \'PENDING_MANAGER_LINK\'')
    })

    test('pending-link list is projected from the durable registry and legacy requests', () => {
        const route = gravitySource('src/app/api/bot-users/route.ts')
        const projector = gravitySource('src/app/api/bot-users/pending-link-requests.ts')
        expect(route).toContain('prisma.botUserRegistry.findMany')
        expect(route).toContain('buildPendingBotLinkRequests({')
        expect(projector).toContain('pendingByTelegramId')
        expect(projector).toContain('linkedTelegramIds.has(telegramId)')
        expect(projector).toContain('row.firstSeenAt.toISOString()')
    })

    test('the bot registers on start and retries unsynced local users', () => {
        const start = botSource('src/handlers/start.js')
        const bot = botSource('src/bot.js')
        const sync = botSource('src/services/botRegistrySync.js')
        expect(start).toContain('botRegistrySync.registerUser({')
        expect(bot).toContain('botRegistrySync.syncPendingUsers()')
        expect(bot).toContain('botRegistrySync.startPeriodicSync()')
        expect(sync).toContain("action: 'register_bot_user'")
        expect(sync).toContain('attemptAutoLink: false')
    })

    test('phone linking requires Telegram contact ownership evidence', () => {
        const webhook = gravitySource('src/app/api/webhooks/bot/route.ts')
        const carManagement = botSource('src/handlers/carManagement.js')
        expect(webhook).toContain("error: 'CONTACT_OWNER_MISMATCH'")
        expect(webhook).toContain('String(contactUserId) !== String(telegramId)')
        expect(carManagement).toContain('contactUserId: ctx.message.contact.user_id')
    })
})
