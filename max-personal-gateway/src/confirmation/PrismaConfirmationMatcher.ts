import { createHash, randomUUID } from 'node:crypto'
import { recordExactProviderConfirmationInTransaction, recordProviderAbsenceInTransaction } from '../dispatch/transactionalConfirmation.ts'
import { dispatchErrorCode } from '../dispatch/errors.ts'
import type { DispatchLedgerPrismaTransaction } from '../dispatch/PrismaDispatchLedger.ts'
import type { JsonValue } from '../journal/types.ts'
import type { ProviderAbsenceEvidenceInput, ProviderAbsenceEvidenceVerifier } from './absence.ts'
import { DenyAllProviderAbsenceEvidenceVerifier } from './absence.ts'
import {
  MAX_PROVIDER_CONFIRMATION_BATCH_LIMIT,
  MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION,
  MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION,
  MAX_PROVIDER_CONFIRMATION_PAGE_LIMIT,
} from './constants.ts'
import { classifyConfirmationEvidence, type ConfirmationEvidenceDraft, type NormalizedConfirmationSource } from './evidence.ts'
import { asConfirmationDatabaseError, ConfirmationMatcherError, confirmationErrorCode } from './errors.ts'
import type {
  ConfirmationMatcher,
  ConfirmationResolutionPage,
  ProcessConfirmationBatchInput,
  ProcessConfirmationBatchResult,
  ProcessConfirmationResult,
  ProcessNormalizedEventInput,
  ProviderConfirmationCursor,
  ProviderConfirmationEvidence,
  ProviderConfirmationMatchMethod,
  ProviderConfirmationResolution,
  ProviderConfirmationResolutionStatus,
  ReprocessEvidenceInput,
  ResolveAmbiguityInput,
} from './types.ts'

type PrismaDelegate = Record<string, (args: any) => Promise<any>>

export interface ConfirmationMatcherPrismaTransaction extends DispatchLedgerPrismaTransaction {
  readonly maxInboundNormalizedEvent: PrismaDelegate
  readonly maxOutboundCommand: PrismaDelegate
  readonly maxProviderConfirmationEvidence: PrismaDelegate
  readonly maxProviderConfirmationResolution: PrismaDelegate
  readonly maxProviderConfirmationDecision: PrismaDelegate
  readonly maxProviderConfirmationCursor: PrismaDelegate
}

export interface ConfirmationMatcherPrismaClient extends ConfirmationMatcherPrismaTransaction {
  $transaction<T>(operation: (transaction: ConfirmationMatcherPrismaTransaction) => Promise<T>): Promise<T>
}

interface Candidate {
  readonly dispatch: any
  readonly attempt: any
  readonly method: ProviderConfirmationMatchMethod
}

interface FinalizeInput {
  readonly status: ProviderConfirmationResolutionStatus
  readonly method?: ProviderConfirmationMatchMethod
  readonly dispatchId?: string | null
  readonly attemptId?: string | null
  readonly transitionId?: string | null
  readonly canonicalEvidenceId?: string | null
  readonly issueCode?: string | null
  readonly safeIssueSummary?: string | null
  readonly candidateDispatchIds?: readonly string[]
  readonly candidateAttemptIds?: readonly string[]
  readonly actor?: string
  readonly reason: string
  readonly decisionType: string
  readonly resolvedAt?: Date | null
  readonly resolutionReason?: string | null
}

interface DecisionLinks {
  readonly dispatchId?: string | null
  readonly attemptId?: string | null
  readonly transitionId?: string | null
}

const TERMINAL_RESOLUTION = new Set<ProviderConfirmationResolutionStatus>([
  'matched', 'duplicate', 'unmatched', 'ignored', 'quarantined',
])
const SENSITIVE = /(authorization|cookie|bearer|token|secret|password|session|signed[_-]?url|private[_-]?key|https?:\/\/|wss?:\/\/)/i

function required(value: string, field: string, maximum = 256): void {
  if (value.length < 1 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ConfirmationMatcherError('INVALID_INPUT', `${field} is invalid`)
  }
}

function identifier(value: string, field: string, maximum = 256): void {
  required(value, field, maximum)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new ConfirmationMatcherError('INVALID_INPUT', `${field} must be an opaque identifier`)
  }
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ConfirmationMatcherError('INVALID_INPUT', `${field} must be nonnegative`)
}

function validDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new ConfirmationMatcherError('INVALID_INPUT', `${field} is invalid`)
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function safeMetadata(value: JsonValue): JsonValue {
  const serialized = canonical(value)
  if (Buffer.byteLength(serialized, 'utf8') > 16_384 || SENSITIVE.test(serialized)
    || /"(?:text|message|caption|phone|contactName)"\s*:/i.test(serialized)) {
    throw new ConfirmationMatcherError('INVALID_INPUT', 'Confirmation metadata is not a bounded safe allowlist')
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function asEvidence(row: any): ProviderConfirmationEvidence {
  return deepFreeze({ ...row, safeMetadata: row.safeMetadata as JsonValue }) as ProviderConfirmationEvidence
}

function asResolution(row: any): ProviderConfirmationResolution {
  return deepFreeze({
    ...row,
    candidateDispatchIds: row.candidateDispatchIds as JsonValue,
    candidateAttemptIds: row.candidateAttemptIds as JsonValue,
  }) as ProviderConfirmationResolution
}

function asCursor(row: any): ProviderConfirmationCursor {
  return deepFreeze({ ...row }) as ProviderConfirmationCursor
}

function prismaCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function sourceFromRow(row: any): NormalizedConfirmationSource {
  return {
    normalizedEventId: row.normalizedEventId,
    accountId: row.accountId,
    sourceObservationId: row.sourceObservationId,
    sourceJournalSequence: row.sourceJournalSequence,
    eventOrdinal: row.eventOrdinal,
    eventKind: row.eventKind,
    direction: row.direction,
    origin: row.origin,
    providerMessageId: row.providerMessageId,
    providerUserId: row.providerUserId,
    protocolChatId: row.protocolChatId,
    webRouteId: row.webRouteId,
    clientMessageId: row.clientMessageId,
    targetProviderMessageId: row.targetProviderMessageId,
    providerOccurredAt: row.providerOccurredAt,
    normalizedPayload: row.normalizedPayload as JsonValue,
    semanticSha256: row.semanticSha256,
  }
}

function stringArray(value: JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value))
}

