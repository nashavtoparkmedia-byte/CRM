'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { sendProviderConfirmedUiText } = require('../sender-v1/ProviderConfirmedUiTextSender')

const exactId = value => /^d301/i.test(String(value || ''))

function request(overrides = {}) {
  return {
    route: { protocolChatId: '902454841098', webRouteId: '511708938' },
    payload: { text: 'one physical canary' },
    ...overrides,
  }
}

test('registers echo before one UI action and confirms only the exact provider-store id', async () => {
  const calls = []
  const result = await sendProviderConfirmedUiText({
    request: request(),
    clock: () => 1234,
    startProviderAck: input => { calls.push(['ack', input]); return Promise.resolve(null) },
    sendViaUi: async input => { calls.push(['send', input]); return true },
    resolveProviderMessageId: async input => { calls.push(['store', input]); return 'd30100000000000000aa' },
    isRealProviderMessageId: exactId,
  })

  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd30100000000000000aa')
  assert.deepEqual(calls.map(item => item[0]), ['ack', 'send', 'store'])
  assert.deepEqual(calls[1][1], {
    protocolChatId: '902454841098', webRouteId: '511708938', text: 'one physical canary',
  })
  assert.equal(calls[2][1].sentAt, 1234)
})

test('accepts an exact own echo when the provider store has not materialized yet', async () => {
  let sends = 0
  const result = await sendProviderConfirmedUiText({
    request: request(),
    startProviderAck: () => Promise.resolve('d30100000000000000bb'),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => null,
    isRealProviderMessageId: exactId,
  })
  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd30100000000000000bb')
  assert.equal(sends, 1)
})

test('an ambiguous post-action result is UNKNOWN and never retries the UI action', async () => {
  let sends = 0
  const result = await sendProviderConfirmedUiText({
    request: request(),
    startProviderAck: () => Promise.resolve(null),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => 'max-dom-placeholder',
    isRealProviderMessageId: exactId,
  })
  assert.equal(result.outcome, 'UNKNOWN_AFTER_ATTEMPT')
  assert.equal(result.safeCode, 'EXACT_PROVIDER_ID_MISSING')
  assert.equal(sends, 1)
})

test('missing exact web route fails closed without a physical action', async () => {
  let sends = 0
  const result = await sendProviderConfirmedUiText({
    request: request({ route: { protocolChatId: '902454841098', webRouteId: null } }),
    startProviderAck: () => Promise.resolve(null),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => null,
    isRealProviderMessageId: exactId,
  })
  assert.equal(result.outcome, 'UNKNOWN_AFTER_ATTEMPT')
  assert.equal(result.safeCode, 'EXACT_WEB_ROUTE_MISSING')
  assert.equal(sends, 0)
})
