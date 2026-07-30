'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const test = require('node:test')
const { createPhysicalTextSenderRuntime } = require('../sender-v1/runtime')
const { DurableSenderAttemptStore, canonical, canaryConversationScope, signForSyntheticTest } = require('../sender-v1')

const secret = 'physical-sender-test-secret-000000000000000000'
const now = new Date('2026-07-29T12:00:00.000Z')

function request(overrides = {}) {
  return {
    schemaVersion: 1, accountId: 'account-a', conversationKey: 'conversation-a',
    route: { routeVersion: 2, protocolChatId: '900001', providerUserId: 'provider-a', webRouteId: null },
    commandId: 'command-a', attemptId: 'attempt-a', attemptCorrelationId: 'correlation-a',
    clientMessageId: 'client-a', idempotencyKey: 'idempotency-a', ownerInstanceId: 'scraper-owner',
    fencingToken: '3', payload: { kind: 'text', text: 'exact durable text' },
    requestedAt: now.toISOString(), deadlineAt: new Date(now.valueOf() + 30_000).toISOString(),
    ...overrides,
  }
}

function environment(statePath) {
  return {
    MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true',
    MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
    MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true',
    MAX_PERSONAL_TEXT_SENDER_GATEWAY_URL: 'http://max-personal-gateway:8080/v1/personal-max/sender/authorize',
    MAX_PERSONAL_TEXT_SENDER_STATE_PATH: statePath,
    MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
    MAX_PERSONAL_TEXT_SENDER_ACCOUNTS_JSON: JSON.stringify(['account-a']),
    MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify([canaryConversationScope('account-a', 'conversation-a')]),
    MAX_PERSONAL_TEXT_SENDER_DAILY_LIMIT: '3',
  }
}

function authentication(body, nonce) {
  return signForSyntheticTest(body, { keyId: 'current', secret: Buffer.from(secret), timestamp: now, nonce })
}

function harness(directory, calls, options = {}) {
  return createPhysicalTextSenderRuntime({
    environment: environment(directory), clock: () => new Date(now),
    preflight: async () => { calls.preflight += 1 },
    fetchImpl: async (_url, init) => {
      calls.authorize += 1
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({ authorized: true, attemptId: body.request.attemptId }), { status: 200 })
    },
    send: async body => {
      calls.send += 1
      if (options.unknown) throw new Error('connection dropped after action')
      return { outcome: 'PROVIDER_CONFIRMED', providerMessageId: `d301${createHash('sha256').update(body.attemptId).digest('hex')}`, physicalProviderCalled: true }
    },
  })
}

