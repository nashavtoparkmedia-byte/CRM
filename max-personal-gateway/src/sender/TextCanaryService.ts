import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { PrismaDispatchLedger } from '../dispatch/PrismaDispatchLedger.ts'
import { dispatchErrorCode } from '../dispatch/errors.ts'
import type { SenderAuthorityInput, SenderAuthorityProof, SenderAuthorityVerifier } from '../dispatch/types.ts'
import { PrismaPerConversationOutboundActor } from '../outbound/PrismaPerConversationOutboundActor.ts'
import { PrismaRouteRegistry } from '../route/PrismaRouteRegistry.ts'
import { DurableAccountSessionOwner } from '../session/AccountSessionOwner.ts'
import { PrismaSessionOwnerRepository } from '../session/PrismaSessionOwnerRepository.ts'
import { buildTextSenderRequest, signTextSenderRequest, verifyTextSenderAuthentication } from './GatewayTextSenderRequest.ts'
import { canaryConversationScope } from './scope.ts'
import type { TextSenderAuthenticationV1, TextSenderRequestV1 } from './types.ts'
import type { TextSenderRuntimeConfig } from './config.ts'

const COMMAND_NAMESPACE = 'personal-max-command-v1'
const SAFE_CODE = /^[A-Z0-9_]{1,128}$/
const REAL_MAX_MESSAGE_ID = /^d301[0-9a-f]{14}$/i

export interface GatewayTextCommand {
  readonly schemaVersion: 1
  readonly accountId: string
  readonly protocolChatId: string
  readonly text: string
  readonly clientMessageId: string
  readonly replyToProviderMessageId?: string
}

export interface GatewayCommandAuthentication {
  readonly timestamp: string | undefined
  readonly nonce: string | undefined
  readonly signature: string | undefined
}

class TextCanaryError extends Error {
  readonly code: string
  constructor(code: string, message = 'Text canary request was refused') { super(message); this.code = code }
}

class SessionOwnerAuthorityVerifier implements SenderAuthorityVerifier {
  readonly #owner: DurableAccountSessionOwner
  constructor(owner: DurableAccountSessionOwner) { this.#owner = owner }

  async verify(input: SenderAuthorityInput): Promise<SenderAuthorityProof> {
    const proof = await this.#owner.verifyImmediatelyBeforeSender({
      accountId: input.accountId,
      ownerInstanceId: input.ownerId,
      fencingToken: BigInt(input.fencingEpoch),
    })
    return {
      accountId: proof.accountId,
      ownerId: proof.ownerInstanceId,
      fencingEpoch: Number(proof.fencingToken),
      verifiedAt: input.proofTimestamp,
      leaseUntil: proof.leaseUntil,
    }
  }
}

function opaque(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex')}`
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback
}

function senderResponse(value: unknown, attemptId: string): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const response = value as Record<string, unknown>
  if (response.schemaVersion !== 1 || response.attemptId !== attemptId
    || !['PROVIDER_CONFIRMED', 'UNKNOWN_AFTER_ATTEMPT', 'REFUSED_BEFORE_SEND', 'UNSUPPORTED'].includes(String(response.outcome))
    || typeof response.physicalProviderCalled !== 'boolean'
    || !SAFE_CODE.test(String(response.safeCode || ''))) return null
  if (response.outcome === 'PROVIDER_CONFIRMED'
    && (response.physicalProviderCalled !== true || typeof response.providerMessageId !== 'string' || !/^d301/i.test(response.providerMessageId))) return null
  if (response.outcome === 'REFUSED_BEFORE_SEND' && response.physicalProviderCalled !== false) return null
  return response
}

