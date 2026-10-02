'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { MessageSync } = require('../sync/MessageSync')
const {
  TransportInterceptor,
  selectPendingLiveDomCandidates,
  evaluatePhoneResolutionUiSend,
  isUiTextSubmitObserved,
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
  assert.match(source, /msgIdStr && isUsableMaxMessageHex\(storedHex\)/)
  assert.doesNotMatch(source, /!stored \|\| hex\.slice\(2\) > stored\.slice\(2\)/)
})

test('live inbound recovery uses guarded DOM batches without injecting active op71', () => {
  const transportSource = fs.readFileSync(require.resolve('../transport/TransportInterceptor'), 'utf8')
  const scraperSource = fs.readFileSync(require.resolve('../index'), 'utf8')

  const markStart = transportSource.indexOf('\n  _handleOutgoingFrame(frame) {')
  const markEnd = transportSource.indexOf('\n  _resolveBrowserAckChatId(', markStart)
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
  // No DOM recovery on a timer after every push: a decoded push is the live
  // path's to persist, and recovery is driven by the inbound ledger.
  assert.doesNotMatch(incomingBlock, /scheduleAutomaticDomMirrorRecovery/)
  assert.match(incomingBlock, /!pushEnvelope\?\.message && looksLikeDomRecoverableMediaPayload\(data\.payload\)/)
  assert.doesNotMatch(incomingBlock, /const anchorHex|hasPendingLive/)
})

test('DOM recovery calculates ordering while real direct anchors are still present', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const estimateStart = source.indexOf('function estimateDomRecoveryTimestampMs(')
  const estimateEnd = source.indexOf('\nfunction stableDomMessageId(', estimateStart)
  const liveRecoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const anchorFilter = source.indexOf('const beforeAnchorFilter', liveRecoveryStart)
  const timestampAssignment = source.indexOf('_recoveryTimestamp = new Date(', liveRecoveryStart)

  assert.notEqual(estimateStart, -1)
  assert.notEqual(estimateEnd, -1)
  assert.notEqual(liveRecoveryStart, -1)
  assert.notEqual(anchorFilter, -1)
  assert.notEqual(timestampAssignment, -1)
  assert.doesNotMatch(source.slice(estimateStart, estimateEnd), /findRecentDirectInboundText/)
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
  const quoteIndex = forwardBlock.indexOf("looksLikeDomReplyQuoteText(chatId, latest)")
  const leafIndex = forwardBlock.indexOf('latest = { ...latest, text: leafText')
  const externalIndex = forwardBlock.indexOf('const externalId = isOutgoingCandidate')

  assert.ok(pendingIndex > -1 && quoteIndex > -1 && leafIndex > -1 && externalIndex > -1)
  assert.ok(pendingIndex < quoteIndex, 'provider id must be checked before quote handling')
  assert.ok(quoteIndex < leafIndex, 'quote branch must normalize to leaf text')
  assert.ok(leafIndex < externalIndex, 'normalized text must be used for webhook payload')
})


test('single live DOM text after unsafe op128 can recover without direct anchor', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const liveRecoveryStart = source.indexOf("if (reason === 'empty_op71_after_op128') {")
  const liveRecoveryEnd = source.indexOf('const results = []', liveRecoveryStart)
  const liveRecoveryBlock = source.slice(liveRecoveryStart, liveRecoveryEnd)

  assert.notEqual(liveRecoveryStart, -1)
  assert.notEqual(liveRecoveryEnd, -1)
  assert.match(liveRecoveryBlock, /liveWindowDetails\.recentOp128Count > 0/)
  assert.match(liveRecoveryBlock, /selectPendingLiveDomCandidates\(\s*recoverable,\s*Math\.min\(recoverable\.length, liveWindowDetails\.recentOp128Count\)/s)
  assert.match(liveRecoveryBlock, /candidate\._liveDomSeriesCandidate = true/)
  assert.match(source, /source: isOutgoingCandidate \? 'max_web_mirror' : \(resolvedProviderId \? 'live_dom_recovery' : 'dom_fallback'\)/)
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
  assert.match(liveRecoveryBlock, /const useLiveRecoveryTime = recoverable\[i\]\._pendingLiveProviderCandidate \|\| recoverable\[i\]\._liveDomNoAnchorCandidate/)
  assert.match(liveRecoveryBlock, /useLiveRecoveryTime\s*\? liveRecoveryNowMs - liveOffsetMs\s*:\s*estimateDomRecoveryTimestampMs\(recoverable, i\)/s)
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

  transport._pushLooseMedia([{ '476': 'videoId', videoId: '15000000000001', previewData: Buffer.from('preview') }])
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
    videoId: '17000000000001',
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
  assert.equal(emitted[0].attachments[0].videoId, '17000000000001')
})

test('phone UI compose observation recognizes only the exact submitted text clearing', () => {
  assert.equal(isUiTextSubmitObserved('Bounded repair', '', 'Bounded repair'), true)
  assert.equal(isUiTextSubmitObserved('', '', 'Bounded repair'), false)
  assert.equal(isUiTextSubmitObserved('Other text', '', 'Bounded repair'), false)
  assert.equal(isUiTextSubmitObserved('Bounded repair', 'Bounded repair', 'Bounded repair'), false)
})

test('phone UI compose clear without an operation-bound proof stays pending', () => {
  assert.deepEqual(evaluatePhoneResolutionUiSend({
    beforeText: 'Bounded repair',
    afterText: '',
    expectedText: 'Bounded repair',
    postActionFrames: [],
  }), {
    chatId: null,
    uiSendAttempted: true,
    deliveryConfirmed: false,
    confirmationSource: 'send_requested_no_authoritative_proof',
    submitObserved: true,
    observedFrameCount: 0,
  })
})

