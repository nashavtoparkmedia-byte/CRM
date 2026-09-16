export type ContactPhoneLifecycleV1 = 'current' | 'superseded' | 'removed' | 'unknown'
export type ContactPhoneTrustV1 = 'provider_bound' | 'manually_verified' | 'source_asserted' | 'claimed' | 'unknown'
export type ContactPhoneFreshnessV1 = 'fresh' | 'stale' | 'unknown'
export type ContactPhoneResolutionStateV1 = 'unique' | 'shared' | 'disputed' | 'unknown'

export type ContactPhoneEvidenceStateV1 = {
  rawPhone: string | null
  lifecycle: ContactPhoneLifecycleV1
  trust: ContactPhoneTrustV1
  freshness: ContactPhoneFreshnessV1
  resolutionState: ContactPhoneResolutionStateV1
  verifiedBy: string | null
  verificationBasis: string | null
  observedAt: string | null
  lastSeenAt: string | null
  lifecycleUpdatedAt: string | null
  evidenceRoot: string | null
  auditTrail: unknown[]
}

export type ContactAutomationStateV1 = {
  canonicalPinnedAt: string | null
  canonicalPinnedBy: string | null
  doNotMerge: boolean
  mergedIntoContactId: string | null
  mergeRecoveryState: string | null
}

export type ContactIdentityEvidenceStateV1 = {
  providerAccountId: string
  origin: string
  evidenceRoot: string | null
  conflictState: string
  providerAliasValues: string[]
  providerAliases: unknown[]
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

export function contactAutomationState(customFields: unknown): ContactAutomationStateV1 {
  const fields = jsonRecord(customFields)
  return {
    canonicalPinnedAt: optionalString(fields.canonicalPinnedAt),
    canonicalPinnedBy: optionalString(fields.canonicalPinnedBy),
    doNotMerge: fields.doNotMerge === true,
    mergedIntoContactId: optionalString(fields.mergedIntoContactId),
    mergeRecoveryState: optionalString(fields.mergeRecoveryState),
  }
}

export function identityEvidenceState(metadata: unknown): ContactIdentityEvidenceStateV1 {
  const value = jsonRecord(metadata)
  return {
    providerAccountId: optionalString(value.providerAccountId) ?? 'legacy',
    origin: optionalString(value.origin) ?? 'legacy',
    evidenceRoot: optionalString(value.evidenceRoot),
    conflictState: optionalString(value.conflictState) ?? 'clear',
    providerAliasValues: Array.isArray(value.providerAliasValues)
      ? value.providerAliasValues.filter((item): item is string => typeof item === 'string')
      : [],
    providerAliases: Array.isArray(value.providerAliases) ? value.providerAliases : [],
  }
}

export function phoneEvidenceByPhoneId(customFields: unknown): Record<string, unknown> {
  return jsonRecord(jsonRecord(customFields).phoneEvidenceByPhoneId)
}

export function phoneEvidenceState(
  customFields: unknown,
  phoneId: string,
  fallback: { phone: string; isActive: boolean; verifiedAt: Date | string | null },
): ContactPhoneEvidenceStateV1 {
  const value = jsonRecord(phoneEvidenceByPhoneId(customFields)[phoneId])
  return {
    rawPhone: optionalString(value.rawPhone) ?? fallback.phone,
    // Legacy rows deliberately remain ineligible for automatic ownership.
    lifecycle: enumValue(value.lifecycle, ['current', 'superseded', 'removed', 'unknown'] as const,
      fallback.isActive ? 'current' : 'removed'),
    trust: enumValue(value.trust, ['provider_bound', 'manually_verified', 'source_asserted', 'claimed', 'unknown'] as const,
      'unknown'),
    freshness: enumValue(value.freshness, ['fresh', 'stale', 'unknown'] as const, 'unknown'),
    resolutionState: enumValue(value.resolutionState, ['unique', 'shared', 'disputed', 'unknown'] as const,
      'unknown'),
    verifiedBy: optionalString(value.verifiedBy),
    verificationBasis: optionalString(value.verificationBasis),
    observedAt: optionalString(value.observedAt),
    lastSeenAt: optionalString(value.lastSeenAt),
    lifecycleUpdatedAt: optionalString(value.lifecycleUpdatedAt),
    evidenceRoot: optionalString(value.evidenceRoot),
    auditTrail: Array.isArray(value.auditTrail) ? value.auditTrail : [],
  }
}

export function withPhoneEvidence(
  customFields: unknown,
  phoneId: string,
  evidence: ContactPhoneEvidenceStateV1,
): Record<string, unknown> {
  const fields = jsonRecord(customFields)
  return {
    ...fields,
    phoneEvidenceByPhoneId: {
      ...phoneEvidenceByPhoneId(fields),
      [phoneId]: evidence,
    },
  }
}

export function withoutPhoneEvidence(customFields: unknown, phoneIds: readonly string[]): Record<string, unknown> {
  const fields = jsonRecord(customFields)
  const map = { ...phoneEvidenceByPhoneId(fields) }
  for (const id of phoneIds) delete map[id]
  return { ...fields, phoneEvidenceByPhoneId: map }
}

export type ChannelCollisionChannelV1 = 'telegram' | 'whatsapp' | 'max'

export type PersonBlockingIdentityV1 = {
  id: string
  channel: string
  externalId: string
}

/**
 * Admission reasons that name a transport, connection or company-account fact
 * and nothing about the person. Every revision of every channel ingress chain
 * that ever wrote a `channel_identity_collision` is covered, including reasons
 * the current callers no longer raise, so historical records classify too.
 */
const TRANSPORT_COLLISION_REASONS_V1: Readonly<Record<ChannelCollisionChannelV1, ReadonlySet<string>>> = Object.freeze({
  telegram: new Set([
    'transport_connection_mismatch',
    'transport_connection_unproven',
    'provider_account_mismatch',
    'provider_account_unproven',
  ]),
  whatsapp: new Set(['transport_mismatch', 'transport_unbound']),
  max: new Set(['provider_account_mismatch', 'provider_account_unproven']),
})

const COLLISION_CHAT_KINDS_V1 = new Set(['private', 'group', 'unknown'])

function isCollisionChannel(value: unknown): value is ChannelCollisionChannelV1 {
  return value === 'telegram' || value === 'whatsapp' || value === 'max'
}

function presentId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function absentId(value: unknown): boolean {
  return value === null || value === undefined
}

/** The recorded values actually express this reason, not merely its label. */
function recordsTransportReason(
  details: Record<string, unknown>,
  reason: string,
  field: 'ProviderAccountId' | 'ConnectionId',
): boolean {
  const incoming = details[`incoming${field}`]
  const existing = details[`existing${field}`]
  if (reason.endsWith('_mismatch')) return presentId(incoming) && presentId(existing) && incoming !== existing
  return presentId(incoming) && absentId(existing)
}

export function isTransportCollisionReasonV1(channel: unknown, reason: unknown): boolean {
  return isCollisionChannel(channel)
    && typeof reason === 'string'
    && TRANSPORT_COLLISION_REASONS_V1[channel].has(reason)
}

/** Values the MAX admission chain treats as "no account", mirrored so the writer can refuse them itself. */
const MAX_ACCOUNT_PLACEHOLDERS_V1: ReadonlySet<string> = new Set(['legacy', 'max-default'])

function concreteMaxAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized !== '' && !MAX_ACCOUNT_PLACEHOLDERS_V1.has(normalized) ? normalized : null
}

