'use strict'

const {
  DurableSenderAttemptStore,
  DurableSenderReplayStore,
  PhysicalTextSenderBoundary,
  SenderAuthenticator,
  TextCanaryPolicy,
} = require('./index')

function exactBoolean(value) { return value === 'true' }

function jsonStringArray(raw, label) {
  let value
  try { value = JSON.parse(raw || '[]') } catch { throw new Error(`${label} is invalid`) }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} is invalid`)
  return value
}

function hmacKeys(raw) {
  let value
  try { value = JSON.parse(raw || '{}') } catch { throw new Error('Sender HMAC keys are invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Sender HMAC keys are invalid')
  const keys = new Map()
  for (const [keyId, secret] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
      throw new Error('Sender HMAC key is invalid')
    }
    keys.set(keyId, Buffer.from(secret))
  }
  return keys
}

function positiveInteger(raw, fallback, maximum, label) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} is invalid`)
  return value
}

function createPhysicalTextSenderRuntime({ environment = process.env, preflight, send, fetchImpl = fetch, clock = () => new Date() }) {
  if (!exactBoolean(environment.MAX_PERSONAL_TEXT_SENDER_ENABLED)) return null
  const gateway = new URL(environment.MAX_PERSONAL_TEXT_SENDER_GATEWAY_URL || '')
  if (gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.search || gateway.hash
    || gateway.pathname !== '/v1/personal-max/sender/authorize'
    || !['max-personal-gateway', '127.0.0.1', 'localhost'].includes(gateway.hostname)) {
    throw new Error('Sender authorization URL is not an exact private endpoint')
  }
  const statePath = environment.MAX_PERSONAL_TEXT_SENDER_STATE_PATH
  if (!statePath || !statePath.startsWith('/var/lib/')) throw new Error('Sender state path must be persistent')
  const keys = hmacKeys(environment.MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON)
  if (keys.size < 1 || keys.size > 4) throw new Error('Sender HMAC rotation set is empty or unbounded')
  const accountAllowlist = jsonStringArray(environment.MAX_PERSONAL_TEXT_SENDER_ACCOUNTS_JSON, 'Sender account allowlist')
  const conversationAllowlist = jsonStringArray(environment.MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON, 'Sender conversation allowlist')
  const replayStore = new DurableSenderReplayStore(statePath)
  const attemptStore = new DurableSenderAttemptStore(statePath)
  const authenticator = new SenderAuthenticator({
    keyResolver: keyId => keys.get(keyId),
    replayStore,
    clock,
    replayWindowMilliseconds: positiveInteger(environment.MAX_PERSONAL_TEXT_SENDER_REPLAY_WINDOW_MS, 60_000, 300_000, 'Sender replay window'),
  })
  const canaryPolicy = new TextCanaryPolicy({
    physicalSenderEnabled: true,
    globalPhysicalSenderDisabled: !exactBoolean(environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED),
    globalEmergencyStop: !exactBoolean(environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR),
    accountAllowlist,
    conversationAllowlist,
    maximumAccounts: 1,
    maximumConversations: 1,
    dailyMessageLimit: positiveInteger(environment.MAX_PERSONAL_TEXT_SENDER_DAILY_LIMIT, 3, 100, 'Sender daily limit'),
  })
  const startOfUtcDay = Date.UTC(clock().getUTCFullYear(), clock().getUTCMonth(), clock().getUTCDate())
  const durableSafety = attemptStore.summarizeSince(startOfUtcDay)
  canaryPolicy.calls = durableSafety.physicalCalls
  canaryPolicy.unknownStopped = durableSafety.unknownOutcomes > 0
  canaryPolicy.routeConflictStopped = durableSafety.routeConflicts > 0
  canaryPolicy.wrongAccountStopped = durableSafety.wrongAccounts > 0
  canaryPolicy.staleFenceRejects = durableSafety.staleFences
  const authorize = async (request, authentication) => {
    const response = await fetchImpl(gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ request, authentication }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error('Gateway authorization refused')
      error.code = body && /^[A-Z0-9_]{1,128}$/.test(body.safeCode || '') ? body.safeCode : 'GATEWAY_AUTHORIZATION_REFUSED'
      throw error
    }
    return body
  }
  const boundary = new PhysicalTextSenderBoundary({ authenticator, attemptStore, canaryPolicy, preflight, authorize, send, clock })
  return Object.freeze({ boundary, canaryPolicy })
}

module.exports = { createPhysicalTextSenderRuntime }
