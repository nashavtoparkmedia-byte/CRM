'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { MessageSync } = require('../sync/MessageSync')
const { TransportInterceptor } = require('../transport/TransportInterceptor')

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

test('pending live queue drains after first confirmed op71 without clearing catch-up early', async () => {
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
  assert.equal(state.scheduledDrain, true)
  assert.equal(transport._catchUpChatIds.has(chatId), true)
  assert.deepEqual((transport._pendingLiveMessageIds.get(chatId) || []).map(item => item.pendingHex), ids.slice(1))
  assert.deepEqual(op71Calls, [{ cid: chatId, anchorHex: ids[0] }])
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
