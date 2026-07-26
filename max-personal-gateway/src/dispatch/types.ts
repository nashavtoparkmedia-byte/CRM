import type { JsonValue } from '../journal/types.ts'

export type DispatchState =
  | 'queued'
  | 'dispatching'
  | 'sent_to_provider_client'
  | 'awaiting_confirmation'
  | 'reconciliation_required'
  | 'provider_confirmed'
  | 'retryable_failed'
  | 'hard_failed'
  | 'dead_letter'

export type DispatchAttemptState =
  | 'prepared'
  | 'physical_action_started'
  | 'client_action_accepted'
  | 'awaiting_confirmation'
  | 'outcome_unknown'
  | 'provider_confirmed'
  | 'pre_action_failed'
  | 'hard_failed'

export type ReconciliationState = 'open' | 'resolved' | 'dead_letter'
export type ReconciliationReason =
  | 'outcome_unknown'
  | 'timeout'
  | 'restart_post_action'
  | 'restart_client_accepted'
  | 'restart_awaiting_confirmation'

export type HonestOutboundStatus =
  | 'queued'
  | 'sending'
  | 'sent_to_client'
  | 'awaiting_provider_confirmation'
  | 'checking'
  | 'accepted_by_max'
  | 'retrying'
  | 'failed'
  | 'needs_review'

