import type { JsonValue } from '../journal/types.ts'
import type { NormalizeRawObservationInput } from '../inbound/types.ts'

export type ComparisonClassification =
  | 'matched'
  | 'expected_difference'
  | 'regression'
  | 'legacy_only'
  | 'new_only'
  | 'unsupported'
  | 'quarantined'

export type SemanticStatus = 'normalized' | 'unsupported' | 'quarantined' | 'absent'
export type DifferenceSeverity = 'info' | 'warning' | 'error' | 'critical'
export type StoredSeverity = DifferenceSeverity | 'none'
export type DifferenceKind =
  | 'missing_event'
  | 'extra_event'
  | 'kind_mismatch'
  | 'direction_mismatch'
  | 'origin_mismatch'
  | 'identifier_mismatch'
  | 'timestamp_mismatch'
  | 'text_hash_mismatch'
  | 'caption_hash_mismatch'
  | 'attachment_count_mismatch'
  | 'attachment_identity_mismatch'
  | 'media_kind_mismatch'
  | 'reply_target_mismatch'
  | 'reaction_target_mismatch'
  | 'receipt_semantic_mismatch'
  | 'route_evidence_mismatch'
  | 'classification_mismatch'

export interface CanonicalAttachment {
  readonly attachmentOrdinal: number
  readonly providerAttachmentId: string | null
  readonly mediaKind: string
  readonly mimeHint: string | null
  readonly fetchReferenceStatus: 'absent' | 'metadata_only' | 'redacted' | 'download_required' | 'sensitive_present'
}

export interface CanonicalRouteEvidence {
  readonly identityKind: string
  readonly identityValue: string
  readonly authority: string
  readonly classification: string
}

export interface CanonicalSemanticEvent {
  readonly eventOrdinal: number
  readonly eventKind: string
  readonly direction: string
  readonly origin: string
  readonly providerMessageId: string | null
  readonly providerUserId: string | null
  readonly protocolChatId: string | null
  readonly webRouteId: string | null
  readonly providerOccurredAtPresent: boolean
  readonly providerOccurredAt: string | null
  readonly textPresent: boolean
  readonly textSha256: string | null
  readonly captionPresent: boolean
  readonly captionSha256: string | null
  readonly attachmentCount: number
  readonly attachments: readonly CanonicalAttachment[]
  readonly replyPresent: boolean
  readonly replyResolution: 'none' | 'exact' | 'unresolved' | 'approximated'
  readonly replyTargetPresent: boolean
  readonly replyTargetProviderMessageId: string | null
  readonly reactionOperation: string | null
  readonly reactionTargetProviderMessageId: string | null
  readonly receiptSemantic: string | null
  readonly receiptTargetProviderMessageId: string | null
  readonly routeEvidence: readonly CanonicalRouteEvidence[]
  readonly issueClassification: string | null
}

export interface CanonicalSemanticOutcome {
  readonly status: SemanticStatus
  readonly events: readonly CanonicalSemanticEvent[]
  readonly issueClassification: string | null
  readonly semanticSha256: string
}

export interface SemanticDiffDraft {
  readonly diffOrdinal: number
  readonly path: string
  readonly differenceKind: DifferenceKind
  readonly severity: DifferenceSeverity
  readonly legacyValueType: string
  readonly newValueType: string
  readonly legacyValueHash: string | null
  readonly newValueHash: string | null
  readonly safeMetadata: JsonValue
}

export interface SemanticComparisonDraft {
  readonly classification: ComparisonClassification
  readonly legacy: CanonicalSemanticOutcome
  readonly current: CanonicalSemanticOutcome
  readonly diffs: readonly SemanticDiffDraft[]
  readonly highestSeverity: StoredSeverity
  readonly issueCode: string | null
  readonly safeSummary: string | null
}

export interface LegacySemanticAdapter {
  readonly adapterVersion: string
  adapt(input: NormalizeRawObservationInput): CanonicalSemanticOutcome
}

export interface SemanticComparisonEngine {
  readonly comparisonVersion: string
  readonly legacyAdapterVersion: string
  readonly newNormalizerVersion: string
  compare(input: NormalizeRawObservationInput): SemanticComparisonDraft
}

