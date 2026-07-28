import { createHash, randomUUID } from 'node:crypto'
import type { RouteRegistry } from '../route/RouteRegistry.ts'
import type { RouteSnapshot } from '../route/types.ts'
import type { AccountSessionOwner, SessionOwnerLease } from '../session/types.ts'
import { MAX_SHADOW_TEXT_BYTES, OUTBOUND_SHADOW_PLAN_SCHEMA_VERSION } from './constants.ts'
import { asShadowPlanDatabaseError, ShadowPlanError } from './errors.ts'
import type {
  LegacyOutboundProjection,
  OutboundShadowPlan,
  PlanOutboundCommandInput,
  ShadowCommandRecord,
  ShadowPlanDraft,
  ShadowPlanRepository,
  ShadowPlanResult,
  ShadowRefusalReason,
  ShadowSemanticComparison,
} from './types.ts'

const IDENTIFIER = /^[^\p{Cc}]{1,256}$/u
const TERMINAL_DISPATCH_STATES = new Set(['provider_confirmed', 'hard_failed', 'dead_letter'])

function exactIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim() || !IDENTIFIER.test(value) || value === '*') {
    throw new ShadowPlanError('INVALID_INPUT', `${field} is not an exact bounded identifier`)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function semanticInputHash(input: PlanOutboundCommandInput): string {
  return sha256(JSON.stringify({
    accountId: input.accountId,
    conversationKey: input.conversationKey,
    commandId: input.commandId,
    reservationId: input.reservationId,
    attemptCorrelationId: input.attemptCorrelationId,
    ownerInstanceId: input.ownerInstanceId ?? null,
    fencingToken: input.fencingToken?.toString(10) ?? null,
    legacy: input.legacy ?? null,
  }))
}

function routeRefusal(route: RouteSnapshot | null): ShadowRefusalReason | null {
  if (route === null) return 'ROUTE_NOT_FOUND'
  if (route.state === 'conflicted' || route.hasOpenConflict) return 'ROUTE_CONFLICT'
  if (route.state !== 'active' || route.activeProtocolChatId === undefined) return 'CONVERSATION_NOT_SENDABLE'
  return null
}

function comparison(
  legacy: LegacyOutboundProjection | undefined,
  input: PlanOutboundCommandInput,
  route: RouteSnapshot | null,
  newSendable: boolean,
): ShadowSemanticComparison {
  const target = route?.activeProtocolChatId ?? null
  if (legacy === undefined) {
    return Object.freeze({
      legacyObserved: false, legacyTargetSha256: null, newTargetSha256: target === null ? null : sha256(target),
      legacyPayloadShape: null, newPayloadShape: 'text' as const, legacySendable: null, newSendable,
      accountMatches: null, conversationMatches: null, targetMatches: null, payloadMatches: null, sendabilityMatches: null,
      hiddenRouteConflict: false, criticalRegression: false,
    })
  }
  const accountMatches = legacy.accountId === input.accountId
  const conversationMatches = legacy.conversationKey === input.conversationKey
  const targetMatches = legacy.targetProtocolChatId === target
  const payloadMatches = legacy.payloadKind === 'text'
  const sendabilityMatches = legacy.sendable === newSendable
  const hiddenRouteConflict = legacy.sendable && route?.state === 'conflicted'
  return Object.freeze({
    legacyObserved: true,
    legacyTargetSha256: legacy.targetProtocolChatId === null ? null : sha256(legacy.targetProtocolChatId),
    newTargetSha256: target === null ? null : sha256(target),
    legacyPayloadShape: legacy.payloadKind,
    newPayloadShape: 'text' as const,
    legacySendable: legacy.sendable,
    newSendable,
    accountMatches,
    conversationMatches,
    targetMatches,
    payloadMatches,
    sendabilityMatches,
    hiddenRouteConflict,
    criticalRegression: !accountMatches || !conversationMatches || !targetMatches || !payloadMatches || hiddenRouteConflict,
  })
}

function ownerRefusal(
  owner: SessionOwnerLease | null,
  input: PlanOutboundCommandInput,
): { readonly reason: ShadowRefusalReason | null; readonly readiness: string } {
  if (owner === null) return { reason: 'OWNER_NOT_ACQUIRED', readiness: 'not_acquired' }
  if (owner.accountId !== input.accountId) return { reason: 'ACCOUNT_MISMATCH', readiness: 'account_mismatch' }
  if (owner.state !== 'active' || owner.leaseUntil <= owner.observedDatabaseTime) {
    return { reason: 'OWNER_LEASE_EXPIRED', readiness: 'expired' }
  }
  if (input.fencingToken === undefined || input.ownerInstanceId === undefined) {
    return { reason: 'FENCING_TOKEN_MISSING', readiness: 'fence_missing' }
  }
  if (owner.ownerInstanceId !== input.ownerInstanceId || owner.fencingToken !== input.fencingToken) {
    return { reason: 'FENCING_TOKEN_STALE', readiness: 'fence_stale' }
  }
  return { reason: null, readiness: 'ready' }
}

function payload(command: ShadowCommandRecord): { kind: string; size: number; supported: boolean } {
  const value = command.commandPayload
  if (command.commandKind !== 'text' || value === null || Array.isArray(value) || typeof value !== 'object') {
    return { kind: command.commandKind, size: 0, supported: false }
  }
  const kind = Reflect.get(value, 'kind')
  const text = Reflect.get(value, 'text')
  if (kind !== 'text' || typeof text !== 'string' || text.length === 0) return { kind: String(kind), size: 0, supported: false }
  const size = Buffer.byteLength(text, 'utf8')
  return { kind, size, supported: size <= MAX_SHADOW_TEXT_BYTES }
}

export interface OutboundShadowPlannerOptions {
  readonly idGenerator?: () => string
  readonly clock?: () => Date
}

export class OutboundShadowPlanner {
  readonly #repository: ShadowPlanRepository
  readonly #routes: RouteRegistry
  readonly #sessionOwner: AccountSessionOwner
  readonly #idGenerator: () => string
  readonly #clock: () => Date

  constructor(repository: ShadowPlanRepository, routes: RouteRegistry, sessionOwner: AccountSessionOwner, options: OutboundShadowPlannerOptions = {}) {
    this.#repository = repository
    this.#routes = routes
    this.#sessionOwner = sessionOwner
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#clock = options.clock ?? (() => new Date())
  }

  async plan(input: PlanOutboundCommandInput): Promise<ShadowPlanResult> {
    for (const [value, field] of [[input.accountId, 'accountId'], [input.conversationKey, 'conversationKey'], [input.commandId, 'commandId'],
      [input.reservationId, 'reservationId'], [input.attemptCorrelationId, 'attemptCorrelationId'], [input.idempotencyKey, 'idempotencyKey']] as const) {
      exactIdentifier(value, field)
    }
    if (input.ownerInstanceId !== undefined) exactIdentifier(input.ownerInstanceId, 'ownerInstanceId')
    if (input.fencingToken !== undefined && (typeof input.fencingToken !== 'bigint' || input.fencingToken < 1n)) {
      throw new ShadowPlanError('INVALID_INPUT', 'fencingToken must be a positive bigint')
    }
    const inputSha256 = semanticInputHash(input)
    try {
      const byKey = await this.#repository.getByIdempotencyKey(input.accountId, input.idempotencyKey)
      if (byKey !== null) {
        if (byKey.inputSha256 !== inputSha256) throw new ShadowPlanError('IDEMPOTENCY_CONFLICT', 'Shadow idempotency key represents different input')
        return Object.freeze({ plan: byKey, idempotent: true, physicalSendAuthorized: false as const, deliveryStateMutated: false as const })
      }
      const byCommand = await this.#repository.getByCommandId(input.commandId)
      if (byCommand !== null) {
        if (byCommand.inputSha256 !== inputSha256) throw new ShadowPlanError('IDEMPOTENCY_CONFLICT', 'Command already has a different shadow plan')
        return Object.freeze({ plan: byCommand, idempotent: true, physicalSendAuthorized: false as const, deliveryStateMutated: false as const })
      }

      const command = await this.#repository.getCommand(input.commandId)
      if (command === null) throw new ShadowPlanError('NOT_FOUND', 'Immutable outbound command was not found')
      const reservation = await this.#repository.getActiveReservation(input.commandId, input.reservationId)
      const [route, owner, dispatchState] = await Promise.all([
        this.#routes.getRouteSnapshot(input.accountId, input.conversationKey),
        this.#sessionOwner.get(input.accountId),
        this.#repository.getDispatchState(input.commandId),
      ])

      const parsedPayload = payload(command)
      let refusal: ShadowRefusalReason | null = null
      if (command.accountId !== input.accountId || command.conversationKey !== input.conversationKey) refusal = 'ACCOUNT_MISMATCH'
      else if (reservation === null || reservation.accountId !== input.accountId || reservation.conversationKey !== input.conversationKey
        || reservation.commandSequence !== command.commandSequence || reservation.reservationState !== 'reserved') refusal = 'CONVERSATION_NOT_SENDABLE'
      else if (!parsedPayload.supported) refusal = 'PAYLOAD_UNSUPPORTED'
      else if (dispatchState !== null && TERMINAL_DISPATCH_STATES.has(dispatchState)) refusal = 'COMMAND_ALREADY_TERMINAL'
      else refusal = routeRefusal(route)
      const ownerDecision = ownerRefusal(owner, input)
      if (refusal === null) refusal = ownerDecision.reason
      const wouldSend = refusal === null
      const semanticComparison = comparison(input.legacy, input, route, wouldSend)
      const evaluatedAt = this.#clock()
      if (!(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.valueOf())) throw new ShadowPlanError('INVALID_INPUT', 'Planner clock is invalid')
      const draft: ShadowPlanDraft = Object.freeze({
        planId: this.#idGenerator(), schemaVersion: OUTBOUND_SHADOW_PLAN_SCHEMA_VERSION, inputSha256,
        accountId: input.accountId, accountAliasSha256: sha256(input.accountId), conversationKey: input.conversationKey,
        conversationKeySha256: sha256(input.conversationKey), commandId: command.commandId, commandSequence: command.commandSequence,
        reservationId: input.reservationId, clientMessageId: command.clientMessageId,
        attemptCorrelationId: input.attemptCorrelationId, idempotencyKey: input.idempotencyKey,
        routeResolution: route?.state ?? 'missing', routeVersion: route?.routeVersion ?? null,
        selectedProtocolChatId: route?.activeProtocolChatId ?? null, payloadKind: parsedPayload.kind,
        payloadSizeBytes: parsedPayload.size, payloadSha256: command.payloadSha256, replyMetadata: 'none' as const,
        ownerReadiness: ownerDecision.readiness, ownerInstanceId: owner?.ownerInstanceId ?? null,
        ownerFencingToken: owner?.fencingToken ?? null, wouldSend, refusalReason: refusal,
        semanticComparison, evaluatedAt: new Date(evaluatedAt), createdAt: new Date(evaluatedAt),
      })
      const created = await this.#repository.createPlan(draft)
      return Object.freeze({ plan: created, idempotent: false, physicalSendAuthorized: false as const, deliveryStateMutated: false as const })
    } catch (error) {
      throw asShadowPlanDatabaseError(error)
    }
  }
}
