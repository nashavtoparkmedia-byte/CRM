/**
 * Unified phone normalization utilities for Contact Model.
 * Single source of truth for phone format: E.164 (+79221234567)
 */

/**
 * Normalize any phone input to E.164 format (+7XXXXXXXXXX).
 * Returns null for invalid/unparseable input.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null

  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return null

  let normalized: string

  if (digits.length === 11) {
    if (digits.startsWith('7') || digits.startsWith('8')) {
      normalized = '7' + digits.slice(1)
    } else {
      return null
    }
  } else if (digits.length === 10) {
    normalized = '7' + digits
  } else if (digits.length > 11) {
    normalized = '7' + digits.slice(-10)
  } else {
    return null
  }

  if (normalized.length !== 11 || !normalized.startsWith('7')) return null

  return '+' + normalized
}

/**
 * Parse externalChatId into channel and externalId.
 * Format: "channel:externalId" (e.g. "whatsapp:79221234567")
 */
export function parseExternalChatId(externalChatId: string): { channel: string; externalId: string } {
  const colonIndex = externalChatId.indexOf(':')

  if (colonIndex === -1) {
    return { channel: 'max', externalId: externalChatId }
  }

  const channel = externalChatId.slice(0, colonIndex)
  const externalId = externalChatId.slice(colonIndex + 1)

  const knownChannels = ['whatsapp', 'telegram', 'max', 'yandex_pro']
  if (knownChannels.includes(channel)) {
    return { channel, externalId }
  }

  // Legacy MAX format: "max_name:ИМЯ"
  if (channel === 'max_name') {
    return { channel: 'max', externalId: `name_${externalId}` }
  }

  return { channel: 'unknown', externalId: externalChatId }
}

/** Check if a string looks like a phone number (10-15 digits). */
export function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

/** Strip non-digit characters for search. */
export function stripToDigits(input: string): string {
  return input.replace(/\D/g, '')
}