test('phone UI delayed identical-text own echo stays pending', () => {
  const delayedEcho = [
    {
      opcode: 128,
      payload: {
        chatId: '902000000888',
        message: { sender: 'self-1', text: 'Bounded repair' },
      },
    },
  ]

  const result = evaluatePhoneResolutionUiSend({
    beforeText: 'Bounded repair',
    afterText: '',
    expectedText: 'Bounded repair',
    postActionFrames: delayedEcho,
  })

  assert.equal(result.deliveryConfirmed, false)
  assert.equal(result.chatId, null)
})

test('phone UI own echo from the wrong chat stays pending', () => {
  const wrongChatEcho = [
    {
      opcode: 128,
      payload: {
        chatId: '902000000999',
        message: { sender: 'self-1', text: 'Bounded repair' },
      },
    },
  ]

  const result = evaluatePhoneResolutionUiSend({
    beforeText: 'Bounded repair',
    afterText: '',
    expectedText: 'Bounded repair',
    postActionFrames: wrongChatEcho,
  })

  assert.equal(result.deliveryConfirmed, false)
  assert.equal(result.chatId, null)
})

test('phone UI unrelated and background frames stay pending', () => {
  const backgroundFrames = [
    { opcode: 198, payload: { commonChats: [{ id: '902000000001' }] } },
    { opcode: 72, payload: { chatId: '902000000003' } },
  ]

  const result = evaluatePhoneResolutionUiSend({
    beforeText: 'Bounded repair',
    afterText: '',
    expectedText: 'Bounded repair',
    postActionFrames: backgroundFrames,
  })

  assert.equal(result.deliveryConfirmed, false)
  assert.equal(result.chatId, null)
  assert.equal(result.observedFrameCount, 2)
})

// ─── M1: exactly-once text transport ─────────────────────────────────────────
// Frames are built the way MAX builds them: the encoder below is the frame
// encoder of the MAX Web bundle (`ere`), and the LZ4 block encoder is a port of
// its `Kne`, verified byte-identical against the bundle on 3,000 inputs. The
// sequences come from the preserved production log of 2026-10-02 (fixture
// max-n0-burst-20261002.json, with line numbers and the log sha256).

const n0 = require('./fixtures/max-n0-burst-20261002.json')
const {
  MaxTextSendObservation,
  canonicalMaxMessageIdHex,
  decideMaxTextSendOutcome,
  decodeMaxBinaryFrame,
  maxMsgpackDecodeAll,
  runSingleMaxTextSend,
} = require('../transport/TransportInterceptor')
const { InboundDeliveryLedger, forwardWithBoundedRetry } = require('../sync/MessageSync')
const { MessageParser } = require('../parser/MessageParser')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// MAX ids travel as msgpack ext type 1 holding an int64 (d3) or uint64 (cf).
class MaxExt {
  constructor(hex) { this.hex = hex }
}
const maxIdExt = hex => new MaxExt(hex)
const maxTimeExt = ms => new MaxExt(`d3${BigInt(ms).toString(16).padStart(16, '0')}`)
const maxTimeOfId = id => Number(BigInt(`0x${id.slice(2)}`) >> 16n)

function mpEncode(value) {
  const out = []
  const u8 = v => out.push(v & 0xff)
  const be = (v, bytes) => {
    const big = BigInt.asUintN(bytes * 8, BigInt(v))
    for (let i = bytes - 1; i >= 0; i--) out.push(Number((big >> BigInt(8 * i)) & 0xffn))
  }
  const write = v => {
    if (v === null) return u8(0xc0)
    if (v === true) return u8(0xc3)
    if (v === false) return u8(0xc2)
    if (v instanceof MaxExt) {
      const bytes = Buffer.from(v.hex, 'hex')
      u8(0xc7); u8(bytes.length); u8(0x01)
      for (const b of bytes) u8(b)
      return
    }
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('floats are not used by these frames')
      if (v >= 0 && v < 0x80) return u8(v)
      if (v >= 0 && v < 0x100) { u8(0xcc); return u8(v) }
      if (v >= 0 && v < 0x10000) { u8(0xcd); return be(v, 2) }
      if (v >= 0 && v < 0x100000000) { u8(0xce); return be(v, 4) }
      if (v >= 0) { u8(0xcf); return be(v, 8) }
      if (v >= -32) return u8(v)
      u8(0xd3); return be(v, 8)
    }
    if (typeof v === 'string') {
      const bytes = Buffer.from(v, 'utf8')
      if (bytes.length < 32) u8(0xa0 | bytes.length)
      else if (bytes.length < 0x100) { u8(0xd9); u8(bytes.length) }
      else { u8(0xda); be(bytes.length, 2) }
      for (const b of bytes) u8(b)
      return
    }
    if (Array.isArray(v)) {
      if (v.length < 16) u8(0x90 | v.length); else { u8(0xdc); be(v.length, 2) }
      v.forEach(write)
      return
    }
    const entries = Object.entries(v).filter(([, item]) => item !== undefined)
    if (entries.length < 16) u8(0x80 | entries.length); else { u8(0xde); be(entries.length, 2) }
    for (const [key, item] of entries) { write(key); write(item) }
  }
  write(value)
  return Buffer.from(out)
}