test('durable physical boundary confirms exact provider identity once across restart', async t => {
  const directory = fs.mkdtempSync('/var/lib/max-sender-test-')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = { preflight: 0, authorize: 0, send: 0 }
  const body = request()
  const first = await harness(directory, calls).boundary.handle(body, authentication(body, 'nonce-one'))
  assert.equal(first.outcome, 'PROVIDER_CONFIRMED')
  assert.match(first.providerMessageId, /^d301[0-9a-f]{64}$/)
  const duplicate = await harness(directory, calls).boundary.handle(body, authentication(body, 'nonce-two'))
  assert.equal(duplicate.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(duplicate.idempotent, true)
  assert.deepEqual(calls, { preflight: 1, authorize: 1, send: 1 })
})

test('post-action failure is durable UNKNOWN and never blindly retried', async t => {
  const directory = fs.mkdtempSync('/var/lib/max-sender-test-')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = { preflight: 0, authorize: 0, send: 0 }
  const body = request()
  const first = await harness(directory, calls, { unknown: true }).boundary.handle(body, authentication(body, 'nonce-three'))
  assert.equal(first.outcome, 'UNKNOWN_AFTER_ATTEMPT')
  const duplicate = await harness(directory, calls).boundary.handle(body, authentication(body, 'nonce-four'))
  assert.equal(duplicate.outcome, 'UNKNOWN_AFTER_ATTEMPT')
  assert.equal(duplicate.idempotent, true)
  assert.equal(calls.send, 1)
})

test('a reserved pre-action attempt is recoverable after a process restart', async t => {
  const directory = fs.mkdtempSync('/var/lib/max-sender-test-')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const body = request()
  const digest = createHash('sha256').update(canonical(body)).digest('hex')
  const crashedStore = new DurableSenderAttemptStore(directory)
  assert.equal(crashedStore.reserve(body, digest).status, 'reserved')
  const calls = { preflight: 0, authorize: 0, send: 0 }
  const recovered = await harness(directory, calls).boundary.handle(body, authentication(body, 'nonce-recovered'))
  assert.equal(recovered.outcome, 'PROVIDER_CONFIRMED')
  assert.deepEqual(calls, { preflight: 1, authorize: 1, send: 1 })
})

test('a physically-started crash becomes durable UNKNOWN without another provider call', async t => {
  const directory = fs.mkdtempSync('/var/lib/max-sender-test-')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const body = request()
  const digest = createHash('sha256').update(canonical(body)).digest('hex')
  const crashedStore = new DurableSenderAttemptStore(directory)
  assert.equal(crashedStore.reserve(body, digest).status, 'reserved')
  crashedStore.markPhysicalStarted(body, digest)
  const calls = { preflight: 0, authorize: 0, send: 0 }
  const recovered = await harness(directory, calls).boundary.handle(body, authentication(body, 'nonce-post-action'))
  assert.equal(recovered.outcome, 'UNKNOWN_AFTER_ATTEMPT')
  assert.equal(recovered.safeCode, 'DURABLE_POST_ACTION_RECOVERY')
  assert.deepEqual(calls, { preflight: 0, authorize: 0, send: 0 })
})

test('a concurrent duplicate is refused while the reserved local attempt is in flight', async t => {
  const directory = fs.mkdtempSync('/var/lib/max-sender-test-')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = { preflight: 0, authorize: 0, send: 0 }
  let releaseAuthorization
  const authorizationGate = new Promise(resolve => { releaseAuthorization = resolve })
  const runtime = createPhysicalTextSenderRuntime({
    environment: environment(directory), clock: () => new Date(now),
    preflight: async () => { calls.preflight += 1 },
    fetchImpl: async (_url, init) => {
      calls.authorize += 1
      await authorizationGate
      const envelope = JSON.parse(init.body)
      return new Response(JSON.stringify({ authorized: true, attemptId: envelope.request.attemptId }), { status: 200 })
    },
    send: async body => {
      calls.send += 1
      return { outcome: 'PROVIDER_CONFIRMED', providerMessageId: `d301${createHash('sha256').update(body.attemptId).digest('hex')}`, physicalProviderCalled: true }
    },
  })
  const body = request()
  const firstPromise = runtime.boundary.handle(body, authentication(body, 'nonce-concurrent-one'))
  while (calls.authorize === 0) await new Promise(resolve => setImmediate(resolve))
  const duplicate = await runtime.boundary.handle(body, authentication(body, 'nonce-concurrent-two'))
  assert.equal(duplicate.outcome, 'REFUSED_BEFORE_SEND')
  assert.equal(duplicate.safeCode, 'ATTEMPT_IN_PROGRESS')
  releaseAuthorization()
  const first = await firstPromise
  assert.equal(first.outcome, 'PROVIDER_CONFIRMED')
  assert.deepEqual(calls, { preflight: 1, authorize: 1, send: 1 })
})

test('daily provider-call limit and UNKNOWN stop are restored from durable state', async t => {
  const limitDirectory = fs.mkdtempSync('/var/lib/max-sender-test-')
  const unknownDirectory = fs.mkdtempSync('/var/lib/max-sender-test-')
  t.after(() => fs.rmSync(limitDirectory, { recursive: true, force: true }))
  t.after(() => fs.rmSync(unknownDirectory, { recursive: true, force: true }))
  const calls = { preflight: 0, authorize: 0, send: 0 }
  const distinct = index => request({
    commandId: `command-${index}`, attemptId: `attempt-${index}`, attemptCorrelationId: `correlation-${index}`,
    clientMessageId: `client-${index}`, idempotencyKey: `idempotency-${index}`,
  })
  for (let index = 1; index <= 3; index += 1) {
    const body = distinct(index)
    const sent = await harness(limitDirectory, calls).boundary.handle(body, authentication(body, `nonce-limit-${index}`))
    assert.equal(sent.outcome, 'PROVIDER_CONFIRMED')
  }
  const fourth = distinct(4)
  const limited = await harness(limitDirectory, calls).boundary.handle(fourth, authentication(fourth, 'nonce-limit-four'))
  assert.equal(limited.safeCode, 'DAILY_MESSAGE_LIMIT')
  assert.equal(calls.send, 3)

  const unknownCalls = { preflight: 0, authorize: 0, send: 0 }
  const uncertain = distinct('unknown')
  assert.equal((await harness(unknownDirectory, unknownCalls, { unknown: true }).boundary
    .handle(uncertain, authentication(uncertain, 'nonce-unknown-one'))).outcome, 'UNKNOWN_AFTER_ATTEMPT')
  const next = distinct('after-unknown')
  const stopped = await harness(unknownDirectory, unknownCalls).boundary.handle(next, authentication(next, 'nonce-unknown-two'))
  assert.equal(stopped.safeCode, 'STOPPED_AFTER_UNKNOWN')
  assert.equal(unknownCalls.send, 1)
})

test('default-off runtime does not construct a physical boundary', () => {
  assert.equal(createPhysicalTextSenderRuntime({ environment: {}, preflight: async () => {}, send: async () => {} }), null)
})
