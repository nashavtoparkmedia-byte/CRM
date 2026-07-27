import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '../journal/types.ts'
import type { RouteRegistry } from '../route/RouteRegistry.ts'
import type { SendableRouteSnapshot } from '../route/types.ts'
import {
  DEFAULT_ATTEMPT_CLAIM_MILLISECONDS,
  DISPATCH_EVIDENCE_VERSION,
  MAX_DISPATCH_CONCURRENCY_RETRIES,
  MAX_DISPATCH_PAGE_LIMIT,
  MAX_RECONCILIATION_PAGE_LIMIT,
} from './constants.ts'
import { asDispatchDatabaseError, DispatchLedgerError, dispatchErrorCode } from './errors.ts'
import { FailClosedSenderAuthorityVerifier, validateSenderAuthorityProof } from './SenderAuthority.ts'
import {
  recordExactProviderConfirmationInTransaction,
  recordProviderAbsenceInTransaction,
} from './transactionalConfirmation.ts'
import type {
  AttemptTransitionInput,
  BeginAttemptInput,
  BeginAttemptResult,
  CreateDispatchFromReservationInput,
  CreateDispatchResult,
  DeadLetterInput,
  DispatchAttemptState,
  DispatchLedger,
  DispatchPage,
  DispatchState,
  DispatchTransitionResult,
  ExactProviderConfirmationInput,
  FailureInput,
  HardFailureInput,
  OutboundDispatch,
  OutboundDispatchAttempt,
  OutboundDispatchLane,
  OutboundDispatchTransition,
  OutboundReconciliationTask,
  ProviderAbsenceInput,
  QueueRetryInput,
  ReconciliationPage,
  ReconciliationReason,
  RecoverStaleDispatchesInput,
  RecoveryResult,
  SenderAuthorityVerifier,
  TerminalAdvanceInput,
  UnknownOutcomeInput,
} from './types.ts'

type PrismaDelegate = Record<string, (args: any) => Promise<any>>

export interface DispatchLedgerPrismaTransaction {
  readonly maxOutboundCommand: PrismaDelegate
  readonly maxOutboundConversationActor: PrismaDelegate
  readonly maxOutboundCommandReservation: PrismaDelegate
  readonly maxOutboundDispatch: PrismaDelegate
  readonly maxOutboundDispatchLane: PrismaDelegate
  readonly maxOutboundDispatchAttempt: PrismaDelegate
  readonly maxOutboundDispatchTransition: PrismaDelegate
  readonly maxOutboundReconciliationTask: PrismaDelegate
}

export interface DispatchLedgerPrismaClient extends DispatchLedgerPrismaTransaction {
  $transaction<T>(operation: (transaction: DispatchLedgerPrismaTransaction) => Promise<T>): Promise<T>
}

interface TransitionSpec {
  readonly attemptId: string | null
  readonly fromState: DispatchState | null
  readonly toState: DispatchState
  readonly eventType: string
  readonly evidenceKind: string
  readonly evidenceReference: string | null
  readonly metadata: JsonValue
  readonly idempotencyKey: string
  readonly occurredAt: Date
}

interface AttemptMutationSpec {
  readonly dispatchStates: readonly DispatchState[]
  readonly attemptStates: readonly DispatchAttemptState[]
  readonly toDispatchState: DispatchState
  readonly toAttemptState: DispatchAttemptState
  readonly eventType: string
  readonly evidenceKind: string
  readonly evidenceReference: string | null
  readonly metadata: JsonValue
  readonly attemptData: Record<string, unknown>
  readonly dispatchData?: Record<string, unknown>
  readonly reconciliation?: { reason: ReconciliationReason; notBefore: Date | null }
}

const TERMINAL_STATES: readonly DispatchState[] = ['provider_confirmed', 'hard_failed', 'dead_letter']
const SENSITIVE = /(authorization|cookie|token|secret|password|signed[_-]?url|https?:\/\/|wss?:\/\/)/i

function required(value: string, label: string, maximum = 256): void {
  if (value.length < 1 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DispatchLedgerError('INVALID_INPUT', `${label} is invalid`)
  }
}

function identifier(value: string, label: string, maximum = 256): void {
  required(value, label, maximum)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new DispatchLedgerError('INVALID_INPUT', `${label} must be an opaque identifier`)
  }
}

function evidenceReference(value: string | undefined, label = 'evidenceReference'): string | null {
  if (value === undefined) return null
  required(value, label, 512)
  if (SENSITIVE.test(value)) throw new DispatchLedgerError('INVALID_INPUT', `${label} is not safe evidence`)
  return value
}

function validDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new DispatchLedgerError('INVALID_INPUT', `${label} must be a valid date`)
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DispatchLedgerError('INVALID_INPUT', `${label} must be a nonnegative integer`)
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DispatchLedgerError('INVALID_INPUT', `${label} must be a positive integer`)
  }
}

function validReconciliationReason(value: ReconciliationReason): void {
  if (!['outcome_unknown', 'timeout', 'restart_post_action', 'restart_client_accepted',
    'restart_awaiting_confirmation'].includes(value)) {
    throw new DispatchLedgerError('INVALID_INPUT', 'reason is invalid')
  }
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function routeEvidence(route: SendableRouteSnapshot): { readonly evidence: JsonValue; readonly hash: string } {
  nonNegativeInteger(route.routeVersion, 'routeVersion')
  required(route.activeProtocolChatId, 'activeProtocolChatId', 512)
  if (route.activeProviderUserId !== undefined) required(route.activeProviderUserId, 'activeProviderUserId', 512)
  if (route.activeWebRouteId !== undefined) required(route.activeWebRouteId, 'activeWebRouteId', 512)
  if (route.evidenceReferences.length > 64) throw new DispatchLedgerError('ROUTE_NOT_SENDABLE', 'Route evidence is not bounded')
  const references = [...route.evidenceReferences]
  for (const reference of references) evidenceReference(reference, 'routeEvidenceReference')
  const evidence: JsonValue = {
    version: DISPATCH_EVIDENCE_VERSION,
    routeVersion: route.routeVersion,
    protocolChatId: route.activeProtocolChatId,
    providerUserId: route.activeProviderUserId ?? null,
    webRouteId: route.activeWebRouteId ?? null,
    evidenceReferences: references,
  }
  if (Buffer.byteLength(canonical(evidence), 'utf8') > 32_768) {
    throw new DispatchLedgerError('ROUTE_NOT_SENDABLE', 'Route evidence exceeds the safe bound')
  }
  return { evidence, hash: sha256(evidence) }
}

function transitionEvidence(spec: TransitionSpec): { readonly metadata: JsonValue; readonly hash: string } {
  const metadata: JsonValue = {
    version: DISPATCH_EVIDENCE_VERSION,
    eventType: spec.eventType,
    evidenceKind: spec.evidenceKind,
    evidenceReference: spec.evidenceReference,
    details: spec.metadata,
  }
  if (SENSITIVE.test(canonical(metadata))) {
    throw new DispatchLedgerError('INVALID_INPUT', 'Transition evidence contains a forbidden secret-bearing shape')
  }
  return { metadata: spec.metadata, hash: sha256(metadata) }
}

function prismaCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
  }
  return undefined
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function asDispatch(row: any): OutboundDispatch {
  return deepFreeze({ ...row, initialRouteEvidence: row.initialRouteEvidence as JsonValue }) as OutboundDispatch
}

function asLane(row: any): OutboundDispatchLane {
  return deepFreeze({ ...row }) as OutboundDispatchLane
}