// Port of MAX Web's LZ4 block encoder `Kne`.
function lz4BlockCompress(input) {
  const MIN_MATCH = 4, LAST_LITERALS = 5, MF_LIMIT = 12, MIN_LENGTH = 13, MAX_DISTANCE = 65535
  const HASH_LOG = 13, HASH_SIZE = 1 << HASH_LOG, SKIP_STRENGTH = 6
  const read32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0
  const hashAt = (b, i) => Math.imul(read32(b, i), 2654435761) >>> (32 - HASH_LOG) & (HASH_SIZE - 1)
  const src = Uint8Array.from(input)
  const end = src.length
  const out = new Uint8Array(end + Math.floor(end / 255) + 16)
  const writeLiterals = (op, anchor) => {
    const length = end - anchor
    if (length >= 15) {
      out[op++] = 15 << 4
      let rest = length - 15
      for (; rest >= 255; rest -= 255) out[op++] = 255
      out[op++] = rest
    } else {
      out[op++] = length << 4
    }
    for (let i = 0; i < length; i++) out[op++] = src[anchor + i]
    return op
  }
  if (end === 0) return new Uint8Array()
  if (end < MIN_LENGTH) return out.subarray(0, writeLiterals(0, 0))
  const table = new Int32Array(HASH_SIZE).fill(0)
  const mfLimit = end - MF_LIMIT
  const matchLimit = end - LAST_LITERALS
  let ip = 0, anchor = 0, op = 0
  table[hashAt(src, ip)] = ip
  ip++
  let forwardHash = hashAt(src, ip)
  for (;;) {
    let ref
    let forwardIp = ip, step = 1, attempts = 1 << SKIP_STRENGTH
    do {
      const h = forwardHash
      ip = forwardIp
      forwardIp += step
      step = attempts++ >>> SKIP_STRENGTH
      if (forwardIp > mfLimit) return out.subarray(0, writeLiterals(op, anchor))
      ref = table[h]
      table[h] = ip
      forwardHash = hashAt(src, forwardIp)
    } while (ref + MAX_DISTANCE < ip || read32(src, ref) !== read32(src, ip))
    while (ip > anchor && ref > 0 && src[ip - 1] === src[ref - 1]) { ip--; ref-- }
    const literalLength = ip - anchor
    let token = op++
    if (literalLength >= 15) {
      out[token] = 15 << 4
      let rest = literalLength - 15
      for (; rest >= 255; rest -= 255) out[op++] = 255
      out[op++] = rest
    } else {
      out[token] = literalLength << 4
    }
    for (let i = 0; i < literalLength; i++) out[op++] = src[anchor + i]
    for (;;) {
      const distance = ip - ref
      out[op++] = distance & 255
      out[op++] = (distance >>> 8) & 255
      let matchLength = 0
      while (ip + MIN_MATCH + matchLength < matchLimit && src[ip + MIN_MATCH + matchLength] === src[ref + MIN_MATCH + matchLength]) matchLength++
      ip += MIN_MATCH + matchLength
      if (matchLength >= 15) {
        out[token] |= 15
        matchLength -= 15
        for (; matchLength >= 510; matchLength -= 510) { out[op++] = 255; out[op++] = 255 }
        if (matchLength >= 255) { matchLength -= 255; out[op++] = 255 }
        out[op++] = matchLength
      } else {
        out[token] |= matchLength
      }
      anchor = ip
      if (ip > mfLimit) return out.subarray(0, writeLiterals(op, anchor))
      table[hashAt(src, ip - 2)] = ip - 2
      ref = table[hashAt(src, ip)]
      table[hashAt(src, ip)] = ip
      if (ref + MAX_DISTANCE >= ip && read32(src, ref) === read32(src, ip)) { token = op++; out[token] = 0; continue }
      forwardHash = hashAt(src, ++ip)
      break
    }
  }
}

// MAX Web's frame encoder (`ere`): payloads over 32 bytes are LZ4-compressed.
function encodeMaxFrame({ cmd, seq, opcode, payload }) {
  let body = payload === undefined ? Buffer.alloc(0) : mpEncode(payload)
  let compression = 0
  if (body.length > 32) {
    const compressed = Buffer.from(lz4BlockCompress(body))
    compression = Math.min(Math.ceil(body.length / compressed.length), 255)
    body = compressed
  }
  const frame = Buffer.alloc(10 + body.length)
  frame[0] = 10
  frame[1] = cmd
  frame.writeInt16BE(seq, 2)
  frame.writeInt16BE(opcode, 4)
  frame[6] = compression
  frame[7] = (body.length >>> 16) & 255
  frame[8] = (body.length >>> 8) & 255
  frame[9] = body.length & 255
  body.copy(frame, 10)
  return frame
}

// The reader this change replaces: msgpack from byte 9, no decompression, last object wins.
function legacyDecodePayload(frame) {
  const values = maxMsgpackDecodeAll(frame.subarray(9))
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null && typeof values[i] === 'object') return values[i]
  }
  return null
}

const ACCOUNT = Number(n0.accountId)
const PEER = Number(n0.peerId)
const CHAT = Number(n0.chatId)

function peerPush(message, seq, unread) {
  return encodeMaxFrame({
    cmd: 0,
    seq,
    opcode: 128,
    payload: {
      chatId: CHAT,
      message: {
        sender: PEER,
        id: maxIdExt(message.id),
        time: maxTimeExt(maxTimeOfId(message.id)),
        text: message.text,
        type: 'USER',
        attaches: [],
        elements: [],
      },
      unread,
      mark: maxTimeExt(maxTimeOfId(message.id)),
    },
  })
}

function pageAck(seq, messageId) {
  // The page acknowledges a push with {chatId, messageId}; its chat id is the
  // 32-bit web route and the id is its own uint64 re-encoding.
  return encodeMaxFrame({ cmd: 1, seq, opcode: 128, payload: { chatId: Number(n0.uiRouteId), messageId: maxIdExt(`cf${messageId.slice(2)}`) } })
}

