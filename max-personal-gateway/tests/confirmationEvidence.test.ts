import assert from 'node:assert/strict'
import test from 'node:test'
import { DenyAllProviderAbsenceEvidenceVerifier } from '../src/confirmation/absence.ts'
import {
  MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION,
  MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED,
  MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION,
} from '../src/confirmation/constants.ts'
import { classifyConfirmationEvidence, type NormalizedConfirmationSource } from '../src/confirmation/evidence.ts'
import { isProviderConfirmationMatcherEnabled } from '../src/confirmation/featureFlag.ts'
import { RECEIPT_SEMANTICS } from '../src/confirmation/receiptSemantics.ts'

function source(overrides: Partial<NormalizedConfirmationSource> = {}): NormalizedConfirmationSource {
  return {
    normalizedEventId: 'normalized-event-1',
    accountId: 'account-A',
    sourceObservationId: 'observation-1',
    sourceJournalSequence: 1n,
    eventOrdinal: 0,
    eventKind: 'message',
    direction: 'outbound_echo',
    origin: 'live',
    providerMessageId: 'provider-message-1',
    providerUserId: 'provider-user-A',
    protocolChatId: 'protocol-chat-A',
    webRouteId: 'web-route-A',
    clientMessageId: null,
    targetProviderMessageId: null,
    providerOccurredAt: new Date('2026-07-27T00:00:00Z'),
    normalizedPayload: { attemptCorrelationId: 'attempt-correlation-1', text: 'never copied' },
    semanticSha256: 'a'.repeat(64),
    ...overrides,
  }
}

test('Stage 6 version constants are explicit and stable', () => {
  assert.equal(MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION, 'max-provider-confirmation-matcher-v1')
  assert.equal(MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION, 'max-provider-confirmation-evidence-v1')
  assert.equal(MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED, 'MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED')
})
test('feature flag defaults false and only exact account token enables', () => {
  assert.equal(isProviderConfirmationMatcherEnabled('account-A', undefined), false)
  assert.equal(isProviderConfirmationMatcherEnabled('account-A', ''), false)
  assert.equal(isProviderConfirmationMatcherEnabled('account-A', 'account-A'), true)
  assert.equal(isProviderConfirmationMatcherEnabled('account-A', 'account-B,account-A'), true)
})

test('feature flag rejects whitespace, booleans, wildcard and malformed list', () => {
  for (const raw of [' account-A', 'account-A ', 'true', '*', 'account-A,', ',account-A', 'account-A, account-B']) {
    assert.equal(isProviderConfirmationMatcherEnabled('account-A', raw), false)
  }
})

test('feature flag remains account isolated', () => {
  assert.equal(isProviderConfirmationMatcherEnabled('account-B', 'account-A'), false)
})

test('outbound echo with exact attempt correlation is eligible', () => {
  const draft = classifyConfirmationEvidence(source())
  assert.equal(draft.evidenceKind, 'outbound_echo')
  assert.equal(draft.attemptCorrelationId, 'attempt-correlation-1')
  assert.equal(draft.positiveAcceptanceEligible, true)
})

test('outbound echo with exact clientMessageId is eligible', () => {
  const draft = classifyConfirmationEvidence(source({ clientMessageId: 'client-message-1', normalizedPayload: {} }))
  assert.equal(draft.clientMessageId, 'client-message-1')
  assert.equal(draft.positiveAcceptanceEligible, true)
})

test('missing providerMessageId never confirms', () => {
  const draft = classifyConfirmationEvidence(source({ providerMessageId: null }))
  assert.equal(draft.issueCode, 'MISSING_PROVIDER_MESSAGE_ID')
  assert.equal(draft.positiveAcceptanceEligible, false)
})

test('missing exact correlation never confirms', () => {
  const draft = classifyConfirmationEvidence(source({ normalizedPayload: {}, clientMessageId: null }))
  assert.equal(draft.issueCode, 'MISSING_EXACT_CORRELATION')
  assert.equal(draft.positiveAcceptanceEligible, false)
})

test('numeric correlation is not coerced', () => {
  const draft = classifyConfirmationEvidence(source({ normalizedPayload: { attemptCorrelationId: 42 } }))
  assert.equal(draft.attemptCorrelationId, null)
  assert.equal(draft.positiveAcceptanceEligible, false)
})

test('correlation is not trimmed', () => {
  const draft = classifyConfirmationEvidence(source({ normalizedPayload: { attemptCorrelationId: ' attempt-correlation-1' } }))
  assert.equal(draft.attemptCorrelationId, null)
})

test('correlation retains case and full opaque value', () => {
  const draft = classifyConfirmationEvidence(source({ normalizedPayload: { attemptCorrelationId: 'Case:Exact:ABC' } }))
  assert.equal(draft.attemptCorrelationId, 'Case:Exact:ABC')
})