/**
 * Whether a channel ingress collision, as recorded, contradicts the person, so
 * that Contacts may record it as a person conflict.
 *
 * A transport, connection or company-account reason never does. On MAX the
 * collision compares the event with facts stored on the conversation, and those
 * facts are evidence about the peer only when the exact admission chain wrote
 * them for the same company account that observed the event: a concrete stored
 * account equal to the incoming one, and a stored `private` chat kind, which the
 * chain writes together with the sender. Earlier writers never stored a chat
 * kind, their sender is whoever wrote last (even the company account's own
 * outbound echo), and their Contact link was re-pointed on every event. Another
 * account's stored facts say nothing about this event either, because MAX chat
 * ids are not proven to be account-independent. So, on MAX, only these are
 * person evidence:
 * - `sender_identity_mismatch`: two concrete, different senders against proven
 *   private peer evidence, neither of them the company account itself;
 * - `chat_kind_mismatch`: group traffic into a proven private conversation.
 * Everything else is route or admission uncertainty and never reaches the person:
 * `sender_identity_unproven` (absent proof is not a contradiction),
 * `message_chat_mismatch` and `channel_mismatch` (global message or conversation
 * key collisions), and any reason the chain does not raise. Messaging still
 * fails the conversation closed and audits it. Other channels are unchanged.
 */
export function isPersonIdentityCollisionEvidenceV1(input: {
  channel: unknown
  reason: unknown
  details: unknown
}): boolean {
  if (!isCollisionChannel(input.channel) || typeof input.reason !== 'string') return false
  if (isTransportCollisionReasonV1(input.channel, input.reason)) return false
  if (input.channel !== 'max') return true

  const details = jsonRecord(input.details)
  const account = concreteMaxAccountId(details.existingProviderAccountId)
  const provenPrivateConversation = account !== null
    && account === concreteMaxAccountId(details.incomingProviderAccountId)
    && details.existingChatKind === 'private'
  if (!provenPrivateConversation) return false

  if (input.reason === 'sender_identity_mismatch') {
    return presentId(details.existingSenderId)
      && presentId(details.incomingSenderId)
      && details.existingSenderId !== details.incomingSenderId
      && details.existingSenderId.trim() !== account
      && details.incomingSenderId.trim() !== account
  }
  if (input.reason === 'chat_kind_mismatch') return details.incomingChatKind === 'group'
  return false
}

