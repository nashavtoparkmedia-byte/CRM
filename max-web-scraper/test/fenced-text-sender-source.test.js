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

test('synthetic boundary has no browser, MAX, network, or real provider dependency and runtime is unwired', () => {
  assert.doesNotMatch(senderSource, /require\(['"][^'"]*(playwright|puppeteer|maxBrowser|TransportInterceptor|SerializedOutboundQueue|providerClient)/i)
  assert.doesNotMatch(senderSource, /fetch\s*\(|axios|https?\.request|sendText|sendMessage|page\./i)
  assert.doesNotMatch(runtime, /sender-v1|FencedTextSenderBoundary|\/v1\/personal-max\/send\/text/)
})

test('all physical gates default disabled with one-account, one-conversation and small-message limits', () => {
  assert.match(senderSource, /physicalSenderEnabled === true/)
  assert.match(senderSource, /globalPhysicalSenderDisabled !== false/)
  assert.match(senderSource, /globalEmergencyStop !== false/)
  assert.match(senderSource, /maximumAccounts \?\? 1/)
  assert.match(senderSource, /maximumConversations \?\? 1/)
  assert.match(senderSource, /dailyMessageLimit \?\? 3/)
  assert.match(senderSource, /physicalProviderCalls = 0/)
})
