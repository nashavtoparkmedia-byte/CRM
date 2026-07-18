import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('Telegram phone and username source contract', () => {
  test('Bot forwards structured shared-contact evidence instead of only display text', () => {
    const integration = source('../tg-bot/src/services/crmIntegration.js')
    expect(integration).toContain('let sharedContact = null')
    expect(integration).toContain('phoneNumber: m.contact.phone_number')
    expect(integration).toContain('userId: m.contact.user_id')
    expect(integration).toContain('sharedContact: sharedContact || undefined')
  })

  test('both Telegram transports use the same strict shared-contact workflow', () => {
    const webhook = source('src/app/api/webhook/telegram/route.ts')
    const gramJs = source('src/app/tg-actions.ts')
    expect(webhook).toContain('applyTelegramSharedContactPhone({')
    expect(webhook).toContain("transport: 'bot_webhook'")
    expect(gramJs).toContain('readTelegramSharedContactMedia(message.media)')
    expect(gramJs).toContain('applyTelegramSharedContactPhone({')
    expect(gramJs).toContain("transport: 'gramjs'")
    expect(gramJs).toContain('phoneNumber: sharedContact.phoneNumber')
  })

  test('username search reads stable ID, current username and lower-ranked history', () => {
    const search = source('src/app/api/contacts/search/route.ts')
    expect(search).toContain("identity.metadata->>'telegramUserId'")
    expect(search).toContain("identity.metadata->>'username'")
    expect(search).toContain("identity.metadata->'usernameHistory'")
    expect(search).toContain('ORDER BY "matchRank"')
    expect(search).not.toContain("identity.\"displayName\" = ${telegramQuery")
  })
})
