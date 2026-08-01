'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { sendProviderConfirmedUiText } = require('../sender-v1/ProviderConfirmedUiTextSender')

const exactId = value => /^d301/i.test(String(value || ''))
const emptySnapshot = async () => []

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
    snapshotProviderMessageIds: async input => { calls.push(['snapshot', input]); return [] },
    startProviderAck: input => { calls.push(['ack', input]); return Promise.resolve(null) },
    sendViaUi: async input => { calls.push(['send', input]); return true },
    resolveProviderMessageId: async input => { calls.push(['store', input]); return 'd30100000000000000aa' },
    isRealProviderMessageId: exactId,
  })

  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd30100000000000000aa')
  assert.deepEqual(calls.map(item => item[0]), ['snapshot', 'ack', 'send', 'store'])
  assert.deepEqual(calls[2][1], {
    protocolChatId: '902454841098', webRouteId: '511708938', text: 'one physical canary',
  })
  assert.equal(calls[3][1].sentAt, 1234)
})

test('accepts an exact own echo when the provider store has not materialized yet', async () => {
  let sends = 0
  const result = await sendProviderConfirmedUiText({
    request: request(),
    snapshotProviderMessageIds: emptySnapshot,
    startProviderAck: () => Promise.resolve('d30100000000000000bb'),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => null,
    isRealProviderMessageId: exactId,
  })
  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd30100000000000000bb')
  assert.equal(sends, 1)
})

test('rechecks the provider store after a bounded empty own-echo wait without another UI action', async () => {
  let sends = 0
  let storeReads = 0
  const result = await sendProviderConfirmedUiText({
    request: request(),
    snapshotProviderMessageIds: emptySnapshot,
    startProviderAck: () => Promise.resolve(null),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => {
      storeReads += 1
      return storeReads === 2 ? 'd30100000000000000cc' : null
    },
    isRealProviderMessageId: exactId,
  })
  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd30100000000000000cc')
  assert.equal(storeReads, 2)
  assert.equal(sends, 1)
})

test('an ambiguous post-action result is UNKNOWN and never retries the UI action', async () => {
  let sends = 0
  const result = await sendProviderConfirmedUiText({
    request: request(),
    snapshotProviderMessageIds: emptySnapshot,
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
    snapshotProviderMessageIds: emptySnapshot,
    startProviderAck: () => Promise.resolve(null),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => null,
    isRealProviderMessageId: exactId,
  })
  assert.equal(result.outcome, 'REFUSED_BEFORE_SEND')
  assert.equal(result.safeCode, 'EXACT_WEB_ROUTE_MISSING')
  assert.equal(sends, 0)
})

test('repeated identical text excludes every provider id present before the physical action', async () => {
  const oldId = 'd30100000000000000d1'
  const newId = 'd30100000000000000d2'
  const resolutions = []
  const result = await sendProviderConfirmedUiText({
    request: request({ payload: { text: 'Одинаковое сообщение' } }),
    snapshotProviderMessageIds: async () => [oldId],
    startProviderAck: () => Promise.resolve(oldId),
    sendViaUi: async () => true,
    resolveProviderMessageId: async input => {
      resolutions.push(input)
      return newId
    },
    isRealProviderMessageId: exactId,
  })

  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, newId)
  assert.deepEqual(resolutions[0].excludedProviderMessageIds, [oldId])
})

test('reply uses one reply provider action and confirms exact provider id', async () => {
  const calls = []
  const result = await sendProviderConfirmedUiText({
    request: request({
      attemptId: 'attempt-reply',
      clientMessageId: 'client-reply',
      payload: { text: 'reply body', replyToProviderMessageId: 'd301abcdef01234567' },
    }),
    snapshotProviderMessageIds: async input => { calls.push(['snapshot', input]); return [] },
    startProviderAck: input => { calls.push(['ack', input]); return Promise.resolve(null) },
    sendViaUi: async input => { calls.push(['plain-send', input]); return true },
    sendReplyViaUi: async input => {
      calls.push(['reply-send', input])
      return { providerMessageId: 'd301abcdef01234568' }
    },
    resolveProviderMessageId: async input => { calls.push(['store', input]); return null },
    isRealProviderMessageId: exactId,
  })

  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd301abcdef01234568')
  assert.deepEqual(calls.map(call => call[0]), ['snapshot', 'ack', 'reply-send'])
  assert.equal(calls[1][1].replyToProviderMessageId, 'd301abcdef01234567')
  assert.deepEqual(calls[2][1], {
    protocolChatId: '902454841098',
    webRouteId: '511708938',
    text: 'reply body',
    replyToProviderMessageId: 'd301abcdef01234567',
    clientMessageId: 'client-reply',
    attemptId: 'attempt-reply',
  })
})

test('reply bridge ok without direct id is accepted and resolved by exact provider store', async () => {
  const calls = []
  const result = await sendProviderConfirmedUiText({
    request: request({
      attemptId: 'attempt-reply-store',
      clientMessageId: 'client-reply-store',
      payload: { text: 'reply body', replyToProviderMessageId: 'd301abcdef01234567' },
    }),
    snapshotProviderMessageIds: async input => { calls.push(['snapshot', input]); return [] },
    startProviderAck: input => { calls.push(['ack', input]); return Promise.resolve(null) },
    sendViaUi: async input => { calls.push(['plain-send', input]); return true },
    sendReplyViaUi: async input => {
      calls.push(['reply-send', input])
      return { ok: true, providerMessageId: null }
    },
    resolveProviderMessageId: async input => { calls.push(['store', input]); return 'd301abcdef01234569' },
    isRealProviderMessageId: exactId,
  })

  assert.equal(result.outcome, 'PROVIDER_CONFIRMED')
  assert.equal(result.providerMessageId, 'd301abcdef01234569')
  assert.deepEqual(calls.map(call => call[0]), ['snapshot', 'ack', 'reply-send', 'store'])
  assert.equal(calls[3][1].replyToProviderMessageId, 'd301abcdef01234567')
})

test('reply refuses before physical action when reply bridge is unavailable', async () => {
  let plainSends = 0
  const result = await sendProviderConfirmedUiText({
    request: request({ payload: { text: 'reply body', replyToProviderMessageId: 'd301abcdef01234567' } }),
    snapshotProviderMessageIds: emptySnapshot,
    startProviderAck: () => Promise.resolve(null),
    sendViaUi: async () => { plainSends += 1; return true },
    resolveProviderMessageId: async () => null,
    isRealProviderMessageId: exactId,
  })

  assert.equal(result.outcome, 'REFUSED_BEFORE_SEND')
  assert.equal(result.safeCode, 'REPLY_TARGET_UNSENDABLE')
  assert.equal(result.physicalProviderCalled, false)
  assert.equal(plainSends, 0)
})

test('snapshot failure refuses before send and never creates an unknown physical outcome', async () => {
  let sends = 0
  const result = await sendProviderConfirmedUiText({
    request: request(),
    snapshotProviderMessageIds: async () => { throw new Error('store unavailable') },
    startProviderAck: () => Promise.resolve(null),
    sendViaUi: async () => { sends += 1; return true },
    resolveProviderMessageId: async () => null,
    isRealProviderMessageId: exactId,
  })
  assert.deepEqual(result, {
    outcome: 'REFUSED_BEFORE_SEND',
    safeCode: 'PROVIDER_STORE_SNAPSHOT_FAILED',
    physicalProviderCalled: false,
  })
  assert.equal(sends, 0)
})
