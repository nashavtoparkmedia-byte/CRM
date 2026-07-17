import type { Prisma } from '@prisma/client'

interface TelegramIdentityObservation {
  telegramUserId: string | number | bigint
  username?: unknown
  firstName?: unknown
  lastName?: unknown
  displayName?: unknown
  observedAt?: Date
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

  const username = optionalText(observation.username)?.replace(/^@/, '') || null
  const firstName = optionalText(observation.firstName)
  const lastName = optionalText(observation.lastName)
  const displayName = optionalText(observation.displayName)
  const timestamp = observedAt.toISOString()

  return {
    ...asRecord(existing),
    telegramUserId,
    username,
    lastObservedUsername: username,
    firstName,
    lastName,
    displayName,
    lastObservedAt: timestamp,
    lastSyncAt: timestamp,
    lastObservedSource: 'telegram_webhook',
  }
}