// Points the first LZ4 back-reference before the start of the output - a block
// MAX Web's own decoder rejects.
function corruptFirstMatchOffset(frame) {
  const corrupted = Buffer.from(frame)
  let ip = 10
  const token = corrupted[ip++]
  let literalLength = token >>> 4
  if (literalLength === 15) {
    let extra
    do { extra = corrupted[ip++]; literalLength += extra } while (extra === 255)
  }
  ip += literalLength
  corrupted[ip] = 0xff
  corrupted[ip + 1] = 0xff
  return corrupted
}

function hexBytes(spaced) {
  return Buffer.from(spaced.split(' ').join(''), 'hex')
}

test('M1 codec: the bundle frame layout explains every real header class in the N0 log', () => {
  const frames = [
    ...n0.realOutgoingFrames.op128Acks,
    ...n0.realOutgoingFrames.op64Requests,
    n0.realOutgoingFrames.op6,
    n0.realOutgoingFrames.op19,
    n0.realOutgoingFrames.op272,
    n0.realOutgoingFrames.op302,
  ]
  for (const frame of frames) {
    const bytes = hexBytes(frame.first20Hex)
    assert.equal(bytes[0], 10, `version, line ${frame.line}`)
    assert.equal(((bytes[7] << 16) | (bytes[8] << 8) | bytes[9]) + 10, frame.byteLength, `length, line ${frame.line}`)
  }
  // Opcodes are int16: the old reader took byte 5 and saw 16 and 46.
  assert.equal(hexBytes(n0.realOutgoingFrames.op272.first20Hex).readInt16BE(4), 272)
  assert.equal(hexBytes(n0.realOutgoingFrames.op302.first20Hex).readInt16BE(4), 302)
  // Byte 6 is the compression factor, not cmd: op:19 (814 bytes) is compressed 2x,
  // op:64 requests 1x, and cmd sits in byte 1.
  const op19 = hexBytes(n0.realOutgoingFrames.op19.first20Hex)
  assert.deepEqual([op19[1], op19[6]], [0, 2])
  for (const request of n0.realOutgoingFrames.op64Requests) {
    const bytes = hexBytes(request.first20Hex)
    assert.deepEqual([bytes[1], bytes.readInt16BE(4), bytes[6]], [0, 64, 1])
  }
})

test('M1 codec: the page acknowledgement of the "1" push is reproduced byte for byte', () => {
  const real = n0.realOutgoingFrames.op128Acks[0]
  const rebuilt = pageAck(0x6e, n0.inbound.messages[0].id)
  assert.equal(rebuilt.length, real.byteLength)
  assert.equal(rebuilt.subarray(0, 20).toString('hex'), real.first20Hex.split(' ').join(''))
  const decoded = decodeMaxBinaryFrame(rebuilt)
  assert.equal(decoded.ok, true)
  assert.deepEqual([decoded.cmd, decoded.seq, decoded.opcode, decoded.compression], [1, 0x6e, 128, 1])
  assert.equal(decoded.payload.chatId, Number(n0.uiRouteId))
  assert.equal(canonicalMaxMessageIdHex(decoded.payload.messageId), n0.inbound.messages[0].id)
})

test('M1 codec: long Cyrillic text with emoji and a line break decodes byte-equal; the old reader garbled it', () => {
  const text = [
    'Здравствуйте! Подтверждаю заказ 🚕 на 10:30, подъеду к главному входу.',
    'Здравствуйте! Подтверждаю заказ 🚕 на 10:30, подъеду к главному входу, номер машины А123ВС ✅',
    'Если что-то изменится — напишите, пожалуйста, заранее. Спасибо!',
  ].join('\n')
  assert.ok(text.length >= 200)
  const message = { id: 'd301a0fe2a00001111', text }
  const frame = peerPush(message, 50, 1)
  assert.ok(frame[6] > 0, 'MAX compresses this payload')

  const decoded = decodeMaxBinaryFrame(frame)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.payload.message.text, text)
  assert.ok(!decoded.payload.message.text.includes('�'))

  const legacy = legacyDecodePayload(frame)
  assert.notEqual(legacy?.message?.text, text, 'the old reader cannot read an LZ4 block with back-references')

  const transport = new TransportInterceptor()
  transport._myUserId = String(ACCOUNT)
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))
  transport._handleBinaryFrame(frame)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].text, text)
  assert.equal(emitted[0].id, message.id)
  assert.equal(emitted[0].timestamp, maxTimeOfId(message.id))
  assert.equal(emitted[0].isOutgoing, false)
})

test('M1 codec: an undecodable frame is dropped whole, never mined for a stray id', () => {
  const frame = corruptFirstMatchOffset(peerPush({ id: 'd301a0fe2a00002222', text: 'проверка '.repeat(20) }, 51, 1))
  const decoded = decodeMaxBinaryFrame(frame)
  assert.deepEqual([decoded.ok, decoded.reason], [false, 'lz4_corrupt'])
  const truncated = decodeMaxBinaryFrame(peerPush({ id: 'd301a0fe2a00002223', text: 'x' }, 52, 1).subarray(0, 20))
  assert.deepEqual([truncated.ok, truncated.reason], [false, 'truncated_payload'])
  const transport = new TransportInterceptor()
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))
  transport._handleBinaryFrame(frame)
  assert.equal(emitted.length, 0)
  assert.equal(transport._pendingNewMsgIds.length, 0)
})

