'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  OP,
  TransportInterceptor,
  maxMsgpackDecodeAll,
} = require('../transport/TransportInterceptor')

const CHAT_ID = '902454841098'
const REPLY_TO = 'd3019f95cab2c07916'

test('reply frame uses native MAX op64 reply payload shape', () => {
  const transport = new TransportInterceptor()
  transport._browserBinaryRequestPrefix = [0xf0, 0x1b]

  const frame = transport._buildBinaryReplyFrame(
    CHAT_ID,
    'Ответил',
    REPLY_TO,
    -12345,
  )

  assert.equal(frame[0], 0x0a)
  assert.equal(frame[1], 0x01, 'native MAX request frames use cmd=1')
  assert.equal(frame[5], OP.SEND_MESSAGE)
  assert.equal(frame[6], 0x00, 'synthetic op64 payload is uncompressed')
  assert.equal(frame[7], 0x00)
  assert.equal((frame[8] << 8) | frame[9], frame.length - 10)
  assert.equal(frame[10], 0x84, 'native op64 payload root is a map, not an f0/opcode wrapper')

  const decoded = maxMsgpackDecodeAll(frame.subarray(10))
  assert.equal(decoded.length, 1, 'native op64 frame contains one root payload object')
  const payload = decoded[0]
  assert.equal(payload.chatId.hex.toLowerCase(), 'cf000000d21e800f0a', 'op64 uses the full protocol chat id, not lower32/ui route')
  assert.equal(payload.postId, null, 'direct-dialog op64 keeps native postId:nil shape')
  assert.equal(payload.notify, true)
  assert.equal(payload.message.text, 'Ответил')
  assert.equal(payload.message.link.type, 'REPLY')
  assert.equal(payload.message.link.id, undefined, 'outbound reply must not use provider-store read-model key id')
  assert.equal(payload.message.link.messageId.hex.toLowerCase(), `cf${REPLY_TO.slice(2)}`, 'native BigInt encoder uses uint64 for positive provider ids')
})

test('reply frame ignores captured f0 prefixes and keeps a native map root', () => {
  const transport = new TransportInterceptor()
  transport._browserBinaryRequestPrefix = [0xf0, 0x1b]
  transport._browserBinaryRequestPrefixesByOpcode.set(OP.SEND_MESSAGE, [0xf0, 0x41])

  const frame = transport._buildBinaryReplyFrame(CHAT_ID, 'Ответил', REPLY_TO, -12345)

  assert.equal(frame[10], 0x84)
  assert.notDeepEqual([...frame.subarray(10, 12)], [0xf0, 0x41])
})

test('reply frame does not require a captured prefix when browser has not emitted native op64', () => {
  const transport = new TransportInterceptor()

  const frame = transport._buildBinaryReplyFrame(CHAT_ID, 'Ответил', REPLY_TO, -12345)

  assert.equal(frame[10], 0x84)
  assert.notDeepEqual([...frame.subarray(10, 12)], [0xf0, OP.SEND_MESSAGE])
})

test('reply frame refuses non-provider reply targets before physical action', () => {
  const transport = new TransportInterceptor()

  assert.throws(
    () => transport._buildBinaryReplyFrame(CHAT_ID, 'Ответил', 'msg_123', -12345),
    /Reply requires real MAX provider message id/,
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
