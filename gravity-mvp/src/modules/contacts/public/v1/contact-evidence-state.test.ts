import { describe, expect, test } from 'vitest'

import {
  contactAutomationState,
  hasPersonBlockingIdentityConflictV1,
  identityEvidenceState,
  isProvenTransportOnlyChannelCollisionV1,
  isProvenTransportOnlyIdentityConflictV1,
  isTransportCollisionReasonV1,
  phoneEvidenceState,
  withPhoneEvidence,
} from './contact-evidence-state'

const TELEGRAM_IDENTITY = { id: 'identity-tg', channel: 'telegram', externalId: '42' }
const WHATSAPP_IDENTITY = { id: 'identity-wa', channel: 'whatsapp', externalId: '79990001122@c.us' }
const MAX_IDENTITY = { id: 'identity-max', channel: 'max', externalId: 'sender-42' }

/** A persisted conflict entry in the exact shape the ingress writer has always produced. */
function ingressCollision(
  identity: { id: string; channel: string; externalId: string },
  reason: string,
  details: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    otherContactIds: [],
    identityId: identity.id,
    conflictType: 'channel_identity_collision',
    evidenceRoot: `channel-collision:${identity.channel}:key:${reason}`,
    source: 'channel-ingress',
    details: { ...details, channel: identity.channel, reason, externalUserId: identity.externalId },
    detectedAt: '2026-09-10T00:00:00.000Z',
    status: 'open',
    ...overrides,
  }
}

const botTransportMismatch = ingressCollision(TELEGRAM_IDENTITY, 'transport_connection_mismatch', {
  incomingProviderAccountId: 'bot-b',
  existingProviderAccountId: null,
  incomingConnectionId: 'driver-bot-primary',
  existingConnectionId: '7001',
  incomingChatKind: 'private',
  existingChatKind: 'private',
})

const whatsappSecondConnection = ingressCollision(WHATSAPP_IDENTITY, 'transport_mismatch', {
  phase: 'live',
  externalChatId: 'whatsapp:79990001122',
  incomingConnectionId: 'wa-slot-b',
  existingConnectionId: 'wa-slot-a',
})

const maxAccountMismatch = ingressCollision(MAX_IDENTITY, 'provider_account_mismatch', {
  incomingProviderAccountId: 'max-account-b',
  existingProviderAccountId: 'max-account-a',
  incomingSenderId: 'sender-42',
  existingSenderId: 'sender-42',
  incomingChatKind: 'private',
  existingChatKind: 'unknown',
})

