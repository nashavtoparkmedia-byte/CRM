export const CONTACT_PROFILE_REFRESH_TTL_MS = 15 * 60 * 1000
export const CONTACT_PROFILE_RETRY_BACKOFF_MS = 60 * 1000

export type ContactProfileRefreshDecision =
  | { kind: 'fresh'; retryAt: null }
  | { kind: 'stale'; retryAt: null }
  | { kind: 'backoff'; retryAt: Date }

export function getContactProfileRefreshDecision(input: {
  lastSuccessfulAt: Date | null
  lastFailedAt: Date | null
  now?: Date
  ttlMs?: number
  backoffMs?: number
}): ContactProfileRefreshDecision {
  const now = input.now || new Date()
  const ttlMs = input.ttlMs ?? CONTACT_PROFILE_REFRESH_TTL_MS
  const backoffMs = input.backoffMs ?? CONTACT_PROFILE_RETRY_BACKOFF_MS

  if (input.lastFailedAt && (!input.lastSuccessfulAt || input.lastFailedAt > input.lastSuccessfulAt)) {
    const retryAt = new Date(input.lastFailedAt.getTime() + backoffMs)
    if (retryAt > now) return { kind: 'backoff', retryAt }
  }

  if (input.lastSuccessfulAt && now.getTime() - input.lastSuccessfulAt.getTime() < ttlMs) {
    return { kind: 'fresh', retryAt: null }
  }

  return { kind: 'stale', retryAt: null }
}

export function formatProfileRefreshWarning(parkName: string): string {
  return 'Не удалось обновить данные «' + parkName + '». Показана последняя сохранённая информация.'
}
