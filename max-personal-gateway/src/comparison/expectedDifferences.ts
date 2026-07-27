import type { NormalizeRawObservationInput } from '../inbound/types.ts'
import { MAX_SHADOW_COMPARISON_VERSION } from './constants.ts'
import type { DifferenceSeverity } from './types.ts'

type UnknownRecord = Record<string, unknown>

export interface ComparisonTraits {
  readonly arbitraryAck: boolean
  readonly missingReplyTarget: boolean
  readonly legacyProviderIdFallback: boolean
  readonly signedReference: boolean
  readonly mediaMetadataOnly: boolean
  readonly unknownShape: boolean
  readonly malformedShape: boolean
  readonly legacyRouteAuthority: boolean
}

export interface ExpectedDifferenceRule {
  readonly ruleId: string
  readonly version: string
  readonly exactPathPredicate: string
  readonly rationale: string
  readonly legacyBehavior: string
  readonly newBehavior: string
  readonly severityDowngrade: DifferenceSeverity
  applies(path: string, traits: ComparisonTraits, legacyValue: unknown, newValue: unknown): boolean
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

export function comparisonTraits(input: NormalizeRawObservationInput): ComparisonTraits {
  const payload = record(input.sanitizedPayload)
  const reply = record(payload?.reply)
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : []
  return {
    arbitraryAck: payload?.kind === 'receipt' && payload.receiptType === 'ack' && payload.proof !== 'provider_acceptance',
    missingReplyTarget: payload?.kind === 'message' && reply !== null
      && typeof reply.targetProviderMessageId !== 'string',
    legacyProviderIdFallback: payload?.kind === 'message'
      && typeof payload.providerMessageId !== 'string'
      && typeof payload.legacyProviderMessageId === 'string',
    signedReference: attachments.some(item => {
      const attachment = record(item)
      return typeof attachment?.signedUrl === 'string'
        || typeof attachment?.fetchUrl === 'string'
        || typeof attachment?.url === 'string'
    }),
    mediaMetadataOnly: attachments.some(item => record(item)?.fetchReferenceAvailable === true),
    unknownShape: payload === null || !['message', 'reaction', 'receipt', 'route_evidence'].includes(String(payload.kind)),
    malformedShape: payload?.kind === 'message' && payload.attachments !== undefined && !Array.isArray(payload.attachments),
    legacyRouteAuthority: payload?.kind === 'message'
      && (typeof payload.senderName === 'string' || typeof payload.senderPhone === 'string'),
  }
}

const eventPath = '\\$events\\[\\d+\\]'
const attachmentPath = `${eventPath}\\.attachments\\[\\d+\\]`

export const EXPECTED_DIFFERENCE_RULES: readonly ExpectedDifferenceRule[] = [
  {
    ruleId: 'ACK_NOT_DELIVERY', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: `${eventPath}\\.(receiptSemantic|issueClassification)|\\$issueClassification`,
    rationale: 'An arbitrary acknowledgement is not recipient-delivery evidence.',
    legacyBehavior: 'Promotes an arbitrary ACK to delivery.',
    newBehavior: 'Retains an unknown receipt without a positive delivery transition.',
    severityDowngrade: 'warning',
    applies: (path, traits, legacy, current) => traits.arbitraryAck && (
      (new RegExp(`^${eventPath}\\.receiptSemantic$`).test(path)
        && legacy === 'recipient_delivery' && current === 'unknown_receipt')
      || (new RegExp(`^${eventPath}\\.issueClassification$`).test(path) || path === '$issueClassification')
        && legacy === 'LEGACY_ARBITRARY_ACK_DELIVERY' && current === 'RECEIPT_SEMANTICS_UNKNOWN'
    ),
  },
  {
    ruleId: 'REPLY_REQUIRES_EXACT_TARGET', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: `${eventPath}\\.(replyResolution|issueClassification)|\\$issueClassification`,
    rationale: 'Text/time reply approximation is forbidden.',
    legacyBehavior: 'May mark a text-only reply reference as approximated.',
    newBehavior: 'Leaves the reply unresolved when the exact provider target is absent.',
    severityDowngrade: 'warning',
    applies: (path, traits, legacy, current) => traits.missingReplyTarget && (
      (new RegExp(`^${eventPath}\\.replyResolution$`).test(path)
        && legacy === 'approximated' && current === 'unresolved')
      || (new RegExp(`^${eventPath}\\.issueClassification$`).test(path) || path === '$issueClassification')
        && legacy === 'LEGACY_REPLY_APPROXIMATION' && current === 'REPLY_TARGET_MISSING'
    ),
  },
  {
    ruleId: 'MISSING_PROVIDER_ID_REMAINS_NULL', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: `${eventPath}\\.(providerMessageId|issueClassification)|\\$issueClassification`,
    rationale: 'A missing provider identity must not be manufactured.',
    legacyBehavior: 'Uses a legacy fallback provider identifier.',
    newBehavior: 'Preserves null provider identity.',
    severityDowngrade: 'warning',
    applies: (path, traits, legacy, current) => traits.legacyProviderIdFallback && (
      (new RegExp(`^${eventPath}\\.providerMessageId$`).test(path)
        && typeof legacy === 'string' && current === null)
      || (new RegExp(`^${eventPath}\\.issueClassification$`).test(path) || path === '$issueClassification')
        && legacy === 'LEGACY_PROVIDER_ID_FALLBACK' && current === null
    ),
  },
  {
    ruleId: 'SIGNED_REFERENCE_REDACTED', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: `${attachmentPath}\\.fetchReferenceStatus|${eventPath}\\.issueClassification|\\$issueClassification`,
    rationale: 'Signed URL and token-bearing reference values are secret.',
    legacyBehavior: 'Carries a sensitive reference into media handling.',
    newBehavior: 'Stores redaction state without the reference value.',
    severityDowngrade: 'info',
    applies: (path, traits, legacy, current) => traits.signedReference && (
      (new RegExp(`^${attachmentPath}\\.fetchReferenceStatus$`).test(path)
        && legacy === 'sensitive_present' && current === 'redacted')
      || (new RegExp(`^${eventPath}\\.issueClassification$`).test(path) || path === '$issueClassification')
        && legacy === 'LEGACY_SIGNED_URL_RETAINED' && current === null
    ),
  },
  {
    ruleId: 'MEDIA_DESCRIPTOR_WITHOUT_DOWNLOAD', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: `${attachmentPath}\\.fetchReferenceStatus|${eventPath}\\.issueClassification|\\$issueClassification`,
    rationale: 'Shadow comparison must never synchronously download media.',
    legacyBehavior: 'Marks the media reference for synchronous download.',
    newBehavior: 'Retains a metadata-only descriptor.',
    severityDowngrade: 'info',
    applies: (path, traits, legacy, current) => traits.mediaMetadataOnly && (
      (new RegExp(`^${attachmentPath}\\.fetchReferenceStatus$`).test(path)
        && legacy === 'download_required' && current === 'metadata_only')
      || (new RegExp(`^${eventPath}\\.issueClassification$`).test(path) || path === '$issueClassification')
        && legacy === 'LEGACY_SYNCHRONOUS_MEDIA' && current === null
    ),
  },
  {
    ruleId: 'UNKNOWN_SHAPE_DURABLE_UNSUPPORTED', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: '\\$events\\[0\\]|\\$issueClassification',
    rationale: 'Unknown provider shapes remain visible as durable unsupported evidence.',
    legacyBehavior: 'Drops the unknown semantic event.',
    newBehavior: 'Emits an unsupported event with a classified issue.',
    severityDowngrade: 'warning',
    applies: (path, traits, legacy, current) => traits.unknownShape && (
      (path === '$events[0]' && legacy === undefined && current !== undefined)
      || (path === '$issueClassification' && legacy === 'LEGACY_SHAPE_UNSUPPORTED'
        && current === 'UNKNOWN_EVENT_SHAPE')
    ),
  },
  {
    ruleId: 'MALFORMED_SHAPE_QUARANTINED', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: '\\$status|\\$issueClassification',
    rationale: 'Malformed known shapes must be quarantined rather than dropped.',
    legacyBehavior: 'Classifies malformed input as merely unsupported.',
    newBehavior: 'Creates a durable quarantine outcome.',
    severityDowngrade: 'warning',
    applies: (path, traits, legacy, current) => traits.malformedShape && (
      (path === '$status' && legacy === 'unsupported' && current === 'quarantined')
      || (path === '$issueClassification' && legacy === 'LEGACY_MALFORMED_UNCLASSIFIED'
        && current === 'MALFORMED_PROVIDER_EVENT')
    ),
  },
  {
    ruleId: 'NAME_PHONE_NOT_ROUTE_AUTHORITY', version: MAX_SHADOW_COMPARISON_VERSION,
    exactPathPredicate: '\\$events\\[\\d+\\]',
    rationale: 'Names and phone values cannot establish transport routing authority.',
    legacyBehavior: 'Emits weak name/phone routing authority.',
    newBehavior: 'Does not emit route authority from name or phone.',
    severityDowngrade: 'warning',
    applies: (path, traits, legacy, current) => traits.legacyRouteAuthority
      && /^\$events\[\d+\]$/.test(path) && legacy !== undefined && current === undefined,
  },
]

export function expectedDifferenceRule(
  comparisonVersion: string,
  path: string,
  traits: ComparisonTraits,
  legacyValue: unknown,
  newValue: unknown,
): ExpectedDifferenceRule | null {
  return EXPECTED_DIFFERENCE_RULES.find(rule => rule.version === comparisonVersion
    && rule.applies(path, traits, legacyValue, newValue)) ?? null
}