describe('transport-only collision classification', () => {
  test('the transport vocabulary covers every historical writer and nothing about the person', () => {
    for (const reason of ['transport_connection_mismatch', 'transport_connection_unproven', 'provider_account_mismatch', 'provider_account_unproven']) {
      expect(isTransportCollisionReasonV1('telegram', reason)).toBe(true)
    }
    expect(isTransportCollisionReasonV1('whatsapp', 'transport_mismatch')).toBe(true)
    expect(isTransportCollisionReasonV1('whatsapp', 'transport_unbound')).toBe(true)
    expect(isTransportCollisionReasonV1('max', 'provider_account_mismatch')).toBe(true)
    expect(isTransportCollisionReasonV1('max', 'provider_account_unproven')).toBe(true)
    for (const reason of [
      'peer_identity_mismatch', 'peer_identity_unproven', 'sender_identity_mismatch', 'sender_identity_unproven',
      'chat_kind_mismatch', 'channel_mismatch', 'conversation_key_mismatch', 'message_chat_mismatch',
    ]) {
      expect(isTransportCollisionReasonV1('telegram', reason)).toBe(false)
      expect(isTransportCollisionReasonV1('max', reason)).toBe(false)
    }
    // A reason is only transport-class on the channel whose chain raises it.
    expect(isTransportCollisionReasonV1('whatsapp', 'provider_account_mismatch')).toBe(false)
    expect(isTransportCollisionReasonV1('max', 'transport_mismatch')).toBe(false)
  })

  test('proves Telegram Bot API, WhatsApp and MAX transport-only records from their own co-evidence', () => {
    expect(isProvenTransportOnlyIdentityConflictV1(botTransportMismatch, TELEGRAM_IDENTITY)).toBe(true)
    expect(isProvenTransportOnlyIdentityConflictV1(whatsappSecondConnection, WHATSAPP_IDENTITY)).toBe(true)
    expect(isProvenTransportOnlyIdentityConflictV1(
      ingressCollision(WHATSAPP_IDENTITY, 'transport_unbound', {
        phase: 'import', externalChatId: 'whatsapp:79990001122', incomingConnectionId: 'wa-slot-a', existingConnectionId: null,
      }),
      WHATSAPP_IDENTITY,
    )).toBe(true)
    expect(isProvenTransportOnlyIdentityConflictV1(maxAccountMismatch, MAX_IDENTITY)).toBe(true)
  })

  test('an MTProto transport record cannot be proven, because its chat kind was never recorded', () => {
    const mtprotoTransport = ingressCollision(TELEGRAM_IDENTITY, 'transport_connection_mismatch', {
      phase: 'inbound',
      incomingPeerId: '42',
      existingPeerId: '42',
      incomingProviderAccountId: '7002',
      existingProviderAccountId: null,
      incomingConnectionId: '7002',
      existingConnectionId: '7001',
    })
    expect(isProvenTransportOnlyIdentityConflictV1(mtprotoTransport, TELEGRAM_IDENTITY)).toBe(false)
  })

  test('a transport reason that hides a person or conversation-shape contradiction is not transport-only', () => {
    // MAX: the account arm pre-empted a sender contradiction.
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'max',
      reason: 'provider_account_mismatch',
      details: { ...maxAccountMismatch.details, existingSenderId: 'other-sender' },
    })).toBe(false)
    // MAX: the sender cannot be proven (for example an outbound echo on a legacy row).
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'max',
      reason: 'provider_account_unproven',
      details: { ...maxAccountMismatch.details, existingProviderAccountId: null, incomingSenderId: null },
    })).toBe(false)
    // MAX: group traffic on a person-owned conversation.
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'max',
      reason: 'provider_account_mismatch',
      details: { ...maxAccountMismatch.details, incomingChatKind: 'group' },
    })).toBe(false)
    // MAX: private traffic into a conversation stored as a concrete group room.
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'max',
      reason: 'provider_account_mismatch',
      details: { ...maxAccountMismatch.details, existingChatKind: 'group', incomingChatKind: 'private' },
    })).toBe(false)
    // MAX: a chat kind outside the recorded vocabulary cannot prove anything. The
    // incoming kind is 'unknown', so no concrete-mismatch rule could reject it:
    // only the vocabulary check does.
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'max',
      reason: 'provider_account_mismatch',
      details: { ...maxAccountMismatch.details, existingChatKind: 'channel', incomingChatKind: 'unknown' },
    })).toBe(false)
    // Control: the same record with consistent kinds is transport-only.
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'max',
      reason: 'provider_account_mismatch',
      details: { ...maxAccountMismatch.details, existingChatKind: 'private', incomingChatKind: 'private' },
    })).toBe(true)
    // Telegram Bot API: the transport arm pre-empted a chat-kind contradiction.
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'telegram',
      reason: 'transport_connection_mismatch',
      details: { ...botTransportMismatch.details, existingChatKind: 'group' },
    })).toBe(false)
  })

  test('the label alone is never enough: recorded values must actually express the reason', () => {
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'whatsapp',
      reason: 'transport_mismatch',
      details: { incomingConnectionId: 'wa-slot-a', existingConnectionId: 'wa-slot-a' },
    })).toBe(false)
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'whatsapp',
      reason: 'transport_unbound',
      details: { incomingConnectionId: 'wa-slot-a', existingConnectionId: 'wa-slot-b' },
    })).toBe(false)
    expect(isProvenTransportOnlyChannelCollisionV1({
      channel: 'telegram',
      reason: 'transport_connection_mismatch',
      details: {},
    })).toBe(false)
  })

  test('a record about another identity, channel or origin is never classified as this identity\'s transport problem', () => {
    expect(isProvenTransportOnlyIdentityConflictV1(whatsappSecondConnection, { ...WHATSAPP_IDENTITY, id: 'identity-other' })).toBe(false)
    expect(isProvenTransportOnlyIdentityConflictV1(whatsappSecondConnection, { ...WHATSAPP_IDENTITY, externalId: 'other@c.us' })).toBe(false)
    expect(isProvenTransportOnlyIdentityConflictV1(whatsappSecondConnection, { ...WHATSAPP_IDENTITY, channel: 'telegram' })).toBe(false)
    expect(isProvenTransportOnlyIdentityConflictV1(
      { ...whatsappSecondConnection, source: 'contact-resolution' },
      WHATSAPP_IDENTITY,
    )).toBe(false)
    expect(isProvenTransportOnlyIdentityConflictV1(
      { ...whatsappSecondConnection, conflictType: 'provider_identity_alias_collision' },
      WHATSAPP_IDENTITY,
    )).toBe(false)
  })
})

