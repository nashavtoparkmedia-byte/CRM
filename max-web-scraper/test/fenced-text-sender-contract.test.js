'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  FencedTextSenderBoundary,
  InMemorySenderIdempotencyLedger,
  InMemorySenderReplayStore,
  SenderAuthenticator,
  SyntheticTextSenderAdapter,
  TextCanaryPolicy,
  canaryConversationScope,
  signForSyntheticTest,
} = require('../sender-v1')

const now = new Date('2026-07-28T22:30:00.000Z')
const keyId = 'synthetic-sender-key'
const secret = Buffer.alloc(32, 7)

function coded(code) { const error = new Error('synthetic refusal'); error.code = code; return error }

class FakeFenceVerifier {
  constructor(clock) { this.clock = clock; this.owners = new Map() }
  set(accountId, ownerInstanceId, fencingToken, leaseUntil = new Date(this.clock().valueOf() + 60_000)) {
    this.owners.set(accountId, { ownerInstanceId, fencingToken: String(fencingToken), leaseUntil })
  }
  async verifyImmediatelyBeforeSender(input) {
    const owner = this.owners.get(input.accountId)
    if (!owner) throw coded('WRONG_ACCOUNT')
    if (owner.leaseUntil <= this.clock()) throw coded('LEASE_EXPIRED')
    if (owner.ownerInstanceId !== input.ownerInstanceId || owner.fencingToken !== input.fencingToken) throw coded('STALE_FENCE')
    return { senderBoundaryVerified: true }
  }
}

class FakeRouteVerifier {
  constructor() { this.routes = new Map(); this.conflicts = new Set() }
  set(accountId, conversationKey, protocolChatId) { this.routes.set(`${accountId}\0${conversationKey}`, protocolChatId) }
  conflict(accountId, conversationKey) { this.conflicts.add(`${accountId}\0${conversationKey}`) }
  async verifyExactRoute(input) {
    const key = `${input.accountId}\0${input.conversationKey}`
    if (this.conflicts.has(key)) throw coded('ROUTE_CONFLICT')
    const target = this.routes.get(key)
    if (!target) throw coded('WRONG_CONVERSATION')
    if (target !== input.route.protocolChatId) throw coded('ROUTE_MISMATCH')
    return { exact: true }
  }
}

class FakeCommandVerifier {
  constructor() { this.terminal = new Set() }
  async verifyCommand(input) { if (this.terminal.has(input.commandId)) throw coded('COMMAND_ALREADY_TERMINAL'); return { exact: true } }
}

function request(overrides = {}) {
  const base = {
    schemaVersion: 1,
    accountId: 'account-a',
    conversationKey: 'conversation-a',
    route: { routeVersion: 1, protocolChatId: 'protocol-a', providerUserId: 'provider-a', webRouteId: 'web-a' },
    commandId: 'command-1',
    attemptId: 'attempt-1',
    attemptCorrelationId: 'correlation-1',
    clientMessageId: 'client-1',
    idempotencyKey: 'idempotency-1',
    ownerInstanceId: 'owner-a',
    fencingToken: '1',
    payload: { kind: 'text', text: 'exact synthetic text' },
    requestedAt: now.toISOString(),
    deadlineAt: new Date(now.valueOf() + 30_000).toISOString(),
  }
  return { ...base, ...overrides, route: overrides.route || base.route, payload: overrides.payload || base.payload }
}

function readyConfiguration(overrides = {}) {
  return {
    physicalSenderEnabled: true,
    globalPhysicalSenderDisabled: false,
    globalEmergencyStop: false,
    accountAllowlist: ['account-a'],
    conversationAllowlist: [canaryConversationScope('account-a', 'conversation-a')],
    maximumAccounts: 2,
    maximumConversations: 4,
    dailyMessageLimit: 500,
    ...overrides,
  }
}

