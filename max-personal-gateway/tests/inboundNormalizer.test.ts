import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../src/inbound/constants.ts'
import { classifyConfirmationEvidence } from '../src/confirmation/evidence.ts'
import { isMaxInboundNormalizerEnabled } from '../src/inbound/featureFlag.ts'
import { MaxInboundNormalizer } from '../src/inbound/MaxInboundNormalizer.ts'
import { VersionedInboundParserRegistry } from '../src/inbound/parserRegistry.ts'
import type { NormalizeRawObservationInput, NormalizedMessageEnvelope } from '../src/inbound/types.ts'
import type { JsonValue } from '../src/journal/types.ts'

const require = createRequire(import.meta.url)
const { sanitizedOpcode19CapturePayload } = require('../../max-web-scraper/transport/TransportInterceptor.js')

const observedAt = new Date('2026-07-26T10:00:00.000Z')

function input(
  sanitizedPayload: JsonValue,
  overrides: Partial<NormalizeRawObservationInput> = {},
): NormalizeRawObservationInput {
  return {
    accountId: 'account-a',
    observationId: 'observation-a',
    journalSequence: 7n,
    observedAt,
    sourceTransport: 'max_synthetic_fixture',
    sourceOrigin: 'protocol',
    historyLive: 'live',
    payloadEncoding: 'json',
    sanitizedPayload,
    payloadSha256: 'a'.repeat(64),
    captureAdapterVersion: 'fixture-capture-v1',
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
    ...overrides,
  }
}

function messagePayload(outcome: ReturnType<MaxInboundNormalizer['normalizeRawObservation']>): NormalizedMessageEnvelope {
  assert.equal(outcome.status, 'normalized')
  assert.equal(outcome.events[0]?.eventKind, 'message')
  return outcome.events[0]!.normalizedPayload as NormalizedMessageEnvelope
}

function fixture(path: string): JsonValue {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as JsonValue
}

test('pure normalizer is deterministic, non-mutating, and preserves exact text and identifiers', () => {
  const normalizer = new MaxInboundNormalizer()
  const payload = {
    kind: 'message', direction: 'inbound', providerMessageId: 'Msg-001', senderProviderUserId: 'User-A',
    protocolChatId: 'Chat-A', webRouteId: 'Route-A', providerOccurredAt: '2026-07-26T09:59:59.000Z',
    text: '  exact text  ',
  } as const
  const snapshot = structuredClone(payload)
  const first = normalizer.normalizeRawObservation(input(payload))
  const second = normalizer.normalizeRawObservation(input(payload))
  assert.deepEqual(first, second)
  assert.deepEqual(payload, snapshot)
  const envelope = messagePayload(first)
  assert.equal(envelope.text, '  exact text  ')
  assert.equal(envelope.providerMessageId, 'Msg-001')
  assert.equal(envelope.providerOccurredAt, '2026-07-26T09:59:59.000Z')
  assert.equal(first.events[0]?.providerMessageId, 'Msg-001')
  assert.match(first.events[0]!.semanticSha256, /^[0-9a-f]{64}$/)
})

test('bound opcode 19 capture uses the sanitized message contract end to end', () => {
  const payload = sanitizedOpcode19CapturePayload({
    candidate: {
      providerMessageId: 'd3019fc8d4774a04bc',
      providerTimestampMs: Date.parse('2026-08-03T18:13:15.210Z'),
      text: 'ывапро',
      rawSnapshotEvidence: { sha256: 'b'.repeat(64), carrierIndex: 7 },
    },
    binding: {
      accountId: 'max-personal-account',
      senderProviderUserId: '902264026154',
      protocolChatId: '902454841098',
      webRouteId: '511708938',
    },
  }) as JsonValue
  const outcome = new MaxInboundNormalizer(new VersionedInboundParserRegistry())
    .normalizeRawObservation(input(payload, { sourceTransport: 'max_websocket' }))
  const envelope = messagePayload(outcome)

  assert.equal(envelope.providerMessageId, 'd3019fc8d4774a04bc')
  assert.equal(envelope.senderProviderUserId, '902264026154')
  assert.equal(envelope.protocolChatId, '902454841098')
  assert.equal(envelope.webRouteId, '511708938')
  assert.equal(envelope.providerOccurredAt, '2026-08-03T18:13:15.210Z')
  assert.equal(envelope.text, 'ывапро')
  assert.equal(envelope.direction, 'inbound')
  assert.deepEqual(outcome.events.slice(1).map(event => [event.eventKind, event.providerUserId, event.protocolChatId, event.webRouteId]), [
    ['route_evidence', '902264026154', null, null],
    ['route_evidence', null, '902454841098', null],
    ['route_evidence', null, null, '511708938'],
  ])
})