test('inbound text is ignored even when text and provider ID resemble outbound', () => {
  const draft = classifyConfirmationEvidence(source({ direction: 'inbound' }))
  assert.equal(draft.ignored, true)
  assert.equal(draft.issueCode, 'INBOUND_MESSAGE_NOT_CONFIRMATION')
})

test('reaction is ignored', () => {
  const draft = classifyConfirmationEvidence(source({ eventKind: 'reaction', direction: 'system' }))
  assert.equal(draft.ignored, true)
  assert.equal(draft.issueCode, 'REACTION_NOT_CONFIRMATION')
})

test('route evidence is ignored', () => {
  const draft = classifyConfirmationEvidence(source({ eventKind: 'route_evidence', direction: 'system' }))
  assert.equal(draft.ignored, true)
})

test('provider acceptance receipt requires exact provider ID and correlation', () => {
  const draft = classifyConfirmationEvidence(source({
    eventKind: 'receipt', direction: 'system', providerMessageId: null,
    targetProviderMessageId: 'provider-message-1',
    normalizedPayload: { receiptType: 'provider_acceptance', attemptCorrelationId: 'attempt-correlation-1' },
  }))
  assert.equal(draft.evidenceKind, 'provider_acceptance_receipt')
  assert.equal(draft.positiveAcceptanceEligible, true)
})

test('delivery receipt persists but does not imply provider acceptance', () => {
  const draft = classifyConfirmationEvidence(source({
    eventKind: 'receipt', direction: 'system', targetProviderMessageId: 'provider-message-1',
    normalizedPayload: { receiptType: 'recipient_delivery' },
  }))
  assert.equal(draft.evidenceKind, 'recipient_delivery_receipt')
  assert.equal(draft.positiveAcceptanceEligible, false)
  assert.equal(RECEIPT_SEMANTICS.recipient_delivery.changesDispatchState, false)
})

test('read receipt persists but does not add read state', () => {
  const draft = classifyConfirmationEvidence(source({
    eventKind: 'receipt', direction: 'system', targetProviderMessageId: 'provider-message-1',
    normalizedPayload: { receiptType: 'recipient_read' },
  }))
  assert.equal(draft.evidenceKind, 'recipient_read_receipt')
  assert.equal(RECEIPT_SEMANTICS.recipient_read.recipientStateProjected, false)
})

test('unknown receipt has no positive effect', () => {
  const draft = classifyConfirmationEvidence(source({
    eventKind: 'receipt', direction: 'system', normalizedPayload: { receiptType: 'future_receipt' },
  }))
  assert.equal(draft.evidenceKind, 'unknown_receipt')
  assert.equal(draft.issueCode, 'UNKNOWN_RECEIPT')
})

test('safe evidence metadata excludes message text and captions', () => {
  const draft = classifyConfirmationEvidence(source({ normalizedPayload: {
    attemptCorrelationId: 'attempt-correlation-1', text: 'sensitive body', caption: 'sensitive caption',
  } }))
  assert.doesNotMatch(JSON.stringify(draft.safeMetadata), /sensitive|text|caption/i)
})

test('text and timestamp differences do not alter exact identity fields', () => {
  const first = classifyConfirmationEvidence(source({ normalizedPayload: { attemptCorrelationId: 'exact-id', text: 'first' } }))
  const second = classifyConfirmationEvidence(source({
    normalizedPayload: { attemptCorrelationId: 'exact-id', text: 'second' },
    providerOccurredAt: new Date('2030-01-01T00:00:00Z'),
  }))
  assert.equal(first.attemptCorrelationId, second.attemptCorrelationId)
  assert.equal(first.providerMessageId, second.providerMessageId)
})

test('web route ID is evidence only and remains exact', () => {
  const draft = classifyConfirmationEvidence(source({ webRouteId: 'web-route-drifted' }))
  assert.equal(draft.webRouteId, 'web-route-drifted')
})

test('same providerMessageId in different physical events is not an evidence identity', () => {
  const first = classifyConfirmationEvidence(source({ normalizedEventId: 'event-1' }))
  const second = classifyConfirmationEvidence(source({ normalizedEventId: 'event-2', origin: 'history' }))
  assert.equal(first.providerMessageId, second.providerMessageId)
  assert.notEqual(first.evidenceSha256, second.evidenceSha256)
})

test('default provider absence verifier denies all local negative hints', async () => {
  const verifier = new DenyAllProviderAbsenceEvidenceVerifier()
  for (const hint of ['timeout', 'missing_echo', 'empty_cache', 'dom_absence', 'text_search_absence']) {
    assert.equal(await verifier.verify({
      accountId: 'account-A', normalizedEventId: 'event-1', dispatchId: 'dispatch-1', attemptId: 'attempt-1',
      absenceReference: `absence-${hint}`, verifierInput: { hint }, expectedStateVersion: 1, expectedAttemptVersion: 1,
    }), null)
  }
})
