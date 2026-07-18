import type { PhoneEvidenceSource } from '@/lib/contacts/contact-resolution.types'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

export type MaxPhoneEvidenceInput = {
  sourceKind?: string | null
  trustedForAutomaticResolution?: boolean | null
  observedAt?: string | null
} | null | undefined

export type ResolvedMaxPhoneEvidence = {
  normalizedPhone: string | null
  sourceKind: PhoneEvidenceSource
  trustedForAutomaticResolution: boolean
  observedAt: string
}

const MAX_PHONE_SOURCES = new Set<PhoneEvidenceSource>([
  'provider_profile',
  'shared_contact',
  'manual_verified',
  'message_text',
  'unknown',
])

// Only MAX's own contact/profile response is accepted automatically. Other
// source names remain useful diagnostics but cannot become CRM ownership proof.
const MAX_TRUSTED_PHONE_SOURCES = new Set<PhoneEvidenceSource>(['provider_profile'])

function sourceKind(value: unknown): PhoneEvidenceSource {
  return typeof value === 'string' && MAX_PHONE_SOURCES.has(value as PhoneEvidenceSource)
    ? value as PhoneEvidenceSource
    : 'unknown'
}

function observationTime(value: unknown, now: () => Date): string {
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }
  return now().toISOString()
}

export function resolveMaxPhoneEvidence(
  rawPhone: unknown,
  input: MaxPhoneEvidenceInput,
  options: { now?: () => Date } = {},
): ResolvedMaxPhoneEvidence {
  const normalizedPhone = typeof rawPhone === 'string' || typeof rawPhone === 'number'
    ? normalizePhoneE164(String(rawPhone))
    : null
  const source = sourceKind(input?.sourceKind)
  const trustedForAutomaticResolution = Boolean(
    normalizedPhone
      && input?.trustedForAutomaticResolution === true
      && MAX_TRUSTED_PHONE_SOURCES.has(source),
  )

  return {
    normalizedPhone,
    sourceKind: source,
    trustedForAutomaticResolution,
    observedAt: observationTime(input?.observedAt, options.now || (() => new Date())),
  }
}