describe('person-blocking identity conflicts', () => {
  test('a proven transport-only collision does not block the person', () => {
    expect(hasPersonBlockingIdentityConflictV1({ identityConflicts: [whatsappSecondConnection] }, WHATSAPP_IDENTITY)).toBe(false)
  })

  test('a genuine identity conflict on the same identity still blocks, alongside a transport-only one', () => {
    const genuine = ingressCollision(WHATSAPP_IDENTITY, 'peer_identity_mismatch', {})
    expect(hasPersonBlockingIdentityConflictV1({ identityConflicts: [whatsappSecondConnection, genuine] }, WHATSAPP_IDENTITY)).toBe(true)
    for (const conflictType of ['stable_identity_phone_contradiction', 'provider_identity_alias_collision']) {
      expect(hasPersonBlockingIdentityConflictV1({
        identityConflicts: [{ identityId: WHATSAPP_IDENTITY.id, conflictType, status: 'open', source: 'contact-resolution' }],
      }, WHATSAPP_IDENTITY)).toBe(true)
    }
  })

  test('an unclassifiable historical transport entry stays fail-closed', () => {
    const historicMtproto = ingressCollision(TELEGRAM_IDENTITY, 'provider_account_unproven', {
      incomingPeerId: '42',
      existingPeerId: null,
      incomingProviderAccountId: '7002',
      existingProviderAccountId: null,
    })
    const historicWithoutDetails = { ...botTransportMismatch, details: { channel: 'telegram', reason: 'transport_connection_mismatch', externalUserId: '42' } }
    expect(hasPersonBlockingIdentityConflictV1({ identityConflicts: [historicMtproto] }, TELEGRAM_IDENTITY)).toBe(true)
    expect(hasPersonBlockingIdentityConflictV1({ identityConflicts: [historicWithoutDetails] }, TELEGRAM_IDENTITY)).toBe(true)
  })

  test('only open entries for this exact identity count', () => {
    const genuine = ingressCollision(TELEGRAM_IDENTITY, 'peer_identity_mismatch', {})
    expect(hasPersonBlockingIdentityConflictV1({ identityConflicts: [{ ...genuine, status: 'resolved' }] }, TELEGRAM_IDENTITY)).toBe(false)
    expect(hasPersonBlockingIdentityConflictV1({ identityConflicts: [genuine] }, { ...TELEGRAM_IDENTITY, id: 'identity-other' })).toBe(false)
    expect(hasPersonBlockingIdentityConflictV1({}, TELEGRAM_IDENTITY)).toBe(false)
    expect(hasPersonBlockingIdentityConflictV1(null, TELEGRAM_IDENTITY)).toBe(false)
  })
})

describe('Contact JSON evidence compatibility', () => {
  test('legacy phone rows fail closed for destructive automatic resolution', () => {
    const evidence = phoneEvidenceState(null, 'phone-1', {
      phone: '+79990000000',
      isActive: true,
      verifiedAt: null,
    })

    expect(evidence).toMatchObject({
      lifecycle: 'current',
      trust: 'unknown',
      freshness: 'unknown',
      resolutionState: 'unknown',
    })
  })

  test('round-trips per-phone provenance without replacing unrelated Contact fields', () => {
    const stored = withPhoneEvidence({ leadStage: 'active' }, 'phone-1', {
      rawPhone: '8 999 000-00-00',
      lifecycle: 'current',
      trust: 'manually_verified',
      freshness: 'fresh',
      resolutionState: 'unique',
      verifiedBy: 'operator-1',
      verificationBasis: 'passport check',
      observedAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      lifecycleUpdatedAt: '2026-09-01T00:00:00.000Z',
      evidenceRoot: 'manual:operator-1',
      auditTrail: [{ action: 'add_or_verify' }],
    })

    expect(stored.leadStage).toBe('active')
    expect(phoneEvidenceState(stored, 'phone-1', {
      phone: '+79990000000', isActive: true, verifiedAt: null,
    })).toMatchObject({
      rawPhone: '8 999 000-00-00',
      trust: 'manually_verified',
      verifiedBy: 'operator-1',
    })
  })

  test('reads provider account provenance as telemetry, defaulting an absent stamp', () => {
    expect(identityEvidenceState({ providerAccountId: 'account-a', origin: 'provider' }))
      .toMatchObject({ providerAccountId: 'account-a', origin: 'provider' })
    // An absent stamp reads back as the legacy sentinel. It is descriptive
    // metadata only: no runtime authorization compares these values, because
    // provider-account isolation is deferred until a provider-authoritative
    // account identity exists. See docs/design/provider-account-identity-v1.md.
    expect(identityEvidenceState({}).providerAccountId).toBe('legacy')
    expect(identityEvidenceState({ providerAccountId: '  ' }).providerAccountId).toBe('legacy')
  })

  test('reads merge redirect, recovery, canonical pin and do-not-merge from existing JSON', () => {
    expect(contactAutomationState({
      canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
      canonicalPinnedBy: 'operator-1',
      doNotMerge: true,
      mergedIntoContactId: 'survivor',
      mergeRecoveryState: 'recoverable',
    })).toEqual({
      canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
      canonicalPinnedBy: 'operator-1',
      doNotMerge: true,
      mergedIntoContactId: 'survivor',
      mergeRecoveryState: 'recoverable',
    })
  })
})
