import { describe, expect, it } from 'vitest'

import { deriveTelegramBotProfileState } from '@/lib/telegram-bot-profile-state'

const base = {
  lookupAvailable: true,
  linkCount: 0,
  hasTelegramIdentity: false,
  linkedProfile: null,
  mainDriverId: null,
}

describe('Telegram Bot profile state', () => {
  it('distinguishes identity and temporary availability states', () => {
    expect(deriveTelegramBotProfileState(base)).toBe('NO_TELEGRAM_IDENTITY')
    expect(deriveTelegramBotProfileState({ ...base, hasTelegramIdentity: true }))
      .toBe('TELEGRAM_IDENTITY_AVAILABLE_BOT_UNBOUND')
    expect(deriveTelegramBotProfileState({ ...base, lookupAvailable: false }))
      .toBe('TEMPORARILY_UNAVAILABLE')
  })

  it('requires a concrete attached DriverProfile for a healthy binding', () => {
    expect(deriveTelegramBotProfileState({ ...base, linkCount: 1 }))
      .toBe('BOT_BOUND_WITHOUT_PROFILE')
    expect(deriveTelegramBotProfileState({
      ...base,
      linkCount: 1,
      linkedProfile: { id: 'driver-1', normalizedStatus: 'working' },
      mainDriverId: 'driver-1',
    })).toBe('BOT_BOUND')
  })

  it('surfaces non-main, dismissed and duplicate bindings', () => {
    expect(deriveTelegramBotProfileState({
      ...base,
      linkCount: 1,
      linkedProfile: { id: 'driver-2', normalizedStatus: 'working' },
      mainDriverId: 'driver-1',
    })).toBe('BOT_BOUND_TO_NON_MAIN_PROFILE')
    expect(deriveTelegramBotProfileState({
      ...base,
      linkCount: 1,
      linkedProfile: { id: 'driver-1', normalizedStatus: 'dismissed' },
      mainDriverId: 'driver-1',
    })).toBe('BOT_BOUND_TO_DISMISSED_PROFILE')
    expect(deriveTelegramBotProfileState({ ...base, linkCount: 2 }))
      .toBe('CONFLICT')
  })
})
