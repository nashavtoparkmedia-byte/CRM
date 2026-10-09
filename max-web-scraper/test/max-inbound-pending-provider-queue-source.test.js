'use strict'

// One pending provider id belongs to ONE DOM candidate.
//
// A production burst of six inbound messages persisted none of them: the first
// provider-backed candidate was refused by the CRM, its pending id was therefore never
// confirmed, and every later candidate in the batch peeked that same unconsumed head,
// derived the same externalId and was suppressed as `seen`. The head was already in the
// seen set and a skip never confirms, so the chat wedged permanently.
//
// index.js is a monolithic entrypoint with no exports, so these are source-contract
// assertions in the same style as the other *-source tests in this directory.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  assert.notEqual(firstIndex, -1, `${message}: missing ${first}`)
  assert.notEqual(secondIndex, -1, `${message}: missing ${second}`)
  assert.ok(firstIndex < secondIndex, message)
}

test('nothing is committed to the seen set before the CRM accepts it', () => {
  const source = read('max-web-scraper/index.js')
  // The guard stays, but the commit must not sit immediately behind it any more.
  assert.match(source, /if \(domFallbackSeen\.has\(externalId\)\) return \{ skipped: 'seen'/u)
  assert.equal(
    /return \{ skipped: 'seen', text: latest\.text \}\s*\n\s*domFallbackSeen\.add\(externalId\)/u.test(source),
    false,
    'a refused message must stay retryable, so the seen set is not written before the webhook',
  )
  // Exactly one commit site, and it is conditional on acceptance.
  const commits = source.match(/domFallbackSeen\.add\(externalId\)/gu) || []
  assert.equal(commits.length, 1, 'exactly one place may commit an externalId as seen')
  assert.match(source, /if \(webhookAccepted\) domFallbackSeen\.add\(externalId\)/u)
  assertBefore(
    source,
    'const result = await forwardToWebhook(',
    'if (webhookAccepted) domFallbackSeen.add(externalId)',
    'the commit must happen after the webhook call, not before it',
  )
})

test('the pending provider head advances only on a stored 2xx', () => {
  const source = read('max-web-scraper/index.js')
  assert.match(source, /const webhookAccepted = result\.status >= 200 && result\.status < 300\n/u)
  assert.match(source, /const webhookStored = webhookAccepted && !result\.skipped/u)
  assert.match(
    source,
    /if \(pendingProviderId && webhookStored\) \{\s*\n\s*transport\?\.confirmPendingLiveTextIdForDomRecovery\?\.\(chatId, pendingProviderId\)/u,
    'the head is consumed only when the CRM actually stored the message',
  )
  const confirms = source.match(/confirmPendingLiveTextIdForDomRecovery\?\.\(/gu) || []
  assert.equal(confirms.length, 1, 'exactly one place may advance the pending provider queue')
})

test('a provider-backed candidate the CRM did not accept keeps its head and stops the batch', () => {
  const source = read('max-web-scraper/index.js')
  assert.match(
    source,
    /if \(pendingProviderId && !webhookAccepted\) \{/u,
    'a provider-backed non-2xx needs its own terminal branch',
  )
  assert.match(source, /providerBackedRetry: true/u)
  // It must return before anything could mark it seen or advance the queue.
  const branch = source.slice(source.indexOf('if (pendingProviderId && !webhookAccepted) {'))
  const terminator = branch.indexOf('\n  }\n')
  const body = branch.slice(0, terminator === -1 ? 400 : terminator)
  assert.equal(body.includes('domFallbackSeen.add'), false, 'a refused candidate is never marked seen')
  assert.equal(body.includes('confirmPendingLiveTextIdForDomRecovery'), false, 'a refused candidate never advances the queue')
  // And the batch must stop, so candidate 2 cannot reuse candidate 1's head.
  assert.match(source, /if \(result\?\.providerBackedRetry\) break/u)
  assertBefore(
    source,
    'else if (result?.skipped) skipped[result.skipped] = (skipped[result.skipped] || 0) + 1',
    'if (result?.providerBackedRetry) break',
    'the stop must be inside the candidate loop, after the counters',
  )
})

test('both DOM-derived inbound sources reach the same bounded peer proof', () => {
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
  assert.match(
    route,
    /if \(event\.source !== 'dom_fallback' && event\.source !== 'live_dom_recovery'\) return null/u,
    'the scraper picks live_dom_recovery whenever it has a provider id; both are one trust class',
  )
  // The scraper's own choice between the two, which is what made this necessary.
  const scraper = read('max-web-scraper/index.js')
  assert.match(scraper, /resolvedProviderId \? 'live_dom_recovery' : 'dom_fallback'/u)
})

test('widening the source did not weaken the durable proof', () => {
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
  // Durable state still decides; a transient provider signal cannot widen it.
  assert.match(route, /if \(chat\.channel !== 'max'\) return unproven\('channel'\)/u)
  assert.match(route, /if \(chat\.chatType !== 'private'\) return unproven\('chat_type'\)/u)
  assert.match(route, /if \(metadata\.chatKind !== 'private'\) return unproven\('stored_chat_kind'\)/u)
  // An explicit group is still refused outright.
  assert.match(route, /unproven\('incoming_chat_kind'\)/u)
  // The placeholder-id recovery gate is a different concern and stays narrow.
  assert.match(route, /source === 'dom_fallback' &&/u)
})