test('M1 codec: op:19 carries the profile on every login; a refused login is not a send-ready socket', () => {
  const transport = new TransportInterceptor()
  const authed = []
  transport.onWsAuth(id => authed.push(id))
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 1, opcode: 19, payload: { token: 'x'.repeat(40), profile: { contact: { id: ACCOUNT, names: [{ name: 'YOKO' }] } } } }))
  assert.equal(transport._myUserId, n0.accountId)
  assert.equal(transport._wsConnected, true)
  assert.deepEqual(authed, [n0.accountId])

  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 3, seq: 1, opcode: 19, payload: { error: 'login.token', message: 'token expired' } }))
  assert.equal(transport._wsConnected, false)
  assert.equal(transport._myUserId, n0.accountId, 'an error answer never replaces the proven principal')
})

function wireInboundLikeIndex(transport, ledger, crm, delaysMs = [5, 10, 20]) {
  // index.js: transport.onMessage -> inboundLedger.enqueue(chat, handleIncoming);
  // handleIncoming: beginForward -> forwardWithBoundedRetry -> markPersisted on 2xx.
  transport.onMessage(msg => {
    ledger.enqueue(String(msg.chatId), async () => {
      if (!ledger.beginForward(msg.id)) return
      try {
        const payload = MessageParser.toCrmPayload(msg)
        const result = await forwardWithBoundedRetry(crm, payload, { delaysMs })
        if (result.status >= 200 && result.status < 300) ledger.markPersisted(payload.externalId, payload.chatId)
      } finally {
        ledger.releaseForward(msg.id)
      }
    })
  })
}

test('M1 inbound: the N0 burst 1,2,3,3,3,3,4 is persisted as seven rows in sent order', async () => {
  assert.deepEqual(n0.inbound.messages.map(m => m.text), n0.inbound.sentByPeer)
  const transport = new TransportInterceptor()
  transport._myUserId = String(ACCOUNT)
  const ledger = new InboundDeliveryLedger({ graceMs: 1000 })
  const stored = []
  const attempts = new Map()
  const crm = async payload => {
    const attempt = (attempts.get(payload.externalId) || 0) + 1
    attempts.set(payload.externalId, attempt)
    // Later messages answer faster, so any parallel forwarding would reorder.
    await sleep(Math.max(1, 30 - 4 * stored.length))
    // The CRM answers 503 once for "2": seen-after-2xx plus the bounded retry keep it.
    if (payload.text === '2' && attempt === 1) return { status: 503, data: 'restarting' }
    stored.push(payload)
    return { status: 200, data: '{}' }
  }
  wireInboundLikeIndex(transport, ledger, crm)

  n0.inbound.messages.forEach((message, index) => transport._handleBinaryFrame(peerPush(message, 100 + index, index + 1)))
  for (let i = 0; i < 200 && stored.length < 7; i++) await sleep(10)

  assert.deepEqual(stored.map(p => p.text), ['1', '2', '3', '3', '3', '3', '4'])
  assert.deepEqual(stored.map(p => p.externalId), n0.inbound.messages.map(m => m.id))
  assert.equal(new Set(stored.map(p => p.externalId)).size, 7)
  const sentAt = stored.map(p => Date.parse(p.timestamp))
  assert.deepEqual(sentAt, [...sentAt].sort((a, b) => a - b), 'provider timestamps, in sent order')
  assert.equal(attempts.get(n0.inbound.messages[1].id), 2)
  for (const message of n0.inbound.messages) assert.equal(ledger.isPersisted(message.id), true)
})

test('M1 inbound: the old reader could not decode every push of the burst; the bundle layout decodes all', () => {
  let legacyReadable = 0
  for (const [index, message] of n0.inbound.messages.entries()) {
    const frame = peerPush(message, 100 + index, index + 1)
    assert.equal(decodeMaxBinaryFrame(frame).payload.message.text, message.text)
    const legacy = legacyDecodePayload(frame)
    if (legacy?.message?.text === message.text && legacy?.message?.id?.hex === message.id) legacyReadable += 1
  }
  assert.ok(legacyReadable < n0.inbound.messages.length, `old reader decoded ${legacyReadable}/7`)
})

test('M1 inbound: a push the page acknowledged but the CRM never stored is handed to recovery by its exact id', async () => {
  const transport = new TransportInterceptor()
  transport._myUserId = String(ACCOUNT)
  const unpersisted = []
  const ledger = new InboundDeliveryLedger({ graceMs: 30, onUnpersisted: event => unpersisted.push(event) })
  const crm = async payload => ({ status: 200, data: '{}', payload })
  wireInboundLikeIndex(transport, ledger, crm)
  transport.onBrowserMessageAck(({ chatId, messageId }) => ledger.noteBrowserAck(chatId, messageId))

  const [one, two, three] = n0.inbound.messages
  // "1" decodes and is stored; "2" arrives as a frame nobody can read (the N0
  // unsafe_pending_id case); "3" decodes and is stored. The page acknowledges all three.
  transport._handleBinaryFrame(peerPush(one, 100, 1))
  const broken = corruptFirstMatchOffset(peerPush(two, 101, 2))
  assert.equal(decodeMaxBinaryFrame(broken).ok, false)
  transport._handleBinaryFrame(broken)
  transport._handleBinaryFrame(peerPush(three, 102, 3))
  for (const [seq, message] of [[0x6e, one], [0x01, two], [0x02, three]]) {
    transport._handleOutgoingFrame({ ...decodeMaxBinaryFrame(pageAck(seq, message.id)), socket: 'ws-1' })
  }
  await sleep(120)

  assert.equal(ledger.isPersisted(one.id), true)
  assert.equal(ledger.isPersisted(three.id), true)
  assert.deepEqual(unpersisted.map(event => event.messageId), [two.id])
  assert.equal(unpersisted[0].chatId, n0.chatId, 'the 32-bit route in the acknowledgement resolves to the provider chat')
})

