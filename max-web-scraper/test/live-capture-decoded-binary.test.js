'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { encode } = require('@msgpack/msgpack')
const { LiveCaptureAdapter } = require('../capture/LiveCaptureAdapter')
const { TransportInterceptor } = require('../transport/TransportInterceptor')

function frame(payload, { opcode = 128, frame = 17, sequence = 23 } = {}) {
  return Buffer.concat([
    Buffer.from([0x0a, 0x01, 0x00, frame >> 8, frame & 0xff, opcode, 0x01, sequence >> 8, sequence & 0xff]),
    Buffer.from(encode(payload)),
  ])
}

test('captures one replayable decoded payload for each successfully decoded binary physical frame', () => {
  const captured = []
  const adapter = {
    capturePhysicalFrame(value) { captured.push(value) },
    getCaptureHealth() { return { enabled: true } },
    close() {},
  }
  const transport = new TransportInterceptor(adapter)
  const payload = {
    chatId: 'protocol-chat-exact',
    message: { id: 'provider-message-exact', sender: 'provider-user-exact', text: 'same text' },
  }
  const binary = frame(payload)

  transport._handleFrame(`b64:${binary.toString('base64')}`)

  assert.equal(captured.length, 1)
  assert.deepEqual(JSON.parse(captured[0].raw), payload)
  assert.equal(captured[0].metadata.opcode, 128)
  assert.equal(captured[0].metadata.frameId, '17')
  assert.equal(captured[0].metadata.transportSequence, '23')
  assert.equal(captured[0].metadata.providerEventId, 'provider-message-exact')
  assert.equal(captured[0].metadata.eventType, 'message')
})

test('keeps opaque binary as a quarantinable physical observation when the frame is malformed', () => {
  const captured = []
  const adapter = {
    capturePhysicalFrame(value) { captured.push(value) },
    getCaptureHealth() { return { enabled: true } },
    close() {},
  }
  const transport = new TransportInterceptor(adapter)
  const binary = Buffer.from([0xff, 0x01, 0x00, 0, 3, 128, 1, 0, 4])

  transport._handleFrame(`b64:${binary.toString('base64')}`)

  assert.equal(captured.length, 1)
  assert.match(captured[0].raw, /^b64:/)
  assert.equal(captured[0].metadata.frameId, '3')
  assert.equal(captured[0].metadata.transportSequence, '4')
})

test('decoded binary message becomes a replayable durable capture envelope', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decoded-capture-'))
  try {
    const adapter = new LiveCaptureAdapter({ accountId: 'account-exact', spoolPath: directory })
    const transport = new TransportInterceptor(adapter)
    const payload = {
      chatId: 'protocol-chat-exact',
      message: { id: 'provider-message-exact', sender: 'provider-user-exact', text: 'same text' },
    }

    transport._handleFrame(`b64:${frame(payload).toString('base64')}`)

    const pending = adapter.spool.readPending(10)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].envelope.replayAvailability, 'available')
    assert.equal(pending[0].envelope.payloadEncoding, 'json')
    assert.deepEqual(pending[0].envelope.sanitizedPayload, payload)
    assert.equal(pending[0].envelope.providerEventId, 'provider-message-exact')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('replaces PostgreSQL-incompatible NUL before the capture envelope reaches the durable spool', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-safe-capture-'))
  try {
    const adapter = new LiveCaptureAdapter({ accountId: 'account-exact', spoolPath: directory })

    adapter.capturePhysicalFrame({
      raw: JSON.stringify({ message: { text: 'before\u0000after' }, '\u0000key': 'safe' }),
      metadata: { opcode: 128, sourceOrigin: 'test' },
    })

    const pending = adapter.spool.readPending(10)
    assert.equal(pending.length, 1)
    assert.equal(JSON.stringify(pending[0].envelope.sanitizedPayload).includes('\\u0000'), false)
    assert.ok(pending[0].envelope.redactionMetadata.categories.includes('postgres_nul_replacement'))
    assert.ok(pending[0].envelope.redactionMetadata.paths.includes('$.message.text'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