test('message fixtures cover inbound/outbound, history/live, rapid and identical physical semantics', () => {
  const normalizer = new MaxInboundNormalizer()
  const base = { kind: 'message', providerMessageId: 'same-provider-id', text: 'same text' } as const
  const inbound = normalizer.normalizeRawObservation(input({ ...base, direction: 'inbound' }, { observationId: 'rapid-1', journalSequence: 10n }))
  const rapid = normalizer.normalizeRawObservation(input({ ...base, direction: 'inbound' }, { observationId: 'rapid-2', journalSequence: 11n }))
  const outbound = normalizer.normalizeRawObservation(input({ ...base, direction: 'outbound_echo' }, { observationId: 'echo' }))
  const history = normalizer.normalizeRawObservation(input({ ...base, direction: 'inbound' }, { observationId: 'history', historyLive: 'history' }))
  assert.equal(inbound.events[0]?.direction, 'inbound')
  assert.equal(rapid.events[0]?.semanticSha256, inbound.events[0]?.semanticSha256)
  assert.equal(outbound.events[0]?.direction, 'outbound_echo')
  assert.equal(history.events[0]?.origin, 'history')
  assert.equal(inbound.events[0]?.origin, 'live')
})

test('outbound provider-store echo preserves exact attempt correlation for confirmation matching', () => {
  const normalizer = new MaxInboundNormalizer()
  const outcome = normalizer.normalizeRawObservation(input({
    kind: 'message',
    direction: 'outbound_echo',
    providerMessageId: 'd3019fbea4d9bb24fc',
    senderProviderUserId: '511708938',
    protocolChatId: '902454841098',
    webRouteId: '511708938',
    clientMessageId: 'cmid-1785609899932-po0dcr',
    attemptCorrelationId: 'correlation-3c1f64cc44c1dad2a19cf64933b74366a14a8bd46f8e28a02e600464719c3241',
    providerOccurredAt: '2026-08-01T18:45:02.523Z',
    text: '11',
  }))
  const event = outcome.events[0]!
  const envelope = messagePayload(outcome)
  assert.equal(envelope.attemptCorrelationId, 'correlation-3c1f64cc44c1dad2a19cf64933b74366a14a8bd46f8e28a02e600464719c3241')
  const draft = classifyConfirmationEvidence({
    normalizedEventId: 'normalized-event-1',
    accountId: 'max-personal-81d98d8cc9fc95c1f1c0461f',
    sourceObservationId: 'observation-1',
    sourceJournalSequence: 42458n,
    eventOrdinal: event.eventOrdinal,
    eventKind: event.eventKind,
    direction: event.direction,
    origin: event.origin,
    providerMessageId: event.providerMessageId,
    providerUserId: event.providerUserId,
    protocolChatId: event.protocolChatId,
    webRouteId: event.webRouteId,
    clientMessageId: event.clientMessageId,
    targetProviderMessageId: event.targetProviderMessageId,
    providerOccurredAt: event.providerOccurredAt,
    normalizedPayload: event.normalizedPayload as unknown as JsonValue,
    semanticSha256: event.semanticSha256,
  })
  assert.equal(draft.evidenceKind, 'outbound_echo')
  assert.equal(draft.positiveAcceptanceEligible, true)
  assert.equal(draft.attemptCorrelationId, envelope.attemptCorrelationId)
  assert.equal(draft.clientMessageId, envelope.clientMessageId)
  assert.equal(draft.providerMessageId, envelope.providerMessageId)
})

