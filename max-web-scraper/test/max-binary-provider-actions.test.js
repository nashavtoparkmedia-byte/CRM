'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  OP,
  TransportInterceptor,
} = require('../transport/TransportInterceptor')

const CHAT_ID = '902454841098'
const REPLY_TO = 'd3019f95cab2c07916'

test('reply frame uses the captured MAX binary header and exact provider target', () => {
  const transport = new TransportInterceptor()
  transport._browserBinaryRequestPrefix = [0xf0, 0x30]

  const frame = transport._buildBinaryReplyFrame(
    CHAT_ID,
    'Ответил',
    REPLY_TO,
    -12345,
  )

  assert.equal(frame[0], 0x0a)
  assert.equal(frame[5], OP.SEND_MESSAGE)
  assert.equal(frame[6], 0x01)
  assert.equal(frame[7], 0x00)
  assert.equal((frame[8] << 8) | frame[9], frame.length - 10)
  assert.deepEqual([...frame.subarray(10, 12)], [0xf0, 0x30])
  assert.equal(frame[12], 0x83, 'payload map must start after the two-byte MAX prefix')
  assert.ok(frame.includes(Buffer.from('Ответил')))
  assert.ok(frame.includes(Buffer.from(REPLY_TO.slice(2), 'hex')))
})

test('reply frame refuses to guess a missing browser protocol prefix', () => {
  const transport = new TransportInterceptor()

  assert.throws(
    () => transport._buildBinaryReplyFrame(CHAT_ID, 'Ответил', REPLY_TO, -12345),
    /browser-captured MAX request prefix/,
  )
})

test('reply target remains a real MAX id and is not replaced by a reaction snapshot id', () => {
  const source = require('node:fs').readFileSync(require.resolve('../index'), 'utf8')
  const start = source.indexOf('function waitForUiSendAck(')
  const end = source.indexOf('async function fillMaxMediaCaption(', start)
  const block = source.slice(start, end)

  assert.match(block, /collectMessageCandidates\(data\.payload\)/)
  assert.match(block, /normalizedProviderEchoText\(message\) !== expectedText/)
  assert.match(block, /maxReplyTargetId\(message\.link \|\| message\.reply \|\| message\)/)
  assert.doesNotMatch(block, /\[53, 71, 128, 180\]/)
  assert.doesNotMatch(block, /messagesReactions/)
})