export interface OutboundDispatch {
  readonly dispatchId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly commandId: string
  readonly commandSequence: number
  readonly reservationId: string
  readonly state: DispatchState
  readonly stateVersion: number
  readonly initialRouteVersion: number
  readonly initialProtocolChatId: string
  readonly initialProviderUserId: string | null
  readonly initialWebRouteId: string | null
  readonly initialRouteEvidence: JsonValue
  readonly initialRouteSnapshotSha256: string
  readonly currentAttemptId: string | null
  readonly attemptCount: number
  readonly providerMessageId: string | null
  readonly providerConfirmedAt: Date | null
  readonly reconciliationRequiredAt: Date | null
  readonly terminalAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface OutboundDispatchLane {
  readonly accountId: string
  readonly conversationKey: string
  readonly nextPhysicalSequence: number
  readonly optimisticVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface OutboundDispatchAttempt {
  readonly attemptId: string
  readonly dispatchId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly attemptNumber: number
  readonly attemptState: DispatchAttemptState
  readonly attemptVersion: number
  readonly senderOwnerId: string
  readonly senderFencingEpoch: number
  readonly senderAuthorityVerifiedAt: Date
  readonly attemptCorrelationId: string
  readonly routeVersion: number
  readonly protocolChatId: string
  readonly providerUserId: string | null
  readonly webRouteId: string | null
  readonly routeSnapshotSha256: string
  readonly preparedAt: Date
  readonly claimUntil: Date
  readonly physicalActionStartedAt: Date | null
  readonly clientActionAcceptedAt: Date | null
  readonly awaitingConfirmationAt: Date | null
  readonly outcomeUnknownAt: Date | null
  readonly completedAt: Date | null
  readonly safeErrorCode: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface OutboundDispatchTransition {
  readonly transitionId: string
  readonly dispatchId: string
  readonly attemptId: string | null
  readonly accountId: string
  readonly conversationKey: string
  readonly transitionSequence: number
  readonly transitionIdempotencyKey: string
  readonly fromState: DispatchState | null
  readonly toState: DispatchState
  readonly eventType: string
  readonly evidenceKind: string
  readonly evidenceReference: string | null
  readonly evidenceSha256: string
  readonly safeEvidenceMetadata: JsonValue
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly occurredAt: Date
  readonly createdAt: Date
}

export interface OutboundReconciliationTask {
  readonly reconciliationId: string
  readonly dispatchId: string
  readonly attemptId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly reason: ReconciliationReason
  readonly state: ReconciliationState
  readonly taskVersion: number
  readonly openedAt: Date
  readonly notBefore: Date | null
  readonly resolvedAt: Date | null
  readonly resolutionType: string | null
  readonly resolutionEvidenceReference: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface SenderAuthorityInput {
  readonly accountId: string
  readonly ownerId: string
  readonly fencingEpoch: number
  readonly proofTimestamp: Date
  readonly now: Date
}

export interface SenderAuthorityProof {
  readonly accountId: string
  readonly ownerId: string
  readonly fencingEpoch: number
  readonly verifiedAt: Date
  readonly leaseUntil: Date
}

export interface SenderAuthorityVerifier {
  verify(input: SenderAuthorityInput): Promise<SenderAuthorityProof>
}

export interface CreateDispatchFromReservationInput {
  readonly dispatchId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly reservationId: string
  readonly expectedCommandId: string
  readonly expectedCommandSequence: number
  readonly ownerId: string
  readonly actorLeaseEpoch: number
  readonly expectedActorVersion: number
  readonly expectedReservationVersion: number
  readonly transitionIdempotencyKey: string
  readonly now?: Date
}

export interface CreateDispatchResult {
  readonly dispatch: OutboundDispatch
  readonly lane: OutboundDispatchLane
  readonly transition: OutboundDispatchTransition
  readonly idempotent: boolean
  readonly physicalSendAuthorized: false
}

export interface BeginAttemptInput {
  readonly attemptId: string
  readonly accountId: string
  readonly conversationKey: string
  readonly dispatchId: string
  readonly expectedStateVersion: number
  readonly senderOwnerId: string
  readonly senderFencingEpoch: number
  readonly senderProofTimestamp: Date
  readonly attemptCorrelationId: string
  readonly transitionIdempotencyKey: string
  readonly claimMilliseconds?: number
  readonly now?: Date
}

export interface BeginAttemptResult {
  readonly dispatch: OutboundDispatch
  readonly attempt: OutboundDispatchAttempt
  readonly transition: OutboundDispatchTransition
  readonly idempotent: boolean
  readonly physicalSendAuthorized: false
}

export interface AttemptTransitionInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly dispatchId: string
  readonly attemptId: string
  readonly expectedStateVersion: number
  readonly expectedAttemptVersion: number
  readonly transitionIdempotencyKey: string
  readonly evidenceReference?: string
  readonly now?: Date
}

export interface UnknownOutcomeInput extends AttemptTransitionInput {
  readonly reason: ReconciliationReason
  readonly notBefore?: Date
}

export interface FailureInput extends AttemptTransitionInput {
  readonly safeErrorCode: string
}

export interface HardFailureInput extends QueueRetryInput {
  readonly attemptId?: string
  readonly expectedAttemptVersion?: number
  readonly safeErrorCode: string
}

export interface ExactProviderConfirmationInput extends AttemptTransitionInput {
  readonly providerMessageId: string
  readonly evidenceReference: string
}

export interface ProviderAbsenceInput extends AttemptTransitionInput {
  readonly evidenceReference: string
}

export interface QueueRetryInput {
  readonly accountId: string
  readonly conversationKey: string
  readonly dispatchId: string
  readonly expectedStateVersion: number
  readonly transitionIdempotencyKey: string
  readonly evidenceReference: string
  readonly now?: Date
}

export interface DeadLetterInput extends QueueRetryInput {
  readonly maximumAttempts: number
}

export interface TerminalAdvanceInput extends QueueRetryInput {}

export interface DispatchTransitionResult {
  readonly dispatch: OutboundDispatch
  readonly attempt: OutboundDispatchAttempt | null
  readonly transition: OutboundDispatchTransition
  readonly reconciliationTask: OutboundReconciliationTask | null
  readonly lane: OutboundDispatchLane | null
  readonly idempotent: boolean
  readonly physicalSendAuthorized: false
}

export interface DispatchPage {
  readonly dispatches: readonly OutboundDispatch[]
  readonly nextSequence: number
}

export interface ReconciliationPage {
  readonly tasks: readonly OutboundReconciliationTask[]
  readonly nextOpenedAt: Date | null
  readonly nextReconciliationId: string | null
}

export interface RecoverStaleDispatchesInput {
  readonly now: Date
  readonly limit: number
}

export interface RecoveryResult {
  readonly recoveredPreAction: number
  readonly openedReconciliation: number
  readonly unchanged: number
}

export interface DispatchLedger {
  createDispatchFromReservation(input: CreateDispatchFromReservationInput): Promise<CreateDispatchResult>
  getDispatch(accountId: string, conversationKey: string, dispatchId: string): Promise<OutboundDispatch | null>
  listDispatchesAfter(accountId: string, conversationKey: string, sequence: number, limit: number): Promise<DispatchPage>
  beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult>
  markPhysicalActionStarted(input: AttemptTransitionInput): Promise<DispatchTransitionResult>
  recordClientActionAccepted(input: AttemptTransitionInput): Promise<DispatchTransitionResult>
  markAwaitingConfirmation(input: AttemptTransitionInput): Promise<DispatchTransitionResult>
  recordUnknownOutcome(input: UnknownOutcomeInput): Promise<DispatchTransitionResult>
  recordPreActionFailure(input: FailureInput): Promise<DispatchTransitionResult>
  recordExactProviderConfirmation(input: ExactProviderConfirmationInput): Promise<DispatchTransitionResult>
  recordProviderAbsenceProven(input: ProviderAbsenceInput): Promise<DispatchTransitionResult>
  queueRetry(input: QueueRetryInput): Promise<DispatchTransitionResult>
  markHardFailed(input: HardFailureInput): Promise<DispatchTransitionResult>
  deadLetter(input: DeadLetterInput): Promise<DispatchTransitionResult>
  resolveTerminalFailureAndAdvance(input: TerminalAdvanceInput): Promise<DispatchTransitionResult>
  recoverStaleDispatches(input: RecoverStaleDispatchesInput): Promise<RecoveryResult>
  listOpenReconciliationTasks(accountId: string, cursor: string | undefined, limit: number): Promise<ReconciliationPage>
}