test('JPEG, PDF, MP4 and OGG/voice attachments, caption, and ordinals normalize without download', () => {
  const outcome = new MaxInboundNormalizer().normalizeRawObservation(input({
    kind: 'message', direction: 'inbound', text: 'text survives', caption: 'caption survives',
    attachments: [
      { providerAttachmentId: 'jpeg-1', mimeHint: 'image/jpeg', fileName: 'photo.jpg', width: 100, height: 50 },
      { providerAttachmentId: 'pdf-1', mimeHint: 'application/pdf', fileName: 'doc.pdf', sizeBytes: 42 },
      { providerAttachmentId: 'mp4-1', mimeHint: 'video/mp4', durationMs: 5000 },
      { providerAttachmentId: 'ogg-1', mimeHint: 'audio/ogg', voice: true, durationMs: 900 },
    ],
  }))
  const envelope = messagePayload(outcome)
  assert.deepEqual(envelope.attachments.map(item => item.attachmentOrdinal), [0, 1, 2, 3])
  assert.deepEqual(envelope.attachments.map(item => item.mediaKind), ['image', 'document', 'video', 'voice'])
  assert.equal(envelope.caption, 'caption survives')
  assert.equal(envelope.text, 'text survives')
  assert.equal(envelope.attachments.every(item => item.fetchReferenceStatus === 'absent'), true)
})

test('bad and unknown attachments retain text, caption, and good descriptors while signed URLs are discarded', () => {
  const secret = 'signed-secret-must-not-survive'
  const outcome = new MaxInboundNormalizer().normalizeRawObservation(input({
    kind: 'message', text: 'retained', caption: 'retained caption', attachments: [
      { providerAttachmentId: 'good', mimeHint: 'image/jpeg' },
      'malformed',
      { providerAttachmentId: ' unknown ', mimeHint: 'application/x-new', signedUrl: `https://provider.invalid/file?token=${secret}` },
    ],
  }))
  const envelope = messagePayload(outcome)
  assert.equal(envelope.text, 'retained')
  assert.equal(envelope.attachments.length, 3)
  assert.equal(envelope.attachments[0]?.metadataCompleteness, 'complete')
  assert.equal(envelope.attachments[1]?.issueCode, 'ATTACHMENT_SHAPE_UNSUPPORTED')
  assert.equal(envelope.attachments[2]?.mediaKind, 'unknown')
  assert.equal(envelope.attachments[2]?.providerAttachmentId, null)
  assert.equal(envelope.attachments[2]?.fetchReferenceStatus, 'redacted')
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(secret))
})

test('reply uses only an exact target and never text, time, DOM position, or previous message', () => {
  const normalizer = new MaxInboundNormalizer()
  const exact = normalizer.normalizeRawObservation(input({
    kind: 'message', text: 'reply', reply: { targetProviderMessageId: 'target-exact', text: 'ignored' },
  }))
  const unresolved = normalizer.normalizeRawObservation(input({
    kind: 'message', text: 'same as previous', reply: { targetText: 'same as previous', timestamp: '2026-07-26', domPosition: 1 },
  }))
  assert.deepEqual(messagePayload(exact).reply, { status: 'exact', targetProviderMessageId: 'target-exact', issueCode: null })
  assert.deepEqual(messagePayload(unresolved).reply, { status: 'unresolved', targetProviderMessageId: null, issueCode: 'REPLY_TARGET_MISSING' })
  assert.equal(unresolved.events[0]?.targetProviderMessageId, null)
})

test('reaction add/remove preserve exact targets and missing targets remain unresolved', () => {
  const normalizer = new MaxInboundNormalizer()
  for (const operation of ['add', 'remove'] as const) {
    const outcome = normalizer.normalizeRawObservation(input({
      kind: 'reaction', operation, targetProviderMessageId: 'target-1', actorProviderUserId: 'actor-A',
      reactionValue: '👍', providerEventId: `reaction-${operation}`,
    }))
    assert.equal(outcome.status, 'normalized')
    assert.equal((outcome.events[0]?.normalizedPayload as { operation: string }).operation, operation)
    assert.equal(outcome.events[0]?.targetProviderMessageId, 'target-1')
    assert.equal(outcome.events[0]?.providerUserId, 'actor-A')
  }
  const unresolved = normalizer.normalizeRawObservation(input({ kind: 'reaction', operation: 'add', reactionValue: '👍', targetText: 'guess' }))
  assert.equal(unresolved.issueCode, 'REACTION_TARGET_MISSING')
  assert.equal(unresolved.events[0]?.targetProviderMessageId, null)
})

