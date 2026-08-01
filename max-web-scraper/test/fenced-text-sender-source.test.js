'use strict'

const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repositoryRoot = path.resolve(__dirname, '../..')
const senderRoot = path.join(repositoryRoot, 'max-web-scraper/sender-v1')
const senderSource = readdirSync(senderRoot).map(name => readFileSync(path.join(senderRoot, name), 'utf8')).join('\n')
const gatewayTypes = readFileSync(path.join(repositoryRoot, 'max-personal-gateway/src/sender/types.ts'), 'utf8')
const gatewayRequest = readFileSync(path.join(repositoryRoot, 'max-personal-gateway/src/sender/GatewayTextSenderRequest.ts'), 'utf8')
const runtime = readFileSync(path.join(repositoryRoot, 'max-web-scraper/index.js'), 'utf8')
const physicalBoundary = readFileSync(path.join(senderRoot, 'PhysicalTextSenderBoundary.js'), 'utf8')
const physicalRuntime = readFileSync(path.join(senderRoot, 'runtime.js'), 'utf8')
const durableStore = readFileSync(path.join(senderRoot, 'DurableSenderStore.js'), 'utf8')
const syntheticSource = ['FencedTextSenderBoundary.js', 'SyntheticTextSenderAdapter.js']
  .map(name => readFileSync(path.join(senderRoot, name), 'utf8')).join('\n')
const schema = JSON.parse(readFileSync(path.join(repositoryRoot, 'contracts/personal-max-text-sender-v1.schema.json'), 'utf8'))

test('contract endpoint, version, exact route, fence, correlation and deadline are explicit', () => {
  assert.match(gatewayTypes, /\/v1\/personal-max\/send\/text/)
  for (const field of ['schemaVersion', 'accountId', 'conversationKey', 'protocolChatId', 'commandId', 'attemptId', 'attemptCorrelationId', 'clientMessageId', 'idempotencyKey', 'ownerInstanceId', 'fencingToken', 'requestedAt', 'deadlineAt']) {
    assert.match(gatewayTypes, new RegExp(`\\b${field}\\b`)); assert.ok(schema.required.includes(field) || field === 'protocolChatId')
  }
  assert.doesNotMatch(gatewayTypes + JSON.stringify(schema), /displayName|phoneNumber|phoneFallback/)
})

test('sender auth has a separate namespace, body digest, timestamp, nonce, HMAC and replay store', () => {
  assert.match(senderSource + gatewayRequest, /personal-max-sender-v1/)
  assert.doesNotMatch(senderSource + gatewayRequest, /capture-v1|capture key/i)
  for (const marker of ['bodySha256', 'timestamp', 'nonce', 'createHmac', 'timingSafeEqual', 'AUTH_REPLAY']) assert.match(senderSource + gatewayRequest, new RegExp(marker))
})

test('outcome enum is exact and never asserts recipient delivery', () => {
  for (const outcome of ['REFUSED_BEFORE_SEND', 'ACCEPTED_BY_SENDER_BOUNDARY', 'PROVIDER_CONFIRMED', 'UNKNOWN_AFTER_ATTEMPT', 'FAILED_BEFORE_PROVIDER', 'UNSUPPORTED']) {
    assert.match(gatewayTypes, new RegExp(`'${outcome}'`))
  }
  assert.doesNotMatch(gatewayTypes + senderSource, /['"]DELIVERED['"]/)
})

test('synthetic boundary remains provider-free while physical runtime uses one exact private UI provider action', () => {
  assert.doesNotMatch(syntheticSource, /require\(['"][^'"]*(playwright|puppeteer|maxBrowser|TransportInterceptor|SerializedOutboundQueue|providerClient)/i)
  assert.doesNotMatch(syntheticSource, /fetch\s*\(|axios|https?\.request|sendText|sendMessage|page\./i)
  assert.match(runtime, /createPhysicalTextSenderRuntime/)
  assert.match(runtime, /app\.post\('\/v1\/personal-max\/send\/text'/)
  assert.match(runtime, /sendProviderConfirmedUiText/)
  assert.match(runtime, /sendTextViaUi\(webRouteId, text, protocolChatId\)/)
  assert.match(runtime, /new MaxWebReplyBridge\(page\)\.sendReply\(/)
  assert.doesNotMatch(runtime, /transport\.sendBinaryReply\(protocolChatId, text, replyToProviderMessageId, cid\)/)
  assert.match(runtime, /resolveOutboundProviderMessageId\(\{/)
  assert.match(runtime, /isRealProviderMessageId: isRealMaxMessageId/)
  assert.match(runtime, /reason === 'manual_debug'/)
  assert.match(runtime, /providerMessageId = exact\.providerMessageId/)
  assert.match(runtime, /provider_lookup_failed/)
  assert.match(runtime, /textMatchCount: Number\(exact\.textMatchCount\)/)
  assert.match(runtime, /routeMatchCount: Number\(exact\.routeMatchCount\)/)
  assert.match(runtime, /waitForUiSendAck\(transport, 12_000/)
  assert.doesNotMatch(physicalBoundary + physicalRuntime, /playwright|puppeteer|page\.|locator\(|click\(|goto\(|page\.evaluate\(/i)
  assert.match(physicalRuntime, /max-personal-gateway/)
  assert.match(physicalRuntime, /\/var\/lib\//)
  assert.doesNotMatch(physicalRuntime, /https:|0\.0\.0\.0|host\.docker\.internal/)
})

test('all physical gates default disabled with one-account, one-conversation and small-message limits', () => {
  assert.match(senderSource, /physicalSenderEnabled === true/)
  assert.match(senderSource, /globalPhysicalSenderDisabled !== false/)
  assert.match(senderSource, /globalEmergencyStop !== false/)
  assert.match(senderSource, /maximumAccounts \?\? 1/)
  assert.match(senderSource, /maximumConversations \?\? 1/)
  assert.match(senderSource, /dailyMessageLimit \?\? 3/)
  assert.match(senderSource, /physicalProviderCalls = 0/)
  for (const marker of ['fsyncSync', 'physical_action_started', 'pending_recoverable', 'unknownOutcomes', 'staleFences']) {
    assert.match(durableStore, new RegExp(marker))
  }
})

test('operational legacy text kill switch refuses before any fallback or provider action', () => {
  const endpoint = runtime.slice(runtime.indexOf("app.post('/send-message'"), runtime.indexOf("app.post('/send-message'") + 6_000)
  const guard = endpoint.indexOf("MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED === 'true'")
  assert.ok(guard >= 0)
  assert.match(endpoint, /DURABLE_TEXT_ROUTE_REQUIRED/)
  assert.ok(guard < endpoint.indexOf('rememberCrmOutboundText'))
  assert.ok(guard < endpoint.indexOf('resolvePhoneLive'))
})
