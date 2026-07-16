import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const drawer = readFileSync(resolve(root, 'src/app/messages/components/ContactProfileDrawer.tsx'), 'utf8')
const contactRoute = readFileSync(resolve(root, 'src/app/api/contacts/[id]/route.ts'), 'utf8')
const contract = readFileSync(resolve(root, 'src/lib/contact-profile-contract.ts'), 'utf8')

describe('critical Messages stabilization source guards', () => {
  it('resolves Telegram bot binding from DriverTelegram attached profiles', () => {
    expect(contactRoute).toContain('prisma.driverTelegram.findMany')
    expect(contactRoute).toContain('profile.externalParkId === telegramBotLink.activeParkId')
    expect(contactRoute).toContain('telegramBotState')
    expect(contactRoute).toContain('telegramIdentity')
  })

  it('keeps the Telegram bot block present for every Contact', () => {
    expect(drawer).toContain('data-telegram-bot-block')
    expect(drawer).toContain("data-telegram-bot-state={telegramBotDisplayStatus}")
    expect(drawer).not.toContain('{contact && tgIdentity && (')
    expect(drawer).toContain("telegramBotDisplayStatus === 'BOT_BOUND'")
    expect(drawer).toContain("telegramBotState?.status || 'NO_TELEGRAM_IDENTITY'")
  })

  it('uses the canonical Telegram user id for manual bot-link actions', () => {
    expect(drawer).toContain('telegramId: botTelegramId')
    expect(drawer).not.toContain('telegramId: tgIdentity.externalId')
  })

  it('keeps an existing MAX chat writeable without requiring phoneId', () => {
    expect(drawer).toContain("const hasOperationalMaxChat = identity.channel === 'max'")
    expect(drawer).toContain('Boolean(linkedChat?.externalChatId)')
    expect(drawer).toContain('hasOperationalMaxChat ? true : reachable')
    expect(drawer).toContain('Существующий MAX Chat связан с Contact и доступен для ответа')
  })

  it('publishes all canonical Telegram bot states in the typed profile contract', () => {
    for (const state of [
      'BOT_BOUND',
      'TELEGRAM_IDENTITY_AVAILABLE_BOT_UNBOUND',
      'TELEGRAM_DISCOVERED_BY_PHONE',
      'NO_TELEGRAM_IDENTITY',
      'CONFLICT',
    ]) {
      expect(contract).toContain(`'${state}'`)
    }
  })
})