/**
 * Proves, from a recorded collision alone, that it concerned only a transport.
 *
 * The reason label is not enough. In the Telegram MTProto and MAX admission
 * chains the transport comparison runs BEFORE the peer or sender comparison, so
 * a transport reason can hide a genuine "this conversation belongs to someone
 * else" contradiction. A record is transport-only only when its own details show
 * that every person or conversation-shape comparison that a transport reason can
 * mask did not contradict. Anything that cannot be proven stays person-blocking.
 */
export function isProvenTransportOnlyChannelCollisionV1(input: {
  channel: unknown
  reason: unknown
  details: unknown
}): boolean {
  if (!isTransportCollisionReasonV1(input.channel, input.reason)) return false
  const channel = input.channel as ChannelCollisionChannelV1
  const reason = input.reason as string
  const details = jsonRecord(input.details)

  if (channel === 'whatsapp') {
    // The WhatsApp chain compares only the stored and incoming connection.
    return recordsTransportReason(details, reason, 'ConnectionId')
  }

  const field = reason.startsWith('provider_account_') ? 'ProviderAccountId' : 'ConnectionId'
  if (!recordsTransportReason(details, reason, field)) return false

  if (channel === 'telegram') {
    // Only the MTProto admission records peer ids. Its peer comparison and its
    // chat-kind comparison both follow the transport arm, and the chat kind is
    // never recorded, so an MTProto transport record cannot be proven clean.
    if (Object.prototype.hasOwnProperty.call(details, 'incomingPeerId')) return false
    // The Bot API chain checks the conversation key before the transport arm and
    // has no peer comparison; only the chat kind follows, and it is recorded.
    return presentId(details.incomingChatKind)
      && (details.incomingChatKind === 'private' || details.incomingChatKind === 'group')
      && details.existingChatKind === details.incomingChatKind
  }

  // MAX: chat kind and sender identity both follow the provider-account arm.
  const incomingChatKind = details.incomingChatKind
  const existingChatKind = details.existingChatKind
  if (!COLLISION_CHAT_KINDS_V1.has(String(incomingChatKind)) || !COLLISION_CHAT_KINDS_V1.has(String(existingChatKind))) {
    return false
  }
  const concreteKindMismatch = existingChatKind !== 'unknown'
    && incomingChatKind !== 'unknown'
    && existingChatKind !== incomingChatKind
  if (concreteKindMismatch || incomingChatKind === 'group') return false
  return presentId(details.incomingSenderId)
    && presentId(details.existingSenderId)
    && details.incomingSenderId === details.existingSenderId
}

/** A persisted conflict entry that is a proven transport-only ingress collision on this exact identity. */
export function isProvenTransportOnlyIdentityConflictV1(
  conflict: unknown,
  identity: PersonBlockingIdentityV1,
): boolean {
  const record = jsonRecord(conflict)
  if (record.conflictType !== 'channel_identity_collision' || record.source !== 'channel-ingress') return false
  if (record.identityId !== identity.id) return false
  const details = jsonRecord(record.details)
  if (details.channel !== identity.channel || details.externalUserId !== identity.externalId) return false
  return isProvenTransportOnlyChannelCollisionV1({
    channel: details.channel,
    reason: details.reason,
    details,
  })
}

/**
 * Whether an open conflict on this identity blocks person-level operations.
 * Every open conflict blocks except a proven transport-only ingress collision:
 * a transport problem fails its own conversation closed and never disables the
 * person. Unclassifiable historical entries keep blocking.
 */
export function hasPersonBlockingIdentityConflictV1(
  customFields: unknown,
  identity: PersonBlockingIdentityV1,
): boolean {
  const conflicts = jsonRecord(customFields).identityConflicts
  return Array.isArray(conflicts) && conflicts.some(item => {
    const conflict = jsonRecord(item)
    return conflict.status === 'open'
      && conflict.identityId === identity.id
      && !isProvenTransportOnlyIdentityConflictV1(conflict, identity)
  })
}

// providerAccountMatches was deliberately REMOVED, not merely left uncalled.
// Comparing a stored provider-account stamp to an inbound one was an
// authorization boundary with no authority behind it: every available value
// names a mutable application transport slot rather than a provider-issued
// account, and no production identity carries the stamp at all. Reintroducing
// the helper would let that boundary return silently. identityEvidenceState
// still exposes providerAccountId as telemetry and future migration metadata.
// See docs/design/provider-account-identity-v1.md.
