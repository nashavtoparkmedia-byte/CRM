import { describe, expect, it } from 'vitest'
import { buildTelegramIdentityMetadata } from '@/lib/telegram-identity-metadata'

describe('Telegram identity metadata', () => {
  it('keeps telegramUserId stable while username changes', () => {
    const first = buildTelegramIdentityMetadata(
      { retainedAuditField: 'keep-me' },
      {
        telegramUserId: '100500',
        username: 'old_name',
        firstName: 'Ivan',
        displayName: '@old_name',
        observedAt: new Date('2026-07-17T10:00:00.000Z'),
      },
    )
    const second = buildTelegramIdentityMetadata(first, {
      telegramUserId: 100500n,
      username: '@new_name',
      firstName: 'Ivan',
      lastName: 'Petrov',
      displayName: '@new_name',
      observedAt: new Date('2026-07-17T10:05:00.000Z'),
    })

    expect(second).toMatchObject({
      telegramUserId: '100500',
      username: 'new_name',
      lastObservedUsername: 'new_name',
      firstName: 'Ivan',
      lastName: 'Petrov',
      displayName: '@new_name',
      retainedAuditField: 'keep-me',
      lastObservedAt: '2026-07-17T10:05:00.000Z',
      lastSyncAt: '2026-07-17T10:05:00.000Z',
      lastObservedSource: 'telegram_webhook',
    })
  })

  it('records username removal without changing stable identity', () => {
    const metadata = buildTelegramIdentityMetadata(
      { telegramUserId: '100500', username: 'old_name' },
      {
        telegramUserId: '100500',
        username: null,
        observedAt: new Date('2026-07-17T11:00:00.000Z'),
      },
    )

    expect(metadata.telegramUserId).toBe('100500')
    expect(metadata.username).toBeNull()
    expect(metadata.lastObservedUsername).toBeNull()
  })

  it('rejects a mutable username as the stable identity key', () => {
    expect(() => buildTelegramIdentityMetadata({}, {
      telegramUserId: '@operator_name',
      username: 'operator_name',
    })).toThrow('telegramUserId must contain digits only')
  })
})