function exactCommand(value: unknown): GatewayTextCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TextCanaryError('COMMAND_INVALID')
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1 || Object.keys(item).some(key => !['schemaVersion', 'accountId', 'protocolChatId', 'text', 'clientMessageId', 'replyToProviderMessageId'].includes(key))
    || typeof item.accountId !== 'string' || typeof item.protocolChatId !== 'string' || !/^\d{5,15}$/.test(item.protocolChatId)
    || typeof item.text !== 'string' || item.text.length < 1 || Buffer.byteLength(item.text, 'utf8') > 65_536
    || typeof item.clientMessageId !== 'string' || item.clientMessageId.length < 1 || item.clientMessageId.length > 256
    || /\p{Cc}/u.test(item.clientMessageId)
    || (item.replyToProviderMessageId !== undefined && (typeof item.replyToProviderMessageId !== 'string' || !REAL_MAX_MESSAGE_ID.test(item.replyToProviderMessageId)))) throw new TextCanaryError('COMMAND_INVALID')
  return item as unknown as GatewayTextCommand
}

export class TextCanaryService {
  readonly #client: PrismaClient
  readonly #config: TextSenderRuntimeConfig
  readonly #routeRegistry: PrismaRouteRegistry
  readonly #actor: PrismaPerConversationOutboundActor
  readonly #ledger: PrismaDispatchLedger
  readonly #sessionOwner: DurableAccountSessionOwner
  readonly #commandReplay = new Map<string, number>()
  readonly #lanes = new Map<string, Promise<unknown>>()
  readonly #sessionOwnerInstanceId: string
  readonly #actorOwnerId: string

  constructor(client: PrismaClient, config: TextSenderRuntimeConfig) {
    this.#client = client
    this.#config = config
    this.#routeRegistry = new PrismaRouteRegistry(client as any)
    this.#sessionOwner = new DurableAccountSessionOwner(new PrismaSessionOwnerRepository(client as any))
    this.#actor = new PrismaPerConversationOutboundActor(client as any, this.#routeRegistry)
    this.#ledger = new PrismaDispatchLedger(client as any, this.#routeRegistry, new SessionOwnerAuthorityVerifier(this.#sessionOwner))
    const bootId = randomUUID()
    this.#sessionOwnerInstanceId = `${config.sessionOwnerInstanceId}:${bootId}`
    this.#actorOwnerId = `${config.actorOwnerId}:${bootId}`
  }