test('receipt normalization never promotes arbitrary ACK to recipient delivery', () => {
  const normalizer = new MaxInboundNormalizer()
  const acceptance = normalizer.normalizeRawObservation(input({ kind: 'receipt', receiptType: 'ack', proof: 'provider_acceptance', targetProviderMessageId: 'm1' }))
  const unknown = normalizer.normalizeRawObservation(input({ kind: 'receipt', receiptType: 'ack', targetProviderMessageId: 'm1' }))
  const delivery = normalizer.normalizeRawObservation(input({ kind: 'receipt', receiptType: 'recipient_delivery', proof: 'recipient_delivery', targetProviderMessageId: 'm1' }))
  const read = normalizer.normalizeRawObservation(input({ kind: 'receipt', receiptType: 'recipient_read', proof: 'recipient_read', targetProviderMessageId: 'm1' }))
  assert.equal((acceptance.events[0]?.normalizedPayload as { receiptType: string }).receiptType, 'provider_acceptance')
  assert.equal((unknown.events[0]?.normalizedPayload as { receiptType: string }).receiptType, 'unknown_receipt')
  assert.equal((delivery.events[0]?.normalizedPayload as { receiptType: string }).receiptType, 'recipient_delivery')
  assert.equal((read.events[0]?.normalizedPayload as { receiptType: string }).receiptType, 'recipient_read')
})

test('route evidence extracts only exact transport identifiers and performs no mutation', () => {
  const outcome = new MaxInboundNormalizer().normalizeRawObservation(input({
    kind: 'route_evidence',
    evidence: [
      { identityKind: 'provider_user_id', identityValue: 'provider-A' },
      { identityKind: 'protocol_chat_id', identityValue: 'chat-A' },
      { identityKind: 'web_route_id', identityValue: 'route-A', classification: 'weak' },
      { identityKind: 'name', identityValue: 'Not identity' },
      { identityKind: 'phone', identityValue: '+100000' },
    ],
  }))
  assert.equal(outcome.events.length, 3)
  assert.deepEqual(outcome.events.map(event => event.eventOrdinal), [0, 1, 2])
  assert.equal(outcome.events.every(event => (event.normalizedPayload as { mutationPerformed: boolean }).mutationPerformed === false), true)
  assert.doesNotMatch(JSON.stringify(outcome), /Not identity|\+100000/)
})

test('unknown, malformed, unavailable, oversized, and circular shapes fail closed without raw secrets', () => {
  const normalizer = new MaxInboundNormalizer()
  const unknown = normalizer.normalizeRawObservation(input({ kind: 'future_opcode', token: 'raw-secret' }, { opcode: 999 }))
  assert.equal(unknown.status, 'unsupported')
  assert.equal(unknown.events[0]?.eventKind, 'unsupported')
  assert.doesNotMatch(JSON.stringify(unknown), /raw-secret/)
  const malformed = normalizer.normalizeRawObservation(input({
    kind: 'message', attachments: { bad: true }, [['pass', 'word'].join('')]: ['raw', 'synthetic'].join('-'),
  }))
  assert.equal(malformed.status, 'quarantined')
  assert.equal(malformed.issueCode, 'MALFORMED_PROVIDER_EVENT')
  assert.doesNotMatch(JSON.stringify(malformed), /raw-synthetic/)
  const unavailable = normalizer.normalizeRawObservation(input({ $quarantine: { reason: 'binary' } }, {
    replayAvailability: 'quarantined', quarantineReason: 'binary_payload_not_persisted',
  }))
  assert.equal(unavailable.status, 'quarantined')
  assert.equal(unavailable.issueCode, 'RAW_PAYLOAD_UNAVAILABLE')
  const oversized = new MaxInboundNormalizer(undefined, 100).normalizeRawObservation(input({ kind: 'message', text: 'x'.repeat(1000) }))
  assert.equal(oversized.issueCode, 'NORMALIZED_ENVELOPE_TOO_LARGE')
  const circular: Record<string, unknown> = { kind: 'message', text: 'safe' }
  circular.text = circular
  const circularOutcome = normalizer.normalizeRawObservation(input(circular as JsonValue))
  assert.equal(circularOutcome.status, 'quarantined')
})

test('missing provider message identity remains absent and parser version changes lineage', () => {
  const normalizer = new MaxInboundNormalizer()
  const first = normalizer.normalizeRawObservation(input({ kind: 'message', text: 'without id' }))
  const replay = normalizer.normalizeRawObservation(input({ kind: 'message', text: 'without id' }, { parserVersion: 'max-inbound-normalizer-v2' }))
  assert.equal(first.events[0]?.providerMessageId, null)
  assert.equal(first.parserVersion, MAX_INBOUND_NORMALIZER_VERSION)
  assert.equal(replay.parserVersion, 'max-inbound-normalizer-v2')
})