export interface PrismaConfirmationMatcherOptions {
  readonly clock?: () => Date
  readonly idGenerator?: () => string
  readonly absenceVerifier?: ProviderAbsenceEvidenceVerifier
}

export class PrismaConfirmationMatcher implements ConfirmationMatcher {
  readonly #client: ConfirmationMatcherPrismaClient
  readonly #clock: () => Date
  readonly #idGenerator: () => string
  readonly #absenceVerifier: ProviderAbsenceEvidenceVerifier

  constructor(client: ConfirmationMatcherPrismaClient, options: PrismaConfirmationMatcherOptions = {}) {
    this.#client = client
    this.#clock = options.clock ?? (() => new Date())
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#absenceVerifier = options.absenceVerifier ?? new DenyAllProviderAbsenceEvidenceVerifier()
  }

  async #decision(
    transaction: ConfirmationMatcherPrismaTransaction,
    resolution: any,
    sequence: number,
    type: string,
    fromStatus: ProviderConfirmationResolutionStatus | null,
    toStatus: ProviderConfirmationResolutionStatus,
    actor: string,
    reason: string,
    resolutionVersionBefore: number,
    resolutionVersionAfter: number,
    links: DecisionLinks,
    metadata: JsonValue,
    now: Date,
  ): Promise<void> {
    required(actor, 'actor')
    required(reason, 'reason', 512)
    const safe = safeMetadata(metadata)
    await transaction.maxProviderConfirmationDecision.create({
      data: {
        decisionId: this.#idGenerator(), resolutionId: resolution.resolutionId,
        evidenceId: resolution.evidenceId, accountId: resolution.accountId,
        decisionSequence: sequence, matcherVersion: resolution.matcherVersion, decisionType: type,
        fromStatus, toStatus, dispatchId: links.dispatchId ?? null,
        attemptId: links.attemptId ?? null, transitionId: links.transitionId ?? null,
        actor, reason, resolutionVersionBefore, resolutionVersionAfter,
        decisionSha256: sha256({
          type, fromStatus, toStatus, actor, reason, resolutionVersionBefore,
          resolutionVersionAfter, dispatchId: links.dispatchId ?? null,
          attemptId: links.attemptId ?? null, transitionId: links.transitionId ?? null,
          metadata: safe,
        }), safeMetadata: safe, createdAt: now,
      },
    })
  }

  async #finalize(
    transaction: ConfirmationMatcherPrismaTransaction,
    resolution: any,
    input: FinalizeInput,
    now: Date,
  ): Promise<any> {
    const resolvedAt = input.resolvedAt === undefined
      ? (TERMINAL_RESOLUTION.has(input.status) ? now : null)
      : input.resolvedAt
    const changed = await transaction.maxProviderConfirmationResolution.updateMany({
      where: {
        resolutionId: resolution.resolutionId,
        status: resolution.status,
        resolutionVersion: resolution.resolutionVersion,
      },
      data: {
        status: input.status,
        matchMethod: input.method ?? 'none',
        dispatchId: input.dispatchId ?? null,
        attemptId: input.attemptId ?? null,
        transitionId: input.transitionId ?? null,
        canonicalEvidenceId: input.canonicalEvidenceId ?? null,
        issueCode: input.issueCode ?? null,
        safeIssueSummary: input.safeIssueSummary ?? null,
        candidateDispatchIds: [...(input.candidateDispatchIds ?? [])],
        candidateAttemptIds: [...(input.candidateAttemptIds ?? [])],
        resolutionVersion: { increment: 1 },
        nextRetryAt: input.status === 'deferred' ? new Date(now.valueOf() + 30_000) : null,
        resolvedAt,
        resolvedBy: input.actor ?? null,
        resolutionReason: input.resolutionReason ?? null,
      },
    })
    if (changed.count !== 1) throw new ConfirmationMatcherError('STALE_RESOLUTION_VERSION', 'Resolution changed concurrently')
    await this.#decision(
      transaction, resolution, resolution.resolutionVersion + 2, input.decisionType,
      resolution.status, input.status, input.actor ?? 'matcher', input.reason,
      resolution.resolutionVersion, resolution.resolutionVersion + 1,
      { dispatchId: input.dispatchId, attemptId: input.attemptId, transitionId: input.transitionId },
      {
        dispatchId: input.dispatchId ?? null,
        attemptId: input.attemptId ?? null,
        issueCode: input.issueCode ?? null,
        candidateCount: (input.candidateDispatchIds ?? []).length,
      },
      now,
    )
    const updated = await transaction.maxProviderConfirmationResolution.findUnique({
      where: { resolutionId: resolution.resolutionId },
    })
    if (updated === null) throw new ConfirmationMatcherError('DATABASE_FAILURE', 'Resolution disappeared')
    return updated
  }

  async #candidateSets(
    transaction: ConfirmationMatcherPrismaTransaction,
    evidence: any,
  ): Promise<{
    readonly provider: Candidate[]
    readonly correlation: Candidate[]
    readonly client: Candidate[]
  }> {
    const providerDispatches = evidence.providerMessageId === null ? [] : await transaction.maxOutboundDispatch.findMany({
      where: { accountId: evidence.accountId, providerMessageId: evidence.providerMessageId },
    })
    const correlationAttempts = evidence.attemptCorrelationId === null ? [] : await transaction.maxOutboundDispatchAttempt.findMany({
      where: { accountId: evidence.accountId, attemptCorrelationId: evidence.attemptCorrelationId },
    })
    const clientCommands = evidence.clientMessageId === null ? [] : await transaction.maxOutboundCommand.findMany({
      where: { accountId: evidence.accountId, clientMessageId: evidence.clientMessageId },
    })
    const clientDispatches = clientCommands.length === 0 ? [] : await transaction.maxOutboundDispatch.findMany({
      where: { accountId: evidence.accountId, commandId: { in: clientCommands.map((row: any) => row.commandId) } },
    })
    const correlation: Candidate[] = []
    for (const attempt of correlationAttempts) {
      const dispatch = await transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: attempt.dispatchId } })
      if (dispatch !== null) correlation.push({ dispatch, attempt, method: 'attempt_correlation_id' })
    }
    const provider: Candidate[] = []
    for (const dispatch of providerDispatches) {
      const attempt = dispatch.currentAttemptId === null ? null
        : await transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: dispatch.currentAttemptId } })
      if (attempt !== null) provider.push({ dispatch, attempt, method: 'existing_provider_message_id' })
    }
    const client: Candidate[] = []
    for (const dispatch of clientDispatches) {
      const attempt = dispatch.currentAttemptId === null ? null
        : await transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: dispatch.currentAttemptId } })
      if (attempt !== null) client.push({ dispatch, attempt, method: 'client_message_id' })
    }
    return { provider, correlation, client }
  }

  #routeIssue(evidence: any, candidate: Candidate): string | null {
    if (evidence.protocolChatId !== null && evidence.protocolChatId !== candidate.attempt.protocolChatId) {
      return 'PROTOCOL_CHAT_ID_MISMATCH'
    }
    if (evidence.providerUserId !== null && evidence.providerUserId !== candidate.attempt.providerUserId) {
      return 'PROVIDER_USER_ID_MISMATCH'
    }
    return null
  }

  async #canonicalEvidenceId(
    transaction: ConfirmationMatcherPrismaTransaction,
    dispatchId: string,
    fallback: string,
  ): Promise<string> {
    const canonical = await transaction.maxProviderConfirmationResolution.findFirst({
      where: { dispatchId, status: 'matched' },
      orderBy: { createdAt: 'asc' },
    })
    return canonical?.canonicalEvidenceId ?? canonical?.evidenceId ?? fallback
  }

  async #resolveEvidence(
    transaction: ConfirmationMatcherPrismaTransaction,
    evidence: any,
    resolution: any,
    draft: ConfirmationEvidenceDraft,
    now: Date,
    selected?: { readonly dispatchId: string; readonly attemptId: string; readonly actor: string; readonly reason: string },
  ): Promise<{ readonly resolution: any; readonly canonicalEffectApplied: boolean }> {
    if (draft.ignored) {
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'ignored', issueCode: draft.issueCode, safeIssueSummary: 'Normalized event is not provider confirmation evidence',
          reason: 'ineligible_event_kind', decisionType: 'ignored_event',
        }, now),
        canonicalEffectApplied: false,
      }
    }
    if (draft.issueCode !== null && !['recipient_delivery_receipt', 'recipient_read_receipt'].includes(draft.evidenceKind)) {
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'unmatched', issueCode: draft.issueCode, safeIssueSummary: 'Exact provider identity or correlation is unavailable',
          reason: 'exact_identity_unavailable', decisionType: 'unmatched_evidence',
        }, now),
        canonicalEffectApplied: false,
      }
    }

    const sets = await this.#candidateSets(transaction, evidence)
    const correlationIds = new Set(sets.correlation.map(item => item.dispatch.dispatchId))
    const clientIds = new Set(sets.client.map(item => item.dispatch.dispatchId))
    const providerIds = new Set(sets.provider.map(item => item.dispatch.dispatchId))
    const all = new Map<string, Candidate>()
    for (const candidate of [...sets.provider, ...sets.correlation, ...sets.client]) all.set(candidate.dispatch.dispatchId, candidate)

    if (draft.evidenceKind === 'recipient_delivery_receipt' || draft.evidenceKind === 'recipient_read_receipt') {
      if (sets.provider.length !== 1) {
        return {
          resolution: await this.#finalize(transaction, resolution, {
            status: sets.provider.length > 1 ? 'ambiguous' : 'unmatched',
            issueCode: sets.provider.length > 1 ? 'PROVIDER_MESSAGE_ID_AMBIGUOUS' : 'NO_EXISTING_PROVIDER_ID',
            safeIssueSummary: 'Recipient receipt did not resolve to one account-scoped confirmed Dispatch',
            candidateDispatchIds: [...providerIds], candidateAttemptIds: sets.provider.map(item => item.attempt.attemptId),
            reason: 'recipient_receipt_link_only', decisionType: 'receipt_stored_without_dispatch_effect',
          }, now),
          canonicalEffectApplied: false,
        }
      }
      const candidate = sets.provider[0]!
      const canonicalEvidenceId = await this.#canonicalEvidenceId(transaction, candidate.dispatch.dispatchId, evidence.evidenceId)
      const transition = await transaction.maxOutboundDispatchTransition.findFirst({
        where: { dispatchId: candidate.dispatch.dispatchId, eventType: 'provider_confirmed' },
      })
      if (transition === null) {
        return {
          resolution: await this.#finalize(transaction, resolution, {
            status: 'quarantined', method: 'existing_provider_message_id',
            dispatchId: candidate.dispatch.dispatchId, attemptId: candidate.attempt.attemptId,
            issueCode: 'CANONICAL_CONFIRMATION_TRANSITION_MISSING',
            safeIssueSummary: 'Recipient receipt found an inconsistent confirmed Dispatch projection',
            reason: 'recipient_receipt_invariant_failed', decisionType: 'invariant_conflict',
          }, now),
          canonicalEffectApplied: false,
        }
      }
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'matched', method: 'existing_provider_message_id', dispatchId: candidate.dispatch.dispatchId,
          attemptId: candidate.attempt.attemptId, transitionId: transition.transitionId, canonicalEvidenceId,
          reason: 'recipient_receipt_linked_without_state_change', decisionType: 'receipt_linked',
        }, now),
        canonicalEffectApplied: false,
      }
    }

    if (selected === undefined) {
      const exactDisagreement = correlationIds.size > 0 && clientIds.size > 0 && !sameSet(correlationIds, clientIds)
      const providerDisagreement = providerIds.size > 0
        && [...new Set([...correlationIds, ...clientIds])].some(id => !providerIds.has(id))
      if (exactDisagreement || providerDisagreement || all.size > 1) {
        return {
          resolution: await this.#finalize(transaction, resolution, {
            status: 'ambiguous', issueCode: 'CORRELATION_DISAGREEMENT',
            safeIssueSummary: 'Exact confirmation identifiers disagree; no automatic winner selected',
            candidateDispatchIds: [...all.keys()], candidateAttemptIds: [...all.values()].map(item => item.attempt.attemptId),
            reason: 'exact_keys_disagree', decisionType: 'ambiguity_opened',
          }, now),
          canonicalEffectApplied: false,
        }
      }
    }

    let candidate: Candidate | undefined
    if (selected !== undefined) {
      candidate = [...all.values()].find(item => item.dispatch.dispatchId === selected.dispatchId && item.attempt.attemptId === selected.attemptId)
      if (candidate === undefined) throw new ConfirmationMatcherError('INVALID_INPUT', 'Manual selection is not a recorded exact candidate')
    } else {
      candidate = sets.provider[0] ?? sets.correlation[0] ?? sets.client[0]
    }
    if (candidate === undefined) {
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'unmatched', issueCode: 'NO_EXACT_CANDIDATE', safeIssueSummary: 'No account-scoped exact candidate exists',
          reason: 'no_exact_candidate', decisionType: 'unmatched_evidence',
        }, now),
        canonicalEffectApplied: false,
      }
    }

    const routeIssue = this.#routeIssue(evidence, candidate)
    if (routeIssue !== null) {
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'quarantined', method: candidate.method, dispatchId: candidate.dispatch.dispatchId,
          attemptId: candidate.attempt.attemptId, issueCode: routeIssue,
          safeIssueSummary: 'Higher-authority route identity does not match the pinned Attempt',
          reason: 'route_guard_failed', decisionType: 'route_mismatch',
        }, now),
        canonicalEffectApplied: false,
      }
    }

    if (candidate.dispatch.state === 'provider_confirmed') {
      if (candidate.dispatch.providerMessageId !== evidence.providerMessageId) {
        return {
          resolution: await this.#finalize(transaction, resolution, {
            status: 'ambiguous', method: candidate.method, dispatchId: candidate.dispatch.dispatchId,
            attemptId: candidate.attempt.attemptId, issueCode: 'PROVIDER_MESSAGE_ID_CONFLICT',
            safeIssueSummary: 'Dispatch already owns a different exact provider identity',
            candidateDispatchIds: [candidate.dispatch.dispatchId], candidateAttemptIds: [candidate.attempt.attemptId],
            reason: 'provider_identity_conflict', decisionType: 'ambiguity_opened',
          }, now),
          canonicalEffectApplied: false,
        }
      }
      const canonicalEvidenceId = await this.#canonicalEvidenceId(transaction, candidate.dispatch.dispatchId, evidence.evidenceId)
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'duplicate', method: candidate.method, dispatchId: candidate.dispatch.dispatchId,
          attemptId: candidate.attempt.attemptId, canonicalEvidenceId,
          reason: 'canonical_confirmation_already_applied', decisionType: 'duplicate_evidence',
        }, now),
        canonicalEffectApplied: false,
      }
    }

    if (candidate.dispatch.state === 'hard_failed' || candidate.dispatch.state === 'dead_letter') {
      const lane = await transaction.maxOutboundDispatchLane.findUnique({
        where: { accountId_conversationKey: { accountId: evidence.accountId, conversationKey: candidate.dispatch.conversationKey } },
      })
      const advanced = lane !== null && lane.nextPhysicalSequence > candidate.dispatch.commandSequence
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'quarantined', method: candidate.method, dispatchId: candidate.dispatch.dispatchId,
          attemptId: candidate.attempt.attemptId,
          issueCode: advanced ? 'LATE_CONFIRMATION_AFTER_TERMINAL_ADVANCE' : 'TERMINAL_DISPATCH_CONFIRMATION_CONFLICT',
          safeIssueSummary: 'Exact evidence conflicts with an audited terminal Dispatch',
          reason: 'terminal_state_conflict', decisionType: 'terminal_conflict',
        }, now),
        canonicalEffectApplied: false,
      }
    }
    if (candidate.dispatch.state === 'queued' || candidate.dispatch.state === 'retryable_failed') {
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'quarantined', method: candidate.method, dispatchId: candidate.dispatch.dispatchId,
          attemptId: candidate.attempt.attemptId, issueCode: 'CONFIRMATION_WITHOUT_ACTIVE_PHYSICAL_ATTEMPT',
          safeIssueSummary: 'Exact evidence cannot confirm a Dispatch without an active physical Attempt',
          reason: 'physical_attempt_invariant', decisionType: 'invariant_conflict',
        }, now),
        canonicalEffectApplied: false,
      }
    }
    if (candidate.dispatch.state === 'dispatching'
      && candidate.attempt.physicalActionStartedAt === null && candidate.attempt.clientActionAcceptedAt === null) {
      return {
        resolution: await this.#finalize(transaction, resolution, {
          status: 'deferred', method: candidate.method, dispatchId: candidate.dispatch.dispatchId,
          attemptId: candidate.attempt.attemptId, issueCode: 'PHYSICAL_MARKER_NOT_YET_DURABLE',
          safeIssueSummary: 'Exact evidence arrived before the physical marker became durable',
          reason: 'temporarily_ineligible', decisionType: 'evidence_deferred', resolvedAt: null,
        }, now),
        canonicalEffectApplied: false,
      }
    }

    const mutation = await recordExactProviderConfirmationInTransaction(transaction, {
        accountId: evidence.accountId,
        conversationKey: candidate.dispatch.conversationKey,
        dispatchId: candidate.dispatch.dispatchId,
        attemptId: candidate.attempt.attemptId,
        expectedStateVersion: candidate.dispatch.stateVersion,
        expectedAttemptVersion: candidate.attempt.attemptVersion,
        transitionIdempotencyKey: `confirmation:${evidence.evidenceId}`,
        providerMessageId: evidence.providerMessageId,
        evidenceReference: evidence.evidenceId,
        now,
      }, this.#idGenerator)
    const canonicalEvidenceId = mutation.idempotent
      ? await this.#canonicalEvidenceId(transaction, candidate.dispatch.dispatchId, evidence.evidenceId)
      : evidence.evidenceId
    const manual = selected !== undefined
    return {
      resolution: await this.#finalize(transaction, resolution, {
        status: mutation.idempotent ? 'duplicate' : 'matched',
        method: candidate.method,
        dispatchId: candidate.dispatch.dispatchId,
        attemptId: candidate.attempt.attemptId,
        transitionId: mutation.transition.transitionId,
        canonicalEvidenceId,
        actor: selected?.actor,
        resolutionReason: selected?.reason,
        reason: manual ? 'manual_exact_candidate_selected' : 'exact_candidate_confirmed',
        decisionType: mutation.idempotent ? 'duplicate_evidence' : manual ? 'ambiguity_resolved' : 'canonical_confirmation',
      }, now),
      canonicalEffectApplied: !mutation.idempotent,
    }
  }

  async #createAndResolve(
    transaction: ConfirmationMatcherPrismaTransaction,
    source: NormalizedConfirmationSource,
    matcherVersion: string,
    now: Date,
  ): Promise<ProcessConfirmationResult> {
    const draft = classifyConfirmationEvidence(source)
    const evidence = await transaction.maxProviderConfirmationEvidence.create({
      data: {
        evidenceId: this.#idGenerator(), accountId: source.accountId,
        sourceNormalizedEventId: source.normalizedEventId, sourceObservationId: source.sourceObservationId,
        sourceJournalSequence: source.sourceJournalSequence, sourceEventOrdinal: source.eventOrdinal,
        matcherVersion, evidenceVersion: draft.evidenceVersion, evidenceKind: draft.evidenceKind,
        providerMessageId: draft.providerMessageId, attemptCorrelationId: draft.attemptCorrelationId,
        clientMessageId: draft.clientMessageId, protocolChatId: draft.protocolChatId,
        providerUserId: draft.providerUserId, webRouteId: draft.webRouteId,
        providerOccurredAt: draft.providerOccurredAt, evidenceSha256: draft.evidenceSha256,
        safeMetadata: safeMetadata(draft.safeMetadata), createdAt: now,
      },
    })
    const resolution = await transaction.maxProviderConfirmationResolution.create({
      data: {
        resolutionId: this.#idGenerator(), evidenceId: evidence.evidenceId, accountId: source.accountId,
        matcherVersion, status: 'pending', matchMethod: 'none', candidateDispatchIds: [],
        candidateAttemptIds: [], resolutionVersion: 0, retryCount: 0, createdAt: now, updatedAt: now,
      },
    })
    await this.#decision(
      transaction, resolution, 1, 'evidence_persisted', null, 'pending', 'matcher',
      'physical_normalized_event_persisted', 0, 0, {}, { evidenceKind: draft.evidenceKind }, now,
    )
    const resolved = await this.#resolveEvidence(transaction, evidence, resolution, draft, now)
    return deepFreeze({
      evidence: asEvidence(evidence), resolution: asResolution(resolved.resolution),
      idempotent: false, canonicalEffectApplied: resolved.canonicalEffectApplied,
    })
  }

  async #existing(accountId: string, normalizedEventId: string, matcherVersion: string): Promise<ProcessConfirmationResult | null> {
    const evidence = await this.#client.maxProviderConfirmationEvidence.findUnique({
      where: { accountId_sourceNormalizedEventId_matcherVersion: { accountId, sourceNormalizedEventId: normalizedEventId, matcherVersion } },
    })
    if (evidence === null) return null
    const resolution = await this.#client.maxProviderConfirmationResolution.findUnique({ where: { evidenceId: evidence.evidenceId } })
    if (resolution === null) throw new ConfirmationMatcherError('DATABASE_FAILURE', 'Evidence resolution is missing')
    return deepFreeze({
      evidence: asEvidence(evidence), resolution: asResolution(resolution), idempotent: true,
      canonicalEffectApplied: false,
    })
  }

  async processNormalizedEvent(input: ProcessNormalizedEventInput): Promise<ProcessConfirmationResult> {
    required(input.accountId, 'accountId', 128)
    identifier(input.normalizedEventId, 'normalizedEventId')
    const matcherVersion = input.matcherVersion ?? MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION
    required(matcherVersion, 'matcherVersion', 128)
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    const prior = await this.#existing(input.accountId, input.normalizedEventId, matcherVersion)
    if (prior !== null) return prior
    for (let retry = 0; retry < 4; retry += 1) {
      try {
        return await this.#client.$transaction(async transaction => {
          const event = await transaction.maxInboundNormalizedEvent.findUnique({ where: { normalizedEventId: input.normalizedEventId } })
          if (event === null || event.accountId !== input.accountId) {
            throw new ConfirmationMatcherError('NOT_FOUND', 'Account-scoped normalized event was not found')
          }
          return this.#createAndResolve(transaction, sourceFromRow(event), matcherVersion, now)
        })
      } catch (error) {
        const existing = await this.#existing(input.accountId, input.normalizedEventId, matcherVersion)
        if (existing !== null) return existing
        const ledgerCode = dispatchErrorCode(error)
        if ((prismaCode(error) === 'P2002' || prismaCode(error) === 'P2034'
          || ledgerCode === 'FIFO_BLOCKED' || ledgerCode === 'STALE_DISPATCH_VERSION'
          || ledgerCode === 'STALE_ATTEMPT_VERSION' || ledgerCode === 'INVALID_TRANSITION') && retry < 3) continue
        throw asConfirmationDatabaseError(error)
      }
    }
    throw new ConfirmationMatcherError('DATABASE_FAILURE', 'Confirmation processing retries were exhausted')
  }

  async getEvidence(accountId: string, evidenceId: string): Promise<ProviderConfirmationEvidence | null> {
    required(accountId, 'accountId', 128)
    identifier(evidenceId, 'evidenceId')
    try {
      const row = await this.#client.maxProviderConfirmationEvidence.findUnique({ where: { evidenceId } })
      return row === null || row.accountId !== accountId ? null : asEvidence(row)
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  async getResolution(accountId: string, evidenceId: string): Promise<ProviderConfirmationResolution | null> {
    required(accountId, 'accountId', 128)
    identifier(evidenceId, 'evidenceId')
    try {
      const row = await this.#client.maxProviderConfirmationResolution.findUnique({ where: { evidenceId } })
      return row === null || row.accountId !== accountId ? null : asResolution(row)
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  async #list(
    status: 'unmatched' | 'deferred' | 'ambiguous',
    accountId: string,
    matcherVersion: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<ConfirmationResolutionPage> {
    required(accountId, 'accountId', 128)
    required(matcherVersion, 'matcherVersion', 128)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROVIDER_CONFIRMATION_PAGE_LIMIT) {
      throw new ConfirmationMatcherError('INVALID_INPUT', `limit must be between 1 and ${MAX_PROVIDER_CONFIRMATION_PAGE_LIMIT}`)
    }
    let cursorDate: Date | undefined
    let cursorId: string | undefined
    if (cursor !== undefined) {
      const separator = cursor.lastIndexOf('|')
      if (separator < 1) throw new ConfirmationMatcherError('INVALID_INPUT', 'Resolution cursor is invalid')
      cursorDate = new Date(cursor.slice(0, separator))
      cursorId = cursor.slice(separator + 1)
      validDate(cursorDate, 'cursor')
      identifier(cursorId, 'cursorId')
    }
    try {
      const rows = await this.#client.maxProviderConfirmationResolution.findMany({
        where: {
          accountId, matcherVersion, status,
          ...(cursorDate === undefined ? {} : {
            OR: [{ createdAt: { gt: cursorDate } }, { createdAt: cursorDate, resolutionId: { gt: cursorId } }],
          }),
        },
        orderBy: [{ createdAt: 'asc' }, { resolutionId: 'asc' }], take: limit,
      })
      const resolutions = rows.map(asResolution)
      const last = resolutions.at(-1)
      return deepFreeze({ resolutions, nextCreatedAt: last?.createdAt ?? null, nextResolutionId: last?.resolutionId ?? null })
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  listUnmatched(accountId: string, matcherVersion: string, cursor: string | undefined, limit: number): Promise<ConfirmationResolutionPage> {
    return this.#list('unmatched', accountId, matcherVersion, cursor, limit)
  }

  listDeferred(accountId: string, matcherVersion: string, cursor: string | undefined, limit: number): Promise<ConfirmationResolutionPage> {
    return this.#list('deferred', accountId, matcherVersion, cursor, limit)
  }

  listAmbiguous(accountId: string, matcherVersion: string, cursor: string | undefined, limit: number): Promise<ConfirmationResolutionPage> {
    return this.#list('ambiguous', accountId, matcherVersion, cursor, limit)
  }

  async #resetForReprocess(transaction: ConfirmationMatcherPrismaTransaction, resolution: any, now: Date): Promise<any> {
    const changed = await transaction.maxProviderConfirmationResolution.updateMany({
      where: { resolutionId: resolution.resolutionId, status: resolution.status, resolutionVersion: resolution.resolutionVersion },
      data: {
        status: 'pending', matchMethod: 'none', dispatchId: null, attemptId: null, transitionId: null,
        canonicalEvidenceId: null, issueCode: null, safeIssueSummary: null, candidateDispatchIds: [],
        candidateAttemptIds: [], resolutionVersion: { increment: 1 }, retryCount: { increment: 1 },
        nextRetryAt: null, resolvedAt: null, resolvedBy: null, resolutionReason: null,
      },
    })
    if (changed.count !== 1) throw new ConfirmationMatcherError('STALE_RESOLUTION_VERSION', 'Resolution changed concurrently')
    await this.#decision(
      transaction, resolution, resolution.resolutionVersion + 2, 'reprocess_started', resolution.status,
      'pending', 'matcher', 'durable_evidence_reprocessing',
      resolution.resolutionVersion, resolution.resolutionVersion + 1, {},
      { retryCount: resolution.retryCount + 1 }, now,
    )
    return transaction.maxProviderConfirmationResolution.findUnique({ where: { resolutionId: resolution.resolutionId } })
  }

  async reprocessEvidence(input: ReprocessEvidenceInput): Promise<ProcessConfirmationResult> {
    required(input.accountId, 'accountId', 128)
    identifier(input.evidenceId, 'evidenceId')
    nonNegativeInteger(input.expectedResolutionVersion, 'expectedResolutionVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const [evidence, resolution, event] = await Promise.all([
          transaction.maxProviderConfirmationEvidence.findUnique({ where: { evidenceId: input.evidenceId } }),
          transaction.maxProviderConfirmationResolution.findUnique({ where: { evidenceId: input.evidenceId } }),
          transaction.maxInboundNormalizedEvent.findFirst({ where: { accountId: input.accountId, confirmationEvidence: { some: { evidenceId: input.evidenceId } } } }),
        ])
        if (evidence === null || resolution === null || event === null || evidence.accountId !== input.accountId) {
          throw new ConfirmationMatcherError('NOT_FOUND', 'Account-scoped evidence was not found')
        }
        if (!['deferred', 'unmatched'].includes(resolution.status)) {
          throw new ConfirmationMatcherError('INVALID_INPUT', 'Only deferred or unmatched evidence may be reprocessed')
        }
        if (resolution.resolutionVersion !== input.expectedResolutionVersion) {
          throw new ConfirmationMatcherError('STALE_RESOLUTION_VERSION', 'Resolution version is stale')
        }
        const pending = await this.#resetForReprocess(transaction, resolution, now)
        const resolved = await this.#resolveEvidence(transaction, evidence, pending, classifyConfirmationEvidence(sourceFromRow(event)), now)
        return deepFreeze({
          evidence: asEvidence(evidence), resolution: asResolution(resolved.resolution),
          idempotent: false, canonicalEffectApplied: resolved.canonicalEffectApplied,
        })
      })
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  async resolveAmbiguity(input: ResolveAmbiguityInput): Promise<ProcessConfirmationResult> {
    required(input.accountId, 'accountId', 128)
    identifier(input.evidenceId, 'evidenceId')
    identifier(input.selectedDispatchId, 'selectedDispatchId')
    identifier(input.selectedAttemptId, 'selectedAttemptId')
    required(input.actor, 'actor')
    required(input.reason, 'reason', 512)
    nonNegativeInteger(input.expectedResolutionVersion, 'expectedResolutionVersion')
    const now = input.now ?? this.#clock()
    try {
      return await this.#client.$transaction(async transaction => {
        const [evidence, resolution, event] = await Promise.all([
          transaction.maxProviderConfirmationEvidence.findUnique({ where: { evidenceId: input.evidenceId } }),
          transaction.maxProviderConfirmationResolution.findUnique({ where: { evidenceId: input.evidenceId } }),
          transaction.maxInboundNormalizedEvent.findFirst({ where: { accountId: input.accountId, confirmationEvidence: { some: { evidenceId: input.evidenceId } } } }),
        ])
        if (evidence === null || resolution === null || event === null || evidence.accountId !== input.accountId) {
          throw new ConfirmationMatcherError('NOT_FOUND', 'Account-scoped ambiguity was not found')
        }
        if (resolution.status !== 'ambiguous' || resolution.resolutionVersion !== input.expectedResolutionVersion) {
          throw new ConfirmationMatcherError('STALE_RESOLUTION_VERSION', 'Ambiguity version is stale')
        }
        if (!stringArray(resolution.candidateDispatchIds as JsonValue).includes(input.selectedDispatchId)
          || !stringArray(resolution.candidateAttemptIds as JsonValue).includes(input.selectedAttemptId)) {
          throw new ConfirmationMatcherError('INVALID_INPUT', 'Manual selection is not present in the durable ambiguity')
        }
        const pending = await this.#resetForReprocess(transaction, resolution, now)
        const resolved = await this.#resolveEvidence(
          transaction, evidence, pending, classifyConfirmationEvidence(sourceFromRow(event)), now,
          { dispatchId: input.selectedDispatchId, attemptId: input.selectedAttemptId, actor: input.actor, reason: input.reason },
        )
        return deepFreeze({
          evidence: asEvidence(evidence), resolution: asResolution(resolved.resolution),
          idempotent: false, canonicalEffectApplied: resolved.canonicalEffectApplied,
        })
      })
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  async recordExactProviderAbsence(input: ProviderAbsenceEvidenceInput): Promise<ProcessConfirmationResult> {
    required(input.accountId, 'accountId', 128)
    identifier(input.normalizedEventId, 'normalizedEventId')
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.attemptId, 'attemptId')
    required(input.absenceReference, 'absenceReference', 512)
    nonNegativeInteger(input.expectedStateVersion, 'expectedStateVersion')
    nonNegativeInteger(input.expectedAttemptVersion, 'expectedAttemptVersion')
    const verified = await this.#absenceVerifier.verify(input)
    if (verified === null || verified.accountId !== input.accountId || verified.dispatchId !== input.dispatchId
      || verified.attemptId !== input.attemptId || verified.absenceReference !== input.absenceReference) {
      throw new ConfirmationMatcherError('ABSENCE_EVIDENCE_DENIED', 'Provider absence verifier denied the evidence')
    }
    validDate(verified.verifiedAt, 'verifiedAt')
    required(verified.verifierVersion, 'verifierVersion', 128)
    const now = input.now ?? this.#clock()
    try {
      return await this.#client.$transaction(async transaction => {
        const [event, dispatch, attempt] = await Promise.all([
          transaction.maxInboundNormalizedEvent.findUnique({ where: { normalizedEventId: input.normalizedEventId } }),
          transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } }),
          transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } }),
        ])
        if (event === null || dispatch === null || attempt === null || event.accountId !== input.accountId
          || dispatch.accountId !== input.accountId || attempt.accountId !== input.accountId || attempt.dispatchId !== input.dispatchId) {
          throw new ConfirmationMatcherError('NOT_FOUND', 'Account-scoped absence target was not found')
        }
        const evidence = await transaction.maxProviderConfirmationEvidence.create({
          data: {
            evidenceId: this.#idGenerator(), accountId: input.accountId,
            sourceNormalizedEventId: event.normalizedEventId, sourceObservationId: event.sourceObservationId,
            sourceJournalSequence: event.sourceJournalSequence, sourceEventOrdinal: event.eventOrdinal,
            matcherVersion: MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION,
            evidenceVersion: MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION, evidenceKind: 'provider_absence',
            evidenceSha256: sha256({
              accountId: input.accountId, normalizedEventId: input.normalizedEventId,
              dispatchId: input.dispatchId, attemptId: input.attemptId,
              absenceReference: input.absenceReference, verifierVersion: verified.verifierVersion,
            }),
            safeMetadata: safeMetadata({ verifierVersion: verified.verifierVersion, verifiedAt: verified.verifiedAt.toISOString() }),
            createdAt: now,
          },
        })
        const resolution = await transaction.maxProviderConfirmationResolution.create({
          data: {
            resolutionId: this.#idGenerator(), evidenceId: evidence.evidenceId, accountId: input.accountId,
            matcherVersion: MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION, status: 'pending', matchMethod: 'none',
            candidateDispatchIds: [input.dispatchId], candidateAttemptIds: [input.attemptId],
            resolutionVersion: 0, retryCount: 0, createdAt: now, updatedAt: now,
          },
        })
        await this.#decision(transaction, resolution, 1, 'absence_evidence_persisted', null, 'pending',
          'matcher', 'verified_exact_absence_evidence', 0, 0, {},
          { verifierVersion: verified.verifierVersion }, now)
        const mutation = await recordProviderAbsenceInTransaction(transaction, {
          accountId: input.accountId, conversationKey: dispatch.conversationKey,
          dispatchId: input.dispatchId, attemptId: input.attemptId,
          expectedStateVersion: input.expectedStateVersion, expectedAttemptVersion: input.expectedAttemptVersion,
          transitionIdempotencyKey: `absence:${evidence.evidenceId}`,
          evidenceReference: input.absenceReference, now,
        }, this.#idGenerator)
        const resolved = await this.#finalize(transaction, resolution, {
          status: 'matched', method: 'provider_absence_reference', dispatchId: input.dispatchId,
          attemptId: input.attemptId, transitionId: mutation.transition.transitionId,
          canonicalEvidenceId: evidence.evidenceId, reason: 'verified_provider_absence',
          decisionType: 'provider_absence_applied',
        }, now)
        return deepFreeze({
          evidence: asEvidence(evidence), resolution: asResolution(resolved),
          idempotent: mutation.idempotent, canonicalEffectApplied: !mutation.idempotent,
        })
      })
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  async getCursor(consumerId: string, accountId: string, matcherVersion: string): Promise<ProviderConfirmationCursor | null> {
    required(consumerId, 'consumerId')
    required(accountId, 'accountId', 128)
    required(matcherVersion, 'matcherVersion', 128)
    try {
      const row = await this.#client.maxProviderConfirmationCursor.findUnique({
        where: { consumerId_accountId_matcherVersion: { consumerId, accountId, matcherVersion } },
      })
      return row === null ? null : asCursor(row)
    } catch (error) {
      throw asConfirmationDatabaseError(error)
    }
  }

  async #ensureCursor(consumerId: string, accountId: string, matcherVersion: string): Promise<ProviderConfirmationCursor> {
    const existing = await this.getCursor(consumerId, accountId, matcherVersion)
    if (existing !== null) return existing
    try {
      const now = this.#clock()
      const row = await this.#client.maxProviderConfirmationCursor.create({
        data: {
          cursorId: this.#idGenerator(), consumerId, accountId, matcherVersion,
          lastJournalSequence: 0n, lastEventOrdinal: 0, optimisticVersion: 0,
          createdAt: now, updatedAt: now,
        },
      })
      return asCursor(row)
    } catch (error) {
      if (prismaCode(error) === 'P2002') {
        const raced = await this.getCursor(consumerId, accountId, matcherVersion)
        if (raced !== null) return raced
      }
      throw asConfirmationDatabaseError(error)
    }
  }

  async processBatch(input: ProcessConfirmationBatchInput): Promise<ProcessConfirmationBatchResult> {
    required(input.consumerId, 'consumerId')
    required(input.accountId, 'accountId', 128)
    const matcherVersion = input.matcherVersion ?? MAX_PROVIDER_CONFIRMATION_MATCHER_VERSION
    required(matcherVersion, 'matcherVersion', 128)
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PROVIDER_CONFIRMATION_BATCH_LIMIT) {
      throw new ConfirmationMatcherError('INVALID_INPUT', `limit must be between 1 and ${MAX_PROVIDER_CONFIRMATION_BATCH_LIMIT}`)
    }
    let cursor = await this.#ensureCursor(input.consumerId, input.accountId, matcherVersion)
    const events = await this.#client.maxInboundNormalizedEvent.findMany({
      where: {
        accountId: input.accountId,
        OR: [
          { sourceJournalSequence: { gt: cursor.lastJournalSequence } },
          { sourceJournalSequence: cursor.lastJournalSequence, eventOrdinal: { gt: cursor.lastEventOrdinal } },
        ],
      },
      orderBy: [{ sourceJournalSequence: 'asc' }, { eventOrdinal: 'asc' }],
      take: input.limit,
    })
    const counts: Record<ProviderConfirmationResolutionStatus, number> = {
      pending: 0, matched: 0, duplicate: 0, deferred: 0, ambiguous: 0, unmatched: 0, ignored: 0, quarantined: 0,
    }
    for (const event of events) {
      const result = await this.processNormalizedEvent({
        accountId: input.accountId, normalizedEventId: event.normalizedEventId, matcherVersion,
      })
      counts[result.resolution.status] += 1
      const next = await this.#client.$transaction(async transaction => {
        const changed = await transaction.maxProviderConfirmationCursor.updateMany({
          where: {
            cursorId: cursor.cursorId,
            optimisticVersion: cursor.optimisticVersion,
            lastJournalSequence: cursor.lastJournalSequence,
            lastEventOrdinal: cursor.lastEventOrdinal,
          },
          data: {
            lastJournalSequence: event.sourceJournalSequence,
            lastEventOrdinal: event.eventOrdinal,
            optimisticVersion: { increment: 1 },
          },
        })
        if (changed.count !== 1) throw new ConfirmationMatcherError('CURSOR_CONFLICT', 'Confirmation cursor advanced concurrently')
        return transaction.maxProviderConfirmationCursor.findUnique({ where: { cursorId: cursor.cursorId } })
      })
      if (next === null) throw new ConfirmationMatcherError('DATABASE_FAILURE', 'Confirmation cursor disappeared')
      cursor = asCursor(next)
    }
    return deepFreeze({
      processed: events.length,
      matched: counts.matched,
      duplicate: counts.duplicate,
      deferred: counts.deferred,
      ambiguous: counts.ambiguous,
      unmatched: counts.unmatched,
      ignored: counts.ignored,
      quarantined: counts.quarantined,
      cursor,
    })
  }
}
