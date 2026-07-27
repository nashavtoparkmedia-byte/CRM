import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../src/inbound/constants.ts'
import { MaxInboundNormalizer } from '../src/inbound/MaxInboundNormalizer.ts'
import type { NormalizationOutcome, NormalizeRawObservationInput } from '../src/inbound/types.ts'
import { MAX_SHADOW_COMPARISON_VERSION } from '../src/comparison/constants.ts'
import { EXPECTED_DIFFERENCE_RULES } from '../src/comparison/expectedDifferences.ts'
import { shadowComparisonEnabled } from '../src/comparison/featureFlag.ts'
import { buildShadowReadinessSummary } from '../src/comparison/readiness.ts'
import { DefaultSemanticComparisonEngine } from '../src/comparison/SemanticComparisonEngine.ts'
import type {
  ShadowComparisonResultRecord,
  ShadowComparisonRunRecord,
  ShadowSemanticDiffRecord,
} from '../src/comparison/types.ts'
import {
  SAFE_COMPARISON_FIXTURES,
  comparisonInput,
  fixtureById,
} from './support/comparisonFixtures.ts'

class TransformingNormalizer extends MaxInboundNormalizer {
  readonly #transform: (outcome: NormalizationOutcome) => NormalizationOutcome

  constructor(transform: (outcome: NormalizationOutcome) => NormalizationOutcome) {
    super()
    this.#transform = transform
  }

  override normalizeRawObservation(input: NormalizeRawObservationInput): NormalizationOutcome {
    return this.#transform(super.normalizeRawObservation(input))
  }
}

function engineWithFault(transform: (outcome: NormalizationOutcome) => NormalizationOutcome): DefaultSemanticComparisonEngine {
  return new DefaultSemanticComparisonEngine(undefined, new TransformingNormalizer(transform))
}

function mutateFirstEvent(
  outcome: NormalizationOutcome,
  transform: (event: NormalizationOutcome['events'][number]) => NormalizationOutcome['events'][number],
): NormalizationOutcome {
  return { ...outcome, events: outcome.events.map((event, index) => index === 0 ? transform(event) : event) }
}