function harness({ policy: policyOverrides = {}, adapterMode = 'confirmed', replayStore, ledger, keyResolver } = {}) {
  const clock = () => new Date(now)
  const replay = replayStore || new InMemorySenderReplayStore()
  const authenticator = new SenderAuthenticator({ keyResolver: keyResolver || (id => id === keyId ? secret : undefined), replayStore: replay, clock })
  const policy = new TextCanaryPolicy(readyConfiguration(policyOverrides))
  const fence = new FakeFenceVerifier(clock); fence.set('account-a', 'owner-a', '1')
  const route = new FakeRouteVerifier(); route.set('account-a', 'conversation-a', 'protocol-a')
  const command = new FakeCommandVerifier()
  const adapter = new SyntheticTextSenderAdapter(adapterMode)
  const idempotency = ledger || new InMemorySenderIdempotencyLedger()
  const boundary = new FencedTextSenderBoundary({ authenticator, idempotencyLedger: idempotency, canaryPolicy: policy, fenceVerifier: fence, routeVerifier: route, commandVerifier: command, syntheticAdapter: adapter, clock })
  return { boundary, replay, policy, fence, route, command, adapter, ledger: idempotency, clock }
}

let nonceSequence = 0
function auth(body, overrides = {}) {
  return signForSyntheticTest(body, { keyId, secret, timestamp: now, nonce: `nonce-${++nonceSequence}`, ...overrides })
}

async function execute(h, body = request(), authValue = auth(body)) { return h.boundary.handle(body, authValue) }

test('1 missing auth is refused before send', async () => {
  const h = harness(); const result = await h.boundary.handle(request(), undefined)
  assert.equal(result.safeCode, 'AUTH_MISSING'); assert.equal(h.adapter.calls.length, 0)
})

test('2 invalid auth signature is refused', async () => {
  const h = harness(); const body = request(); const invalid = { ...auth(body), signature: '0'.repeat(64) }
  assert.equal((await h.boundary.handle(body, invalid)).safeCode, 'AUTH_SIGNATURE_INVALID')
})

test('3 replayed authentication nonce is refused', async () => {
  const h = harness(); const body = request(); const signed = auth(body)
  assert.equal((await h.boundary.handle(body, signed)).outcome, 'PROVIDER_CONFIRMED')
  assert.equal((await h.boundary.handle(body, signed)).safeCode, 'AUTH_REPLAY')
})

test('4 wrong sender key namespace/key id is refused', async () => {
  const h = harness(); const body = request(); const signed = signForSyntheticTest(body, { keyId: 'wrong-key', secret, timestamp: now, nonce: 'wrong-key-nonce' })
  assert.equal((await h.boundary.handle(body, signed)).safeCode, 'AUTH_KEY_UNKNOWN')
})

test('5 missing fence is refused', async () => {
  const h = harness(); const body = request({ fencingToken: '' })
  assert.equal((await execute(h, body)).safeCode, 'FENCING_TOKEN_MISSING')
})

test('6 stale fence is refused and trips threshold', async () => {
  const h = harness(); const body = request({ fencingToken: '2' })
  assert.equal((await execute(h, body)).safeCode, 'STALE_FENCE'); assert.equal(h.policy.staleFenceRejects, 1)
})

test('7 expired lease is refused immediately before adapter', async () => {
  const h = harness(); h.fence.set('account-a', 'owner-a', '1', new Date(now.valueOf() - 1))
  assert.equal((await execute(h)).safeCode, 'LEASE_EXPIRED'); assert.equal(h.adapter.calls.length, 0)
})

test('8 wrong account is refused and latches kill switch', async () => {
  const h = harness({ policy: { accountAllowlist: ['account-a', 'account-b'], conversationAllowlist: [canaryConversationScope('account-a', 'conversation-a'), canaryConversationScope('account-b', 'conversation-a')] } })
  const body = request({ accountId: 'account-b' }); const result = await execute(h, body)
  assert.equal(result.safeCode, 'WRONG_ACCOUNT'); assert.equal(h.policy.wrongAccountStopped, true)
})

test('9 wrong conversation is refused', async () => {
  const h = harness({ policy: { conversationAllowlist: [canaryConversationScope('account-a', 'conversation-a'), canaryConversationScope('account-a', 'conversation-b')] } })
  const body = request({ conversationKey: 'conversation-b' })
  assert.equal((await execute(h, body)).safeCode, 'WRONG_CONVERSATION')
})