test('M1 inbound ledger: an in-flight forward is decided by the CRM answer, not by a clock', async () => {
  const fired = []
  const ledger = new InboundDeliveryLedger({ graceMs: 15, onUnpersisted: event => fired.push(event.messageId) })
  assert.equal(ledger.beginForward('d301aa'), true)
  assert.equal(ledger.beginForward('d301aa'), false, 'one id is forwarded once at a time')
  ledger.noteBrowserAck('902454841098', 'd301aa')
  await sleep(60)
  assert.deepEqual(fired, [], 'still in flight: recovery waits')
  ledger.markPersisted('d301aa', '902454841098')
  await sleep(40)
  assert.deepEqual(fired, [])
  assert.equal(ledger.beginForward('d301aa'), false, 'a stored id is never forwarded again')

  ledger.beginForward('d301bb')
  ledger.noteBrowserAck('902454841098', 'd301bb')
  ledger.releaseForward('d301bb')
  await sleep(40)
  assert.deepEqual(fired, ['d301bb'], 'a failed forward goes to recovery once')
})

test('M1 inbound: a forward is retried only on 5xx or network errors and a refusal is returned as is', async () => {
  let calls = 0
  const refused = await forwardWithBoundedRetry(async () => { calls += 1; return { status: 409 } }, {}, { delaysMs: [1, 1, 1] })
  assert.deepEqual([refused.status, refused.attempts, calls], [409, 1, 1])
  calls = 0
  const flaky = await forwardWithBoundedRetry(async () => {
    calls += 1
    if (calls < 3) throw new Error('ECONNRESET')
    return { status: 200 }
  }, {}, { delaysMs: [1, 1, 1] })
  assert.deepEqual([flaky.status, flaky.attempts], [200, 3])
  calls = 0
  const down = await forwardWithBoundedRetry(async () => { calls += 1; return { status: 502 } }, {}, { delaysMs: [1, 1, 1] })
  assert.deepEqual([down.status, down.attempts, calls], [502, 4, 4])
})

function outgoingRequest(seq, text, cid) {
  return decodeMaxBinaryFrame(encodeMaxFrame({
    cmd: 0,
    seq,
    opcode: 64,
    payload: {
      chatId: maxIdExt(`cf${BigInt(n0.chatId).toString(16).padStart(16, '0')}`),
      message: { text, cid: maxIdExt(`d3${BigInt.asUintN(64, BigInt(cid)).toString(16).padStart(16, '0')}`), elements: [], attaches: [] },
      notify: true,
    },
  }))
}

function sendResponse(seq, text, cid, providerMessageId) {
  return encodeMaxFrame({
    cmd: 1,
    seq,
    opcode: 64,
    payload: {
      chatId: CHAT,
      message: {
        sender: ACCOUNT,
        id: maxIdExt(providerMessageId),
        time: maxTimeExt(maxTimeOfId(providerMessageId)),
        text,
        cid: maxIdExt(`d3${BigInt.asUintN(64, BigInt(cid)).toString(16).padStart(16, '0')}`),
        type: 'USER',
        attaches: [],
      },
      unread: 0,
      mark: maxTimeExt(maxTimeOfId(providerMessageId)),
    },
  })
}

test('M1 outbound: the N0 sequence 5,5,5,6,6,7 is one physical send per call, each with its own id', async () => {
  const transport = new TransportInterceptor()
  transport._myUserId = String(ACCOUNT)
  transport._wsConnected = true
  const wire = []
  const results = []
  let previousId = null
  for (const [index, send] of n0.outbound.sends.entries()) {
    // The second "6" was typed into a page whose socket had just closed; in the
    // model it is sent after the re-login, with an id of its own.
    const seq = send.requestSeq ?? 0x19
    const providerMessageId = send.responseId ?? `d3${((BigInt(Date.parse('2026-10-02T19:25:59.500Z')) << 16n) | 0x5e0bn).toString(16).padStart(16, '0')}`
    const cid = -(1790969144000 + index)
    let reauthAt = null
    if (send.socketClosedLine) {
      transport._wsConnected = false
      setTimeout(() => {
        reauthAt = Date.now()
        transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 1, opcode: 19, payload: { token: 't'.repeat(40), profile: { contact: { id: ACCOUNT } } } }))
      }, 60)
    }
    let actionAt = null
    let actions = 0
    const result = await runSingleMaxTextSend({
      transport,
      chatId: n0.chatId,
      text: send.text,
      ensureReady: () => transport.waitForSendReadySocket({ stableMs: 20, timeoutMs: 2000, pollMs: 5 }),
      performAction: async () => {
        actions += 1
        actionAt = Date.now()
        const request = outgoingRequest(seq, send.text, cid)
        wire.push(request)
        transport._handleOutgoingFrame({ ...request, socket: 'ws-1' })
        if (previousId) {
          // N0 hazards: a reactions snapshot and a stale op:64 answer, both
          // carrying the PREVIOUS message's id, arrive before the real answer.
          transport._handleBinaryFrame(encodeMaxFrame({ cmd: 0, seq: 3, opcode: 180, payload: { messagesReactions: { [previousId]: {} } } }))
          transport._handleBinaryFrame(sendResponse(seq + 9, send.text, cid, previousId))
        }
        setTimeout(() => transport._handleBinaryFrame(sendResponse(seq, send.text, cid, providerMessageId)), 5)
        return { performed: true, kind: 'compose', inspectWithoutRequest: async () => ({ composeRetainedText: false }) }
      },
      requestTimeoutMs: 300,
      answerTimeoutMs: 500,
    })
    assert.equal(actions, 1)
    if (send.socketClosedLine) assert.ok(reauthAt !== null && actionAt >= reauthAt, 'nothing is typed before the socket re-authenticates')
    assert.equal(result.outcome, 'accepted', `send ${index}`)
    assert.equal(result.providerMessageId, providerMessageId, `send ${index} gets its own id`)
    results.push(result)
    previousId = result.providerMessageId
  }
  assert.equal(wire.length, 6, 'six physical sends for six intended sends')
  assert.deepEqual(wire.map(frame => frame.payload.message.text), n0.outbound.sentByCrm)
  assert.equal(new Set(results.map(r => r.providerMessageId)).size, 6)
  assert.notEqual(results[5].providerMessageId, results[3].providerMessageId, '"7" never receives the id of "6"')
  assert.ok(results.every(r => r.extraRequestFrames === 0))
})

