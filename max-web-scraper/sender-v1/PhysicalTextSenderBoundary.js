'use strict'

const { createHash } = require('node:crypto')
const { SenderAuthenticationError, canonical } = require('./authentication')
const { validateRequest } = require('./FencedTextSenderBoundary')

function outcome(request, value, safeCode, options = {}) {
  return Object.freeze({
    schemaVersion: 1,
    attemptId: request && typeof request.attemptId === 'string' ? request.attemptId : null,
    outcome: value,
    safeCode,
    idempotent: options.idempotent === true,
    physicalProviderCalled: options.physicalProviderCalled === true,
    providerMessageId: typeof options.providerMessageId === 'string' ? options.providerMessageId : null,
  })
}

function recordSafetySignal(canaryPolicy, safeCode) {
  if (['STALE_FENCE', 'LEASE_EXPIRED'].includes(safeCode)) canaryPolicy.recordSafetySignal('STALE_FENCE')
  if (['ROUTE_CONFLICT', 'ROUTE_MISMATCH'].includes(safeCode)) canaryPolicy.recordSafetySignal('ROUTE_CONFLICT')
  if (['WRONG_ACCOUNT', 'ACCOUNT_NOT_ALLOWLISTED'].includes(safeCode)) canaryPolicy.recordSafetySignal('WRONG_ACCOUNT')
}

class PhysicalTextSenderBoundary {
  constructor({ authenticator, attemptStore, canaryPolicy, preflight = async () => {}, authorize, send, clock = () => new Date() }) {
    this.authenticator = authenticator
    this.attemptStore = attemptStore
    this.canaryPolicy = canaryPolicy
    this.preflight = preflight
    this.authorize = authorize
    this.send = send
    this.clock = clock
  }

  async handle(request, authentication) {
    try {
      this.authenticator.authenticate(request, authentication)
    } catch (error) {
      const code = error instanceof SenderAuthenticationError ? error.code : 'AUTH_INVALID'
      return outcome(request, 'REFUSED_BEFORE_SEND', code)
    }
    const invalid = validateRequest(request)
    if (invalid) return outcome(request, invalid === 'PAYLOAD_UNSUPPORTED' ? 'UNSUPPORTED' : 'REFUSED_BEFORE_SEND', invalid)
    const now = this.clock()
    if (new Date(request.deadlineAt) <= now) return outcome(request, 'REFUSED_BEFORE_SEND', 'DEADLINE_EXPIRED')
    const requestDigest = createHash('sha256').update(canonical(request)).digest('hex')
    const prior = this.attemptStore.lookup(request, requestDigest)
    if (prior.status === 'prior') return Object.freeze({ ...prior.response, idempotent: true })
    if (prior.status === 'conflict') return outcome(request, 'REFUSED_BEFORE_SEND', 'IDEMPOTENCY_CONFLICT')
    if (prior.status === 'uncertain') {
      return outcome(request, 'UNKNOWN_AFTER_ATTEMPT', 'DURABLE_POST_ACTION_RECOVERY', { idempotent: true, physicalProviderCalled: true })
    }
    if (prior.status === 'pending_local') return outcome(request, 'REFUSED_BEFORE_SEND', 'ATTEMPT_IN_PROGRESS', { idempotent: true })
    const policyRefusal = this.canaryPolicy.evaluate(request)
    if (policyRefusal) {
      recordSafetySignal(this.canaryPolicy, policyRefusal)
      return outcome(request, 'REFUSED_BEFORE_SEND', policyRefusal)
    }
    try {
      await this.preflight(request)
    } catch (error) {
      const safeCode = error && /^[A-Z0-9_]{1,128}$/.test(error.code || '') ? error.code : 'SENDER_NOT_READY'
      return outcome(request, 'REFUSED_BEFORE_SEND', safeCode)
    }
    const reserved = prior.status === 'pending_recoverable'
      ? this.attemptStore.claimPending(request, requestDigest)
      : this.attemptStore.reserve(request, requestDigest)
    if (reserved.status !== 'reserved' && reserved.status !== 'missing') {
      if (reserved.status === 'prior') return Object.freeze({ ...reserved.response, idempotent: true })
      if (reserved.status === 'uncertain') return outcome(request, 'UNKNOWN_AFTER_ATTEMPT', 'DURABLE_POST_ACTION_RECOVERY', { idempotent: true, physicalProviderCalled: true })
      if (reserved.status === 'pending_local') return outcome(request, 'REFUSED_BEFORE_SEND', 'ATTEMPT_IN_PROGRESS', { idempotent: true })
      return outcome(request, 'REFUSED_BEFORE_SEND', 'IDEMPOTENCY_CONFLICT')
    }
    let authorization
    try {
      authorization = await this.authorize(request, authentication)
    } catch (error) {
      const safeCode = error && /^[A-Z0-9_]{1,128}$/.test(error.code || '') ? error.code : 'GATEWAY_AUTHORIZATION_FAILED'
      recordSafetySignal(this.canaryPolicy, safeCode)
      const refused = outcome(request, 'REFUSED_BEFORE_SEND', safeCode)
      this.attemptStore.finish(request, requestDigest, refused)
      return refused
    }
    if (!authorization || authorization.authorized !== true || authorization.attemptId !== request.attemptId) {
      const safeCode = authorization?.safeCode || 'GATEWAY_AUTHORIZATION_REFUSED'
      recordSafetySignal(this.canaryPolicy, safeCode)
      const refused = outcome(request, 'REFUSED_BEFORE_SEND', safeCode)
      this.attemptStore.finish(request, requestDigest, refused)
      return refused
    }
    this.attemptStore.markPhysicalStarted(request, requestDigest)
    this.canaryPolicy.recordBoundaryCall()
    let result
    try {
      result = await this.send(request)
    } catch {
      result = { outcome: 'UNKNOWN_AFTER_ATTEMPT', safeCode: 'PROVIDER_CALL_OUTCOME_UNKNOWN', physicalProviderCalled: true }
    }
    const confirmed = result && result.outcome === 'PROVIDER_CONFIRMED'
      && typeof result.providerMessageId === 'string' && /^d301/i.test(result.providerMessageId)
    const response = confirmed
      ? outcome(request, 'PROVIDER_CONFIRMED', 'EXACT_PROVIDER_CONFIRMATION', { physicalProviderCalled: true, providerMessageId: result.providerMessageId })
      : outcome(request, 'UNKNOWN_AFTER_ATTEMPT', result?.safeCode || 'PROVIDER_CALL_OUTCOME_UNKNOWN', { physicalProviderCalled: true })
    this.attemptStore.finish(request, requestDigest, response)
    this.canaryPolicy.recordOutcome(response.outcome)
    return response
  }
}

module.exports = { PhysicalTextSenderBoundary }