test('10 route conflict is refused and stops future canary attempts', async () => {
  const h = harness(); h.route.conflict('account-a', 'conversation-a')
  assert.equal((await execute(h)).safeCode, 'ROUTE_CONFLICT')
  const next = request({ commandId: 'command-2', attemptId: 'attempt-2', attemptCorrelationId: 'correlation-2', idempotencyKey: 'idempotency-2' })
  assert.equal((await execute(h, next)).safeCode, 'STOPPED_AFTER_ROUTE_CONFLICT')
})

test('11 media/reply payload is unsupported', async () => {
  const h = harness(); const body = request({ payload: { kind: 'media', text: 'x', reply: {} } })
  assert.equal((await execute(h, body)).outcome, 'UNSUPPORTED'); assert.equal(h.adapter.calls.length, 0)
})

test('12 duplicate request with new nonce returns prior outcome without a second call', async () => {
  const h = harness(); const body = request()
  const first = await execute(h, body); const second = await execute(h, body)
  assert.equal(first.idempotent, false); assert.equal(second.idempotent, true); assert.equal(h.adapter.calls.length, 1)
})

test('13 timeout before provider is honestly failed-before-provider', async () => {
  const h = harness({ adapterMode: 'timeout_before' }); const result = await execute(h)
  assert.equal(result.outcome, 'FAILED_BEFORE_PROVIDER'); assert.equal(result.safeCode, 'SYNTHETIC_TIMEOUT_BEFORE_PROVIDER')
})

test('14 timeout after sender boundary is unknown, never delivered', async () => {
  const h = harness({ adapterMode: 'timeout_after' }); const result = await execute(h)
  assert.equal(result.outcome, 'UNKNOWN_AFTER_ATTEMPT'); assert.equal(result.physicalProviderCalled, false)
})

test('15 first unknown stops the canary without blind retry', async () => {
  const h = harness({ adapterMode: 'unknown' }); assert.equal((await execute(h)).outcome, 'UNKNOWN_AFTER_ATTEMPT')
  const next = request({ commandId: 'command-2', attemptId: 'attempt-2', attemptCorrelationId: 'correlation-2', idempotencyKey: 'idempotency-2' })
  assert.equal((await execute(h, next)).safeCode, 'STOPPED_AFTER_UNKNOWN'); assert.equal(h.adapter.calls.length, 1)
})

test('16 global physical sender kill switch is default-on', async () => {
  const h = harness({ policy: { globalPhysicalSenderDisabled: true } })
  assert.equal((await execute(h)).safeCode, 'GLOBAL_PHYSICAL_SENDER_DISABLED')
})

test('17 account kill switch refuses allowlisted account', async () => {
  const h = harness({ policy: { disabledAccounts: ['account-a'] } })
  assert.equal((await execute(h)).safeCode, 'ACCOUNT_KILL_SWITCH')
})

test('18 conversation kill switch refuses exact account-conversation pair', async () => {
  const h = harness({ policy: { disabledConversations: [canaryConversationScope('account-a', 'conversation-a')] } })
  assert.equal((await execute(h)).safeCode, 'CONVERSATION_KILL_SWITCH')
})

test('19 burst calls preserve synthetic FIFO invocation identity', async () => {
  const h = harness()
  for (let index = 1; index <= 20; index += 1) {
    const body = request({ commandId: `command-${index}`, attemptId: `attempt-${index}`, attemptCorrelationId: `correlation-${index}`, idempotencyKey: `idempotency-${index}` })
    assert.equal((await execute(h, body)).outcome, 'PROVIDER_CONFIRMED')
  }
  assert.deepEqual(h.adapter.calls.map(call => call.attemptId), Array.from({ length: 20 }, (_, index) => `attempt-${index + 1}`))
})

test('20 one hundred identical texts remain one hundred exact attempts', async () => {
  const h = harness()
  for (let index = 1; index <= 100; index += 1) {
    const body = request({ commandId: `same-command-${index}`, attemptId: `same-attempt-${index}`, attemptCorrelationId: `same-correlation-${index}`, idempotencyKey: `same-idempotency-${index}` })
    await execute(h, body)
  }
  assert.equal(h.adapter.calls.length, 100); assert.equal(new Set(h.adapter.calls.map(call => call.attemptId)).size, 100)
})