export interface ShadowComparisonRunRecord {
  readonly runId: string
  readonly accountId: string
  readonly comparisonVersion: string
  readonly legacyAdapterVersion: string
  readonly newNormalizerVersion: string
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly sourceFromJournalSequence: bigint | null
  readonly sourceToJournalSequence: bigint | null
  readonly processedCount: number
  readonly matchedCount: number
  readonly expectedDifferenceCount: number
  readonly regressionCount: number
  readonly legacyOnlyCount: number
  readonly newOnlyCount: number
  readonly unsupportedCount: number
  readonly quarantinedCount: number
  readonly startedAt: Date
  readonly completedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ShadowComparisonResultRecord {
  readonly resultId: string
  readonly runId: string
  readonly accountId: string
  readonly sourceObservationId: string
  readonly sourceJournalSequence: bigint
  readonly comparisonVersion: string
  readonly classification: ComparisonClassification
  readonly legacyStatus: SemanticStatus
  readonly newStatus: SemanticStatus
  readonly legacySemanticSha256: string
  readonly newSemanticSha256: string
  readonly diffCount: number
  readonly highestSeverity: StoredSeverity
  readonly issueCode: string | null
  readonly safeSummary: string | null
  readonly createdAt: Date
}

export interface ShadowSemanticDiffRecord extends SemanticDiffDraft {
  readonly diffId: string
  readonly resultId: string
  readonly accountId: string
  readonly createdAt: Date
}

export interface ShadowComparisonCursorRecord {
  readonly cursorId: string
  readonly runId: string
  readonly accountId: string
  readonly comparisonVersion: string
  readonly lastJournalSequence: bigint
  readonly optimisticVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateComparisonRunInput {
  readonly runId?: string
  readonly accountId: string
  readonly comparisonVersion: string
  readonly legacyAdapterVersion: string
  readonly newNormalizerVersion: string
  readonly sourceFromJournalSequence?: bigint
  readonly sourceToJournalSequence?: bigint
  readonly now?: Date
}

export interface CompareObservationInput {
  readonly runId: string
  readonly accountId: string
  readonly comparisonVersion: string
  readonly observationId: string
}

export interface CompareObservationResult {
  readonly result: ShadowComparisonResultRecord
  readonly diffs: readonly ShadowSemanticDiffRecord[]
  readonly idempotent: boolean
}

export interface CompareBatchInput {
  readonly runId: string
  readonly accountId: string
  readonly comparisonVersion: string
  readonly limit: number
}

export interface CompareBatchResult {
  readonly processed: number
  readonly idempotent: number
  readonly classifications: Readonly<Record<ComparisonClassification, number>>
  readonly lastJournalSequence: bigint
}

export interface ListResultsInput {
  readonly runId: string
  readonly accountId: string
  readonly classification?: ComparisonClassification
  readonly afterJournalSequence?: bigint
  readonly limit: number
}

export interface ShadowReadinessSummary {
  readonly totalObservations: number
  readonly matched: number
  readonly expectedDifferences: number
  readonly regressions: number
  readonly criticalRegressions: number
  readonly unsupported: number
  readonly quarantined: number
  readonly legacyOnly: number
  readonly newOnly: number
  readonly comparisonCoverage: number
  readonly fixtureCoverage: number
  readonly routeCriticalMismatchCount: number
  readonly providerIdentityMismatchCount: number
  readonly replyReactionTargetMismatchCount: number
  readonly mediaMismatchCount: number
  readonly deterministicReplay: number
  readonly stage8Ready: boolean
}

export interface ShadowSemanticComparisonHarness {
  createRun(input: CreateComparisonRunInput): Promise<ShadowComparisonRunRecord>
  compareObservation(input: CompareObservationInput): Promise<CompareObservationResult>
  compareBatch(input: CompareBatchInput): Promise<CompareBatchResult>
  resumeRun(input: CompareBatchInput): Promise<CompareBatchResult>
  replayObservation(input: CompareObservationInput): Promise<CompareObservationResult>
  getRun(accountId: string, runId: string): Promise<ShadowComparisonRunRecord | null>
  getResult(accountId: string, runId: string, observationId: string, comparisonVersion: string): Promise<CompareObservationResult | null>
  listResults(input: ListResultsInput): Promise<readonly ShadowComparisonResultRecord[]>
  listCriticalDiffs(accountId: string, runId: string, limit: number): Promise<readonly ShadowSemanticDiffRecord[]>
  listRegressions(accountId: string, runId: string, limit: number): Promise<readonly ShadowComparisonResultRecord[]>
  getCursor(accountId: string, runId: string, comparisonVersion: string): Promise<ShadowComparisonCursorRecord | null>
}
