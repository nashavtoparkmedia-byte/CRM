import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const drawer = readFileSync(resolve(process.cwd(), 'src/app/messages/components/ContactProfileDrawer.tsx'), 'utf8')

describe('Messages operator help contract', () => {
  test('explains Contact, profiles, Telegram bot, refresh, and manual review in operator language', () => {
    expect(drawer).toContain('const MESSAGES_HELP_SECTIONS')
    expect(drawer).toContain("title: 'Контакт.'")
    expect(drawer).toContain("title: 'Профили в парках.'")
    expect(drawer).toContain("title: 'Telegram-бот.'")
    expect(drawer).toContain("title: 'Привязка и объединение.'")
    expect(drawer).toContain("title: 'Обновление.'")
  })

  test('keeps build and schema markers inside collapsed technical data only', () => {
    expect(drawer).toContain('data-testid="technical-data"')
    expect(drawer).toContain('Profile schema: {contact.technicalData.schemaVersion}')
    expect(drawer).toContain('Build marker: {contact.technicalData.buildMarker}')
  })

  test('does not expose implementation vocabulary in the operator help copy', () => {
    const helpStart = drawer.indexOf('const MESSAGES_HELP_SECTIONS')
    const helpEnd = drawer.indexOf('function getIdentitySourceBadges', helpStart)
    const helpCopy = drawer.slice(helpStart, helpEnd)

    for (const forbidden of ['Prisma', 'provider identity', 'migration', 'route ID', 'external composite key', 'enum', 'Attachment', 'Ambiguous']) {
      expect(helpCopy).not.toContain(forbidden)
    }
  })
})