test('21 two accounts remain isolated', async () => {
  const h = harness({ policy: { accountAllowlist: ['account-a', 'account-b'], conversationAllowlist: [canaryConversationScope('account-a', 'conversation-a'), canaryConversationScope('account-b', 'conversation-b')] } })
  h.fence.set('account-b', 'owner-b', '7'); h.route.set('account-b', 'conversation-b', 'protocol-b')
  const b = request({ accountId: 'account-b', conversationKey: 'conversation-b', ownerInstanceId: 'owner-b', fencingToken: '7', commandId: 'command-b', attemptId: 'attempt-b', attemptCorrelationId: 'correlation-b', idempotencyKey: 'idempotency-b', route: { routeVersion: 1, protocolChatId: 'protocol-b', providerUserId: null, webRouteId: null } })
  assert.equal((await execute(h)).outcome, 'PROVIDER_CONFIRMED'); assert.equal((await execute(h, b)).outcome, 'PROVIDER_CONFIRMED')
  assert.deepEqual(h.adapter.calls.map(call => call.accountId), ['account-a', 'account-b'])
})

test('22 scraper boundary restart reuses durable-style idempotency ledger', async () => {
  const h = harness(); const body = request(); await execute(h, body)
  const restarted = harness({ ledger: h.ledger, replayStore: h.replay }); restarted.adapter = h.adapter
  restarted.boundary.syntheticAdapter = h.adapter
  const duplicate = await execute(restarted, body)
  assert.equal(duplicate.idempotent, true); assert.equal(h.adapter.calls.length, 1)
})

test('23 gateway restart with a new nonce preserves request idempotency', async () => {
  const h = harness(); const body = request(); await execute(h, body)
  const duplicate = await h.boundary.handle(body, auth(body))
  assert.equal(duplicate.idempotent, true); assert.equal(h.adapter.calls.length, 1)
})

test('24 delayed stale request after takeover is refused', async () => {
  const h = harness(); h.fence.set('account-a', 'owner-new', '2')
  const delayed = await execute(h, request({ ownerInstanceId: 'owner-a', fencingToken: '1' }))
  assert.equal(delayed.safeCode, 'STALE_FENCE'); assert.equal(h.adapter.calls.length, 0)
})

test('25 synthetic adapter is invoked exactly once and physical provider count stays zero', async () => {
  const h = harness(); const result = await execute(h)
  assert.equal(result.outcome, 'PROVIDER_CONFIRMED'); assert.equal(h.adapter.calls.length, 1); assert.equal(h.adapter.physicalProviderCalls, 0)
})

test('authenticated body digest rejects post-sign route mutation', async () => {
  const h = harness(); const body = request(); const signed = auth(body); body.route = { ...body.route, protocolChatId: 'other-chat' }
  assert.equal((await h.boundary.handle(body, signed)).safeCode, 'AUTH_BODY_DIGEST_INVALID')
})

test('command terminal verifier refuses before synthetic adapter', async () => {
  const h = harness(); h.command.terminal.add('command-1')
  assert.equal((await execute(h)).safeCode, 'COMMAND_ALREADY_TERMINAL'); assert.equal(h.adapter.calls.length, 0)
})

test('repeated restart kill switch stops later attempt', async () => {
  const h = harness(); h.policy.recordRestart(); h.policy.recordRestart()
  assert.equal((await execute(h)).safeCode, 'STOPPED_AFTER_REPEATED_RESTART')
})

test('daily message limit is bounded', async () => {
  const h = harness({ policy: { dailyMessageLimit: 1 } }); await execute(h)
  const second = request({ commandId: 'command-2', attemptId: 'attempt-2', attemptCorrelationId: 'correlation-2', idempotencyKey: 'idempotency-2' })
  assert.equal((await execute(h, second)).safeCode, 'DAILY_MESSAGE_LIMIT')
})

test('length-prefixed conversation scopes cannot collide on account colons', () => {
  assert.notEqual(canaryConversationScope('account:a', 'conversation'), canaryConversationScope('account', 'a:conversation'))
})
