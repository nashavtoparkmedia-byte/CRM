import { describe, expect, test } from 'vitest'
import { buildPendingBotLinkRequests } from './pending-link-requests'

const max8q = {
  id: 'registry-max8q',
  telegramId: 88000001n,
  phone: '+79990001122',
  username: 'Max8q',
  firstName: 'Максим',
  lastName: null,
  firstSeenAt: new Date('2026-08-29T12:00:00.000Z'),
  lastSeenAt: new Date('2026-08-29T12:05:00.000Z'),
}

describe('pending Telegram driver links', () => {
  test('shows an unlinked registered user once with the submitted phone', () => {
    const requests = buildPendingBotLinkRequests({
      registryRows: [max8q],
      legacyRequests: [{
        id: 'legacy-max8q',
        telegramId: max8q.telegramId,
        text: '[Запрос привязки] Телефон: +79990001122, @Max8q',
        createdAt: new Date('2026-08-29T12:03:00.000Z'),
      }],
      linkedTelegramIds: new Set(),
      chatMap: { '88000001': 'chat-max8q' },
    })

    expect(requests).toEqual([expect.objectContaining({
      id: 'legacy-max8q',
      telegramId: '88000001',
      username: 'Max8q',
      phone: '+79990001122',
      chatId: 'chat-max8q',
    })])
  })

  test('does not show a registered user after the driver link exists', () => {
    expect(buildPendingBotLinkRequests({
      registryRows: [max8q],
      legacyRequests: [],
      linkedTelegramIds: new Set(['88000001']),
      chatMap: {},
    })).toEqual([])
  })
})
