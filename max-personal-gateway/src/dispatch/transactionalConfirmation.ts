import { createHash } from 'node:crypto'
import type { JsonValue } from '../journal/types.ts'
import { DISPATCH_EVIDENCE_VERSION } from './constants.ts'
import { DispatchLedgerError } from './errors.ts'
import type { DispatchLedgerPrismaTransaction } from './PrismaDispatchLedger.ts'
import type { DispatchState, ExactProviderConfirmationInput, ProviderAbsenceInput } from './types.ts'

export interface TransactionalDispatchMutationResult {
  readonly transition: any
  readonly idempotent: boolean
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`
}

function evidenceHash(
  eventType: string,
  evidenceKind: string,
  evidenceReference: string,
  details: JsonValue,
): string {
  return createHash('sha256').update(canonical({
    version: DISPATCH_EVIDENCE_VERSION,
    eventType,
    evidenceKind,
    evidenceReference,
    details,
  }), 'utf8').digest('hex')
}

function laneKey(accountId: string, conversationKey: string): Record<string, unknown> {
  return { accountId_conversationKey: { accountId, conversationKey } }
}

async function insertTransition(
  transaction: DispatchLedgerPrismaTransaction,
  dispatch: any,
  attemptId: string,
  input: ExactProviderConfirmationInput | ProviderAbsenceInput,
  toState: DispatchState,
  eventType: string,
  evidenceKind: string,
  details: JsonValue,
  idGenerator: () => string,
): Promise<any> {
  return transaction.maxOutboundDispatchTransition.create({
    data: {
      transitionId: idGenerator(),
      dispatchId: dispatch.dispatchId,
      attemptId,
      accountId: dispatch.accountId,
      conversationKey: dispatch.conversationKey,
      transitionSequence: dispatch.stateVersion + 1,
      transitionIdempotencyKey: input.transitionIdempotencyKey,
      fromState: dispatch.state,
      toState,
      eventType,
      evidenceKind,
      evidenceReference: input.evidenceReference,
      evidenceSha256: evidenceHash(eventType, evidenceKind, input.evidenceReference, details),
      safeEvidenceMetadata: details,
      stateVersionBefore: dispatch.stateVersion,
      stateVersionAfter: dispatch.stateVersion + 1,
      occurredAt: input.now,
    },
  })
}

export async function recordExactProviderConfirmationInTransaction(
  transaction: DispatchLedgerPrismaTransaction,
  input: ExactProviderConfirmationInput & { readonly now: Date },
  idGenerator: () => string,
): Promise<TransactionalDispatchMutationResult> {
  const [dispatch, attempt] = await Promise.all([
    transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } }),
    transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } }),
  ])
  if (dispatch === null || attempt === null || dispatch.accountId !== input.accountId
    || dispatch.conversationKey !== input.conversationKey || attempt.dispatchId !== input.dispatchId
    || attempt.accountId !== input.accountId || attempt.conversationKey !== input.conversationKey) {
    throw new DispatchLedgerError('NOT_FOUND', 'Account-scoped Dispatch Attempt was not found')
  }
  if (dispatch.state === 'provider_confirmed') {
    if (dispatch.providerMessageId !== input.providerMessageId) {
      throw new DispatchLedgerError('PROVIDER_MESSAGE_ID_CONFLICT', 'Dispatch already has another exact provider identity')
    }
    const transition = await transaction.maxOutboundDispatchTransition.findFirst({
      where: { dispatchId: input.dispatchId, eventType: 'provider_confirmed' },
    })
    if (transition === null) throw new DispatchLedgerError('DATABASE_FAILURE', 'Confirmation transition is missing')
    return { transition, idempotent: true }
  }
  if (dispatch.state === 'hard_failed' || dispatch.state === 'dead_letter') {
    throw new DispatchLedgerError('TERMINAL_STATE', 'Exact evidence conflicts with a terminal Dispatch')
  }

  const allowed = (dispatch.state === 'awaiting_confirmation' && attempt.attemptState === 'awaiting_confirmation')
    || (dispatch.state === 'reconciliation_required' && attempt.attemptState === 'outcome_unknown')
    || (dispatch.state === 'sent_to_provider_client' && attempt.attemptState === 'client_action_accepted')
    || (dispatch.state === 'dispatching'
      && ['physical_action_started', 'client_action_accepted'].includes(attempt.attemptState)
      && (attempt.physicalActionStartedAt !== null || attempt.clientActionAcceptedAt !== null))
  if (!allowed) {
    throw new DispatchLedgerError('INVALID_TRANSITION', 'Exact confirmation lacks an eligible physical Attempt state')
  }
  if (dispatch.stateVersion !== input.expectedStateVersion) {
    throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch state version is stale')
  }
  if (attempt.attemptVersion !== input.expectedAttemptVersion) {
    throw new DispatchLedgerError('STALE_ATTEMPT_VERSION', 'Attempt version is stale')
  }
  const lane = await transaction.maxOutboundDispatchLane.findUnique({
    where: laneKey(input.accountId, input.conversationKey),
  })
  if (lane === null || lane.nextPhysicalSequence !== dispatch.commandSequence) {
    throw new DispatchLedgerError('FIFO_BLOCKED', 'Confirmation is not the exact physical FIFO head')
  }

  if (dispatch.state === 'reconciliation_required') {
    const task = await transaction.maxOutboundReconciliationTask.findFirst({
      where: { dispatchId: input.dispatchId, attemptId: input.attemptId, state: 'open' },
    })
    if (task === null) throw new DispatchLedgerError('DATABASE_FAILURE', 'Open reconciliation task is missing')
    const taskChanged = await transaction.maxOutboundReconciliationTask.updateMany({
      where: { reconciliationId: task.reconciliationId, state: 'open', taskVersion: task.taskVersion },
      data: {
        state: 'resolved', taskVersion: { increment: 1 }, resolvedAt: input.now,
        resolutionType: 'exact_provider_confirmation', resolutionEvidenceReference: input.evidenceReference,
      },
    })
    if (taskChanged.count !== 1) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Reconciliation task changed concurrently')
  }

  const attemptChanged = await transaction.maxOutboundDispatchAttempt.updateMany({
    where: {
      attemptId: input.attemptId,
      dispatchId: input.dispatchId,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      attemptVersion: input.expectedAttemptVersion,
      attemptState: attempt.attemptState,
    },
    data: { attemptState: 'provider_confirmed', attemptVersion: { increment: 1 }, completedAt: input.now },
  })
  if (attemptChanged.count !== 1) throw new DispatchLedgerError('STALE_ATTEMPT_VERSION', 'Attempt changed concurrently')
  const dispatchChanged = await transaction.maxOutboundDispatch.updateMany({
    where: {
      dispatchId: input.dispatchId,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      state: dispatch.state,
      stateVersion: input.expectedStateVersion,
      providerMessageId: null,
    },
    data: {
      state: 'provider_confirmed', stateVersion: { increment: 1 }, providerMessageId: input.providerMessageId,
      providerConfirmedAt: input.now, reconciliationRequiredAt: null, terminalAt: input.now,
    },
  })
  if (dispatchChanged.count !== 1) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch changed concurrently')
  const laneChanged = await transaction.maxOutboundDispatchLane.updateMany({
    where: {
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      nextPhysicalSequence: dispatch.commandSequence,
      optimisticVersion: lane.optimisticVersion,
    },
    data: { nextPhysicalSequence: { increment: 1 }, optimisticVersion: { increment: 1 } },
  })
  if (laneChanged.count !== 1) throw new DispatchLedgerError('FIFO_BLOCKED', 'Physical lane changed concurrently')
  const details: JsonValue = { providerMessageId: input.providerMessageId }
  const transition = await insertTransition(
    transaction, dispatch, input.attemptId, input, 'provider_confirmed',
    'provider_confirmed', 'exact_provider_confirmation', details, idGenerator,
  )
  return { transition, idempotent: false }
}

export async function recordProviderAbsenceInTransaction(
  transaction: DispatchLedgerPrismaTransaction,
  input: ProviderAbsenceInput & { readonly now: Date },
  idGenerator: () => string,
): Promise<TransactionalDispatchMutationResult> {
  const [dispatch, attempt, task] = await Promise.all([
    transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } }),
    transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } }),
    transaction.maxOutboundReconciliationTask.findFirst({
      where: { dispatchId: input.dispatchId, attemptId: input.attemptId, state: 'open' },
    }),
  ])
  if (dispatch === null || attempt === null || task === null || dispatch.accountId !== input.accountId
    || dispatch.conversationKey !== input.conversationKey || attempt.dispatchId !== input.dispatchId) {
    throw new DispatchLedgerError('NOT_FOUND', 'Open account-scoped reconciliation was not found')
  }
  const repeated = await transaction.maxOutboundDispatchTransition.findFirst({
    where: {
      accountId: input.accountId,
      dispatchId: input.dispatchId,
      transitionIdempotencyKey: input.transitionIdempotencyKey,
    },
  })
  if (repeated !== null) {
    if (repeated.eventType !== 'provider_absence_proven' || repeated.evidenceReference !== input.evidenceReference) {
      throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Transition idempotency key represents another event')
    }
    return { transition: repeated, idempotent: true }
  }
  if (dispatch.state !== 'reconciliation_required' || attempt.attemptState !== 'outcome_unknown') {
    throw new DispatchLedgerError('INVALID_TRANSITION', 'Provider absence proof is not valid from the current state')
  }
  if (dispatch.stateVersion !== input.expectedStateVersion) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch state version is stale')
  if (attempt.attemptVersion !== input.expectedAttemptVersion) throw new DispatchLedgerError('STALE_ATTEMPT_VERSION', 'Attempt version is stale')
  const taskChanged = await transaction.maxOutboundReconciliationTask.updateMany({
    where: { reconciliationId: task.reconciliationId, state: 'open', taskVersion: task.taskVersion },
    data: {
      state: 'resolved', taskVersion: { increment: 1 }, resolvedAt: input.now,
      resolutionType: 'provider_absence_proven', resolutionEvidenceReference: input.evidenceReference,
    },
  })
  const attemptChanged = await transaction.maxOutboundDispatchAttempt.updateMany({
    where: { attemptId: input.attemptId, attemptState: 'outcome_unknown', attemptVersion: input.expectedAttemptVersion },
    data: { attemptVersion: { increment: 1 }, completedAt: input.now, safeErrorCode: 'PROVIDER_ABSENCE_PROVEN' },
  })
  const dispatchChanged = await transaction.maxOutboundDispatch.updateMany({
    where: { dispatchId: input.dispatchId, state: 'reconciliation_required', stateVersion: input.expectedStateVersion },
    data: { state: 'retryable_failed', stateVersion: { increment: 1 }, reconciliationRequiredAt: null },
  })
  if (taskChanged.count !== 1 || attemptChanged.count !== 1 || dispatchChanged.count !== 1) {
    throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Absence proof raced another transition')
  }
  const details: JsonValue = { exactNegativeEvidence: true }
  const transition = await insertTransition(
    transaction, dispatch, input.attemptId, input, 'retryable_failed',
    'provider_absence_proven', 'provider_absence', details, idGenerator,
  )
  return { transition, idempotent: false }
}
