import { MaxInboundNormalizer } from '../inbound/MaxInboundNormalizer.ts'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../inbound/constants.ts'
import type { NormalizeRawObservationInput } from '../inbound/types.ts'
import { boundedValueHash, canonicalizeNewOutcome, semanticValueType } from './canonical.ts'
import {
  MAX_SHADOW_COMPARISON_MAX_DIFFS,
  MAX_SHADOW_COMPARISON_VERSION,
} from './constants.ts'
import { ShadowComparisonError } from './errors.ts'
import { comparisonTraits, expectedDifferenceRule } from './expectedDifferences.ts'
import { PureLegacySemanticAdapter } from './LegacySemanticAdapter.ts'
import type {
  CanonicalSemanticEvent,
  CanonicalSemanticOutcome,
  DifferenceKind,
  DifferenceSeverity,
  SemanticComparisonDraft,
  SemanticComparisonEngine as SemanticComparisonEngineContract,
  SemanticDiffDraft,
  StoredSeverity,
} from './types.ts'

interface InternalDiff extends SemanticDiffDraft {
  readonly expected: boolean
}

const severityRank: Readonly<Record<StoredSeverity, number>> = {
  none: 0, info: 1, warning: 2, error: 3, critical: 4,
}

function kindForPath(path: string, legacy: unknown, current: unknown): DifferenceKind {
  if (/^\$events\[\d+\]$/.test(path)) return legacy === undefined ? 'extra_event' : 'missing_event'
  if (path.endsWith('.eventKind')) return 'kind_mismatch'
  if (path.endsWith('.direction')) return 'direction_mismatch'
  if (path.endsWith('.origin')) return 'origin_mismatch'
  if (/providerMessageId|providerUserId|protocolChatId|webRouteId/.test(path)) return 'identifier_mismatch'
  if (/providerOccurredAt/.test(path)) return 'timestamp_mismatch'
  if (/text(Present|Sha256)/.test(path)) return 'text_hash_mismatch'
  if (/caption(Present|Sha256)/.test(path)) return 'caption_hash_mismatch'
  if (/attachmentCount/.test(path)) return 'attachment_count_mismatch'
  if (/attachments\[\d+\]\.providerAttachmentId/.test(path)) return 'attachment_identity_mismatch'
  if (/attachments\[\d+\]\.(mediaKind|mimeHint|fetchReferenceStatus)/.test(path)) return 'media_kind_mismatch'
  if (/reply(Target|Present|Resolution)/.test(path)) return 'reply_target_mismatch'
  if (/reaction(Target|Operation)/.test(path)) return 'reaction_target_mismatch'
  if (/receipt(Semantic|Target)/.test(path)) return 'receipt_semantic_mismatch'
  if (/routeEvidence/.test(path)) return 'route_evidence_mismatch'
  return 'classification_mismatch'
}

function severityFor(path: string, kind: DifferenceKind, legacy: unknown): DifferenceSeverity {
  if (kind === 'missing_event') {
    const event = legacy as Partial<CanonicalSemanticEvent> | undefined
    return event?.direction === 'inbound' ? 'critical' : 'error'
  }
  if (kind === 'direction_mismatch' || kind === 'identifier_mismatch'
    || kind === 'reply_target_mismatch' || kind === 'reaction_target_mismatch'
    || kind === 'receipt_semantic_mismatch') return 'critical'
  if (kind === 'attachment_count_mismatch' || kind === 'attachment_identity_mismatch'
    || kind === 'media_kind_mismatch' || kind === 'caption_hash_mismatch') return 'error'
  if (kind === 'extra_event' || kind === 'kind_mismatch' || kind === 'text_hash_mismatch') return 'error'
  if (path === '$alignment') return 'error'
  return 'warning'
}

function equalScalar(left: unknown, right: unknown): boolean {
  return Object.is(left, right)
}

function rawDiffs(legacy: CanonicalSemanticOutcome, current: CanonicalSemanticOutcome): Array<{
  path: string
  legacy: unknown
  current: unknown
}> {
  const output: Array<{ path: string; legacy: unknown; current: unknown }> = []
  const legacyOrdinals = legacy.events.map(event => event.eventOrdinal)
  const currentOrdinals = current.events.map(event => event.eventOrdinal)
  if (new Set(legacyOrdinals).size !== legacyOrdinals.length
    || new Set(currentOrdinals).size !== currentOrdinals.length) {
    output.push({ path: '$alignment', legacy: legacyOrdinals, current: currentOrdinals })
    return output
  }

  function walk(left: unknown, right: unknown, path: string): void {
    if (left === undefined || right === undefined) {
      if (left !== right) output.push({ path, legacy: left, current: right })
      return
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
      if (!equalScalar(left, right)) output.push({ path, legacy: left, current: right })
      return
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) {
        output.push({ path, legacy: left, current: right })
        return
      }
      if (path.endsWith('.attachments') && left.length !== right.length) {
        output.push({ path: `${path.slice(0, -'.attachments'.length)}.attachmentCount`, legacy: left.length, current: right.length })
      }
      const length = Math.max(left.length, right.length)
      for (let index = 0; index < length; index += 1) walk(left[index], right[index], `${path}[${index}]`)
      return
    }
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()
    for (const key of keys) walk(leftRecord[key], rightRecord[key], `${path}.${key}`)
  }

  walk(legacy.status, current.status, '$status')
  walk(legacy.events, current.events, '$events')
  walk(legacy.issueClassification, current.issueClassification, '$issueClassification')
  return output
}

