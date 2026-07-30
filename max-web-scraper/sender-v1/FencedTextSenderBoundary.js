'use strict'

const { createHash } = require('node:crypto')
const { SenderAuthenticationError, canonical } = require('./authentication')

const OUTCOMES = new Set([
  'REFUSED_BEFORE_SEND',
  'ACCEPTED_BY_SENDER_BOUNDARY',
  'PROVIDER_CONFIRMED',
  'UNKNOWN_AFTER_ATTEMPT',
  'FAILED_BEFORE_PROVIDER',
  'UNSUPPORTED',
])

class InMemorySenderIdempotencyLedger {
  constructor() { this.byAttempt = new Map(); this.byKey = new Map() }

  lookup(request, digest) {
    const prior = this.byAttempt.get(request.attemptId) || this.byKey.get(`${request.accountId}\0${request.idempotencyKey}`)
    if (!prior) return { status: 'missing' }
    if (prior.digest !== digest) return { status: 'conflict' }
    return { status: 'prior', response: prior.response }
  }

  store(request, digest, response) {
    const entry = Object.freeze({ digest, response })
    this.byAttempt.set(request.attemptId, entry)
    this.byKey.set(`${request.accountId}\0${request.idempotencyKey}`, entry)
  }
}

function response(request, outcome, safeCode, idempotent = false, syntheticAdapterCalled = false) {
  if (!OUTCOMES.has(outcome)) throw new Error('Sender outcome is not honest')
  return Object.freeze({
    schemaVersion: 1,
    attemptId: request && typeof request.attemptId === 'string' ? request.attemptId : null,
    outcome,
    safeCode,
    idempotent,
    syntheticAdapterCalled,
    physicalProviderCalled: false,
  })
}

function identifier(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim() && !/[\p{Cc}]/u.test(value) && value !== '*'
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || request.schemaVersion !== 1) return 'CONTRACT_INVALID'
  const topLevelFields = new Set(['schemaVersion', 'accountId', 'conversationKey', 'route', 'commandId', 'attemptId', 'attemptCorrelationId', 'clientMessageId', 'idempotencyKey', 'ownerInstanceId', 'fencingToken', 'payload', 'requestedAt', 'deadlineAt'])
  if (Object.keys(request).some(key => !topLevelFields.has(key))) return 'CONTRACT_INVALID'
  for (const field of ['accountId', 'conversationKey', 'commandId', 'attemptId', 'attemptCorrelationId', 'idempotencyKey', 'ownerInstanceId']) {
    if (!identifier(request[field], field === 'accountId' ? 128 : 256)) return 'CONTRACT_INVALID'
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.accountId)) return 'CONTRACT_INVALID'
  if (request.clientMessageId !== null && !identifier(request.clientMessageId)) return 'CONTRACT_INVALID'
  if (!/^[1-9][0-9]*$/.test(request.fencingToken || '')) return 'FENCING_TOKEN_MISSING'
  if (!request.route || typeof request.route !== 'object' || !Number.isSafeInteger(request.route.routeVersion) || request.route.routeVersion < 1 || !identifier(request.route.protocolChatId)) return 'ROUTE_INVALID'
  if (Object.keys(request.route).some(key => !['routeVersion', 'protocolChatId', 'providerUserId', 'webRouteId'].includes(key))) return 'ROUTE_INVALID'
  if (request.route.providerUserId !== null && !identifier(request.route.providerUserId)) return 'ROUTE_INVALID'
  if (request.route.webRouteId !== null && !identifier(request.route.webRouteId)) return 'ROUTE_INVALID'
  if (!request.payload || request.payload.kind !== 'text' || typeof request.payload.text !== 'string' || request.payload.text.length === 0 || Buffer.byteLength(request.payload.text, 'utf8') > 65_536) return 'PAYLOAD_UNSUPPORTED'
  if (Object.keys(request.payload).some(key => !['kind', 'text'].includes(key)) || 'phone' in request || 'displayName' in request || 'reply' in request || 'reaction' in request) return 'PAYLOAD_UNSUPPORTED'
  const requestedAt = new Date(request.requestedAt); const deadlineAt = new Date(request.deadlineAt)
  if (!Number.isFinite(requestedAt.valueOf()) || !Number.isFinite(deadlineAt.valueOf()) || deadlineAt <= requestedAt) return 'CONTRACT_INVALID'
  return null
}

