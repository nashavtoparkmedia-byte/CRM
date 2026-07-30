'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { MessageSync } = require('../sync/MessageSync')
const {
  TransportInterceptor,
  selectPendingLiveDomCandidates,
} = require('../transport/TransportInterceptor')

function isolatedSync() {
  const sync = new MessageSync()
  sync.seen.clear()
  sync._save = () => {}
  return sync
}

test('dedups MAX text replay only by provider message id', () => {
  const sync = isolatedSync()
  const first = {
    id: 'd301aaaaaaaaaaaaaaaa',
    chatId: '902454841098',
    type: 'text',
    text: 'same text',
    timestamp: '2026-07-06T08:00:00.000Z',
  }
  const replay = { ...first }

  assert.equal(sync.isDuplicate(first), false)
  sync.markSeen(first)
  assert.equal(sync.isDuplicate(replay), true)
})

test('keeps three identical inbound texts when provider ids differ', () => {
  const sync = isolatedSync()
  const messages = [1, 2, 3].map(n => ({
    id: `d301bbbbbbbbbbbbbbb${n}`,
    chatId: '902454841098',
    type: 'text',
    text: 'repeat',
    timestamp: '2026-07-06T08:00:00.000Z',
  }))

  for (const message of messages) {
    assert.equal(sync.isDuplicate(message), false)
    sync.markSeen(message)
  }
})

test('does not dedup text without provider identity by text or time', () => {
  const sync = isolatedSync()
  const first = {
    chatId: '902454841098',
    type: 'text',
    text: 'repeat without id',
    timestamp: '2026-07-06T08:00:00.000Z',
  }
  const second = { ...first }

  assert.equal(sync.isDuplicate(first), false)
  sync.markSeen(first)
  assert.equal(sync.isDuplicate(second), false)
})

test('keeps non-text fallback dedup for missing provider id', () => {
  const sync = isolatedSync()
  const first = {
    chatId: '902454841098',
    type: 'image',
    text: '[Фото]',
    timestamp: '2026-07-06T08:00:00.000Z',
    attachments: [{ type: 'image', url: 'memory://one' }],
  }
  const replay = { ...first }

  assert.equal(sync.isDuplicate(first), false)
  sync.markSeen(first)
  assert.equal(sync.isDuplicate(replay), true)
})