function highest(diffs: readonly SemanticDiffDraft[]): StoredSeverity {
  return diffs.reduce<StoredSeverity>((value, diff) => severityRank[diff.severity] > severityRank[value] ? diff.severity : value, 'none')
}

function classification(
  legacy: CanonicalSemanticOutcome,
  current: CanonicalSemanticOutcome,
  diffs: readonly InternalDiff[],
): SemanticComparisonDraft['classification'] {
  if (current.status === 'quarantined') return 'quarantined'
  if (current.status === 'unsupported') return 'unsupported'
  if (legacy.status === 'absent' && current.events.length > 0) return 'new_only'
  if (current.status === 'absent' && legacy.events.length > 0) return 'legacy_only'
  if (diffs.length === 0) return 'matched'
  return diffs.every(diff => diff.expected) ? 'expected_difference' : 'regression'
}

export class DefaultSemanticComparisonEngine implements SemanticComparisonEngineContract {
  readonly comparisonVersion: string
  readonly legacyAdapterVersion: string
  readonly newNormalizerVersion = MAX_INBOUND_NORMALIZER_VERSION
  readonly #legacy: PureLegacySemanticAdapter
  readonly #normalizer: MaxInboundNormalizer

  constructor(
    legacy = new PureLegacySemanticAdapter(),
    normalizer = new MaxInboundNormalizer(),
    comparisonVersion = MAX_SHADOW_COMPARISON_VERSION,
  ) {
    this.#legacy = legacy
    this.#normalizer = normalizer
    this.comparisonVersion = comparisonVersion
    this.legacyAdapterVersion = legacy.adapterVersion
  }

  compare(input: NormalizeRawObservationInput): SemanticComparisonDraft {
    if (input.parserVersion !== this.newNormalizerVersion) {
      throw new ShadowComparisonError('INVALID_INPUT', 'new normalizer version must be exact')
    }
    const legacy = this.#legacy.adapt(input)
    const current = canonicalizeNewOutcome(this.#normalizer.normalizeRawObservation(input))
    const traits = comparisonTraits(input)
    const internal = rawDiffs(legacy, current).map((difference, index): InternalDiff => {
      const kind = kindForPath(difference.path, difference.legacy, difference.current)
      const baseSeverity = severityFor(difference.path, kind, difference.legacy)
      const rule = expectedDifferenceRule(
        this.comparisonVersion,
        difference.path,
        traits,
        difference.legacy,
        difference.current,
      )
      return {
        diffOrdinal: index,
        path: difference.path,
        differenceKind: kind,
        severity: rule?.severityDowngrade ?? baseSeverity,
        legacyValueType: semanticValueType(difference.legacy),
        newValueType: semanticValueType(difference.current),
        legacyValueHash: boundedValueHash(difference.legacy),
        newValueHash: boundedValueHash(difference.current),
        safeMetadata: {
          comparisonVersion: this.comparisonVersion,
          expectedRuleId: rule?.ruleId ?? null,
        },
        expected: rule !== null,
      }
    })
    if (internal.length > MAX_SHADOW_COMPARISON_MAX_DIFFS) {
      throw new ShadowComparisonError('INVALID_INPUT', 'semantic diff count exceeds safe bound')
    }
    const stored: SemanticDiffDraft[] = internal.map(({ expected: _expected, ...diff }) => diff)
    const resultClass = classification(legacy, current, internal)
    const issueCode = resultClass === 'regression' || resultClass === 'legacy_only' || resultClass === 'new_only'
      ? 'UNEXPECTED_SEMANTIC_DIFFERENCE'
      : resultClass === 'expected_difference' ? 'EXPLICIT_EXPECTED_DIFFERENCE'
        : resultClass === 'unsupported' ? current.issueClassification ?? 'UNKNOWN_EVENT_SHAPE'
          : resultClass === 'quarantined' ? current.issueClassification ?? 'MALFORMED_PROVIDER_EVENT'
            : null
    return {
      classification: resultClass,
      legacy,
      current,
      diffs: stored,
      highestSeverity: highest(stored),
      issueCode,
      safeSummary: stored.length === 0 ? null : `${stored.length} bounded semantic difference(s) classified`,
    }
  }
}
