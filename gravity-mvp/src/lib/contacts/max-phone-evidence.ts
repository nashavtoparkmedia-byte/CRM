import type { PhoneEvidenceSource } from '@/lib/contacts/contact-resolution.types'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

export type MaxPhoneEvidenceInput = {
  sourceKind?: string | null
  trustedForAutomaticResolution?: boolean | null
  observedAt?: string | null
  providerIdentityId?: string | number | null
  protocolChatId?: string | number | null
  uiRouteId?: string | number | null
} | null | undefined

export type ResolvedMaxPhoneEvidence = {
  normalizedPhone: string | null
  sourceKind: PhoneEvidenceSource
  trustedForAutomaticResolution: boolean
  observedAt: string
  providerIdentityId: string | null
  protocolChatId: string | null
  uiRouteId: string | null
  trustResult: 'bound_provider_profile' | 'untrusted_source' | 'unbound_provider_profile'
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

function digits(value: unknown): string | null {
  const normalized = String(value ?? '').replace(/\D/g, '')
  return normalized || null
}

function expectedUiRouteId(protocolChatId: string | null): string | null {
  if (!protocolChatId) return null
  try {
    return BigInt.asUintN(32, BigInt(protocolChatId)).toString()
  } catch {
    return null
  }
}

export function resolveMaxPhoneEvidence(
  rawPhone: unknown,
  input: MaxPhoneEvidenceInput,
  options: {
    now?: () => Date
    externalChatId?: string | number | null
    senderId?: string | number | null
  } = {},
): ResolvedMaxPhoneEvidence {
  const normalizedPhone = typeof rawPhone === 'string' || typeof rawPhone === 'number'
    ? normalizePhoneE164(String(rawPhone))
    : null
  const source = sourceKind(input?.sourceKind)
  const providerIdentityId = digits(input?.providerIdentityId)
  const protocolChatId = digits(input?.protocolChatId)
  const uiRouteId = digits(input?.uiRouteId)
  const externalChatId = digits(options.externalChatId)
  const senderId = digits(options.senderId)
  const identityMatches = Boolean(
    providerIdentityId
      && (providerIdentityId === senderId || providerIdentityId === externalChatId),
  )
  const routeMatches = Boolean(
    protocolChatId
      && externalChatId
      && protocolChatId === externalChatId
      && uiRouteId
      && uiRouteId === expectedUiRouteId(protocolChatId),
  )
  const providerBindingValid = identityMatches && routeMatches
  const trustedForAutomaticResolution = Boolean(
    normalizedPhone
      && input?.trustedForAutomaticResolution === true
      && MAX_TRUSTED_PHONE_SOURCES.has(source)
      && providerBindingValid,
  )
  const trustResult = trustedForAutomaticResolution
    ? 'bound_provider_profile'
    : source === 'provider_profile'
      ? 'unbound_provider_profile'
      : 'untrusted_source'

  return {
    normalizedPhone,
    sourceKind: source,
    trustedForAutomaticResolution,
    observedAt: observationTime(input?.observedAt, options.now || (() => new Date())),
    providerIdentityId,
    protocolChatId,
    uiRouteId,
    trustResult,
  }
}
