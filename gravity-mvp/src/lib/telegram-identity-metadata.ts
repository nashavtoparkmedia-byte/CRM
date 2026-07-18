import type { Prisma } from '@prisma/client'

interface TelegramIdentityObservation {
  telegramUserId: string | number | bigint
  username?: unknown
  firstName?: unknown
  lastName?: unknown
  displayName?: unknown
  observedAt?: Date
  source?: 'telegram_webhook' | 'telegram_gramjs'
}

function asRecord(value: unknown): Prisma.InputJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Prisma.InputJsonObject
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

export function normalizeTelegramUsername(value: unknown): string | null {
  return optionalText(value)?.replace(/^@/, '').toLocaleLowerCase('en-US') || null
}

type UsernameHistoryEntry = {
  username: string
  lastObservedAt: string
}

function usernameHistory(value: unknown): UsernameHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const username = normalizeTelegramUsername(record.username)
    const lastObservedAt = optionalText(record.lastObservedAt)
    return username && lastObservedAt ? [{ username, lastObservedAt }] : []
  })
}

export function buildTelegramIdentityMetadata(
  existing: unknown,
  observation: TelegramIdentityObservation,
): Prisma.InputJsonObject {
  const telegramUserId = String(observation.telegramUserId).trim()
  if (!/^\d+$/.test(telegramUserId)) {
    throw new Error('telegramUserId must contain digits only')
  }

  const observedAt = observation.observedAt || new Date()
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error('observedAt must be a valid date')
  }

  const existingRecord = asRecord(existing)
  const existingTelegramUserId = optionalText(existingRecord.telegramUserId)
  if (existingTelegramUserId && existingTelegramUserId !== telegramUserId) {
    throw new Error('telegramUserId cannot change for an existing identity')
  }

  const username = normalizeTelegramUsername(observation.username)
  const previousUsername = normalizeTelegramUsername(existingRecord.username)
  const firstName = optionalText(observation.firstName)
  const lastName = optionalText(observation.lastName)
  const displayName = optionalText(observation.displayName)
  const timestamp = observedAt.toISOString()
  const previousHistory = usernameHistory(existingRecord.usernameHistory)
  const nextHistory = previousUsername && previousUsername !== username
    ? [
        ...previousHistory.filter(item => item.username !== previousUsername),
        { username: previousUsername, lastObservedAt: timestamp },
      ]
    : previousHistory

  return {
    ...existingRecord,
    telegramUserId,
    username,
    lastObservedUsername: username,
    usernameHistory: nextHistory as unknown as Prisma.InputJsonArray,
    firstName: firstName ?? existingRecord.firstName ?? null,
    lastName: lastName ?? existingRecord.lastName ?? null,
    displayName: displayName ?? existingRecord.displayName ?? null,
    lastObservedAt: timestamp,
    lastSyncAt: timestamp,
    lastObservedSource: observation.source || 'telegram_webhook',
  }
}