function asAttempt(row: any): OutboundDispatchAttempt {
  return deepFreeze({ ...row }) as OutboundDispatchAttempt
}

function asTransition(row: any): OutboundDispatchTransition {
  return deepFreeze({ ...row, safeEvidenceMetadata: row.safeEvidenceMetadata as JsonValue }) as OutboundDispatchTransition
}

function asReconciliation(row: any): OutboundReconciliationTask {
  return deepFreeze({ ...row }) as OutboundReconciliationTask
}

function conversationKey(accountId: string, key: string): Record<string, unknown> {
  return { accountId_conversationKey: { accountId, conversationKey: key } }
}

function validateScope(accountId: string, key: string): void {
  required(accountId, 'accountId', 128)
  required(key, 'conversationKey', 256)
}

export class PrismaDispatchLedger implements DispatchLedger {
  readonly #client: DispatchLedgerPrismaClient
  readonly #routeRegistry: RouteRegistry
  readonly #authority: SenderAuthorityVerifier
  readonly #clock: () => Date
  readonly #idGenerator: () => string

  constructor(
    client: DispatchLedgerPrismaClient,
    routeRegistry: RouteRegistry,
    authority: SenderAuthorityVerifier = new FailClosedSenderAuthorityVerifier(),
    options: { readonly clock?: () => Date; readonly idGenerator?: () => string } = {},
  ) {
    this.#client = client
    this.#routeRegistry = routeRegistry
    this.#authority = authority
    this.#clock = options.clock ?? (() => new Date())
    this.#idGenerator = options.idGenerator ?? randomUUID
  }