test('M1 outbound: the wire, not the compose box, decides the answer of one call', async () => {
  const transport = new TransportInterceptor()
  const ready = async () => ({ ready: true })
  const run = (performAction, extra = {}) => runSingleMaxTextSend({
    transport, chatId: n0.chatId, text: '6', ensureReady: ready, performAction, requestTimeoutMs: 40, answerTimeoutMs: 40, ...extra,
  })

  // The request left the page and MAX's answer was not seen: requested, no id.
  const requested = await run(async () => {
    transport._handleOutgoingFrame({ ...outgoingRequest(30, '6', -1), socket: 'ws-1' })
    return { performed: true, kind: 'compose' }
  })
  assert.deepEqual([requested.outcome, requested.providerMessageId ?? null, requested.requestSeq], ['requested', null, 30])

  // No frame, compose box still holds the text: the page never took the submit.
  const notSubmitted = await run(async () => ({ performed: true, kind: 'compose', inspectWithoutRequest: async () => ({ composeRetainedText: true }) }))
  assert.equal(notSubmitted.outcome, 'not_dispatched')

  // No frame, compose box emptied (the N0 second "6"): unknown, never success.
  const swallowed = await run(async () => ({ performed: true, kind: 'compose', inspectWithoutRequest: async () => ({ composeRetainedText: false }) }))
  assert.deepEqual([swallowed.outcome, swallowed.reason], ['unknown', 'submitted_without_send_frame'])

  // Socket never ready: nothing is typed at all.
  let typed = false
  const notReady = await runSingleMaxTextSend({
    transport, chatId: n0.chatId, text: '6',
    ensureReady: async () => ({ ready: false, reason: 'socket_not_authenticated' }),
    performAction: async () => { typed = true; return { performed: true } },
  })
  assert.deepEqual([notReady.outcome, notReady.reason, typed], ['not_dispatched', 'socket_not_authenticated', false])

  // The action broke midway: unknown.
  const broke = await run(async () => { throw new Error('Target closed') })
  assert.equal(broke.outcome, 'unknown')

  // MAX answered the request with an error.
  const rejected = await run(async () => {
    transport._handleOutgoingFrame({ ...outgoingRequest(31, '6', -2), socket: 'ws-1' })
    setTimeout(() => transport._handleBinaryFrame(encodeMaxFrame({ cmd: 3, seq: 31, opcode: 64, payload: { error: 'chat.denied', message: 'denied' } })), 2)
    return { performed: true, kind: 'compose' }
  })
  assert.deepEqual([rejected.outcome, rejected.reason], ['rejected', 'chat.denied'])
  assert.equal(transport._sendObservations.size, 0, 'every observation is closed')
})

test('M1 outbound: an answer for the right seq but another chat, text or cid is ignored', () => {
  const observation = new MaxTextSendObservation({ chatId: n0.chatId, text: '5' })
  observation.onOutgoingFrame({ ...outgoingRequest(40, '5', -7), socket: 'ws-1' })
  const answer = (overrides) => {
    const decoded = decodeMaxBinaryFrame(sendResponse(40, '5', -7, 'd301a0fe1478805e09'))
    return { ...decoded, payload: { ...decoded.payload, ...overrides(decoded.payload) } }
  }
  observation.onIncomingFrame(answer(() => ({ chatId: 902144614300 })))
  observation.onIncomingFrame(answer(payload => ({ message: { ...payload.message, text: '6' } })))
  observation.onIncomingFrame(answer(payload => ({ message: { ...payload.message, cid: maxIdExt('d3ffffffffffffff00') } })))
  assert.equal(observation.response, null)
  assert.equal(observation.ignoredResponses, 3)
  observation.onIncomingFrame(answer(() => ({})))
  assert.equal(observation.response.providerMessageId, 'd301a0fe1478805e09')
})

test('M1 outbound: a page re-send is recorded, and a reply proven only by the store read-back is accepted', () => {
  const resent = decideMaxTextSendOutcome({
    action: { performed: true, kind: 'compose' },
    evidence: { request: { seq: 5 }, extraRequests: [{ seq: 9 }], response: { providerMessageId: 'd301a0fe1478805e09' } },
  })
  assert.deepEqual([resent.outcome, resent.extraRequestFrames], ['accepted', 1])

  const storeOnly = decideMaxTextSendOutcome({ action: { performed: true, kind: 'reply', storeConfirmedId: 'd301a0fe1478805e09' }, evidence: {} })
  assert.deepEqual([storeOnly.outcome, storeOnly.proofKind], ['accepted', 'provider_store_readback'])

  const conflict = decideMaxTextSendOutcome({
    action: { performed: true, kind: 'reply', storeConfirmedId: 'd301a0fe1483c85e09' },
    evidence: { request: { seq: 5 }, response: { providerMessageId: 'd301a0fe1478805e09' } },
  })
  assert.deepEqual([conflict.outcome, conflict.reason], ['unknown', 'provider_id_conflict'])

  const replyNotStarted = decideMaxTextSendOutcome({ action: { performed: false, notDispatchedReason: 'reply_not_started:max_web_core_not_found' }, evidence: {} })
  assert.equal(replyNotStarted.outcome, 'not_dispatched')
})