test('opcode 49 browser history is quarantined from live inbound handlers', () => {
  const source = fs.readFileSync(require.resolve('../transport/TransportInterceptor'), 'utf8')
  const start = source.indexOf('if (data.opcode === OP.GET_HISTORY')
  const end = source.indexOf('\n    for (const h of this._rawHandlers)', start)
  const block = source.slice(start, end)
  assert.match(block, /history quarantined/)
  assert.doesNotMatch(block, /this\._emit\(/)
  assert.doesNotMatch(block, /this\._lastSeenMsgId\.set/)
})
test('bare op128 live inbound keeps previous anchor until op71 confirms the new provider id', () => {
  const transport = new TransportInterceptor()
  transport._lastMsgRawHex.clear()
  transport._lastSeenMsgId.clear()
  transport._pendingLiveMessageIds.clear()
  transport._persistLastMsgRawHex = () => {}

  const chatId = '902454841098'
  const previousId = 'd3010000000000000001'
  const pendingNewId = 'd3010000000000000002'

  transport._lastMsgRawHex.set(chatId, previousId)

  const registration = transport._registerPendingLiveMessageId(chatId, pendingNewId)

  assert.equal(registration.registered, true)
  assert.equal(registration.pendingHex, pendingNewId)
  assert.equal(registration.anchorHex, previousId)
  assert.equal(transport._lastMsgRawHex.get(chatId), previousId)
  assert.equal(transport._lastSeenMsgId.has(chatId), false)
  assert.equal(transport._op71AnchorForLiveNotification(chatId), previousId)

  assert.equal(transport._advanceLastMsgAfterOp71(chatId, pendingNewId), true)
  assert.equal(transport._lastMsgRawHex.get(chatId), pendingNewId)
  assert.deepEqual(transport._pendingLiveMessageIds.get(chatId) || [], [])
})

test('bare op128 live inbound without a previous anchor never uses pending new id as op71 anchor', () => {
  const transport = new TransportInterceptor()
  transport._lastMsgRawHex.clear()
  transport._pendingLiveMessageIds.clear()

  const registration = transport._registerPendingLiveMessageId('902454841098', 'd3010000000000000003')

  assert.equal(registration.registered, true)
  assert.equal(registration.anchorHex, null)
  assert.equal(transport._op71AnchorForLiveNotification('902454841098'), null)
})

test('multiple bare op128 ids before one mark are queued and registered in order', () => {
  const transport = new TransportInterceptor()
  transport._lastMsgRawHex.clear()
  transport._lastSeenMsgId.clear()
  transport._pendingLiveMessageIds.clear()
  transport._persistLastMsgRawHex = () => {}

  const chatId = '902454841098'
  const previousId = 'd3010000000000000001'
  const ids = [
    'd3010000000000000002',
    'd3010000000000000003',
    'd3010000000000000004',
  ]

  transport._lastMsgRawHex.set(chatId, previousId)

  const remembered = ids.map(id => transport._rememberPreChatPendingMessageId(id))
  assert.deepEqual(remembered.map(item => item.registered), [true, true, true])
  assert.deepEqual(transport._pendingNewMsgIds.map(item => item.pendingHex), ids)

  const registrations = transport._registerPreChatPendingForChat(chatId)

  assert.deepEqual(registrations.map(item => item.pendingHex), ids)
  assert.deepEqual((transport._pendingLiveMessageIds.get(chatId) || []).map(item => item.pendingHex), ids)
  assert.deepEqual(transport._pendingNewMsgIds, [])
  assert.equal(transport._lastMsgRawHex.get(chatId), previousId)
})

test('op128 live marks keep a bounded recent event count per chat for DOM recovery', () => {
  const transport = new TransportInterceptor()
  const chatId = '902454841098'
  const now = Date.now()

  assert.equal(transport._rememberRecentOp128Chat(chatId, now - 20_000), 1)
  assert.equal(transport.recentOp128CountForChat(chatId, 15_000), 0)

  assert.equal(transport._rememberRecentOp128Chat(chatId, now - 2_000), 1)
  assert.equal(transport._rememberRecentOp128Chat(chatId, now - 1_000), 2)
  assert.equal(transport._rememberRecentOp128Chat(chatId, now), 3)
  assert.equal(transport.recentOp128CountForChat(chatId, 15_000), 3)
  assert.match(transport.recentOp128SeriesKeyForChat(chatId, 15_000), /^op128-series:/)
  assert.equal(transport.recentOp128CountForChat('902000000000', 15_000), 0)
  assert.equal(transport.recentOp128SeriesKeyForChat('902000000000', 15_000), null)
})

test('pending live queue stays available for DOM recovery without injecting another op71', async () => {
  const transport = new TransportInterceptor()
  transport._lastMsgRawHex.clear()
  transport._lastSeenMsgId.clear()
  transport._pendingLiveMessageIds.clear()
  transport._catchUpChatIds.clear()
  transport._persistLastMsgRawHex = () => {}

  const chatId = '902454841098'
  const previousId = 'd3010000000000000001'
  const ids = [
    'd3010000000000000002',
    'd3010000000000000003',
    'd3010000000000000004',
  ]
  const op71Calls = []

  transport._lastMsgRawHex.set(chatId, previousId)
  transport._catchUpChatIds.set(chatId, 0)
  transport._wsConnected = true
  transport.sendBinaryOp71 = async (cid, anchorHex) => {
    op71Calls.push({ cid, anchorHex })
    return { ok: true }
  }

  ids.forEach(id => transport._registerPendingLiveMessageId(chatId, id))

  assert.equal(transport._advanceLastMsgAfterOp71(chatId, ids[0]), true)
  const state = transport._finalizeOp71CatchUpState(chatId, 0)
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(state.pendingLiveCount, 2)
  assert.equal(state.scheduledDrain, false)
  assert.equal(transport._catchUpChatIds.has(chatId), true)
  assert.deepEqual((transport._pendingLiveMessageIds.get(chatId) || []).map(item => item.pendingHex), ids.slice(1))
  assert.deepEqual(op71Calls, [])
})

test('three identical inbound text events with different provider ids are forwarded separately', () => {
  const sync = isolatedSync()
  const forwarded = []
  const messages = [1, 2, 3].map(n => ({
    id: `d301ccccccccccccccc${n}`,
    chatId: '902454841098',
    type: 'text',
    text: '?',
    timestamp: '2026-07-06T19:20:00.000Z',
  }))

  for (const msg of messages) {
    if (!sync.isDuplicate(msg)) {
      sync.markSeen(msg)
      forwarded.push({ externalId: msg.id, text: msg.text })
    }
  }

  assert.equal(forwarded.length, 3)
  assert.deepEqual(forwarded.map(item => item.externalId), messages.map(msg => msg.id))
})

test('confirmed provider id replaces a malformed persisted anchor', () => {
  const transport = new TransportInterceptor()
  transport._lastMsgRawHex.clear()
  transport._lastSeenMsgId.clear()
  transport._persistLastMsgRawHex = () => {}

  const chatId = '902454841098'
  const malformedAnchor = 'd31c00786efba474'
  const confirmedId = 'd3019f4aff6c135642'

  transport._lastMsgRawHex.set(chatId, malformedAnchor)

  assert.equal(transport._rememberConfirmedMessageAnchor(chatId, confirmedId), true)
  assert.equal(transport._lastMsgRawHex.get(chatId), confirmedId)
  assert.equal(transport._op71AnchorForLiveNotification(chatId), confirmedId)
})

test('malformed previous anchor cannot reject a pending live provider id', () => {
  const transport = new TransportInterceptor()
  transport._lastMsgRawHex.clear()
  transport._pendingLiveMessageIds.clear()

  const chatId = '902454841098'
  const pendingId = 'd3019f4aff70000001'
  transport._lastMsgRawHex.set(chatId, 'd31c00786efba474')

  const registration = transport._registerPendingLiveMessageId(chatId, pendingId)

  assert.equal(registration.registered, true)
  assert.equal(registration.anchorHex, null)
  assert.deepEqual(
    (transport._pendingLiveMessageIds.get(chatId) || []).map(item => item.pendingHex),
    [pendingId],
  )
})

test('binary op71 refuses a malformed stored provider anchor without touching the socket', async () => {
  const transport = new TransportInterceptor()
  let socketCalls = 0
  transport._page = {
    evaluate: async () => {
      socketCalls += 1
      return { ok: true }
    },
  }
  transport._lastMsgRawHex.clear()
  transport._lastMsgRawHex.set('902454841098', 'd31c00786efba474')

  await assert.rejects(
    transport.sendBinaryOp71('902454841098'),
    /Refusing op:71 with invalid provider anchor/,
  )
  assert.equal(socketCalls, 0)
})

test('live op128 and startup chat scan only retain validated provider anchors', () => {
  const source = fs.readFileSync(require.resolve('../transport/TransportInterceptor'), 'utf8')

  assert.match(source, /this\._rememberConfirmedMessageAnchor\(cidStr, hex, \{ markSeen: true \}\)/)
  assert.match(source, /key\?\.__maxId && isUsableMaxMessageHex\(key\.hex\)/)
  assert.match(source, /\[op49\] history quarantined/)
  const historyBlock = source.slice(source.indexOf('if (data.opcode === OP.GET_HISTORY'), source.indexOf('for (const h of this._rawHandlers)'))
  assert.doesNotMatch(historyBlock, /this\._emit\(/)
  assert.doesNotMatch(source, /!stored \|\| hex\.slice\(2\) > stored\.slice\(2\)/)
})

test('live inbound recovery uses guarded DOM batches without injecting active op71', () => {
  const transportSource = fs.readFileSync(require.resolve('../transport/TransportInterceptor'), 'utf8')
  const scraperSource = fs.readFileSync(require.resolve('../index'), 'utf8')

  const markStart = transportSource.indexOf('// op:128 cmd:1 (browser mark-as-received)')
  const markEnd = transportSource.indexOf('const maxHex', markStart)
  assert.notEqual(markStart, -1)
  assert.notEqual(markEnd, -1)
  const markBlock = transportSource.slice(markStart, markEnd)
  assert.doesNotMatch(markBlock, /sendBinaryOp71/)

  const op48Start = transportSource.indexOf('// Active op:71 injection is intentionally disabled')
  const op48End = transportSource.indexOf('// op:71 —', op48Start)
  assert.notEqual(op48Start, -1)
  assert.notEqual(op48End, -1)
  assert.doesNotMatch(transportSource.slice(op48Start, op48End), /sendBinaryOp71/)

  const readyStart = transportSource.indexOf('\n  _fireWsReady() {')
  const readyEnd = transportSource.indexOf('waitForWsReady(', readyStart)
  assert.notEqual(readyStart, -1)
  assert.notEqual(readyEnd, -1)
  assert.doesNotMatch(transportSource.slice(readyStart, readyEnd), /sendBinaryOp71/)

  const drainStart = transportSource.indexOf('\n  _schedulePendingLiveDrain(')
  const drainEnd = transportSource.indexOf('\n  _finalizeOp71CatchUpState(', drainStart)
  assert.notEqual(drainStart, -1)
  assert.notEqual(drainEnd, -1)
  assert.doesNotMatch(transportSource.slice(drainStart, drainEnd), /sendBinaryOp71/)

  const backfillStart = transportSource.indexOf('\n  _scheduleDirectBackfill(')
  const backfillEnd = transportSource.indexOf('_detectMaxType(', backfillStart)
  assert.notEqual(backfillStart, -1)
  assert.notEqual(backfillEnd, -1)
  assert.doesNotMatch(transportSource.slice(backfillStart, backfillEnd), /_sendDirectBackfillOp71|sendBinaryOp71/)

  const rawStart = scraperSource.indexOf('transport.onRawFrame(async data =>')
  const incomingStart = scraperSource.indexOf('if (data.opcode === OP.INCOMING_MSG) {', rawStart)
  const incomingEnd = scraperSource.indexOf('// Логируем остальные неизвестные push-опкоды', incomingStart)
  assert.notEqual(rawStart, -1)
  assert.notEqual(incomingStart, -1)
  assert.notEqual(incomingEnd, -1)
  const incomingBlock = scraperSource.slice(incomingStart, incomingEnd)
  assert.match(incomingBlock, /scheduleAutomaticDomMirrorRecovery\(String\(chatId\), 'empty_op71_after_op128'\)/)
  assert.doesNotMatch(incomingBlock, /const anchorHex|hasPendingLive/)
})

test('DOM recovery calculates ordering while real direct anchors are still present', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const liveRecoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const anchorFilter = source.indexOf('const beforeAnchorFilter', liveRecoveryStart)
  const timestampAssignment = source.indexOf('_recoveryTimestamp = new Date(', liveRecoveryStart)

  assert.notEqual(liveRecoveryStart, -1)
  assert.notEqual(anchorFilter, -1)
  assert.notEqual(timestampAssignment, -1)
  assert.match(source, /const hasDirectTimestampAnchor = hasDirectDomTimestampAnchor\(recoverable\)/)
  assert.match(source, /const useLiveRecoveryTime = !hasDirectTimestampAnchor &&/)
  assert.ok(timestampAssignment < anchorFilter, 'timestamps must be assigned before direct anchors are filtered out')
})

test('provider-backed live DOM recovery survives a media-to-text transition', () => {
  const transport = new TransportInterceptor()
  const chatId = '902454841098'
  const previousMediaId = 'd3010000000000000010'
  const liveTextId = 'd3010000000000000011'

  transport._lastMsgRawHex.clear()
  transport._pendingLiveMessageIds.clear()
  transport._lastMsgRawHex.set(chatId, previousMediaId)

  const registration = transport.registerPendingLiveTextIdForDomRecovery(chatId, liveTextId)
  assert.equal(registration.registered, true)
  assert.equal(transport.pendingLiveTextCountForDomRecovery(chatId), 1)
  assert.equal(transport.peekPendingLiveTextIdForDomRecovery(chatId), liveTextId)

  const selected = selectPendingLiveDomCandidates([
    { text: 'old history', attachments: [], isOutgoing: false, displayMinute: 840 },
    { text: '????????????????', attachments: [], isOutgoing: false, displayMinute: 845 },
    { text: 'own message', attachments: [], isOutgoing: true, displayMinute: 845 },
  ], 1)

  assert.deepEqual(selected.map(candidate => candidate.text), ['????????????????'])

  transport.confirmPendingLiveTextIdForDomRecovery(chatId, liveTextId)
  assert.equal(transport.pendingLiveTextCountForDomRecovery(chatId), 0)
})

test('provider-backed live DOM recovery keeps production JPEG and PDF candidates', () => {
  const selected = selectPendingLiveDomCandidates([
    {
      text: '',
      attachments: [{ type: 'image', url: 'blob:production-jpeg' }],
      isOutgoing: false,
      displayMinute: 1216,
    },
    {
      text: 'Документ.pdf',
      attachments: [{
        type: 'document',
        name: 'Документ.pdf',
        downloadable: true,
      }],
      isOutgoing: false,
      displayMinute: 1216,
    },
    {
      text: 'own upload',
      attachments: [{ type: 'image', url: 'blob:outgoing' }],
      isOutgoing: true,
      displayMinute: 1216,
    },
  ], 2)

  assert.deepEqual(
    selected.map(candidate => candidate.attachments[0].type),
    ['image', 'document'],
  )
})

test('op128 schedules one canonical DOM recovery path for text and media', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const rawStart = source.indexOf('transport.onRawFrame(async data =>')
  const incomingStart = source.indexOf('if (data.opcode === OP.INCOMING_MSG) {', rawStart)
  const incomingEnd = source.indexOf('// Логируем остальные неизвестные push-опкоды', incomingStart)
  const incomingBlock = source.slice(incomingStart, incomingEnd)
  const recoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const candidateStart = source.lastIndexOf('const candidates = await scrapeRecentDomMessages', recoveryStart)
  const recoveryEnd = source.indexOf('const results = []', recoveryStart)
  const recoveryBlock = source.slice(candidateStart, recoveryEnd)

  assert.doesNotMatch(incomingBlock, /scheduleDomFallbackForRecentMedia/)
  assert.match(incomingBlock, /scheduleAutomaticDomMirrorRecovery\(String\(chatId\), 'empty_op71_after_op128'\)/)
  assert.match(recoveryBlock, /candidate\.text \|\| candidate\.attachments\?\.length/)
})

