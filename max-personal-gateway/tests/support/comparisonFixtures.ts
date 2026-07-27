import { createHash } from 'node:crypto'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../../src/inbound/constants.ts'
import type { NormalizeRawObservationInput } from '../../src/inbound/types.ts'
import type { JsonValue } from '../../src/journal/types.ts'
import type { ComparisonClassification } from '../../src/comparison/types.ts'

export interface SafeComparisonFixture {
  readonly fixtureId: string
  readonly payload: JsonValue
  readonly expectedClassification: ComparisonClassification
  readonly historyLive?: 'history' | 'live' | 'unknown'
  readonly replayAvailability?: 'available' | 'quarantined'
}

const attachment = (mediaKind: string, mimeHint: string, id: string): JsonValue => ({
  mediaKind,
  mimeHint,
  providerAttachmentId: id,
})

export const SAFE_COMPARISON_FIXTURES: readonly SafeComparisonFixture[] = [
  { fixtureId: 'inbound-text', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-in-1', senderProviderUserId: 'user-a', protocolChatId: 'chat-a', text: 'synthetic inbound' }, expectedClassification: 'matched' },
  { fixtureId: 'outbound-echo', payload: { kind: 'message', direction: 'outbound_echo', providerMessageId: 'msg-out-1', protocolChatId: 'chat-a', text: 'synthetic outbound' }, expectedClassification: 'matched' },
  { fixtureId: 'identical-a', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-identical-a', text: 'same synthetic text' }, expectedClassification: 'matched' },
  { fixtureId: 'identical-b', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-identical-b', text: 'same synthetic text' }, expectedClassification: 'matched' },
  { fixtureId: 'rapid-series', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-burst-1', providerOccurredAt: '2026-07-27T00:00:00.001Z', text: 'burst' }, expectedClassification: 'matched' },
  { fixtureId: 'history-copy', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-overlap', text: 'overlap' }, historyLive: 'history', expectedClassification: 'matched' },
  { fixtureId: 'live-copy', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-overlap', text: 'overlap' }, historyLive: 'live', expectedClassification: 'matched' },
  { fixtureId: 'jpeg', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-jpeg', attachments: [attachment('image', 'image/jpeg', 'att-jpeg')] }, expectedClassification: 'matched' },
  { fixtureId: 'jpeg-caption', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-caption', caption: 'synthetic caption', attachments: [attachment('image', 'image/jpeg', 'att-caption')] }, expectedClassification: 'matched' },
  { fixtureId: 'pdf', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-pdf', attachments: [attachment('document', 'application/pdf', 'att-pdf')] }, expectedClassification: 'matched' },
  { fixtureId: 'mp4', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-mp4', attachments: [attachment('video', 'video/mp4', 'att-mp4')] }, expectedClassification: 'matched' },
  { fixtureId: 'ogg-voice', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-ogg', attachments: [{ mediaKind: 'voice', mimeHint: 'audio/ogg', providerAttachmentId: 'att-ogg', voice: true }] }, expectedClassification: 'matched' },
  { fixtureId: 'multiple-attachments', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-multi', attachments: [attachment('image', 'image/jpeg', 'att-1'), attachment('document', 'application/pdf', 'att-2')] }, expectedClassification: 'matched' },
  { fixtureId: 'reply-exact', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-reply', text: 'reply', reply: { targetProviderMessageId: 'msg-target' } }, expectedClassification: 'matched' },
  { fixtureId: 'reply-unresolved', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-reply-unresolved', text: 'reply', reply: { targetText: 'synthetic approximation only' } }, expectedClassification: 'expected_difference' },
  { fixtureId: 'reaction-add', payload: { kind: 'reaction', operation: 'add', targetProviderMessageId: 'msg-target', actorProviderUserId: 'actor-a', reactionValue: 'like' }, expectedClassification: 'matched' },
  { fixtureId: 'reaction-remove', payload: { kind: 'reaction', operation: 'remove', targetProviderMessageId: 'msg-target', actorProviderUserId: 'actor-a', reactionValue: 'like' }, expectedClassification: 'matched' },
  { fixtureId: 'provider-acceptance', payload: { kind: 'receipt', receiptType: 'ack', proof: 'provider_acceptance', targetProviderMessageId: 'msg-target' }, expectedClassification: 'matched' },
  { fixtureId: 'unknown-ack', payload: { kind: 'receipt', receiptType: 'ack', targetProviderMessageId: 'msg-target' }, expectedClassification: 'expected_difference' },
  { fixtureId: 'delivery-receipt', payload: { kind: 'receipt', receiptType: 'recipient_delivery', proof: 'recipient_delivery', targetProviderMessageId: 'msg-target' }, expectedClassification: 'matched' },
  { fixtureId: 'read-receipt', payload: { kind: 'receipt', receiptType: 'recipient_read', proof: 'recipient_read', targetProviderMessageId: 'msg-target' }, expectedClassification: 'matched' },
  { fixtureId: 'route-evidence', payload: { kind: 'route_evidence', evidence: [{ identityKind: 'protocol_chat_id', identityValue: 'chat-route' }, { identityKind: 'provider_user_id', identityValue: 'user-route' }] }, expectedClassification: 'matched' },
  { fixtureId: 'missing-provider-id', payload: { kind: 'message', direction: 'inbound', legacyProviderMessageId: 'legacy-fallback-id', text: 'missing id' }, expectedClassification: 'expected_difference' },
  { fixtureId: 'malformed-event', payload: { kind: 'message', attachments: { malformed: true } }, expectedClassification: 'quarantined' },
  { fixtureId: 'unsupported-event', payload: { kind: 'future_provider_shape', opaqueShapeCode: 'synthetic' }, expectedClassification: 'unsupported' },
  { fixtureId: 'invalid-utf8-quarantine', payload: { kind: 'future_provider_shape', encodingIssue: 'invalid_utf8_boundary' }, replayAvailability: 'quarantined', expectedClassification: 'quarantined' },
  { fixtureId: 'loose-media', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-loose', attachments: [{ mimeHint: 'image/jpeg', providerAttachmentId: 'att-loose' }] }, expectedClassification: 'matched' },
  { fixtureId: 'duplicate-provider-frame', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-frame', text: 'frame copy' }, expectedClassification: 'matched' },
  { fixtureId: 'signed-reference-redaction', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-signed', attachments: [{ mediaKind: 'image', mimeHint: 'image/jpeg', providerAttachmentId: 'att-signed', signedUrl: 'redacted-fixture-reference' }] }, expectedClassification: 'expected_difference' },
  { fixtureId: 'media-metadata-only', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-metadata', attachments: [{ mediaKind: 'image', mimeHint: 'image/jpeg', providerAttachmentId: 'att-meta', fetchReferenceAvailable: true }] }, expectedClassification: 'expected_difference' },
  { fixtureId: 'name-phone-route-authority', payload: { kind: 'message', direction: 'inbound', providerMessageId: 'msg-route-safe', text: 'route', senderName: 'Synthetic Person', senderPhone: 'synthetic-phone' }, expectedClassification: 'expected_difference' },
]

export function comparisonInput(
  fixture: SafeComparisonFixture,
  accountId = 'account-synthetic-a',
  sequence = 1n,
  observationId = `observation-${fixture.fixtureId}`,
): NormalizeRawObservationInput {
  const payloadJson = JSON.stringify(fixture.payload)
  return {
    accountId,
    observationId,
    journalSequence: sequence,
    observedAt: new Date('2026-07-27T00:00:00.000Z'),
    sourceTransport: 'max_synthetic_fixture',
    sourceOrigin: 'stage7-safe-fixture',
    historyLive: fixture.historyLive ?? 'live',
    payloadEncoding: 'json',
    sanitizedPayload: fixture.payload,
    payloadSha256: createHash('sha256').update(payloadJson).digest('hex'),
    captureAdapterVersion: 'stage7-safe-fixture-v1',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    replayAvailability: fixture.replayAvailability ?? 'available',
  }
}

export function fixtureById(fixtureId: string): SafeComparisonFixture {
  const fixture = SAFE_COMPARISON_FIXTURES.find(candidate => candidate.fixtureId === fixtureId)
  if (fixture === undefined) throw new Error(`Unknown safe fixture: ${fixtureId}`)
  return fixture
}