describe('Stage 7 pure semantic comparison', () => {
  test('S7-U-01 fixture matrix covers mandatory semantics with deterministic expected classifications', () => {
    const engine = new DefaultSemanticComparisonEngine()
    assert.equal(SAFE_COMPARISON_FIXTURES.length >= 25, true)
    for (const [index, fixture] of SAFE_COMPARISON_FIXTURES.entries()) {
      const first = engine.compare(comparisonInput(fixture, 'account-a', BigInt(index + 1)))
      const repeated = engine.compare(comparisonInput(fixture, 'account-a', BigInt(index + 1)))
      assert.equal(first.classification, fixture.expectedClassification, fixture.fixtureId)
      assert.deepEqual(repeated, first, fixture.fixtureId)
      assert.equal(first.legacy.semanticSha256.length, 64)
      assert.equal(first.current.semanticSha256.length, 64)
      assert.deepEqual(first.diffs.map(diff => diff.diffOrdinal), first.diffs.map((_diff, ordinal) => ordinal))
    }
  })

  test('S7-U-02 canonical output contains hashes and never durable message/caption/reference contents', () => {
    const engine = new DefaultSemanticComparisonEngine()
    for (const fixtureId of ['inbound-text', 'jpeg-caption', 'signed-reference-redaction']) {
      const fixture = fixtureById(fixtureId)
      const result = engine.compare(comparisonInput(fixture))
      const storedShape = JSON.stringify({
        legacy: result.legacy,
        current: result.current,
        diffs: result.diffs,
        summary: result.safeSummary,
      })
      assert.doesNotMatch(storedShape, /synthetic inbound|synthetic caption|redacted-fixture-reference/)
      if (fixtureId !== 'signed-reference-redaction') {
        assert.equal(result.current.events[0]?.textPresent || result.current.events[0]?.captionPresent, true)
      }
    }
  })

  test('S7-U-03 physical identity is not a semantic dedup or alignment input', () => {
    const engine = new DefaultSemanticComparisonEngine()
    const fixture = fixtureById('duplicate-provider-frame')
    const first = engine.compare(comparisonInput(fixture, 'account-a', 1n, 'physical-1'))
    const second = engine.compare(comparisonInput(fixture, 'account-a', 2n, 'physical-2'))
    assert.equal(first.current.semanticSha256, second.current.semanticSha256)
    assert.equal(first.classification, 'matched')
    assert.equal(second.classification, 'matched')
  })

  test('S7-U-04 explicit expected-difference policy has exact bounded rules and no wildcard acceptance', () => {
    assert.equal(EXPECTED_DIFFERENCE_RULES.length, 8)
    assert.equal(EXPECTED_DIFFERENCE_RULES.every(rule => rule.version === MAX_SHADOW_COMPARISON_VERSION), true)
    assert.equal(EXPECTED_DIFFERENCE_RULES.every(rule => rule.ruleId.length > 0
      && rule.exactPathPredicate.length > 0 && rule.rationale.length > 0
      && !['*', '.*', '$.*'].includes(rule.exactPathPredicate)), true)
    const engine = new DefaultSemanticComparisonEngine()
    for (const id of ['unknown-ack', 'reply-unresolved', 'missing-provider-id',
      'signed-reference-redaction', 'media-metadata-only', 'name-phone-route-authority']) {
      assert.equal(engine.compare(comparisonInput(fixtureById(id))).classification, 'expected_difference', id)
    }
    const nextVersion = new DefaultSemanticComparisonEngine(undefined, undefined, 'max-shadow-comparison-v2-test')
    assert.equal(nextVersion.compare(comparisonInput(fixtureById('unknown-ack'))).classification, 'regression')
  })

  test('S7-U-05 malformed and unknown shapes remain visible as quarantined and unsupported', () => {
    const engine = new DefaultSemanticComparisonEngine()
    assert.equal(engine.compare(comparisonInput(fixtureById('malformed-event'))).classification, 'quarantined')
    assert.equal(engine.compare(comparisonInput(fixtureById('unsupported-event'))).classification, 'unsupported')
    assert.equal(engine.compare(comparisonInput(fixtureById('invalid-utf8-quarantine'))).classification, 'quarantined')
  })

  test('S7-U-06 wrong provider/chat/user identities and direction are critical regressions', () => {
    const fixture = fixtureById('inbound-text')
    const faults: Array<(outcome: NormalizationOutcome) => NormalizationOutcome> = [
      outcome => mutateFirstEvent(outcome, event => ({ ...event, providerMessageId: 'wrong-provider-message' })),
      outcome => mutateFirstEvent(outcome, event => ({ ...event, protocolChatId: 'wrong-protocol-chat' })),
      outcome => mutateFirstEvent(outcome, event => ({ ...event, providerUserId: 'wrong-provider-user' })),
      outcome => mutateFirstEvent(outcome, event => ({ ...event, direction: 'outbound_echo' })),
    ]
    for (const fault of faults) {
      const result = engineWithFault(fault).compare(comparisonInput(fixture))
      assert.equal(result.classification, 'regression')
      assert.equal(result.highestSeverity, 'critical')
    }
  })

  test('S7-U-07 missing inbound, wrong reply/reaction target, and false acceptance are critical', () => {
    const missing = engineWithFault(outcome => ({ ...outcome, events: [] }))
      .compare(comparisonInput(fixtureById('inbound-text')))
    assert.equal(missing.classification, 'regression')
    assert.equal(missing.highestSeverity, 'critical')

    const wrongReply = engineWithFault(outcome => mutateFirstEvent(outcome, event => ({
      ...event,
      targetProviderMessageId: 'wrong-reply-target',
      normalizedPayload: {
        ...(event.normalizedPayload as unknown as Record<string, unknown>),
        reply: { status: 'exact', targetProviderMessageId: 'wrong-reply-target', issueCode: null },
      } as never,
    }))).compare(comparisonInput(fixtureById('reply-exact')))
    assert.equal(wrongReply.highestSeverity, 'critical')

    const wrongReaction = engineWithFault(outcome => mutateFirstEvent(outcome, event => ({
      ...event, targetProviderMessageId: 'wrong-reaction-target',
    }))).compare(comparisonInput(fixtureById('reaction-add')))
    assert.equal(wrongReaction.highestSeverity, 'critical')

    const falseAcceptance = engineWithFault(outcome => mutateFirstEvent(outcome, event => ({
      ...event,
      normalizedPayload: { ...(event.normalizedPayload as unknown as Record<string, unknown>), receiptType: 'provider_acceptance' } as never,
    }))).compare(comparisonInput(fixtureById('unknown-ack')))
    assert.equal(falseAcceptance.classification, 'regression')
    assert.equal(falseAcceptance.highestSeverity, 'critical')
  })

  test('S7-U-08 attachment loss, caption loss, and wrong media kind are errors', () => {
    const lostAttachment = engineWithFault(outcome => mutateFirstEvent(outcome, event => ({
      ...event, normalizedPayload: { ...(event.normalizedPayload as unknown as Record<string, unknown>), attachments: [] } as never,
    }))).compare(comparisonInput(fixtureById('jpeg')))
    assert.equal(lostAttachment.classification, 'regression')
    assert.equal(lostAttachment.highestSeverity, 'error')
    const lostCaption = engineWithFault(outcome => mutateFirstEvent(outcome, event => ({
      ...event, normalizedPayload: { ...(event.normalizedPayload as unknown as Record<string, unknown>), caption: null } as never,
    }))).compare(comparisonInput(fixtureById('jpeg-caption')))
    assert.equal(lostCaption.highestSeverity, 'error')
    const wrongMedia = engineWithFault(outcome => mutateFirstEvent(outcome, event => {
      const payload = event.normalizedPayload as unknown as Record<string, unknown>
      const attachments = (payload.attachments as Array<Record<string, unknown>>).map(item => ({ ...item, mediaKind: 'video' }))
      return { ...event, normalizedPayload: { ...payload, attachments } as never }
    })).compare(comparisonInput(fixtureById('jpeg')))
    assert.equal(wrongMedia.highestSeverity, 'error')
  })

  test('S7-U-09 unknown differences are not silently expected', () => {
    const result = engineWithFault(outcome => mutateFirstEvent(outcome, event => ({ ...event, origin: 'replay' })))
      .compare(comparisonInput(fixtureById('inbound-text')))
    assert.equal(result.classification, 'regression')
    assert.equal(result.diffs.every(diff => (diff.safeMetadata as Record<string, unknown>).expectedRuleId === null), true)
  })

  test('S7-U-10 eventOrdinal is the alignment boundary; text/time similarity never selects a winner', () => {
    const reversed = engineWithFault(outcome => ({ ...outcome, events: [...outcome.events].reverse() }))
      .compare(comparisonInput({
        fixtureId: 'multi-route-order', expectedClassification: 'matched',
        payload: {
          kind: 'message', direction: 'inbound', providerMessageId: 'msg-order', text: 'same',
          routeEvidence: [{ identityKind: 'protocol_chat_id', identityValue: 'chat-order' }],
        },
      }))
    assert.equal(reversed.classification, 'regression')
    assert.equal(reversed.diffs.some(diff => diff.differenceKind === 'kind_mismatch'), true)
    const ambiguous = new DefaultSemanticComparisonEngine().compare(comparisonInput({
      fixtureId: 'ambiguous-order', expectedClassification: 'regression',
      payload: { kind: 'message', providerMessageId: 'msg-ambiguous', text: 'same', legacyAmbiguousAlignment: true },
    }))
    assert.equal(ambiguous.classification, 'regression')
    assert.deepEqual(ambiguous.diffs.map(diff => diff.path), ['$alignment'])
  })

  test('S7-U-11 comparison feature flag is fail-closed and exact account scoped', () => {
    assert.equal(shadowComparisonEnabled('account-a', {}), false)
    assert.equal(shadowComparisonEnabled('account-a', { MAX_SHADOW_COMPARISON_ENABLED: 'true' }), false)
    assert.equal(shadowComparisonEnabled('account-a', { MAX_SHADOW_COMPARISON_ENABLED: '*' }), false)
    assert.equal(shadowComparisonEnabled('account-a', { MAX_SHADOW_COMPARISON_ENABLED: 'account-a' }), true)
    assert.equal(shadowComparisonEnabled('account-b', { MAX_SHADOW_COMPARISON_ENABLED: 'account-a' }), false)
    assert.equal(shadowComparisonEnabled(' account-a', { MAX_SHADOW_COMPARISON_ENABLED: 'account-a' }), false)
  })

  test('S7-U-12 readiness metrics fail closed on critical and identity differences', () => {
    const run = {
      runId: 'run', accountId: 'account', comparisonVersion: MAX_SHADOW_COMPARISON_VERSION,
      legacyAdapterVersion: 'legacy', newNormalizerVersion: MAX_INBOUND_NORMALIZER_VERSION,
      state: 'completed', sourceFromJournalSequence: null, sourceToJournalSequence: null,
      processedCount: 2, matchedCount: 1, expectedDifferenceCount: 0, regressionCount: 1,
      legacyOnlyCount: 0, newOnlyCount: 0, unsupportedCount: 0, quarantinedCount: 0,
      startedAt: new Date(0), completedAt: new Date(1), createdAt: new Date(0), updatedAt: new Date(1),
    } satisfies ShadowComparisonRunRecord
    const results = [{
      resultId: 'result', runId: 'run', accountId: 'account', sourceObservationId: 'observation',
      sourceJournalSequence: 1n, comparisonVersion: MAX_SHADOW_COMPARISON_VERSION,
      classification: 'regression', legacyStatus: 'normalized', newStatus: 'normalized',
      legacySemanticSha256: 'a'.repeat(64), newSemanticSha256: 'b'.repeat(64), diffCount: 1,
      highestSeverity: 'critical', issueCode: 'UNEXPECTED_SEMANTIC_DIFFERENCE', safeSummary: 'bounded', createdAt: new Date(1),
    }] satisfies ShadowComparisonResultRecord[]
    const diffs = [{
      diffId: 'diff', resultId: 'result', accountId: 'account', diffOrdinal: 0,
      path: '$events[0].providerMessageId', differenceKind: 'identifier_mismatch', severity: 'critical',
      legacyValueType: 'string', newValueType: 'string', legacyValueHash: 'a'.repeat(64), newValueHash: 'b'.repeat(64),
      safeMetadata: {}, createdAt: new Date(1),
    }] satisfies ShadowSemanticDiffRecord[]
    const summary = buildShadowReadinessSummary(run, results, diffs, 1, 1)
    assert.equal(summary.criticalRegressions, 1)
    assert.equal(summary.providerIdentityMismatchCount, 1)
    assert.equal(summary.stage8Ready, false)
  })
})
