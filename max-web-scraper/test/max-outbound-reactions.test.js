'use strict'

const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  explicitChatReactionConfirms,
  reactionCountersConfirm,
} = require('../lib/MaxReactionEvents')
const {
  OP,
  TransportInterceptor,
} = require('../transport/TransportInterceptor')

const CHAT_ID = '902454841098'
const MESSAGE_ID = 'd3019f95cd27b00f32'

test('reaction state confirms only the expected emoji and operation', () => {
  const thumbsUp = [{ reaction: '👍', count: 1 }]
  const heart = [{ reaction: '❤️', count: 1 }]

  assert.equal(reactionCountersConfirm(thumbsUp, '❤️', false), false)
  assert.equal(reactionCountersConfirm(heart, '❤️', false), true)
  assert.equal(reactionCountersConfirm(heart, '❤️', true), false)
  assert.equal(reactionCountersConfirm([], '❤️', true), true)
  assert.equal(explicitChatReactionConfirms('👍', '❤️', false), false)
  assert.equal(explicitChatReactionConfirms('❤️', '❤️', false), true)
  assert.equal(explicitChatReactionConfirms('', '❤️', true), true)
})

test('reaction add frame uses browser header and exact provider message id', () => {
  const transport = new TransportInterceptor()
  transport._browserBinaryRequestPrefix = [0xf0, 0x30]

  const frame = transport._buildBinaryReactionFrame(
    CHAT_ID,
    MESSAGE_ID,
    1,
    false,
    true,
  )

  assert.equal(frame[5], OP.SEND_REACTION)
  assert.equal(frame[6], 0x00, 'synthetic reaction payload is uncompressed')
  assert.equal((frame[8] << 8) | frame[9], frame.length - 10)
  assert.equal(frame[10], 0x83, 'native reaction payload root is a map, not an f0/opcode wrapper')
  assert.notDeepEqual([...frame.subarray(10, 12)], [0xf0, 0x30])
  assert.ok(frame.includes(Buffer.from(MESSAGE_ID.slice(2), 'hex')))
  assert.ok(frame.includes(Buffer.from('reactionType')))
})

test('reaction remove frame targets the same provider message without reaction payload', () => {
  const transport = new TransportInterceptor()
  transport._browserBinaryRequestPrefix = [0xf0, 0x30]

  const frame = transport._buildBinaryReactionFrame(
    CHAT_ID,
    MESSAGE_ID,
    null,
    true,
    true,
  )

  assert.equal(frame[5], OP.REMOVE_REACTION)
  assert.equal(frame[6], 0x00, 'synthetic remove-reaction payload is uncompressed')
  assert.equal((frame[8] << 8) | frame[9], frame.length - 10)
  assert.equal(frame[10], 0x82, 'native remove-reaction payload root is a map, not an f0/opcode wrapper')
  assert.notDeepEqual([...frame.subarray(10, 12)], [0xf0, 0x30])
  assert.ok(frame.includes(Buffer.from(MESSAGE_ID.slice(2), 'hex')))
  assert.equal(frame.includes(Buffer.from('reactionType')), false)
})

test('reaction frame rejects an unadvertised string emoji id', () => {
  const transport = new TransportInterceptor()
  transport._browserBinaryRequestPrefix = [0xf0, 0x30]

  assert.throws(
    () => transport._buildBinaryReactionFrame(CHAT_ID, MESSAGE_ID, '❤️', false, true),
    /numeric provider reaction id/,
  )
})

test('runtime confirmation ignores unrelated snapshots and requires exact state', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  const start = source.indexOf('function waitForReactionConfirmation(')
  const end = source.indexOf('function normalizeReactionCounters(', start)
  const block = source.slice(start, end)

  assert.match(block, /reactionCountersConfirm\(counters, expectedEmoji, remove\)/)
  assert.match(block, /explicitChatReactionConfirms\(reaction, expectedEmoji, remove\)/)
  assert.doesNotMatch(block, /compactReactionSnapshotMatches/)
  assert.doesNotMatch(block, /counters\.length > 0 \|\| remove/)
  assert.match(source, /UNSUPPORTED_MAX_REACTION/)
  assert.match(source, /removeReaction\(transport, Number\(chatId\), messageId, emoji\)/)
})
