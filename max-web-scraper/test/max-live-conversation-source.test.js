'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const source = fs.readFileSync('index.js', 'utf8')

function blockBetween(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  const end = source.indexOf(endNeedle, start)
  assert.ok(start >= 0, `missing source marker: ${startNeedle}`)
  assert.ok(end > start, `missing source end marker: ${endNeedle}`)
  return source.slice(start, end)
}

test('history snapshot endpoint is loopback-only, read-only and exact-route fenced', () => {
  const block = blockBetween(
    "app.post('/v1/personal-max/history/snapshot'",
    "// Отправить текст",
  )
  assert.match(block, /isLoopbackRequest\(req\)/)
  assert.match(block, /account_mismatch/)
  assert.match(block, /route_or_participant_mismatch/)
  assert.match(block, /hydrateReadOnlyProviderHistory/)
  assert.match(block, /maxScrollAttempts:\s*48/)
  assert.match(block, /completeThroughWindowStart/)
  assert.match(block, /buildProviderHistorySnapshot/)
  assert.doesNotMatch(block, /forwardToWebhook/)
  assert.doesNotMatch(block, /sendProviderConfirmedUiText/)
  assert.doesNotMatch(block, /page\.type|keyboard\.press|click\(/)
})

test('read-only history hydration is bounded and cannot perform provider actions', () => {
  const block = blockBetween(
    'async function hydrateReadOnlyProviderHistory',
    '// Root-operated, read-only provider-store snapshot',
  )
  assert.match(block, /Math\.min\(Number\(maxScrollAttempts\) \|\| 1, 48\)/)
  assert.match(block, /target\.scrollTop = Math\.max\(0, before - distance\)/)
  assert.match(block, /readCandidates/)
  assert.match(block, /stalledAttempts >= 4/)
  assert.doesNotMatch(block, /forwardToWebhook/)
  assert.doesNotMatch(block, /sendProviderConfirmedUiText/)
  assert.doesNotMatch(block, /page\.type|keyboard\.press|click\(/)
})

test('direct-native DOM projection requires a real provider identity', () => {
  const block = blockBetween('async function forwardDomCandidate', 'async function forwardLatestDomMessage')
  assert.match(block, /outgoing_provider_identity_required/)
  assert.match(block, /readProviderMessage/)
  assert.match(block, /routeMatchCount === 1/)
  assert.match(block, /source: isOutgoingCandidate \? 'max_native'/)
  assert.doesNotMatch(block, /stableDomMirrorMessageId\(/)
})

test('live binary text recovery fails closed when provider-store evidence is absent', () => {
  const block = blockBetween('async function handleIncoming', 'async function sendText(')
  assert.match(block, /msg\.textQuarantineReason/)
  assert.match(block, /readProviderMessage/)
  assert.match(block, /provider route identity mismatch/)
  assert.match(block, /quarantined/)
  assert.match(block, /return/)
})

test('forwarding metadata never mutates exact provider text', () => {
  const block = blockBetween(
    '// Переслано: provider metadata остаются структурированными',
    '// Скачиваем вложения',
  )
  assert.match(block, /forwardedFrom:/)
  assert.doesNotMatch(block, /const prefix/)
  assert.doesNotMatch(block, /text:\s*payload\.text\s*\?/)
})
