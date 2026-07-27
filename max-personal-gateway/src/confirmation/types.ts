import type { JsonValue } from '../journal/types.ts'
import type { ProviderAbsenceEvidenceInput } from './absence.ts'

export type ProviderConfirmationEvidenceKind =
  | 'outbound_echo'
  | 'provider_acceptance_receipt'
  | 'recipient_delivery_receipt'
  | 'recipient_read_receipt'
  | 'provider_absence'
  | 'unknown_receipt'
  | 'unsupported'

export type ProviderConfirmationResolutionStatus =
  | 'pending'
  | 'deferred'
  | 'matched'
  | 'duplicate'
  | 'unmatched'
  | 'ambiguous'
  | 'ignored'
  | 'quarantined'

export type ProviderConfirmationMatchMethod =
  | 'attempt_correlation_id'
  | 'client_message_id'
  | 'existing_provider_message_id'
  | 'provider_absence_reference'
  | 'none'

export interface ProviderConfirmationEvidence {
  readonly evidenceId: string
  readonly accountId: string
  readonly sourceNormalizedEventId: string
  readonly sourceObservationId: string
  readonly sourceJournalSequence: bigint
  readonly sourceEventOrdinal: number
  readonly matcherVersion: string
  readonly evidenceVersion: string
  readonly evidenceKind: ProviderConfirmationEvidenceKind
  readonly providerMessageId: string | null
  readonly attemptCorrelationId: string | null
  readonly clientMessageId: string | null
  readonly protocolChatId: string | null
  readonly providerUserId: string | null
  readonly webRouteId: string | null
  readonly providerOccurredAt: Date | null
  readonly evidenceSha256: string
  readonly safeMetadata: JsonValue
  readonly createdAt: Date
}

export interface ProviderConfirmationResolution {
  readonly resolutionId: string
  readonly evidenceId: string
  readonly accountId: string
  readonly matcherVersion: string
  readonly status: ProviderConfirmationResolutionStatus
  readonly matchMethod: ProviderConfirmationMatchMethod
  readonly dispatchId: string | null
  readonly attemptId: string | null
  readonly transitionId: string | null
  readonly canonicalEvidenceId: string | null
  readonly issueCode: string | null
  readonly safeIssueSummary: string | null
  readonly candidateDispatchIds: JsonValue
  readonly candidateAttemptIds: JsonValue
  readonly resolutionVersion: number
  readonly retryCount: number
  readonly nextRetryAt: Date | null
  readonly resolvedAt: Date | null
  readonly resolvedBy: string | null
  readonly resolutionReason: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ProviderConfirmationDecision {
  readonly decisionId: string
  readonly resolutionId: string
  readonly evidenceId: string
  readonly accountId: string
  readonly decisionSequence: number
  readonly matcherVersion: string
  readonly decisionType: string
  readonly fromStatus: ProviderConfirmationResolutionStatus | null
  readonly toStatus: ProviderConfirmationResolutionStatus
  readonly dispatchId: string | null
  readonly attemptId: string | null
  readonly transitionId: string | null
  readonly actor: string
  readonly reason: string
  readonly decisionSha256: string
  readonly safeMetadata: JsonValue
  readonly resolutionVersionBefore: number
  readonly resolutionVersionAfter: number
  readonly createdAt: Date
}

export interface ProviderConfirmationCursor {
  readonly cursorId: string
  readonly consumerId: string
  readonly accountId: string
  readonly matcherVersion: string
  readonly lastJournalSequence: bigint
  readonly lastEventOrdinal: number
  readonly optimisticVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ProcessNormalizedEventInput {
  readonly accountId: string
  readonly normalizedEventId: string
  readonly matcherVersion?: string
  readonly now?: Date
}

export interface ProcessConfirmationResult {
  readonly evidence: ProviderConfirmationEvidence
  readonly resolution: ProviderConfirmationResolution
  readonly idempotent: boolean
  readonly canonicalEffectApplied: boolean
}

export interface ProcessConfirmationBatchInput {
  readonly consumerId: string
  readonly accountId: string
  readonly matcherVersion?: string
  readonly limit: number
}

export interface ProcessConfirmationBatchResult {
  readonly processed: number
  readonly matched: number
  readonly duplicate: number
  readonly deferred: number
  readonly ambiguous: number
  readonly unmatched: number
  readonly ignored: number
  readonly quarantined: number
  readonly cursor: ProviderConfirmationCursor
}

export interface ConfirmationResolutionPage {
  readonly resolutions: readonly ProviderConfirmationResolution[]
  readonly nextCreatedAt: Date | null
  readonly nextResolutionId: string | null
}

export interface ReprocessEvidenceInput {
  readonly accountId: string
  readonly evidenceId: string
  readonly expectedResolutionVersion: number
  readonly now?: Date
}

export interface ResolveAmbiguityInput extends ReprocessEvidenceInput {
  readonly selectedDispatchId: string
  readonly selectedAttemptId: string
  readonly actor: string
  readonly reason: string
}

export interface ConfirmationMatcher {
  processNormalizedEvent(input: ProcessNormalizedEventInput): Promise<ProcessConfirmationResult>
  processBatch(input: ProcessConfirmationBatchInput): Promise<ProcessConfirmationBatchResult>
  getEvidence(accountId: string, evidenceId: string): Promise<ProviderConfirmationEvidence | null>
  getResolution(accountId: string, evidenceId: string): Promise<ProviderConfirmationResolution | null>
  listUnmatched(accountId: string, matcherVersion: string, cursor: string | undefined, limit: number): Promise<ConfirmationResolutionPage>
  listDeferred(accountId: string, matcherVersion: string, cursor: string | undefined, limit: number): Promise<ConfirmationResolutionPage>
  listAmbiguous(accountId: string, matcherVersion: string, cursor: string | undefined, limit: number): Promise<ConfirmationResolutionPage>
  reprocessEvidence(input: ReprocessEvidenceInput): Promise<ProcessConfirmationResult>
  resolveAmbiguity(input: ResolveAmbiguityInput): Promise<ProcessConfirmationResult>
  recordExactProviderAbsence(input: ProviderAbsenceEvidenceInput): Promise<ProcessConfirmationResult>
  getCursor(consumerId: string, accountId: string, matcherVersion: string): Promise<ProviderConfirmationCursor | null>
}
