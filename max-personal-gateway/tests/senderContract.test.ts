import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildTextSenderRequest, canonicalTextSenderBody, signTextSenderRequest } from '../src/sender/GatewayTextSenderRequest.ts'
import { textSenderFeatureFlags } from '../src/sender/featureFlag.ts'
import { TEXT_SENDER_AUTH_NAMESPACE, TEXT_SENDER_ENDPOINT } from '../src/sender/types.ts'

const require = createRequire(import.meta.url)
const { canonical, signForSyntheticTest } = require('../../max-web-scraper/sender-v1/authentication.js') as {
  canonical(value: unknown): string
  signForSyntheticTest(request: unknown, input: { keyId: string; secret: Buffer; timestamp: Date; nonce: string }): Record<string, unknown>
}

const timestamp = new Date('2026-07-28T22:30:00.000Z')

function request() {
  return buildTextSenderRequest({
    accountId: 'account-a', conversationKey: 'conversation-a',
    route: { routeVersion: 3, protocolChatId: 'protocol-exact', providerUserId: 'provider-exact', webRouteId: 'web-exact' },
    commandId: 'command-1', attemptId: 'attempt-1', attemptCorrelationId: 'correlation-1', clientMessageId: 'client-1',
    idempotencyKey: 'idempotency-1', ownerInstanceId: 'owner-1', fencingToken: 42n,
    payload: { kind: 'text', text: '  exact Unicode Привет\n' }, requestedAt: timestamp, deadlineAt: new Date(timestamp.valueOf() + 30_000),
  })
}

test('gateway request uses exact route and canonical decimal fencing token without fallback identifiers', () => {
  const built = request()
  assert.equal(TEXT_SENDER_ENDPOINT, '/v1/personal-max/send/text')
  assert.equal(built.fencingToken, '42')
  assert.equal(built.route.protocolChatId, 'protocol-exact')
  assert.equal(built.payload.text, '  exact Unicode Привет\n')
  assert.equal('phone' in built || 'displayName' in built, false)
})

test('gateway request carries reply target as signed provider identity only', () => {
  const built = buildTextSenderRequest({
    accountId: 'account-a', conversationKey: 'conversation-a',
    route: { routeVersion: 3, protocolChatId: 'protocol-exact', providerUserId: 'provider-exact', webRouteId: 'web-exact' },
    commandId: 'command-reply', attemptId: 'attempt-reply', attemptCorrelationId: 'correlation-reply', clientMessageId: 'client-reply',
    idempotencyKey: 'idempotency-reply', ownerInstanceId: 'owner-1', fencingToken: 42n,
    payload: { kind: 'text', text: 'reply body', replyToProviderMessageId: 'd301abcdef01234567' },
    requestedAt: timestamp, deadlineAt: new Date(timestamp.valueOf() + 30_000),
  })

  assert.deepEqual(built.payload, {
    kind: 'text',
    text: 'reply body',
    replyToProviderMessageId: 'd301abcdef01234567',
  })
  assert.match(canonicalTextSenderBody(built), /replyToProviderMessageId/)
})

test('gateway and scraper produce the same canonical body digest and sender-namespace HMAC', () => {
  const built = request(); const key = Buffer.alloc(32, 9)
  const gateway = signTextSenderRequest(built, { keyId: 'synthetic-key', secret: key, timestamp, nonce: 'synthetic-nonce' })
  const scraper = signForSyntheticTest(built, { keyId: 'synthetic-key', secret: key, timestamp, nonce: 'synthetic-nonce' })
  assert.equal(canonicalTextSenderBody(built), canonical(built))
  assert.deepEqual(gateway, scraper)
  assert.equal(gateway.namespace, TEXT_SENDER_AUTH_NAMESPACE)
})

test('gateway physical feature flag is independently default-off and rejects wildcard', () => {
  assert.deepEqual(textSenderFeatureFlags('account-a', {}), { contract: false, physical: false })
  assert.deepEqual(textSenderFeatureFlags('account-a', {
    MAX_PERSONAL_TEXT_SENDER_CONTRACT_ACCOUNTS: 'account-a',
    MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ACCOUNTS: '*',
  }), { contract: true, physical: false })
})

test('request builder rejects zero fence, non-text payload, and phone-style routing fallback', () => {
  const base = {
    accountId: 'account-a', conversationKey: 'conversation-a', route: { routeVersion: 1, protocolChatId: 'exact', providerUserId: null, webRouteId: null },
    commandId: 'command', attemptId: 'attempt', attemptCorrelationId: 'correlation', clientMessageId: null, idempotencyKey: 'idempotency', ownerInstanceId: 'owner',
    payload: { kind: 'text' as const, text: 'text' }, requestedAt: timestamp, deadlineAt: new Date(timestamp.valueOf() + 1000),
  }
  assert.throws(() => buildTextSenderRequest({ ...base, fencingToken: 0n }))
  assert.throws(() => buildTextSenderRequest({ ...base, fencingToken: 1n, payload: { kind: 'media' as never, text: 'x' } }))
  assert.throws(() => buildTextSenderRequest({ ...base, fencingToken: 1n, payload: { kind: 'text' as const, text: 'reply', replyToProviderMessageId: 'not-provider-id' } }))
  assert.throws(() => buildTextSenderRequest({ ...base, fencingToken: 1n, route: { ...base.route, protocolChatId: '+79990000000\n' } }))
})