test('anchorless live DOM text is gated by a correlated provider identity', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const liveRecoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const liveRecoveryEnd = source.indexOf('const results = []', liveRecoveryStart)
  const liveRecoveryBlock = source.slice(liveRecoveryStart, liveRecoveryEnd)

  assert.notEqual(liveRecoveryStart, -1)
  assert.notEqual(liveRecoveryEnd, -1)
  assert.match(source, /registerPendingLiveTextIdForDomRecovery/)
  assert.match(liveRecoveryBlock, /pendingLiveTextCountForDomRecovery/)
  assert.match(liveRecoveryBlock, /selectPendingLiveDomCandidates/)
  assert.match(liveRecoveryBlock, /no_recent_direct_time_anchor/)
})


test('provider-backed DOM reply recovery forwards only reply body text', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const helperStart = source.indexOf('function domReplyQuoteParts(')
  const helperEnd = source.indexOf('function decodeBase64Payload(', helperStart)
  const forwardStart = source.indexOf('async function forwardDomCandidate(')
  const forwardEnd = source.indexOf('async function forwardRecentDomMessages(', forwardStart)

  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)
  assert.notEqual(forwardStart, -1)
  assert.notEqual(forwardEnd, -1)

  const helperBlock = source.slice(helperStart, helperEnd)
  assert.match(helperBlock, /quotedText: lines\.slice\(1, -1\)\.join\('\\n'\)\.trim\(\)/)
  assert.match(helperBlock, /recentDirectInboundTextHits\(chatId, parts\.quotedText\)/)

  const forwardBlock = source.slice(forwardStart, forwardEnd)
  const pendingIndex = forwardBlock.indexOf('const pendingProviderId =')
  const quoteIndex = forwardBlock.indexOf('const isStructuredDomReply =')
  const quoteTextIndex = forwardBlock.indexOf('_replyQuoteText: replyParts.quotedText')
  const unresolvedIndex = forwardBlock.indexOf('replyQuoteText: latest._replyQuoteText')
  const webhookIndex = forwardBlock.indexOf('const result = await forwardToWebhook')
  const externalIndex = forwardBlock.indexOf('const externalId = resolvedProviderId || stableDomCandidateMessageId')

  assert.ok(pendingIndex > -1 && quoteIndex > -1 && quoteTextIndex > -1 && unresolvedIndex > -1 && webhookIndex > -1 && externalIndex > -1)
  assert.ok(pendingIndex < quoteIndex, 'provider id must be checked before quote handling')
  assert.ok(quoteIndex < quoteTextIndex, 'structured DOM reply must preserve quoted text separately')
  assert.ok(quoteTextIndex < externalIndex, 'normalized body must be used for webhook payload')
  assert.ok(webhookIndex < unresolvedIndex, 'unresolved quote must be forwarded inside webhook metadata')
})