  #conversationIsEnabled(accountId: string, conversationKey: string): boolean {
    return accountId === this.#config.accountId && (this.#config.operationalMode
      || this.#config.conversationScopes.has(canaryConversationScope(accountId, conversationKey)))
  }

  authenticateCommand(body: Buffer, authentication: GatewayCommandAuthentication, now = new Date()): boolean {
    if (!this.#config.enabled || !this.#config.commandHmacSecret || typeof authentication.timestamp !== 'string'
      || typeof authentication.nonce !== 'string' || authentication.nonce.length < 1 || authentication.nonce.length > 256
      || !/^[0-9a-f]{64}$/.test(authentication.signature || '')) return false
    const timestamp = new Date(authentication.timestamp)
    if (!Number.isFinite(timestamp.valueOf()) || Math.abs(now.valueOf() - timestamp.valueOf()) >= 60_000) return false
    for (const [key, expiry] of this.#commandReplay) if (expiry <= now.valueOf()) this.#commandReplay.delete(key)
    const replayKey = `${authentication.timestamp}\0${authentication.nonce}`
    if (this.#commandReplay.has(replayKey)) return false
    const bodyHash = createHash('sha256').update(body).digest('hex')
    const expected = createHmac('sha256', this.#config.commandHmacSecret)
      .update(`${COMMAND_NAMESPACE}\nPOST\n/v1/personal-max/commands/text\n${authentication.timestamp}\n${authentication.nonce}\n${bodyHash}`)
      .digest()
    const supplied = Buffer.from(authentication.signature!, 'hex')
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return false
    this.#commandReplay.set(replayKey, timestamp.valueOf() + 60_000)
    return true
  }

  async submit(value: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (!this.#config.enabled || !this.#config.physicalEnabled || !this.#config.emergencyStopClear) {
      throw new TextCanaryError('PHYSICAL_SENDER_DISABLED')
    }
    const command = exactCommand(value)
    if (command.accountId !== this.#config.accountId) throw new TextCanaryError('WRONG_ACCOUNT')
    // Register the request in its route lane before the first asynchronous
    // lookup. Otherwise concurrent route reads can complete out of order and
    // assign commandSequence by database scheduling rather than request FIFO.
    return this.#serialize(`${command.accountId}\0protocol_chat_id\0${command.protocolChatId}`, async () => {
      const route = await this.#routeRegistry.resolveByIdentity(command.accountId, 'protocol_chat_id', command.protocolChatId)
      if (!route || route.state !== 'active' || route.hasOpenConflict || route.activeProtocolChatId !== command.protocolChatId) {
        throw new TextCanaryError('ROUTE_NOT_SENDABLE')
      }
      if (!this.#conversationIsEnabled(command.accountId, route.conversationKey)) {
        throw new TextCanaryError('CONVERSATION_NOT_ALLOWLISTED')
      }
      const commandId = opaque('cmd', `${command.accountId}\0${command.clientMessageId}`)
      const enqueued = await this.#actor.enqueueCommand({
        commandId,
        accountId: command.accountId,
        conversationKey: route.conversationKey,
        clientMessageId: command.clientMessageId,
        commandKind: 'text',
        text: command.text,
        replyToProviderMessageId: command.replyToProviderMessageId,
        source: 'gravity',
      })
      const result = await this.#execute(enqueued.command.commandId, command.accountId, route.conversationKey)
      return {
        success: result.state !== 'hard_failed' && result.state !== 'retryable_failed',
        externalId: result.providerMessageId,
        chatId: command.protocolChatId,
        deliveryConfirmed: result.state === 'provider_confirmed',
        deliveryStatus: result.state === 'provider_confirmed' ? 'accepted_by_max'
          : result.state === 'reconciliation_required' ? 'needs_review'
            : result.state === 'dispatching' ? 'sending'
              : result.state,
        dispatchId: result.dispatchId,
        idempotent: enqueued.idempotent,
      }
    })
  }

  async authorize(value: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (!this.#config.enabled || !this.#config.physicalEnabled || !this.#config.emergencyStopClear) {
      throw new TextCanaryError('PHYSICAL_SENDER_DISABLED')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TextCanaryError('AUTHORIZATION_INVALID')
    const body = value as { request?: TextSenderRequestV1; authentication?: TextSenderAuthenticationV1 }
    const request = body.request
    const authentication = body.authentication
    const now = new Date()
    if (!request || !authentication || !verifyTextSenderAuthentication(request, authentication, {
      keys: this.#config.hmacKeys, now, maximumClockSkewMs: 60_000,
    })) throw new TextCanaryError('AUTH_INVALID')
    const requestedAt = new Date(request.requestedAt)
    const deadlineAt = new Date(request.deadlineAt)
    if (request.schemaVersion !== 1 || !Number.isFinite(requestedAt.valueOf()) || !Number.isFinite(deadlineAt.valueOf())
      || deadlineAt <= now || requestedAt > now || deadlineAt <= requestedAt) throw new TextCanaryError('DEADLINE_EXPIRED')
    if (!this.#conversationIsEnabled(request.accountId, request.conversationKey)) {
      throw new TextCanaryError('WRONG_ACCOUNT')
    }
    await this.#sessionOwner.verifyImmediatelyBeforeSender({
      accountId: request.accountId,
      ownerInstanceId: request.ownerInstanceId,
      fencingToken: BigInt(request.fencingToken),
    })
    const route = await this.#routeRegistry.getSendableRouteSnapshot(request.accountId, request.conversationKey)
    if (route.routeVersion !== request.route.routeVersion || route.activeProtocolChatId !== request.route.protocolChatId
      || (route.activeProviderUserId ?? null) !== request.route.providerUserId
      || (route.activeWebRouteId ?? null) !== request.route.webRouteId) throw new TextCanaryError('ROUTE_MISMATCH')
    const [command, dispatch, attempt] = await Promise.all([
      (this.#client as any).maxOutboundCommand.findUnique({ where: { commandId: request.commandId } }),
      (this.#client as any).maxOutboundDispatch.findUnique({ where: { commandId: request.commandId } }),
      (this.#client as any).maxOutboundDispatchAttempt.findUnique({ where: { attemptId: request.attemptId } }),
    ])
    const commandReplyTo = typeof command?.commandPayload?.replyToProviderMessageId === 'string'
      ? command.commandPayload.replyToProviderMessageId
      : undefined
    if (!command || !dispatch || !attempt || command.accountId !== request.accountId || command.conversationKey !== request.conversationKey
      || command.clientMessageId !== request.clientMessageId || command.commandPayload?.kind !== 'text'
      || command.commandPayload?.text !== request.payload?.text
      || commandReplyTo !== request.payload?.replyToProviderMessageId
      || dispatch.dispatchId !== attempt.dispatchId || dispatch.currentAttemptId !== request.attemptId
      || attempt.attemptCorrelationId !== request.attemptCorrelationId || attempt.senderOwnerId !== request.ownerInstanceId
      || String(attempt.senderFencingEpoch) !== request.fencingToken || attempt.routeVersion !== request.route.routeVersion
      || attempt.protocolChatId !== request.route.protocolChatId || (attempt.providerUserId ?? null) !== request.route.providerUserId
      || (attempt.webRouteId ?? null) !== request.route.webRouteId) throw new TextCanaryError('COMMAND_ATTEMPT_MISMATCH')
    if (attempt.attemptState === 'physical_action_started' && attempt.physicalActionStartedAt) {
      return { authorized: true, attemptId: request.attemptId, idempotent: true }
    }
    if (dispatch.state !== 'dispatching' || attempt.attemptState !== 'prepared') throw new TextCanaryError('COMMAND_ALREADY_TERMINAL')
    const marked = await this.#ledger.markPhysicalActionStarted({
      accountId: request.accountId, conversationKey: request.conversationKey,
      dispatchId: dispatch.dispatchId, attemptId: attempt.attemptId,
      expectedStateVersion: dispatch.stateVersion, expectedAttemptVersion: attempt.attemptVersion,
      transitionIdempotencyKey: opaque('transition', `${attempt.attemptId}:physical`),
      evidenceReference: request.attemptCorrelationId,
    })
    return { authorized: true, attemptId: request.attemptId, idempotent: marked.idempotent }
  }

  async #execute(commandId: string, accountId: string, conversationKey: string): Promise<any> {
    let dispatch = await (this.#client as any).maxOutboundDispatch.findUnique({ where: { commandId } })
    if (!dispatch) {
      const actor = await this.#actor.acquireActorLease({ accountId, conversationKey, ownerId: this.#actorOwnerId, leaseMilliseconds: 60_000 })
      const reservation = await this.#actor.reserveNextCommand({
        accountId, conversationKey, ownerId: this.#actorOwnerId, leaseEpoch: actor.leaseEpoch,
        expectedActorVersion: actor.optimisticVersion, reservationMilliseconds: 60_000,
      })
      if (reservation.status !== 'reserved' || reservation.command.commandId !== commandId) {
        return { state: 'queued', providerMessageId: null, dispatchId: null }
      }
      const created = await this.#ledger.createDispatchFromReservation({
        dispatchId: opaque('dispatch', commandId), accountId, conversationKey,
        reservationId: reservation.reservation.reservationId, expectedCommandId: commandId,
        expectedCommandSequence: reservation.command.commandSequence, ownerId: this.#actorOwnerId,
        actorLeaseEpoch: actor.leaseEpoch, expectedActorVersion: actor.optimisticVersion,
        expectedReservationVersion: reservation.reservation.reservationVersion,
        transitionIdempotencyKey: opaque('transition', `${commandId}:dispatch`),
      })
      dispatch = created.dispatch
    }
    if (dispatch.state === 'dispatching') {
      await this.#ledger.recoverStaleDispatches({ now: new Date(), limit: 100 })
      dispatch = await (this.#client as any).maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: dispatch.dispatchId } })
    }
    if (dispatch.state === 'provider_confirmed' || dispatch.state === 'reconciliation_required' || dispatch.state === 'hard_failed' || dispatch.state === 'dead_letter') return dispatch
    if (dispatch.state === 'retryable_failed') {
      const queued = await this.#ledger.queueRetry({
        accountId, conversationKey, dispatchId: dispatch.dispatchId,
        expectedStateVersion: dispatch.stateVersion,
        transitionIdempotencyKey: opaque('transition', `${dispatch.dispatchId}:retry:${dispatch.attemptCount}`),
        evidenceReference: opaque('evidence', `${dispatch.dispatchId}:pre-action-retry:${dispatch.attemptCount}`),
      })
      dispatch = queued.dispatch
    }
    if (dispatch.state === 'dispatching') return dispatch
    if (!['queued', 'retryable_failed'].includes(dispatch.state)) throw new TextCanaryError('ATTEMPT_IN_PROGRESS')
    const owner = await this.#sessionOwner.acquire({ accountId, ownerInstanceId: this.#sessionOwnerInstanceId, leaseMilliseconds: 120_000 })
    if (owner.lease.fencingToken > BigInt(Number.MAX_SAFE_INTEGER)) throw new TextCanaryError('FENCING_TOKEN_OVERFLOW')
    const attemptNumber = Number(dispatch.attemptCount) + 1
    const attemptId = opaque('attempt', `${dispatch.dispatchId}:${attemptNumber}`)
    const correlation = opaque('correlation', attemptId)
    const proofTimestamp = new Date()
    let begun
    try {
      begun = await this.#ledger.beginAttempt({
        attemptId, accountId, conversationKey, dispatchId: dispatch.dispatchId,
        expectedStateVersion: dispatch.stateVersion, senderOwnerId: this.#sessionOwnerInstanceId,
        senderFencingEpoch: Number(owner.lease.fencingToken), senderProofTimestamp: proofTimestamp,
        attemptCorrelationId: correlation, transitionIdempotencyKey: opaque('transition', `${attemptId}:begin`),
        claimMilliseconds: 60_000,
      })
    } catch (error) {
      if (dispatchErrorCode(error) === 'FIFO_BLOCKED') return dispatch
      throw error
    }
    const command = await this.#actor.getCommand(accountId, commandId)
    if (!command || !command.commandPayload || typeof command.commandPayload !== 'object'
      || Array.isArray(command.commandPayload) || (command.commandPayload as any).kind !== 'text'
      || typeof (command.commandPayload as any).text !== 'string') throw new TextCanaryError('COMMAND_PAYLOAD_INVALID')
    const request = buildTextSenderRequest({
      accountId, conversationKey,
      route: {
        routeVersion: begun.attempt.routeVersion, protocolChatId: begun.attempt.protocolChatId,
        providerUserId: begun.attempt.providerUserId, webRouteId: begun.attempt.webRouteId,
      },
      commandId, attemptId, attemptCorrelationId: correlation,
      clientMessageId: command.clientMessageId,
      idempotencyKey: opaque('idempotency', attemptId),
      ownerInstanceId: this.#sessionOwnerInstanceId, fencingToken: owner.lease.fencingToken,
      payload: {
        kind: 'text',
        text: (command.commandPayload as any).text,
        ...((command.commandPayload as any).replyToProviderMessageId ? { replyToProviderMessageId: (command.commandPayload as any).replyToProviderMessageId } : {}),
      },
      requestedAt: new Date(), deadlineAt: new Date(Date.now() + this.#config.requestTimeoutMs),
    })
    const authentication = signTextSenderRequest(request, {
      keyId: this.#config.currentKeyId!, secret: this.#config.hmacKeys.get(this.#config.currentKeyId!)!,
      timestamp: new Date(), nonce: randomUUID(),
    })
    let rawResponse: unknown
    try {
      const senderResponse = await fetch(this.#config.scraperUrl!, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        body: JSON.stringify({ request, authentication }),
      })
      rawResponse = await senderResponse.json().catch(() => null)
    } catch {
      rawResponse = null
    }
    const currentDispatch = await (this.#client as any).maxOutboundDispatch.findUniqueOrThrow({ where: { dispatchId: dispatch.dispatchId } })
    const currentAttempt = await (this.#client as any).maxOutboundDispatchAttempt.findUniqueOrThrow({ where: { attemptId } })
    if (currentDispatch.state === 'provider_confirmed' && currentAttempt.attemptState === 'provider_confirmed') {
      return currentDispatch
    }
    const response = senderResponse(rawResponse, attemptId)
    if (response?.outcome === 'PROVIDER_CONFIRMED' && typeof response.providerMessageId === 'string'
      && currentAttempt.attemptState === 'physical_action_started') {
      const accepted = await this.#ledger.recordClientActionAccepted({
        accountId, conversationKey, dispatchId: dispatch.dispatchId, attemptId,
        expectedStateVersion: currentDispatch.stateVersion, expectedAttemptVersion: currentAttempt.attemptVersion,
        transitionIdempotencyKey: opaque('transition', `${attemptId}:accepted`), evidenceReference: correlation,
      })
      const awaiting = await this.#ledger.markAwaitingConfirmation({
        accountId, conversationKey, dispatchId: dispatch.dispatchId, attemptId,
        expectedStateVersion: accepted.dispatch.stateVersion, expectedAttemptVersion: accepted.attempt!.attemptVersion,
        transitionIdempotencyKey: opaque('transition', `${attemptId}:awaiting`), evidenceReference: correlation,
      })
      try {
        const confirmed = await this.#ledger.recordExactProviderConfirmation({
          accountId, conversationKey, dispatchId: dispatch.dispatchId, attemptId,
          expectedStateVersion: awaiting.dispatch.stateVersion, expectedAttemptVersion: awaiting.attempt!.attemptVersion,
          transitionIdempotencyKey: opaque('transition', `${attemptId}:confirmed`),
          evidenceReference: correlation, providerMessageId: response.providerMessageId,
        })
        return confirmed.dispatch
      } catch (error) {
        if (dispatchErrorCode(error) !== 'PROVIDER_MESSAGE_ID_CONFLICT') throw error
        const unknown = await this.#ledger.recordUnknownOutcome({
          accountId, conversationKey, dispatchId: dispatch.dispatchId, attemptId,
          expectedStateVersion: awaiting.dispatch.stateVersion, expectedAttemptVersion: awaiting.attempt!.attemptVersion,
          transitionIdempotencyKey: opaque('transition', `${attemptId}:provider-id-conflict`),
          evidenceReference: correlation, reason: 'outcome_unknown',
        })
        return unknown.dispatch
      }
    }
    if (currentAttempt.attemptState === 'prepared') {
      const failed = await this.#ledger.recordPreActionFailure({
        accountId, conversationKey, dispatchId: dispatch.dispatchId, attemptId,
        expectedStateVersion: currentDispatch.stateVersion, expectedAttemptVersion: currentAttempt.attemptVersion,
        transitionIdempotencyKey: opaque('transition', `${attemptId}:pre-failed`), evidenceReference: correlation,
        safeErrorCode: safeCode(response?.safeCode, response === null ? 'SENDER_RESPONSE_INVALID' : 'SENDER_REFUSED'),
      })
      return failed.dispatch
    }
    if (currentAttempt.attemptState === 'physical_action_started') {
      try {
        const unknown = await this.#ledger.recordUnknownOutcome({
          accountId, conversationKey, dispatchId: dispatch.dispatchId, attemptId,
          expectedStateVersion: currentDispatch.stateVersion, expectedAttemptVersion: currentAttempt.attemptVersion,
          transitionIdempotencyKey: opaque('transition', `${attemptId}:unknown`), evidenceReference: correlation,
          reason: 'outcome_unknown',
        })
        return unknown.dispatch
      } catch (error) {
        const confirmed = await (this.#client as any).maxOutboundDispatch.findUnique({ where: { dispatchId: dispatch.dispatchId } })
        const confirmedAttempt = await (this.#client as any).maxOutboundDispatchAttempt.findUnique({ where: { attemptId } })
        if (confirmed?.state === 'provider_confirmed' && confirmedAttempt?.attemptState === 'provider_confirmed') {
          return confirmed
        }
        throw error
      }
    }
    throw new TextCanaryError('SENDER_STATE_MISMATCH')
  }

  async #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#lanes.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#lanes.set(key, current)
    try { return await current } finally { if (this.#lanes.get(key) === current) this.#lanes.delete(key) }
  }
}

export function textCanaryErrorCode(error: unknown): string {
  return error instanceof TextCanaryError ? error.code : safeCode(Reflect.get(Object(error), 'code'), 'TEXT_SENDER_FAILED')
}
