'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  isRealMaxMessageId,
  resolveOutboundProviderMessageId,
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
    route: { uiChatId: '24393518' },
  })
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
  assert.match(service, /\.filter\(shouldMarkStuckOutboundFailed\)/)
  assert.match(service, /maxDeliveryMetadata = \{/)
  assert.match(service, /status: maxDeliveryConfirmed \? 'delivered'/)
})