test('unanchored live DOM text is blocked until an exact provider identity is available', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const liveRecoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const liveRecoveryEnd = source.indexOf('const results = []', liveRecoveryStart)
  const liveRecoveryBlock = source.slice(liveRecoveryStart, liveRecoveryEnd)

  assert.notEqual(liveRecoveryStart, -1)
  assert.notEqual(liveRecoveryEnd, -1)
  assert.match(liveRecoveryBlock, /liveWindowDetails\.recentOp128Count > 0/)
  assert.match(liveRecoveryBlock, /selectPendingLiveDomCandidates\(\s*recoverable,\s*Math\.min\(recoverable\.length, liveWindowDetails\.recentOp128Count\)/s)
  assert.match(liveRecoveryBlock, /candidate\._liveDomSeriesCandidate = true/)
  const exactLookup = source.indexOf("{ text: latest.text, sentAt: receivedAt, direction: 'inbound' }")
  const identityGate = source.indexOf("skipped: 'provider_identity_required'", exactLookup)
  assert.ok(exactLookup > -1 && identityGate > exactLookup)
  assert.match(source.slice(exactLookup, identityGate), /resolvedInbound\.providerMessageId/)
  assert.match(source.slice(exactLookup, identityGate), /comparableDomText\(providerMessage\.text\)/)
  assert.match(source, /skipped: 'provider_identity_required'/)
})