class FencedTextSenderBoundary {
  constructor({ authenticator, idempotencyLedger, canaryPolicy, fenceVerifier, routeVerifier, commandVerifier, syntheticAdapter, clock = () => new Date() }) {
    this.authenticator = authenticator
    this.idempotencyLedger = idempotencyLedger
    this.canaryPolicy = canaryPolicy
    this.fenceVerifier = fenceVerifier
    this.routeVerifier = routeVerifier
    this.commandVerifier = commandVerifier
    this.syntheticAdapter = syntheticAdapter
    this.clock = clock
  }

  async handle(request, auth) {
    try {
      this.authenticator.authenticate(request, auth)
    } catch (error) {
      const code = error instanceof SenderAuthenticationError ? error.code : 'AUTH_INVALID'
      return response(request, 'REFUSED_BEFORE_SEND', code)
    }
    const invalid = validateRequest(request)
    if (invalid) return response(request, invalid === 'PAYLOAD_UNSUPPORTED' ? 'UNSUPPORTED' : 'REFUSED_BEFORE_SEND', invalid)
    const now = this.clock()
    if (new Date(request.deadlineAt) <= now) return response(request, 'REFUSED_BEFORE_SEND', 'DEADLINE_EXPIRED')
    const digest = createHash('sha256').update(canonical(request)).digest('hex')
    const prior = this.idempotencyLedger.lookup(request, digest)
    if (prior.status === 'prior') return Object.freeze({ ...prior.response, idempotent: true })
    if (prior.status === 'conflict') return response(request, 'REFUSED_BEFORE_SEND', 'IDEMPOTENCY_CONFLICT')
    const policyRefusal = this.canaryPolicy.evaluate(request)
    if (policyRefusal) {
      const refused = response(request, 'REFUSED_BEFORE_SEND', policyRefusal)
      this.idempotencyLedger.store(request, digest, refused)
      return refused
    }
    try {
      await this.fenceVerifier.verifyImmediatelyBeforeSender({ accountId: request.accountId, ownerInstanceId: request.ownerInstanceId, fencingToken: request.fencingToken })
      await this.routeVerifier.verifyExactRoute({ accountId: request.accountId, conversationKey: request.conversationKey, route: request.route })
      await this.commandVerifier.verifyCommand({ accountId: request.accountId, conversationKey: request.conversationKey, commandId: request.commandId, attemptId: request.attemptId, attemptCorrelationId: request.attemptCorrelationId })
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'BOUNDARY_VERIFICATION_FAILED'
      if (code === 'STALE_FENCE' || code === 'LEASE_EXPIRED') this.canaryPolicy.recordSafetySignal('STALE_FENCE')
      if (code === 'ROUTE_CONFLICT') this.canaryPolicy.recordSafetySignal('ROUTE_CONFLICT')
      if (code === 'WRONG_ACCOUNT') this.canaryPolicy.recordSafetySignal('WRONG_ACCOUNT')
      const refused = response(request, 'REFUSED_BEFORE_SEND', code)
      this.idempotencyLedger.store(request, digest, refused)
      return refused
    }
    this.canaryPolicy.recordBoundaryCall()
    const adapterResult = await this.syntheticAdapter.invoke(request)
    if (!OUTCOMES.has(adapterResult.outcome)) throw new Error('Synthetic adapter returned a dishonest outcome')
    const result = response(request, adapterResult.outcome, adapterResult.safeCode, false, true)
    this.idempotencyLedger.store(request, digest, result)
    this.canaryPolicy.recordOutcome(result.outcome)
    return result
  }
}

module.exports = { FencedTextSenderBoundary, InMemorySenderIdempotencyLedger, OUTCOMES, validateRequest }
