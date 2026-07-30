'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MessageParser } = require('../parser/MessageParser')
const { TransportInterceptor } = require('../transport/TransportInterceptor')
const { LiveCaptureAdapter } = require('../capture/LiveCaptureAdapter')
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
  assert.equal(parsed.textPreview, 'hello')
  assert.equal(parsed.textLength, 5)
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
  assert.equal(safe.textPreview, 'visible text')
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
})

test('raw transport exposes no payload trace API that could bypass capture sanitization', () => {
  const transport = new TransportInterceptor()
  assert.equal(typeof transport._traceRawFrameSummary, 'undefined')
  const source = fs.readFileSync(require.resolve('../transport/TransportInterceptor'), 'utf8')
  assert.doesNotMatch(source, /_traceRawFrameSummary|candidateMessages|MAX_RUNTIME_TRACE_PREFIX/)
})

test('durable capture health diagnostics read spool state without mutating it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-trace-health-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const adapter = new LiveCaptureAdapter({
    accountId: 'account-a', spoolPath: directory,
    clock: () => new Date('2026-07-30T00:00:00.000Z'),
  })
  const captured = adapter.capturePhysicalFrame({
    raw: JSON.stringify({ message: { id: 'd301ffffffff000002', text: 'diagnostic fixture' } }),
    metadata: { opcode: 128, sourceOrigin: 'test', providerEventId: 'd301ffffffff000002' },
  })
  assert.equal(captured.captured, true)
  const first = adapter.getCaptureHealth()
  const second = adapter.getCaptureHealth()
  assert.deepEqual(second, first)
  assert.equal(second.adapterState, 'healthy')
  assert.equal(second.spoolPendingCount, 1)
  assert.equal(adapter.spool.readPending(10).length, 1)
})