test('live DOM recovery timestamps provider-backed/no-anchor text at recovery time', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const liveRecoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const liveRecoveryEnd = source.indexOf('const beforeAnchorFilter', liveRecoveryStart)
  const liveRecoveryBlock = source.slice(liveRecoveryStart, liveRecoveryEnd)

  assert.notEqual(liveRecoveryStart, -1)
  assert.notEqual(liveRecoveryEnd, -1)
  assert.match(liveRecoveryBlock, /candidate\._liveDomNoAnchorCandidate = true/)
  assert.match(liveRecoveryBlock, /const liveRecoveryNowMs = Date\.now\(\)/)
  assert.match(liveRecoveryBlock, /const useLiveRecoveryTime = !hasDirectTimestampAnchor &&/)
  assert.match(liveRecoveryBlock, /recoverable\[i\]\._pendingLiveProviderCandidate \|\| recoverable\[i\]\._liveDomNoAnchorCandidate/)
})

test('media UI send blocks live DOM recovery until upload/send finishes', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const mediaStart = source.indexOf('async function sendMediaViaUi(')
  const mediaEnd = source.indexOf('\nconst domFallbackSeen', mediaStart)
  const mediaBlock = source.slice(mediaStart, mediaEnd)
  const mirrorStart = source.indexOf('function scheduleAutomaticDomMirrorRecovery(')
  const mirrorEnd = source.indexOf('\nfunction cleanDomMessageText', mirrorStart)
  const mirrorBlock = source.slice(mirrorStart, mirrorEnd)

  assert.notEqual(mediaStart, -1)
  assert.notEqual(mediaEnd, -1)
  assert.match(mediaBlock, /uiSendInProgress = true/)
  assert.match(mediaBlock, /finally \{[\s\S]*uiSendInProgress = false[\s\S]*fs\.unlinkSync\(tmpPath\)/)
  assert.match(mirrorBlock, /if \(uiSendInProgress \|\| domFallbackRunning\) \{[\s\S]*scheduleAutomaticDomMirrorRecovery\(chatIdStr, reason, attempt \+ 1\)/)
})

test('op180 provider id with loose media is not queued as live text recovery', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const op180Start = source.indexOf('if (data.opcode === 180 && data.payload?.messagesReactions)')
  const op180End = source.indexOf('const byMessage = extractReactionCountersFromMap', op180Start)
  const op180Block = source.slice(op180Start, op180End)

  assert.notEqual(op180Start, -1)
  assert.notEqual(op180End, -1)
  assert.match(op180Block, /hasRecentLooseMediaForDomRecovery/)
  assert.match(op180Block, /emitPendingLooseMediaMessage/)
  assert.ok(op180Block.indexOf('emitPendingLooseMediaMessage') < op180Block.indexOf('registerPendingLiveTextIdForDomRecovery'))
})