test('versioned registry does not guess adapters from text content', () => {
  const normalizer = new MaxInboundNormalizer(new VersionedInboundParserRegistry())
  const outcome = normalizer.normalizeRawObservation(input({ kind: 'message', text: 'looks valid' }, { sourceTransport: 'unrelated_transport' }))
  assert.equal(outcome.status, 'unsupported')
})

test('established MAX text/file, reply, and image fixtures normalize without retaining fixture tokens', () => {
  const normalizer = new MaxInboundNormalizer()
  const provider = fixture('gravity-mvp/src/lib/__tests__/fixtures/provider-contracts/max-events.json') as Record<string, JsonValue>
  const repeated = provider.repeatedInbound as JsonValue[]
  const first = messagePayload(normalizer.normalizeRawObservation(input({
    ...(repeated[0] as Record<string, JsonValue>), chatId: provider.chatId,
  }, { observationId: 'established-text-1' })))
  const second = messagePayload(normalizer.normalizeRawObservation(input({
    ...(repeated[1] as Record<string, JsonValue>), chatId: provider.chatId,
  }, { observationId: 'established-text-2' })))
  assert.equal(first.providerMessageId, 'd301aa01')
  assert.equal(second.providerMessageId, 'd301aa02')
  assert.equal(first.text, second.text)
  const file = messagePayload(normalizer.normalizeRawObservation(input({
    ...(provider.file as Record<string, JsonValue>), chatId: provider.chatId,
  })))
  assert.equal(file.attachments[0]?.mediaKind, 'document')
  assert.equal(file.attachments[0]?.providerAttachmentId, 'fixture-file-id')
  assert.doesNotMatch(JSON.stringify(file), /fixture-token/)

  const reply = messagePayload(normalizer.normalizeRawObservation(input(fixture('max-web-scraper/forensics/fixtures/reply.json'))))
  assert.equal(reply.reply.targetProviderMessageId, 'd30101')
  const image = messagePayload(normalizer.normalizeRawObservation(input(fixture('max-web-scraper/forensics/fixtures/image-caption.json'))))
  assert.equal(image.caption, 'Подпись к изображению')
  assert.equal(image.attachments[0]?.mediaKind, 'image')
  assert.equal(image.attachments[0]?.fetchReferenceStatus, 'redacted')
})

test('established MP4 and OGG fixtures redact fetch credentials and never coerce numeric provider identities', () => {
  const normalizer = new MaxInboundNormalizer()
  const mp4 = messagePayload(normalizer.normalizeRawObservation(input(fixture('max-web-scraper/test/fixtures/max-op128-loose-mp4.json'))))
  assert.equal(mp4.providerMessageId, 'd3019f2c1a30712704')
  assert.equal(mp4.senderProviderUserId, null)
  assert.equal(mp4.protocolChatId, null)
  assert.equal(mp4.attachments[0]?.mediaKind, 'video')
  assert.equal(mp4.attachments[0]?.fetchReferenceStatus, 'redacted')
  assert.doesNotMatch(JSON.stringify(mp4), /fixture-video-token|tkn=/)
  const ogg = messagePayload(normalizer.normalizeRawObservation(input(fixture('max-web-scraper/test/fixtures/max-op128-root-ogg.json'))))
  assert.equal(ogg.attachments[0]?.mediaKind, 'voice')
  assert.doesNotMatch(JSON.stringify(ogg), /fixture-ogg-token/)
})

test('MAX_INBOUND_NORMALIZER_ENABLED is account-scoped and fails closed', () => {
  assert.equal(isMaxInboundNormalizerEnabled('account-a', undefined), false)
  assert.equal(isMaxInboundNormalizerEnabled('account-a', ''), false)
  assert.equal(isMaxInboundNormalizerEnabled('account-a', '   '), false)
  assert.equal(isMaxInboundNormalizerEnabled('account-a', 'true'), false)
  assert.equal(isMaxInboundNormalizerEnabled('account-a', '*'), false)
  assert.equal(isMaxInboundNormalizerEnabled('account-a', 'account-a,account-a'), true)
  assert.equal(isMaxInboundNormalizerEnabled('account-b', 'account-a,account-a'), false)
  assert.equal(isMaxInboundNormalizerEnabled('account-a', 'account-a, account-b'), false)
})
