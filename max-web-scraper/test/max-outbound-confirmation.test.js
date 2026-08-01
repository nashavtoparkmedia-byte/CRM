'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  isRealMaxMessageId,
  resolveOutboundProviderMessageId,
  snapshotOutboundProviderMessageIds,
} = require('../lib/MaxOutboundConfirmation')

test('resolves an exact outbound provider id from the MAX Web store', async () => {
  const calls = []
  const bridge = {
    async resolveProviderId(chatId, context, route) {
      calls.push({ chatId, context, route })
      return calls.length === 1
        ? { providerMessageId: null }
        : { providerMessageId: 'd30100000000000000ff' }
    },
  }

  const providerId = await resolveOutboundProviderMessageId({
    bridge,
    protocolChatId: '901967525678',
    uiRouteId: '24393518',
    text: 'outbound fixture',
    sentAt: 1_721_000_000_000,
    attempts: 3,
    delayMs: 0,
    waitFn: async () => {},
  })

  assert.equal(providerId, 'd30100000000000000ff')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    chatId: '901967525678',
    context: {
      text: 'outbound fixture',
      sentAt: 1_721_000_000_000,
      direction: 'outbound',
    },
    route: {
      uiChatId: '24393518',
      excludedProviderMessageIds: [],
      historyWindowStart: 1_720_999_820_000,
      historyMaxPages: 6,
    },
  })
})

test('takes a normalized provider-store baseline before repeated-text resolution', async () => {
  const bridge = {
    async snapshotProviderMessageIds(chatId, options) {
      assert.equal(chatId, '902454841098')
      assert.deepEqual(options, { uiChatId: '511708938' })
      return ['D30100000000000000AA', 'not-provider', 'd30100000000000000aa']
    },
  }
  const snapshot = await snapshotOutboundProviderMessageIds({
    bridge,
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
  })
  assert.deepEqual(snapshot, ['d30100000000000000aa'])
})

test('passes reply target into exact provider-store resolution', async () => {
  let observed = null
  const bridge = {
    async resolveProviderId(chatId, context, route) {
      observed = { chatId, context, route }
      return { providerMessageId: 'd30100000000000000ef' }
    },
  }

  const providerId = await resolveOutboundProviderMessageId({
    bridge,
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
    text: 'reply body',
    sentAt: 1_785_567_153_000,
    replyToProviderMessageId: 'd301abcdef01234567',
    excludedProviderMessageIds: ['d30100000000000000aa'],
    delayMs: 0,
    waitFn: async () => {},
  })

  assert.equal(providerId, 'd30100000000000000ef')
  assert.deepEqual(observed, {
    chatId: '902454841098',
    context: {
      text: 'reply body',
      sentAt: 1_785_567_153_000,
      direction: 'outbound',
      replyToProviderMessageId: 'd301abcdef01234567',
    },
    route: {
      uiChatId: '511708938',
      excludedProviderMessageIds: ['d30100000000000000aa'],
      historyWindowStart: 1_785_566_973_000,
      historyMaxPages: 6,
    },
  })
})

test('uses a bounded history window and page count when resolving after a stalled ack', async () => {
  const routes = []
  const bridge = {
    async resolveProviderId(_chatId, _context, route) {
      routes.push(route)
      return { providerMessageId: null }
    },
  }

  const providerId = await resolveOutboundProviderMessageId({
    bridge,
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
    text: 'late echo',
    sentAt: 1_785_600_000_000,
    attempts: 1,
    delayMs: 0,
    waitFn: async () => {},
  })

  assert.equal(providerId, null)
  assert.deepEqual(routes, [{
    uiChatId: '511708938',
    excludedProviderMessageIds: [],
    historyWindowStart: 1_785_599_820_000,
    historyMaxPages: 6,
  }])
})

test('does not promote an ambiguous or malformed store result', async () => {
  const bridge = {
    async resolveProviderId() {
      return { providerMessageId: 'max-dom-placeholder', reason: 'ambiguous' }
    },
  }

  const providerId = await resolveOutboundProviderMessageId({
    bridge,
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
    text: 'same text',
    sentAt: Date.now(),
    attempts: 2,
    delayMs: 0,
    waitFn: async () => {},
  })

  assert.equal(providerId, null)
  assert.equal(isRealMaxMessageId('max-dom-placeholder'), false)
})

test('integrates exact store confirmation and protects pending CRM delivery state', () => {
  const scraper = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8')
  const service = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'gravity-mvp', 'src', 'lib', 'MessageService.ts'),
    'utf8',
  )

  assert.match(scraper, /const storeId = await resolveOutboundProviderMessageId\(\{/)
  assert.match(scraper, /const ackId = storeId \|\| await ackPromise/)
  assert.match(scraper, /captureProviderStoreOutgoingEchoForConfirmation\(/)
  assert.match(scraper, /trackPendingOutboundProviderStoreConfirmation\(\{/)
  assert.match(scraper, /attemptCorrelationId: request\?\.attemptCorrelationId/)
  assert.doesNotMatch(scraper, /if \(providerMessage\.isOutgoing\) return \{ skipped: 'provider_store_outgoing_echo' \}/)
  assert.match(service, /\.filter\(shouldMarkStuckOutboundFailed\)/)
  assert.match(service, /maxDeliveryMetadata = \{/)
  assert.match(service, /status: durableStatus/)
})