test('loose media provider id emits media message with real provider identity', () => {
  const transport = new TransportInterceptor()
  const chatId = '902454841098'
  const providerId = 'd30100000000000000aa'
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))

  transport._pushLooseMedia([{ '476': 'videoId', videoId: '15147223310127', previewData: Buffer.from('preview') }])
  const result = transport.emitPendingLooseMediaMessage(chatId, providerId)

  assert.equal(result.emitted, true)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].id, providerId)
  assert.equal(emitted[0].chatId, chatId)
  assert.equal(emitted[0].type, 'video')
  assert.equal(emitted[0].attachments.length, 1)
  assert.equal(emitted[0].attachments[0].type, 'video')
  assert.equal(transport.pendingLiveTextCountForDomRecovery(chatId), 0)
})

test('loose video keeps the direct MP4 source from the live MAX payload', () => {
  const transport = new TransportInterceptor()
  const chatId = '902454841098'
  const providerId = 'd30100000000000000ab'
  const videoUrl = 'https://maxvd.example.test/video.mp4?expires=9999999999&sig=test'
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))

  transport._pushLooseMedia([{
    '476': 'videoId',
    videoId: '17565274016389',
    token: 'video-token',
    previewData: Buffer.from('preview'),
    MP4_1080: videoUrl,
  }])
  const result = transport.emitPendingLooseMediaMessage(chatId, providerId)

  assert.equal(result.emitted, true)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].attachments.length, 1)
  assert.equal(emitted[0].attachments[0].type, 'video')
  assert.equal(emitted[0].attachments[0].url, videoUrl)
  assert.equal(emitted[0].attachments[0].videoId, '17565274016389')
})
