export type TelegramBotProfileStateCode =
  | 'BOT_BOUND'
  | 'BOT_BOUND_WITHOUT_PROFILE'
  | 'BOT_BOUND_TO_NON_MAIN_PROFILE'
  | 'BOT_BOUND_TO_DISMISSED_PROFILE'
  | 'TELEGRAM_IDENTITY_AVAILABLE_BOT_UNBOUND'
  | 'TELEGRAM_DISCOVERED_BY_PHONE'
  | 'NO_TELEGRAM_IDENTITY'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'CONFLICT'

interface TelegramBotProfileStateInput {
  lookupAvailable: boolean
  linkCount: number
  hasTelegramIdentity: boolean
  linkedProfile: {
    id: string
    normalizedStatus: 'working' | 'dismissed' | 'unknown'
  } | null
  mainDriverId: string | null
}

export function deriveTelegramBotProfileState(
  input: TelegramBotProfileStateInput,
): TelegramBotProfileStateCode {
  if (!input.lookupAvailable) return 'TEMPORARILY_UNAVAILABLE'
  if (input.linkCount > 1) return 'CONFLICT'
  if (input.linkCount === 1) {
    if (!input.linkedProfile) return 'BOT_BOUND_WITHOUT_PROFILE'
    if (input.linkedProfile.normalizedStatus === 'dismissed') {
      return 'BOT_BOUND_TO_DISMISSED_PROFILE'
    }
    if (input.mainDriverId && input.linkedProfile.id !== input.mainDriverId) {
      return 'BOT_BOUND_TO_NON_MAIN_PROFILE'
    }
    return 'BOT_BOUND'
  }
  return input.hasTelegramIdentity
    ? 'TELEGRAM_IDENTITY_AVAILABLE_BOT_UNBOUND'
    : 'NO_TELEGRAM_IDENTITY'
}