  async #sendableRoute(accountId: string, key: string): Promise<SendableRouteSnapshot> {
    try {
      const route = await this.#routeRegistry.getSendableRouteSnapshot(accountId, key)
      if (route.accountId !== accountId || route.conversationKey !== key || route.state !== 'active'
        || route.hasOpenConflict || route.activeProtocolChatId === undefined) {
        throw new DispatchLedgerError('ROUTE_NOT_SENDABLE', 'Current account-scoped route is not sendable')
      }
      return route
    } catch (error) {
      if (error instanceof DispatchLedgerError) throw error
      if (dispatchErrorCode(error) === 'DATABASE_FAILURE') throw asDispatchDatabaseError(error)
      throw new DispatchLedgerError('ROUTE_NOT_SENDABLE', 'Current account-scoped route is not sendable')
    }
  }

  async #existingTransition(
    transaction: DispatchLedgerPrismaTransaction,
    accountId: string,
    dispatchId: string,
    spec: TransitionSpec,
  ): Promise<any | null> {
    const existing = await transaction.maxOutboundDispatchTransition.findFirst({
      where: { accountId, dispatchId, transitionIdempotencyKey: spec.idempotencyKey },
    })
    if (existing === null) return null
    const evidence = transitionEvidence(spec)
    if (existing.attemptId !== spec.attemptId || existing.fromState !== spec.fromState
      || existing.toState !== spec.toState || existing.eventType !== spec.eventType
      || existing.evidenceKind !== spec.evidenceKind || existing.evidenceReference !== spec.evidenceReference
      || existing.evidenceSha256 !== evidence.hash) {
      throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Transition idempotency key represents another event')
    }
    return existing
  }

  async #resultForTransition(
    transaction: DispatchLedgerPrismaTransaction,
    transition: any,
    idempotent: boolean,
  ): Promise<DispatchTransitionResult> {
    const dispatch = await transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: transition.dispatchId } })
    if (dispatch === null) throw new DispatchLedgerError('DATABASE_FAILURE', 'Dispatch disappeared')
    const [attempt, task, lane] = await Promise.all([
      transition.attemptId === null
        ? Promise.resolve(null)
        : transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: transition.attemptId } }),
      transaction.maxOutboundReconciliationTask.findFirst({
        where: { dispatchId: transition.dispatchId }, orderBy: { openedAt: 'desc' },
      }),
      transaction.maxOutboundDispatchLane.findUnique({
        where: conversationKey(dispatch.accountId, dispatch.conversationKey),
      }),
    ])
    return deepFreeze({
      dispatch: asDispatch(dispatch),
      attempt: attempt === null ? null : asAttempt(attempt),
      transition: asTransition(transition),
      reconciliationTask: task === null ? null : asReconciliation(task),
      lane: lane === null ? null : asLane(lane),
      idempotent,
      physicalSendAuthorized: false as const,
    })
  }

  async #insertTransition(
    transaction: DispatchLedgerPrismaTransaction,
    dispatch: any,
    spec: TransitionSpec,
  ): Promise<any> {
    const evidence = transitionEvidence(spec)
    return transaction.maxOutboundDispatchTransition.create({
      data: {
        transitionId: this.#idGenerator(),
        dispatchId: dispatch.dispatchId,
        attemptId: spec.attemptId,
        accountId: dispatch.accountId,
        conversationKey: dispatch.conversationKey,
        transitionSequence: dispatch.stateVersion + 1,
        transitionIdempotencyKey: spec.idempotencyKey,
        fromState: spec.fromState,
        toState: spec.toState,
        eventType: spec.eventType,
        evidenceKind: spec.evidenceKind,
        evidenceReference: spec.evidenceReference,
        evidenceSha256: evidence.hash,
        safeEvidenceMetadata: evidence.metadata,
        stateVersionBefore: dispatch.stateVersion,
        stateVersionAfter: dispatch.stateVersion + 1,
        occurredAt: spec.occurredAt,
      },
    })
  }

  async #existingCreation(
    transaction: DispatchLedgerPrismaTransaction,
    input: CreateDispatchFromReservationInput,
  ): Promise<CreateDispatchResult | null> {
    const existing = await transaction.maxOutboundDispatch.findUnique({ where: { reservationId: input.reservationId } })
    if (existing === null) return null
    if (existing.dispatchId !== input.dispatchId
      || existing.accountId !== input.accountId || existing.conversationKey !== input.conversationKey
      || existing.commandId !== input.expectedCommandId || existing.commandSequence !== input.expectedCommandSequence) {
      throw new DispatchLedgerError('DISPATCH_CREATION_CONFLICT', 'Reservation already links to another immutable Dispatch')
    }
    const [transition, lane, reservation] = await Promise.all([
      transaction.maxOutboundDispatchTransition.findFirst({
        where: { dispatchId: existing.dispatchId, eventType: 'dispatch_created' },
      }),
      transaction.maxOutboundDispatchLane.findUnique({ where: conversationKey(input.accountId, input.conversationKey) }),
      transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } }),
    ])
    if (transition !== null && transition.transitionIdempotencyKey !== input.transitionIdempotencyKey) {
      throw new DispatchLedgerError('DISPATCH_CREATION_CONFLICT', 'Reservation creation key does not match the immutable Dispatch')
    }
    if (transition === null || lane === null || reservation === null
      || reservation.reservationState !== 'handed_off' || reservation.dispatchId !== existing.dispatchId
      || reservation.handoffReference !== existing.dispatchId) {
      throw new DispatchLedgerError('DATABASE_FAILURE', 'Atomic Dispatch linkage is incomplete')
    }
    return deepFreeze({
      dispatch: asDispatch(existing), lane: asLane(lane), transition: asTransition(transition),
      idempotent: true, physicalSendAuthorized: false as const,
    })
  }

  async createDispatchFromReservation(input: CreateDispatchFromReservationInput): Promise<CreateDispatchResult> {
    validateScope(input.accountId, input.conversationKey)
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.reservationId, 'reservationId')
    identifier(input.expectedCommandId, 'expectedCommandId')
    required(input.ownerId, 'ownerId')
    identifier(input.transitionIdempotencyKey, 'transitionIdempotencyKey')
    positiveInteger(input.expectedCommandSequence, 'expectedCommandSequence')
    nonNegativeInteger(input.actorLeaseEpoch, 'actorLeaseEpoch')
    nonNegativeInteger(input.expectedActorVersion, 'expectedActorVersion')
    nonNegativeInteger(input.expectedReservationVersion, 'expectedReservationVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    const prior = await this.#existingCreation(this.#client, input)
    if (prior !== null) return prior
    const route = await this.#sendableRoute(input.accountId, input.conversationKey)
    const pinned = routeEvidence(route)

    for (let concurrencyAttempt = 0; concurrencyAttempt < MAX_DISPATCH_CONCURRENCY_RETRIES; concurrencyAttempt += 1) {
      try {
        return await this.#client.$transaction(async transaction => {
          const raced = await this.#existingCreation(transaction, input)
          if (raced !== null) return raced
          const [actor, reservation, command] = await Promise.all([
            transaction.maxOutboundConversationActor.findUnique({ where: conversationKey(input.accountId, input.conversationKey) }),
            transaction.maxOutboundCommandReservation.findUnique({ where: { reservationId: input.reservationId } }),
            transaction.maxOutboundCommand.findUnique({ where: { commandId: input.expectedCommandId } }),
          ])
          if (actor === null || reservation === null || command === null
            || reservation.accountId !== input.accountId || reservation.conversationKey !== input.conversationKey
            || command.accountId !== input.accountId || command.conversationKey !== input.conversationKey) {
            throw new DispatchLedgerError('NOT_FOUND', 'Account-scoped command reservation was not found')
          }
          if (actor.leaseOwnerId !== input.ownerId || actor.leaseEpoch !== input.actorLeaseEpoch
            || actor.leaseUntil === null || actor.leaseUntil <= now) {
            throw new DispatchLedgerError('STALE_ACTOR_LEASE', 'Actor lease owner, epoch, or deadline is stale')
          }
          if (actor.optimisticVersion !== input.expectedActorVersion) {
            throw new DispatchLedgerError('STALE_ACTOR_VERSION', 'Actor optimistic version is stale')
          }
          if (reservation.reservationState !== 'reserved' || reservation.leaseOwnerId !== input.ownerId
            || reservation.leaseEpoch !== input.actorLeaseEpoch || reservation.leaseUntil <= now) {
            throw new DispatchLedgerError('RESERVATION_NOT_ACTIVE', 'Reservation is not active for the current actor lease')
          }
          if (reservation.reservationVersion !== input.expectedReservationVersion) {
            throw new DispatchLedgerError('STALE_RESERVATION_VERSION', 'Reservation version is stale')
          }
          if (reservation.commandId !== input.expectedCommandId
            || reservation.commandSequence !== input.expectedCommandSequence
            || command.commandSequence !== input.expectedCommandSequence
            || actor.nextHandoffSequence !== input.expectedCommandSequence) {
            throw new DispatchLedgerError('DISPATCH_CREATION_CONFLICT', 'Reservation is not the exact FIFO command head')
          }
          const lane = await transaction.maxOutboundDispatchLane.upsert({
            where: conversationKey(input.accountId, input.conversationKey),
            create: { accountId: input.accountId, conversationKey: input.conversationKey, nextPhysicalSequence: 1, optimisticVersion: 0 },
            update: {},
          })
          const dispatch = await transaction.maxOutboundDispatch.create({
            data: {
              dispatchId: input.dispatchId,
              accountId: input.accountId,
              conversationKey: input.conversationKey,
              commandId: input.expectedCommandId,
              commandSequence: input.expectedCommandSequence,
              reservationId: input.reservationId,
              state: 'queued',
              stateVersion: 1,
              initialRouteVersion: route.routeVersion,
              initialProtocolChatId: route.activeProtocolChatId,
              initialProviderUserId: route.activeProviderUserId ?? null,
              initialWebRouteId: route.activeWebRouteId ?? null,
              initialRouteEvidence: pinned.evidence,
              initialRouteSnapshotSha256: pinned.hash,
              attemptCount: 0,
            },
          })
          const initialEvidence: JsonValue = {
            commandId: input.expectedCommandId,
            reservationId: input.reservationId,
            actorLeaseEpoch: input.actorLeaseEpoch,
            routeVersion: route.routeVersion,
          }
          const transitionEvidenceValue = transitionEvidence({
            attemptId: null, fromState: null, toState: 'queued', eventType: 'dispatch_created',
            evidenceKind: 'dispatch_creation', evidenceReference: input.reservationId,
            metadata: initialEvidence, idempotencyKey: input.transitionIdempotencyKey, occurredAt: now,
          })
          const transition = await transaction.maxOutboundDispatchTransition.create({
            data: {
              transitionId: this.#idGenerator(), dispatchId: dispatch.dispatchId, attemptId: null,
              accountId: input.accountId, conversationKey: input.conversationKey, transitionSequence: 1,
              transitionIdempotencyKey: input.transitionIdempotencyKey, fromState: null, toState: 'queued',
              eventType: 'dispatch_created', evidenceKind: 'dispatch_creation', evidenceReference: input.reservationId,
              evidenceSha256: transitionEvidenceValue.hash, safeEvidenceMetadata: initialEvidence,
              stateVersionBefore: 0, stateVersionAfter: 1, occurredAt: now,
            },
          })
          const reservationChanged = await transaction.maxOutboundCommandReservation.updateMany({
            where: {
              reservationId: input.reservationId, accountId: input.accountId, conversationKey: input.conversationKey,
              commandId: input.expectedCommandId, commandSequence: input.expectedCommandSequence,
              leaseOwnerId: input.ownerId, leaseEpoch: input.actorLeaseEpoch, reservationState: 'reserved',
              reservationVersion: input.expectedReservationVersion, leaseUntil: { gt: now }, dispatchId: null,
            },
            data: {
              reservationState: 'handed_off', reservationVersion: { increment: 1 }, handedOffAt: now,
              handoffReference: dispatch.dispatchId, dispatchId: dispatch.dispatchId,
            },
          })
          if (reservationChanged.count !== 1) throw new DispatchLedgerError('STALE_RESERVATION_VERSION', 'Reservation changed during Dispatch creation')
          const actorChanged = await transaction.maxOutboundConversationActor.updateMany({
            where: {
              accountId: input.accountId, conversationKey: input.conversationKey,
              leaseOwnerId: input.ownerId, leaseEpoch: input.actorLeaseEpoch,
              optimisticVersion: input.expectedActorVersion, nextHandoffSequence: input.expectedCommandSequence,
              leaseUntil: { gt: now },
            },
            data: { nextHandoffSequence: { increment: 1 }, optimisticVersion: { increment: 1 } },
          })
          if (actorChanged.count !== 1) throw new DispatchLedgerError('STALE_ACTOR_VERSION', 'Actor changed during Dispatch creation')
          return deepFreeze({
            dispatch: asDispatch(dispatch), lane: asLane(lane), transition: asTransition(transition),
            idempotent: false, physicalSendAuthorized: false as const,
          })
        })
      } catch (error) {
        if (prismaCode(error) === 'P2002' || prismaCode(error) === 'P2034') {
          const existing = await this.#existingCreation(this.#client, input)
          if (existing !== null) return existing
          if (concurrencyAttempt + 1 < MAX_DISPATCH_CONCURRENCY_RETRIES) continue
          throw new DispatchLedgerError('DISPATCH_CREATION_CONFLICT', 'Dispatch creation collided with another immutable identity')
        }
        throw asDispatchDatabaseError(error)
      }
    }
    throw new DispatchLedgerError('DATABASE_FAILURE', 'Dispatch creation retries were exhausted')
  }

  async getDispatch(accountId: string, key: string, dispatchId: string): Promise<OutboundDispatch | null> {
    validateScope(accountId, key)
    identifier(dispatchId, 'dispatchId')
    try {
      const row = await this.#client.maxOutboundDispatch.findUnique({ where: { dispatchId } })
      return row === null || row.accountId !== accountId || row.conversationKey !== key ? null : asDispatch(row)
    } catch (error) {
      throw asDispatchDatabaseError(error)
    }
  }

  async listDispatchesAfter(accountId: string, key: string, sequence: number, limit: number): Promise<DispatchPage> {
    validateScope(accountId, key)
    nonNegativeInteger(sequence, 'sequence')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DISPATCH_PAGE_LIMIT) {
      throw new DispatchLedgerError('INVALID_INPUT', `limit must be between 1 and ${MAX_DISPATCH_PAGE_LIMIT}`)
    }
    try {
      const rows = await this.#client.maxOutboundDispatch.findMany({
        where: { accountId, conversationKey: key, commandSequence: { gt: sequence } },
        orderBy: { commandSequence: 'asc' }, take: limit,
      })
      const dispatches = rows.map(asDispatch)
      return deepFreeze({ dispatches, nextSequence: dispatches.at(-1)?.commandSequence ?? sequence })
    } catch (error) {
      throw asDispatchDatabaseError(error)
    }
  }

  async #existingBegin(input: BeginAttemptInput): Promise<BeginAttemptResult | null> {
    const spec: TransitionSpec = {
      attemptId: input.attemptId, fromState: null, toState: 'dispatching', eventType: 'attempt_begun',
      evidenceKind: 'sender_authority', evidenceReference: input.attemptCorrelationId,
      metadata: { senderOwnerId: input.senderOwnerId, senderFencingEpoch: input.senderFencingEpoch },
      idempotencyKey: input.transitionIdempotencyKey, occurredAt: input.now ?? this.#clock(),
    }
    const existing = await this.#client.maxOutboundDispatchTransition.findFirst({
      where: { accountId: input.accountId, dispatchId: input.dispatchId, transitionIdempotencyKey: input.transitionIdempotencyKey },
    })
    if (existing === null) return null
    if (existing.attemptId !== input.attemptId || existing.toState !== 'dispatching'
      || existing.eventType !== 'attempt_begun' || existing.evidenceReference !== input.attemptCorrelationId
      || existing.evidenceSha256 !== transitionEvidence({ ...spec, fromState: existing.fromState }).hash) {
      throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Attempt idempotency key represents another operation')
    }
    const [dispatch, attempt] = await Promise.all([
      this.#client.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } }),
      this.#client.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } }),
    ])
    if (dispatch === null || attempt === null || dispatch.accountId !== input.accountId
      || dispatch.conversationKey !== input.conversationKey) {
      throw new DispatchLedgerError('DATABASE_FAILURE', 'Idempotent Attempt state is incomplete')
    }
    return deepFreeze({
      dispatch: asDispatch(dispatch), attempt: asAttempt(attempt), transition: asTransition(existing),
      idempotent: true, physicalSendAuthorized: false as const,
    })
  }

  async beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult> {
    validateScope(input.accountId, input.conversationKey)
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.attemptId, 'attemptId')
    identifier(input.attemptCorrelationId, 'attemptCorrelationId')
    identifier(input.transitionIdempotencyKey, 'transitionIdempotencyKey')
    required(input.senderOwnerId, 'senderOwnerId')
    nonNegativeInteger(input.senderFencingEpoch, 'senderFencingEpoch')
    nonNegativeInteger(input.expectedStateVersion, 'expectedStateVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    validDate(input.senderProofTimestamp, 'senderProofTimestamp')
    const claimMilliseconds = input.claimMilliseconds ?? DEFAULT_ATTEMPT_CLAIM_MILLISECONDS
    positiveInteger(claimMilliseconds, 'claimMilliseconds')
    const prior = await this.#existingBegin({ ...input, now })
    if (prior !== null) return prior
    const [route, proof] = await Promise.all([
      this.#sendableRoute(input.accountId, input.conversationKey),
      this.#authority.verify({
        accountId: input.accountId, ownerId: input.senderOwnerId, fencingEpoch: input.senderFencingEpoch,
        proofTimestamp: input.senderProofTimestamp, now,
      }),
    ])
    validateSenderAuthorityProof({
      accountId: input.accountId, ownerId: input.senderOwnerId, fencingEpoch: input.senderFencingEpoch,
      proofTimestamp: input.senderProofTimestamp, now,
    }, proof)
    const pinned = routeEvidence(route)
    try {
      return await this.#client.$transaction(async transaction => {
        const dispatch = await transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } })
        if (dispatch === null || dispatch.accountId !== input.accountId || dispatch.conversationKey !== input.conversationKey) {
          throw new DispatchLedgerError('NOT_FOUND', 'Account-scoped Dispatch was not found')
        }
        const spec: TransitionSpec = {
          attemptId: input.attemptId, fromState: dispatch.state, toState: 'dispatching', eventType: 'attempt_begun',
          evidenceKind: 'sender_authority', evidenceReference: input.attemptCorrelationId,
          metadata: { senderOwnerId: input.senderOwnerId, senderFencingEpoch: input.senderFencingEpoch },
          idempotencyKey: input.transitionIdempotencyKey, occurredAt: now,
        }
        const repeated = await this.#existingTransition(transaction, input.accountId, input.dispatchId, spec)
        if (repeated !== null) {
          const attempt = await transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } })
          if (attempt === null) throw new DispatchLedgerError('DATABASE_FAILURE', 'Idempotent Attempt disappeared')
          return deepFreeze({
            dispatch: asDispatch(dispatch), attempt: asAttempt(attempt), transition: asTransition(repeated),
            idempotent: true, physicalSendAuthorized: false as const,
          })
        }
        if (!['queued', 'retryable_failed'].includes(dispatch.state)) {
          if (TERMINAL_STATES.includes(dispatch.state)) throw new DispatchLedgerError('TERMINAL_STATE', 'Terminal Dispatch cannot begin an Attempt')
          throw new DispatchLedgerError('INVALID_TRANSITION', 'Dispatch is not ready to begin an Attempt')
        }
        if (dispatch.stateVersion !== input.expectedStateVersion) {
          throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch state version is stale')
        }
        const [lane, openTask, activeAttempt] = await Promise.all([
          transaction.maxOutboundDispatchLane.findUnique({ where: conversationKey(input.accountId, input.conversationKey) }),
          transaction.maxOutboundReconciliationTask.findFirst({ where: { dispatchId: input.dispatchId, state: 'open' } }),
          transaction.maxOutboundDispatchAttempt.findFirst({ where: { dispatchId: input.dispatchId, completedAt: null } }),
        ])
        if (lane === null) throw new DispatchLedgerError('DATABASE_FAILURE', 'Physical dispatch lane is missing')
        if (lane.nextPhysicalSequence !== dispatch.commandSequence) {
          throw new DispatchLedgerError('FIFO_BLOCKED', 'An earlier Dispatch still owns the physical FIFO lane')
        }
        if (openTask !== null) throw new DispatchLedgerError('RECONCILIATION_REQUIRED', 'Open reconciliation blocks a new Attempt')
        if (activeAttempt !== null) throw new DispatchLedgerError('ATTEMPT_CONFLICT', 'Dispatch already has an active Attempt')
        const attempt = await transaction.maxOutboundDispatchAttempt.create({
          data: {
            attemptId: input.attemptId, dispatchId: input.dispatchId, accountId: input.accountId,
            conversationKey: input.conversationKey, attemptNumber: dispatch.attemptCount + 1,
            attemptState: 'prepared', attemptVersion: 0, senderOwnerId: proof.ownerId,
            senderFencingEpoch: proof.fencingEpoch, senderAuthorityVerifiedAt: proof.verifiedAt,
            attemptCorrelationId: input.attemptCorrelationId, routeVersion: route.routeVersion,
            protocolChatId: route.activeProtocolChatId, providerUserId: route.activeProviderUserId ?? null,
            webRouteId: route.activeWebRouteId ?? null, routeSnapshotSha256: pinned.hash,
            preparedAt: now, claimUntil: new Date(now.valueOf() + claimMilliseconds),
          },
        })
        const changed = await transaction.maxOutboundDispatch.updateMany({
          where: { dispatchId: input.dispatchId, accountId: input.accountId, conversationKey: input.conversationKey, state: dispatch.state, stateVersion: input.expectedStateVersion },
          data: { state: 'dispatching', stateVersion: { increment: 1 }, currentAttemptId: input.attemptId, attemptCount: { increment: 1 } },
        })
        if (changed.count !== 1) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch changed while beginning Attempt')
        const transition = await this.#insertTransition(transaction, dispatch, spec)
        const updated = await transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } })
        if (updated === null) throw new DispatchLedgerError('DATABASE_FAILURE', 'Dispatch disappeared after Attempt creation')
        return deepFreeze({
          dispatch: asDispatch(updated), attempt: asAttempt(attempt), transition: asTransition(transition),
          idempotent: false, physicalSendAuthorized: false as const,
        })
      })
    } catch (error) {
      const existing = await this.#existingBegin({ ...input, now })
      if (existing !== null) return existing
      if (prismaCode(error) === 'P2002' || prismaCode(error) === 'P2034') {
        throw new DispatchLedgerError('ATTEMPT_CONFLICT', 'Attempt creation collided with another active Attempt')
      }
      throw asDispatchDatabaseError(error)
    }
  }

  async #mutateAttempt(input: AttemptTransitionInput, mutation: AttemptMutationSpec): Promise<DispatchTransitionResult> {
    validateScope(input.accountId, input.conversationKey)
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.attemptId, 'attemptId')
    identifier(input.transitionIdempotencyKey, 'transitionIdempotencyKey')
    nonNegativeInteger(input.expectedStateVersion, 'expectedStateVersion')
    nonNegativeInteger(input.expectedAttemptVersion, 'expectedAttemptVersion')
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const [dispatch, attempt] = await Promise.all([
          transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } }),
          transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } }),
        ])
        if (dispatch === null || attempt === null || dispatch.accountId !== input.accountId
          || dispatch.conversationKey !== input.conversationKey || attempt.dispatchId !== input.dispatchId
          || attempt.accountId !== input.accountId || attempt.conversationKey !== input.conversationKey) {
          throw new DispatchLedgerError('NOT_FOUND', 'Account-scoped Dispatch Attempt was not found')
        }
        const spec: TransitionSpec = {
          attemptId: input.attemptId, fromState: dispatch.state, toState: mutation.toDispatchState,
          eventType: mutation.eventType, evidenceKind: mutation.evidenceKind,
          evidenceReference: mutation.evidenceReference, metadata: mutation.metadata,
          idempotencyKey: input.transitionIdempotencyKey, occurredAt: now,
        }
        const repeated = await this.#existingTransition(transaction, input.accountId, input.dispatchId, spec)
        if (repeated !== null) return this.#resultForTransition(transaction, repeated, true)
        if (!mutation.dispatchStates.includes(dispatch.state)) {
          if (TERMINAL_STATES.includes(dispatch.state)) throw new DispatchLedgerError('TERMINAL_STATE', 'Terminal Dispatch cannot transition')
          throw new DispatchLedgerError('INVALID_TRANSITION', 'Dispatch transition is not allowed from the current state')
        }
        if (!mutation.attemptStates.includes(attempt.attemptState)) {
          throw new DispatchLedgerError('INVALID_TRANSITION', 'Attempt transition is not allowed from the current state')
        }
        if (dispatch.stateVersion !== input.expectedStateVersion) {
          throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch state version is stale')
        }
        if (attempt.attemptVersion !== input.expectedAttemptVersion) {
          throw new DispatchLedgerError('STALE_ATTEMPT_VERSION', 'Attempt version is stale')
        }
        const attemptChanged = await transaction.maxOutboundDispatchAttempt.updateMany({
          where: { attemptId: input.attemptId, dispatchId: input.dispatchId, accountId: input.accountId, conversationKey: input.conversationKey, attemptState: attempt.attemptState, attemptVersion: input.expectedAttemptVersion },
          data: { ...mutation.attemptData, attemptState: mutation.toAttemptState, attemptVersion: { increment: 1 } },
        })
        if (attemptChanged.count !== 1) throw new DispatchLedgerError('STALE_ATTEMPT_VERSION', 'Attempt changed concurrently')
        const dispatchChanged = await transaction.maxOutboundDispatch.updateMany({
          where: { dispatchId: input.dispatchId, accountId: input.accountId, conversationKey: input.conversationKey, state: dispatch.state, stateVersion: input.expectedStateVersion, currentAttemptId: input.attemptId },
          data: { ...mutation.dispatchData, state: mutation.toDispatchState, stateVersion: { increment: 1 } },
        })
        if (dispatchChanged.count !== 1) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch changed concurrently')
        if (mutation.reconciliation !== undefined) {
          await transaction.maxOutboundReconciliationTask.create({
            data: {
              reconciliationId: this.#idGenerator(), dispatchId: input.dispatchId, attemptId: input.attemptId,
              accountId: input.accountId, conversationKey: input.conversationKey,
              reason: mutation.reconciliation.reason, state: 'open', taskVersion: 0, openedAt: now,
              notBefore: mutation.reconciliation.notBefore,
            },
          })
        }
        const transition = await this.#insertTransition(transaction, dispatch, spec)
        return this.#resultForTransition(transaction, transition, false)
      })
    } catch (error) {
      const existing = await this.#client.maxOutboundDispatchTransition.findFirst({
        where: { accountId: input.accountId, dispatchId: input.dispatchId, transitionIdempotencyKey: input.transitionIdempotencyKey },
      })
      if (existing !== null) {
        const expectedHash = transitionEvidence({
          attemptId: input.attemptId, fromState: existing.fromState, toState: mutation.toDispatchState,
          eventType: mutation.eventType, evidenceKind: mutation.evidenceKind,
          evidenceReference: mutation.evidenceReference, metadata: mutation.metadata,
          idempotencyKey: input.transitionIdempotencyKey, occurredAt: input.now ?? this.#clock(),
        }).hash
        if (existing.attemptId !== input.attemptId || existing.toState !== mutation.toDispatchState
          || existing.eventType !== mutation.eventType || existing.evidenceKind !== mutation.evidenceKind
          || existing.evidenceReference !== mutation.evidenceReference || existing.evidenceSha256 !== expectedHash) {
          throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Transition idempotency key represents another event')
        }
        return this.#resultForTransition(this.#client, existing, true)
      }
      throw asDispatchDatabaseError(error)
    }
  }

  markPhysicalActionStarted(input: AttemptTransitionInput): Promise<DispatchTransitionResult> {
    const now = input.now ?? this.#clock()
    return this.#mutateAttempt({ ...input, now }, {
      dispatchStates: ['dispatching'], attemptStates: ['prepared'], toDispatchState: 'dispatching',
      toAttemptState: 'physical_action_started', eventType: 'physical_action_started', evidenceKind: 'physical_marker',
      evidenceReference: evidenceReference(input.evidenceReference), metadata: { physicalActionStarted: true },
      attemptData: { physicalActionStartedAt: now },
    })
  }

  recordClientActionAccepted(input: AttemptTransitionInput): Promise<DispatchTransitionResult> {
    const now = input.now ?? this.#clock()
    return this.#mutateAttempt({ ...input, now }, {
      dispatchStates: ['dispatching'], attemptStates: ['physical_action_started'],
      toDispatchState: 'sent_to_provider_client', toAttemptState: 'client_action_accepted',
      eventType: 'client_action_accepted', evidenceKind: 'client_ack',
      evidenceReference: evidenceReference(input.evidenceReference), metadata: { localClientOnly: true },
      attemptData: { clientActionAcceptedAt: now },
    })
  }

  markAwaitingConfirmation(input: AttemptTransitionInput): Promise<DispatchTransitionResult> {
    const now = input.now ?? this.#clock()
    return this.#mutateAttempt({ ...input, now }, {
      dispatchStates: ['sent_to_provider_client'], attemptStates: ['client_action_accepted'],
      toDispatchState: 'awaiting_confirmation', toAttemptState: 'awaiting_confirmation',
      eventType: 'awaiting_confirmation', evidenceKind: 'awaiting_confirmation',
      evidenceReference: evidenceReference(input.evidenceReference), metadata: { exactCorrelationPersisted: true },
      attemptData: { awaitingConfirmationAt: now },
    })
  }

  recordUnknownOutcome(input: UnknownOutcomeInput): Promise<DispatchTransitionResult> {
    const now = input.now ?? this.#clock()
    validDate(input.notBefore ?? now, 'notBefore')
    validReconciliationReason(input.reason)
    return this.#mutateAttempt({ ...input, now }, {
      dispatchStates: ['dispatching', 'sent_to_provider_client', 'awaiting_confirmation'],
      attemptStates: ['physical_action_started', 'client_action_accepted', 'awaiting_confirmation'],
      toDispatchState: 'reconciliation_required', toAttemptState: 'outcome_unknown',
      eventType: 'outcome_unknown', evidenceKind: 'unknown_outcome',
      evidenceReference: evidenceReference(input.evidenceReference), metadata: { reason: input.reason },
      attemptData: { outcomeUnknownAt: now, safeErrorCode: 'OUTCOME_UNKNOWN' },
      dispatchData: { reconciliationRequiredAt: now },
      reconciliation: { reason: input.reason, notBefore: input.notBefore ?? null },
    })
  }

  recordPreActionFailure(input: FailureInput): Promise<DispatchTransitionResult> {
    if (!/^[A-Z0-9_]{1,128}$/u.test(input.safeErrorCode)) {
      throw new DispatchLedgerError('INVALID_INPUT', 'safeErrorCode is invalid')
    }
    const now = input.now ?? this.#clock()
    return this.#mutateAttempt({ ...input, now }, {
      dispatchStates: ['dispatching'], attemptStates: ['prepared'],
      toDispatchState: 'retryable_failed', toAttemptState: 'pre_action_failed',
      eventType: 'pre_action_failed', evidenceKind: input.safeErrorCode === 'PRE_ACTION_RECOVERY' ? 'recovery' : 'contract_failure',
      evidenceReference: evidenceReference(input.evidenceReference), metadata: { safeErrorCode: input.safeErrorCode, physicalActionStarted: false },
      attemptData: { completedAt: now, safeErrorCode: input.safeErrorCode },
    })
  }

  async recordExactProviderConfirmation(input: ExactProviderConfirmationInput): Promise<DispatchTransitionResult> {
    validateScope(input.accountId, input.conversationKey)
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.attemptId, 'attemptId')
    identifier(input.transitionIdempotencyKey, 'transitionIdempotencyKey')
    nonNegativeInteger(input.expectedStateVersion, 'expectedStateVersion')
    nonNegativeInteger(input.expectedAttemptVersion, 'expectedAttemptVersion')
    required(input.providerMessageId, 'providerMessageId', 512)
    const reference = evidenceReference(input.evidenceReference)!
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const mutation = await recordExactProviderConfirmationInTransaction(
          transaction,
          { ...input, evidenceReference: reference, now },
          this.#idGenerator,
        )
        return this.#resultForTransition(transaction, mutation.transition, mutation.idempotent)
      })
    } catch (error) {
      const confirmed = await this.#client.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } })
      if (confirmed !== null && confirmed.accountId === input.accountId
        && confirmed.state === 'provider_confirmed' && confirmed.providerMessageId === input.providerMessageId) {
        const transition = await this.#client.maxOutboundDispatchTransition.findFirst({
          where: { dispatchId: input.dispatchId, eventType: 'provider_confirmed' },
        })
        if (transition !== null) return this.#resultForTransition(this.#client, transition, true)
      }
      if (prismaCode(error) === 'P2002') {
        const owner = await this.#client.maxOutboundDispatch.findFirst({
          where: { accountId: input.accountId, providerMessageId: input.providerMessageId },
        })
        if (owner !== null && owner.dispatchId !== input.dispatchId) {
          throw new DispatchLedgerError('PROVIDER_MESSAGE_ID_CONFLICT', 'Exact provider identity already confirms another Dispatch')
        }
      }
      throw asDispatchDatabaseError(error)
    }
  }

  async recordProviderAbsenceProven(input: ProviderAbsenceInput): Promise<DispatchTransitionResult> {
    validateScope(input.accountId, input.conversationKey)
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.attemptId, 'attemptId')
    identifier(input.transitionIdempotencyKey, 'transitionIdempotencyKey')
    nonNegativeInteger(input.expectedStateVersion, 'expectedStateVersion')
    nonNegativeInteger(input.expectedAttemptVersion, 'expectedAttemptVersion')
    const reference = evidenceReference(input.evidenceReference)!
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const mutation = await recordProviderAbsenceInTransaction(
          transaction,
          { ...input, evidenceReference: reference, now },
          this.#idGenerator,
        )
        return this.#resultForTransition(transaction, mutation.transition, mutation.idempotent)
      })
    } catch (error) {
      const existing = await this.#client.maxOutboundDispatchTransition.findFirst({
        where: { accountId: input.accountId, dispatchId: input.dispatchId, transitionIdempotencyKey: input.transitionIdempotencyKey },
      })
      if (existing !== null) {
        if (existing.attemptId !== input.attemptId || existing.toState !== 'retryable_failed'
          || existing.eventType !== 'provider_absence_proven' || existing.evidenceReference !== reference) {
          throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Transition idempotency key represents another event')
        }
        return this.#resultForTransition(this.#client, existing, true)
      }
      throw asDispatchDatabaseError(error)
    }
  }

  async #dispatchOnlyTransition(
    input: QueueRetryInput,
    allowedStates: readonly DispatchState[],
    toState: DispatchState | ((dispatch: any) => DispatchState),
    eventType: string,
    evidenceKind: string,
    metadata: JsonValue,
    extraCheck?: (transaction: DispatchLedgerPrismaTransaction, dispatch: any) => Promise<{ attemptId: string | null; data?: Record<string, unknown> }>,
  ): Promise<DispatchTransitionResult> {
    validateScope(input.accountId, input.conversationKey)
    identifier(input.dispatchId, 'dispatchId')
    identifier(input.transitionIdempotencyKey, 'transitionIdempotencyKey')
    nonNegativeInteger(input.expectedStateVersion, 'expectedStateVersion')
    const reference = evidenceReference(input.evidenceReference)!
    const now = input.now ?? this.#clock()
    validDate(now, 'now')
    try {
      return await this.#client.$transaction(async transaction => {
        const dispatch = await transaction.maxOutboundDispatch.findUnique({ where: { dispatchId: input.dispatchId } })
        if (dispatch === null || dispatch.accountId !== input.accountId || dispatch.conversationKey !== input.conversationKey) {
          throw new DispatchLedgerError('NOT_FOUND', 'Account-scoped Dispatch was not found')
        }
        const resolvedToState = typeof toState === 'function' ? toState(dispatch) : toState
        const repeated = await transaction.maxOutboundDispatchTransition.findFirst({
          where: { accountId: input.accountId, dispatchId: input.dispatchId, transitionIdempotencyKey: input.transitionIdempotencyKey },
        })
        if (repeated !== null) {
          const expectedHash = transitionEvidence({
            attemptId: repeated.attemptId, fromState: repeated.fromState, toState: resolvedToState,
            eventType, evidenceKind, evidenceReference: reference, metadata,
            idempotencyKey: input.transitionIdempotencyKey, occurredAt: now,
          }).hash
          if (repeated.toState !== resolvedToState || repeated.eventType !== eventType
            || repeated.evidenceKind !== evidenceKind || repeated.evidenceReference !== reference
            || repeated.evidenceSha256 !== expectedHash) {
            throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Transition idempotency key represents another event')
          }
          return this.#resultForTransition(transaction, repeated, true)
        }
        const checked = extraCheck === undefined ? { attemptId: dispatch.currentAttemptId as string | null } : await extraCheck(transaction, dispatch)
        const spec: TransitionSpec = {
          attemptId: checked.attemptId, fromState: dispatch.state, toState: resolvedToState, eventType, evidenceKind,
          evidenceReference: reference, metadata, idempotencyKey: input.transitionIdempotencyKey, occurredAt: now,
        }
        if (!allowedStates.includes(dispatch.state)) {
          if (TERMINAL_STATES.includes(dispatch.state) && dispatch.state !== resolvedToState) throw new DispatchLedgerError('TERMINAL_STATE', 'Terminal Dispatch cannot transition')
          throw new DispatchLedgerError('INVALID_TRANSITION', 'Dispatch transition is not allowed from the current state')
        }
        if (dispatch.stateVersion !== input.expectedStateVersion) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch state version is stale')
        const changed = await transaction.maxOutboundDispatch.updateMany({
          where: {
            dispatchId: input.dispatchId, accountId: input.accountId, conversationKey: input.conversationKey,
            state: dispatch.state, stateVersion: input.expectedStateVersion,
          },
          data: { ...checked.data, state: resolvedToState, stateVersion: { increment: 1 } },
        })
        if (changed.count !== 1) throw new DispatchLedgerError('STALE_DISPATCH_VERSION', 'Dispatch changed concurrently')
        const transition = await this.#insertTransition(transaction, dispatch, spec)
        return this.#resultForTransition(transaction, transition, false)
      })
    } catch (error) {
      const existing = await this.#client.maxOutboundDispatchTransition.findFirst({
        where: { accountId: input.accountId, dispatchId: input.dispatchId, transitionIdempotencyKey: input.transitionIdempotencyKey },
      })
      if (existing !== null) {
        const expectedToState = typeof toState === 'function' ? existing.toState : toState
        const expectedHash = transitionEvidence({
          attemptId: existing.attemptId, fromState: existing.fromState, toState: expectedToState,
          eventType, evidenceKind, evidenceReference: reference, metadata,
          idempotencyKey: input.transitionIdempotencyKey, occurredAt: now,
        }).hash
        if (existing.toState !== expectedToState || existing.eventType !== eventType
          || existing.evidenceKind !== evidenceKind || existing.evidenceReference !== reference
          || existing.evidenceSha256 !== expectedHash) {
          throw new DispatchLedgerError('TRANSITION_IDEMPOTENCY_CONFLICT', 'Transition idempotency key represents another event')
        }
        return this.#resultForTransition(this.#client, existing, true)
      }
      throw asDispatchDatabaseError(error)
    }
  }

  queueRetry(input: QueueRetryInput): Promise<DispatchTransitionResult> {
    return this.#dispatchOnlyTransition(input, ['retryable_failed'], 'queued', 'retry_queued', 'retry_policy', { audited: true }, async (transaction, dispatch) => {
      const openTask = await transaction.maxOutboundReconciliationTask.findFirst({ where: { dispatchId: dispatch.dispatchId, state: 'open' } })
      if (openTask !== null) throw new DispatchLedgerError('UNSAFE_RETRY', 'Unknown provider outcome blocks retry')
      const attempt = await transaction.maxOutboundDispatchAttempt.findFirst({
        where: { dispatchId: dispatch.dispatchId }, orderBy: { attemptNumber: 'desc' },
      })
      if (attempt === null) throw new DispatchLedgerError('UNSAFE_RETRY', 'Retry requires a proven-safe previous Attempt')
      let safe = attempt.attemptState === 'pre_action_failed' && attempt.physicalActionStartedAt === null
      if (!safe && attempt.attemptState === 'outcome_unknown' && attempt.completedAt !== null) {
        const resolved = await transaction.maxOutboundReconciliationTask.findFirst({
          where: { dispatchId: dispatch.dispatchId, attemptId: attempt.attemptId, state: 'resolved', resolutionType: 'provider_absence_proven' },
        })
        safe = resolved !== null
      }
      if (!safe) throw new DispatchLedgerError('UNSAFE_RETRY', 'Retry is not backed by pre-action or exact absence evidence')
      return { attemptId: attempt.attemptId, data: { currentAttemptId: null } }
    })
  }

  async markHardFailed(input: HardFailureInput): Promise<DispatchTransitionResult> {
    if (!/^[A-Z0-9_]{1,128}$/u.test(input.safeErrorCode)) throw new DispatchLedgerError('INVALID_INPUT', 'safeErrorCode is invalid')
    const now = input.now ?? this.#clock()
    return this.#dispatchOnlyTransition(input, ['queued', 'dispatching'], 'hard_failed', 'hard_failed', 'contract_failure', {
      audited: true, safeErrorCode: input.safeErrorCode,
      attemptId: input.attemptId ?? null, expectedAttemptVersion: input.expectedAttemptVersion ?? null,
    }, async (transaction, dispatch) => {
      if (dispatch.state === 'queued') return { attemptId: null, data: { terminalAt: now } }
      if (input.attemptId === undefined || input.expectedAttemptVersion === undefined) {
        throw new DispatchLedgerError('INVALID_INPUT', 'Dispatching hard failure requires the exact Attempt version')
      }
      const attempt = await transaction.maxOutboundDispatchAttempt.findUnique({ where: { attemptId: input.attemptId } })
      if (attempt === null || attempt.dispatchId !== dispatch.dispatchId || attempt.attemptState !== 'prepared'
        || attempt.physicalActionStartedAt !== null || attempt.attemptVersion !== input.expectedAttemptVersion) {
        throw new DispatchLedgerError('UNSAFE_RETRY', 'Hard failure is forbidden after physical action uncertainty')
      }
      const changed = await transaction.maxOutboundDispatchAttempt.updateMany({
        where: { attemptId: attempt.attemptId, attemptState: 'prepared', attemptVersion: input.expectedAttemptVersion },
        data: { attemptState: 'hard_failed', attemptVersion: { increment: 1 }, completedAt: now, safeErrorCode: input.safeErrorCode },
      })
      if (changed.count !== 1) throw new DispatchLedgerError('STALE_ATTEMPT_VERSION', 'Attempt changed concurrently')
      return { attemptId: attempt.attemptId, data: { terminalAt: now } }
    })
  }

  deadLetter(input: DeadLetterInput): Promise<DispatchTransitionResult> {
    positiveInteger(input.maximumAttempts, 'maximumAttempts')
    const now = input.now ?? this.#clock()
    return this.#dispatchOnlyTransition(input, ['retryable_failed'], 'dead_letter', 'dead_lettered', 'dead_letter_policy', {
      audited: true, maximumAttempts: input.maximumAttempts,
    }, async (_transaction, dispatch) => {
      if (dispatch.attemptCount < input.maximumAttempts) {
        throw new DispatchLedgerError('INVALID_TRANSITION', 'Attempt policy limit has not been reached')
      }
      return { attemptId: dispatch.currentAttemptId, data: { terminalAt: now } }
    })
  }

  async resolveTerminalFailureAndAdvance(input: TerminalAdvanceInput): Promise<DispatchTransitionResult> {
    return this.#dispatchOnlyTransition(input, ['hard_failed', 'dead_letter'], dispatch => dispatch.state, 'terminal_failure_advanced', 'terminal_skip', { audited: true }, async (transaction, dispatch) => {
      const lane = await transaction.maxOutboundDispatchLane.findUnique({ where: conversationKey(input.accountId, input.conversationKey) })
      if (lane === null || lane.nextPhysicalSequence !== dispatch.commandSequence) {
        throw new DispatchLedgerError('FIFO_BLOCKED', 'Terminal Dispatch is not the exact physical FIFO head')
      }
      const changed = await transaction.maxOutboundDispatchLane.updateMany({
        where: { accountId: input.accountId, conversationKey: input.conversationKey, nextPhysicalSequence: dispatch.commandSequence, optimisticVersion: lane.optimisticVersion },
        data: { nextPhysicalSequence: { increment: 1 }, optimisticVersion: { increment: 1 } },
      })
      if (changed.count !== 1) throw new DispatchLedgerError('FIFO_BLOCKED', 'Physical lane changed concurrently')
      return { attemptId: dispatch.currentAttemptId }
    })
  }

  async recoverStaleDispatches(input: RecoverStaleDispatchesInput): Promise<RecoveryResult> {
    validDate(input.now, 'now')
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_DISPATCH_PAGE_LIMIT) {
      throw new DispatchLedgerError('INVALID_INPUT', `limit must be between 1 and ${MAX_DISPATCH_PAGE_LIMIT}`)
    }
    let recoveredPreAction = 0
    let openedReconciliation = 0
    let unchanged = 0
    let attempts: any[]
    try {
      attempts = await this.#client.maxOutboundDispatchAttempt.findMany({
        where: {
          claimUntil: { lte: input.now }, completedAt: null,
          attemptState: { in: ['prepared', 'physical_action_started', 'client_action_accepted', 'awaiting_confirmation'] },
        },
        orderBy: [{ claimUntil: 'asc' }, { attemptId: 'asc' }], take: input.limit,
      })
    } catch (error) {
      throw asDispatchDatabaseError(error)
    }
    for (const attempt of attempts) {
      const dispatch = await this.getDispatch(attempt.accountId, attempt.conversationKey, attempt.dispatchId)
      if (dispatch === null) { unchanged += 1; continue }
      try {
        if (attempt.attemptState === 'prepared' && attempt.physicalActionStartedAt === null) {
          await this.recordPreActionFailure({
            accountId: attempt.accountId, conversationKey: attempt.conversationKey, dispatchId: attempt.dispatchId,
            attemptId: attempt.attemptId, expectedStateVersion: dispatch.stateVersion,
            expectedAttemptVersion: attempt.attemptVersion,
            transitionIdempotencyKey: `recovery:${attempt.attemptId}:pre_action`,
            evidenceReference: attempt.attemptId, safeErrorCode: 'PRE_ACTION_RECOVERY', now: input.now,
          })
          recoveredPreAction += 1
        } else {
          const reason: ReconciliationReason = attempt.attemptState === 'client_action_accepted'
            ? 'restart_client_accepted'
            : attempt.attemptState === 'awaiting_confirmation'
              ? 'restart_awaiting_confirmation'
              : 'restart_post_action'
          await this.recordUnknownOutcome({
            accountId: attempt.accountId, conversationKey: attempt.conversationKey, dispatchId: attempt.dispatchId,
            attemptId: attempt.attemptId, expectedStateVersion: dispatch.stateVersion,
            expectedAttemptVersion: attempt.attemptVersion,
            transitionIdempotencyKey: `recovery:${attempt.attemptId}:unknown`,
            evidenceReference: attempt.attemptId, reason, now: input.now,
          })
          openedReconciliation += 1
        }
      } catch (error) {
        if (['STALE_DISPATCH_VERSION', 'STALE_ATTEMPT_VERSION', 'INVALID_TRANSITION', 'TERMINAL_STATE'].includes(dispatchErrorCode(error) ?? '')) {
          unchanged += 1
        } else {
          throw error
        }
      }
    }
    return deepFreeze({ recoveredPreAction, openedReconciliation, unchanged })
  }

  async listOpenReconciliationTasks(accountId: string, cursor: string | undefined, limit: number): Promise<ReconciliationPage> {
    required(accountId, 'accountId', 128)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECONCILIATION_PAGE_LIMIT) {
      throw new DispatchLedgerError('INVALID_INPUT', `limit must be between 1 and ${MAX_RECONCILIATION_PAGE_LIMIT}`)
    }
    let cursorDate: Date | undefined
    let cursorId: string | undefined
    if (cursor !== undefined) {
      const separator = cursor.lastIndexOf('|')
      if (separator < 1) throw new DispatchLedgerError('INVALID_INPUT', 'Reconciliation cursor is invalid')
      cursorDate = new Date(cursor.slice(0, separator))
      cursorId = cursor.slice(separator + 1)
      validDate(cursorDate, 'cursor')
      identifier(cursorId, 'cursorId')
    }
    try {
      const rows = await this.#client.maxOutboundReconciliationTask.findMany({
        where: {
          accountId, state: 'open',
          ...(cursorDate === undefined ? {} : {
            OR: [{ openedAt: { gt: cursorDate } }, { openedAt: cursorDate, reconciliationId: { gt: cursorId } }],
          }),
        },
        orderBy: [{ openedAt: 'asc' }, { reconciliationId: 'asc' }], take: limit,
      })
      const tasks = rows.map(asReconciliation)
      const last = tasks.at(-1)
      return deepFreeze({
        tasks, nextOpenedAt: last?.openedAt ?? null,
        nextReconciliationId: last?.reconciliationId ?? null,
      })
    } catch (error) {
      throw asDispatchDatabaseError(error)
    }
  }
}
