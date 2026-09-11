'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { MessageParser } = require('../parser/MessageParser')
const {
  MAX_RUNTIME_TRACE_PREFIX,
  maxRuntimeTrace,
  sanitizeTraceFields,
} = require('../lib/runtimeTrace')

function captureStdout(fn) {
  const writes = []
  const originalWrite = process.stdout.write
  process.stdout.write = (chunk, encoding, cb) => {
    writes.push(String(chunk))
    if (typeof encoding === 'function') encoding()
    if (typeof cb === 'function') cb()
    return true
  }
  try {
    const result = fn()
    return { result, output: writes.join('') }
  } finally {
    process.stdout.write = originalWrite
  }
}

test('runtime trace helper emits JSONL and never throws on circular fields', () => {
  const circular = { ok: true }
  circular.self = circular

  const { output } = captureStdout(() => {
    assert.doesNotThrow(() => maxRuntimeTrace('test.circular', {
      providerMessageId: 'd301trace000000001',
      chatId: '902454841098',
      text: 'hello',
      circular,
    }))
  })

  const line = output.trim()
  assert.ok(line.startsWith(`${MAX_RUNTIME_TRACE_PREFIX} `))
  const parsed = JSON.parse(line.slice(MAX_RUNTIME_TRACE_PREFIX.length + 1))
  assert.equal(parsed.stage, 'test.circular')
  assert.equal(parsed.providerMessageId, 'd301trace000000001')
  assert.equal(parsed.chatId, '902454841098')
  // Message bodies must never reach container stdout; length and hash stay for correlation.
  assert.equal(parsed.textPreview, '[redacted:5]')
  assert.equal(parsed.textLength, 5)
  assert.ok(!output.includes('hello'))
})

test('runtime trace sanitizer redacts sensitive fields and large payloads', () => {
  const safe = sanitizeTraceFields({
    phone: '+79991234567',
    senderPhone: '+79990000000',
    token: 'secret-token',
    authorization: 'Bearer secret',
    mediaUrl: 'https://example.test/private.jpg',
    text: 'visible text',
    providerMessageId: 'd301trace000000002',
  })

  assert.equal(safe.phone, '[redacted]')
  assert.equal(safe.senderPhone, '[redacted]')
  assert.equal(safe.token, '[redacted]')
  assert.equal(safe.authorization, '[redacted]')
  assert.equal(safe.mediaUrl, '[redacted]')
  assert.equal(safe.textPreview, '[redacted:12]')
  assert.equal(safe.providerMessageId, 'd301trace000000002')
})

test('MessageParser instrumentation does not change CRM payload', () => {
  const msg = {
    id: 'd301trace000000003',
    chatId: '902454841098',
    from: '12345',
    phone: '+7 (999) 123-45-67',
    text: 'repeat',
    timestamp: 1773405600000,
    type: 'text',
    attachments: [],
    isOutgoing: false,
    replyToMessageId: 'd301reply000000001',
  }

  const { result, output } = captureStdout(() => MessageParser.toCrmPayload(msg))

  assert.deepEqual(result, {
    externalId: 'd301trace000000003',
    chatId: '902454841098',
    senderId: '12345',
    phone: '79991234567',
    text: 'repeat',
    timestamp: '2026-03-13T12:40:00.000Z',
    messageType: 'text',
    attachments: [],
    isOutgoing: false,
    replyToExternalId: 'd301reply000000001',
  })
  assert.ok(output.includes(MAX_RUNTIME_TRACE_PREFIX))
  assert.ok(!output.includes('+7 (999) 123-45-67'))
  assert.ok(!output.includes('79991234567'))
  assert.ok(!output.includes('"repeat"'))
})
