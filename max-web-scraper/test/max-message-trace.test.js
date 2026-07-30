'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')

const { maxMsgpackDecodeAll } = require('../transport/TransportInterceptor')
const { buildMaxTextMessage } = require('../pipeline/MessageEnvelope')
const { traceInboundPayload } = require('../forensics/MaxMessageTrace')

const fixtureRoot = join(__dirname, '..', 'forensics', 'fixtures')

function fixture(name) {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'))
}

test('traces text through transport and parser without changing it', () => {
  const trace = traceInboundPayload(fixture('text.json'))

  assert.equal(trace.transportEvent.text, 'Сообщение для трассировки')
  assert.equal(trace.parserOutput.text, 'Сообщение для трассировки')
  assert.equal(trace.webhookPayload.text, 'Сообщение для трассировки')
  assert.deepEqual(trace.unsafeTextSignals, {
    replacementCharacter: false,
    serializedAttachments: false,
    serializedPrevMessage: false,
  })
})

test('keeps image data outside the caption', () => {
  const trace = traceInboundPayload(fixture('image-caption.json'))

  assert.equal(trace.webhookPayload.text, 'Подпись к изображению')
  assert.equal(trace.webhookPayload.messageType, 'image')
  assert.equal(trace.webhookPayload.attachments.length, 1)
  assert.equal(trace.webhookPayload.text.includes('attachments'), false)
})

test('keeps reply and prevM metadata outside text', () => {
  const trace = traceInboundPayload(fixture('reply.json'))

  assert.equal(trace.webhookPayload.text, 'Ответ без служебных полей в тексте')
  assert.equal(trace.webhookPayload.replyToExternalId, 'd30101')
  assert.equal(trace.webhookPayload.text.includes('prevM'), false)
})

test('keeps forwarding metadata structured and leaves text untouched', () => {
  const trace = traceInboundPayload(fixture('forward.json'), {
    lookupContact: id => ({ name: `Fixture ${id}`, phone: '+70000000000' }),
  })

  assert.equal(trace.webhookPayload.text, 'Пересланный текст без префикса')
  assert.deepEqual(trace.webhookPayload.forwardedFrom, {
    id: '700777',
    name: 'Fixture 700777',
    phone: '[redacted]',
  })
  assert.equal(trace.webhookPayload.text.startsWith('[↩'), false)
})

test('does not stringify arbitrary message metadata into body text', () => {
  const trace = traceInboundPayload(fixture('metadata-boundary.json'))

  assert.equal(trace.webhookPayload.text, 'Только пользовательский текст')
  assert.equal(trace.webhookPayload.text.includes('prevM'), false)
  assert.equal(trace.webhookPayload.text.includes('attachments'), false)
})

test('distinguishes repeated equal text by provider message id', () => {
  const first = fixture('text.json')
  const second = fixture('text.json')
  second.message.id = 'd30199'

  const firstTrace = traceInboundPayload(first)
  const secondTrace = traceInboundPayload(second)

  assert.equal(firstTrace.webhookPayload.text, secondTrace.webhookPayload.text)
  assert.notEqual(firstTrace.webhookPayload.externalId, secondTrace.webhookPayload.externalId)
})

test('outbound text is one provider message with optional reply metadata', () => {
  const body = 'Первая строка\nВторая строка\nТретья строка'
  const message = buildMaxTextMessage(body, 'd30101', -123)

  assert.equal(message.text, body)
  assert.equal(Array.isArray(message.attaches), true)
  assert.equal(message.attaches.length, 0)
  assert.deepEqual(message.link, { type: 'REPLY', messageId: 'd30101' })
})

test('reports invalid UTF-8 at the msgpack string boundary', () => {
  const diagnostics = []
  const decoded = maxMsgpackDecodeAll(
    Buffer.from([0xa2, 0xc3, 0x28]),
    { onDiagnostic: value => diagnostics.push(value) },
  )

  assert.deepEqual(decoded[0], {
    __maxInvalidUtf8: true,
    kind: 'invalid_utf8_string',
    byteOffset: 1,
    byteLength: 2,
    sha256: 'eddf68639913a3cb8331cdfe7f87559e0beccf2c289c0d90ac4d89b3204004f8',
  })
  assert.equal(diagnostics.length, 1)
  assert.deepEqual(diagnostics[0], {
    kind: 'invalid_utf8_string',
    byteOffset: 1,
    byteLength: 2,
    sha256: 'eddf68639913a3cb8331cdfe7f87559e0beccf2c289c0d90ac4d89b3204004f8',
  })
})