test('M1 outbound: the send-ready gate refuses when no authenticated socket appears', async () => {
  const transport = new TransportInterceptor()
  transport._myUserId = String(ACCOUNT)
  transport._wsConnected = false
  const startedAt = Date.now()
  const readiness = await transport.waitForSendReadySocket({ stableMs: 20, timeoutMs: 120, pollMs: 5 })
  assert.deepEqual(readiness, { ready: false, reason: 'socket_not_authenticated' })
  assert.ok(Date.now() - startedAt >= 100)

  const unproven = new TransportInterceptor()
  unproven._wsConnected = true
  assert.deepEqual(await unproven.waitForSendReadySocket({ stableMs: 10, timeoutMs: 200, pollMs: 5 }), { ready: false, reason: 'provider_account_unproven' })
})

function freshTransport() {
  const transport = new TransportInterceptor()
  // Anchors persisted by other tests in this process must not leak in.
  transport._lastMsgRawHex.clear()
  transport._lastSeenMsgId.clear()
  transport._persistLastMsgRawHex = () => {}
  transport._myUserId = String(ACCOUNT)
  return transport
}

function chatListEntry(chatId, message) {
  return {
    id: chatId,
    type: 'DIALOG',
    owner: ACCOUNT,
    participants: { [String(ACCOUNT)]: 0, [String(PEER)]: 0 },
    lastMessage: {
      sender: PEER,
      id: maxIdExt(message.id),
      time: maxTimeExt(maxTimeOfId(message.id)),
      text: message.text,
      type: 'USER',
      // A forwarded original is content of this message, never a message of the chat.
      link: { type: 'FORWARD', message: { sender: 902000000001, id: maxIdExt('d301a0fe7f00000001'), text: 'пересланное', type: 'USER' } },
    },
  }
}

test('M1 decoded chat lists: an unseen chat is only anchored and old conversations are never replayed', () => {
  const transport = freshTransport()
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))
  const old = { id: 'd301a0f000000000aa', text: 'старое сообщение' }
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 7, opcode: 53, payload: { chats: [chatListEntry(902100000001, old)], marker: maxTimeExt(1) } }))
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 2, opcode: 48, payload: { chats: [chatListEntry(902100000002, old)] } }))
  assert.equal(emitted.length, 0)
  assert.equal(transport._lastMsgRawHex.get('902100000001'), old.id)
  assert.equal(transport._lastMsgRawHex.get('902100000002'), old.id)
})

test('M1 decoded chat lists: a lastMessage newer than the anchor is emitted once, never silently confirmed', () => {
  const transport = freshTransport()
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))
  const chatId = 902100000003
  const before = { id: 'd301a0fe1412085642', text: '1' }
  const missed = { id: 'd301a0fe14238c2c0a', text: '4' }
  // "1" arrived as a push; "4" arrived while the socket was down and is only
  // visible in the chat list the page loads after it reconnects.
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 0, seq: 9, opcode: 128, payload: { chatId, message: { sender: PEER, id: maxIdExt(before.id), time: maxTimeExt(maxTimeOfId(before.id)), text: before.text, type: 'USER' }, unread: 1 } }))
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 3, opcode: 48, payload: { chats: [chatListEntry(chatId, missed)] } }))
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 8, opcode: 53, payload: { chats: [chatListEntry(chatId, missed)] } }))
  transport._handleBinaryFrame(encodeMaxFrame({ cmd: 1, seq: 9, opcode: 53, payload: { chats: [chatListEntry(chatId, before)] } }))
  assert.deepEqual(emitted.map(m => [m.id, m.text]), [[before.id, '1'], [missed.id, '4']])
  assert.ok(!emitted.some(m => m.id === 'd301a0fe7f00000001'), 'a forwarded original is never emitted')
  assert.equal(transport._lastMsgRawHex.get(String(chatId)), missed.id)
})

test('M1 decoded history: an unanchored chat is anchored; an anchored chat gets only newer messages', () => {
  const transport = freshTransport()
  const emitted = []
  transport.onMessage(msg => emitted.push(msg))
  const history = (chatId, ids) => encodeMaxFrame({
    cmd: 1,
    seq: 11,
    opcode: 49,
    payload: {
      chatId,
      messages: ids.map((id, index) => ({ sender: PEER, id: maxIdExt(id), time: maxTimeExt(maxTimeOfId(id)), text: `h${index}`, type: 'USER' })),
    },
  })
  transport._handleBinaryFrame(history(902100000004, ['d301a0f000000000a1', 'd301a0f000000000a2', 'd301a0f000000000a3']))
  assert.equal(emitted.length, 0)
  assert.equal(transport._lastMsgRawHex.get('902100000004'), 'd301a0f000000000a3')
  transport._handleBinaryFrame(history(902100000004, ['d301a0f000000000a2', 'd301a0f000000000a3', 'd301a0f000000000a4']))
  assert.deepEqual(emitted.map(m => m.id), ['d301a0f000000000a4'])
})
