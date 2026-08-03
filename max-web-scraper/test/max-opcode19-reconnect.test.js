'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  OPCODE19_MAX_SNAPSHOT_BYTES,
  bindOpcode19ReconnectMessage,
  decodeOpcode19ReconnectPayload,
} = require('../transport/Opcode19ReconnectDecoder')
const { Opcode19DeliverySpool } = require('../inbound/Opcode19DeliverySpool')
const { OP, TransportInterceptor } = require('../transport/TransportInterceptor')

const ACCOUNT_ID = 'personal-max-main'
const OWNER_ID = '902000000001'
const CHAT_ID = '902454841098'
const SENDER_ID = '902264026154'
const WEB_ROUTE_ID = '511708938'
const FIRST_PROVIDER_ID = 'd3019fc8d4774a04bc'
const SECOND_PROVIDER_ID = 'd3019fc8d8ab3a4130'

function uint64(value) {
  const output = Buffer.alloc(8)
  output.writeBigUInt64BE(BigInt(value))
  return output
}

function msgpackString(value) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= 31) return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes])
  if (bytes.length <= 255) return Buffer.concat([Buffer.from([0xd9, bytes.length]), bytes])
  if (bytes.length <= 0xffff) {
    const header = Buffer.alloc(3)
    header[0] = 0xda
    header.writeUInt16BE(bytes.length, 1)
    return Buffer.concat([header, bytes])
  }
  const header = Buffer.alloc(5)
  header[0] = 0xdb
  header.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([header, bytes])
}

function reconnectCarrier({
  providerMessageId = FIRST_PROVIDER_ID,
  text = 'ывапро',
  senderId = SENDER_ID,
  chatId = CHAT_ID,
  suffixNoise = true,
} = {}) {
  const message = Buffer.concat([
    msgpackString('lastMessage'),
    Buffer.from([0xde, 0x00, 0x06]),
    msgpackString('id'),
    Buffer.from([0xc7, 0x09, 0x01]),
    Buffer.from(providerMessageId, 'hex'),
    msgpackString('type'),
    msgpackString('USER'),
    msgpackString('sender'),
    Buffer.from([0xcf]),
    uint64(senderId),
    msgpackString('text'),
    msgpackString(text),
    msgpackString('attaches'),
    Buffer.from([0x90]),
    msgpackString('route'),
    Buffer.from([0xcf]),
    uint64(chatId),
    msgpackString('prevMessageId'),
    Buffer.from([0xc0]),
  ])
  if (!suffixNoise) return message
  // The real 8 KiB carrier may contain these markers elsewhere. Decoder
  // uniqueness is intentionally scoped to the exact map16 lastMessage value.
  return Buffer.concat([
    message,
    Buffer.alloc(256, 0),
    msgpackString('USER'),
    msgpackString('text'),
  ])
}

function reconnectPayload(options = {}) {
  const payload = Array(15).fill(null)
  const index = options.index ?? 7
  const carrier = options.carrier || reconnectCarrier(options)
  payload[index] = options.carrierValue || carrier.toString('hex')
  return payload
}

function exactBindingContext(overrides = {}) {
  const binding = {
    accountId: ACCOUNT_ID,
    ownerProviderUserId: OWNER_ID,
    protocolChatId: CHAT_ID,
    senderProviderUserId: SENDER_ID,
    webRouteId: WEB_ROUTE_ID,
    routeOwnerAccountId: ACCOUNT_ID,
    fencingToken: 'fence-42',
    ...overrides.binding,
  }
  return {
    accountId: ACCOUNT_ID,
    ownerProviderUserId: OWNER_ID,
    bindings: [binding],
    ...overrides.context,
  }
}

function encodeOuterPayload(payload) {
  const values = [Buffer.from([0x9f])]
  for (const item of payload) {
    if (item === null) values.push(Buffer.from([0xc0]))
    else if (typeof item === 'string') values.push(msgpackString(item))
    else throw new Error('test outer payload value is unsupported')
  }
  return Buffer.concat(values)
}

function binaryAuthFrame(payload, frameSequence = 1) {
  return Buffer.concat([
    Buffer.from([0x0a, 0x01, 0x00, frameSequence >> 8, frameSequence & 0xff, OP.AUTH, 0x01, 0x00, 0x00]),
    encodeOuterPayload(payload),
  ])
}

function temporarySpool(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmax-op19-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'spool')
  return { directory, spool: new Opcode19DeliverySpool(directory) }
}

function configuredTransport(t, options = {}) {
  const capture = options.capture || {
    records: [],
    capturePhysicalFrame(record) { this.records.push(record) },
    getCaptureHealth() { return { enabled: true } },
    close() {},
  }
  const transport = new TransportInterceptor(capture)
  const { directory, spool } = temporarySpool(t)
  transport.setOpcode19DeliverySpool(spool)
  transport.setOpcode19ReconnectBindingResolver(() => exactBindingContext())
  if (options.authenticated !== false) transport._myUserId = OWNER_ID
  return { capture, directory, spool, transport }
}

function durableAck(message, overrides = {}) {
  return {
    durable: true,
    messageId: `crm-${message.id}`,
    chatInternalId: 'crm-chat-1',
    providerMessageId: message.id,
    chatId: message.chatId,
    ...overrides,
  }
}

test('decodes the proven seq 68978 Unicode shape inside one exact lastMessage map', () => {
  const decoded = decodeOpcode19ReconnectPayload(reconnectPayload())
  assert.equal(decoded.ok, true)
  assert.equal(decoded.candidate.providerMessageId, FIRST_PROVIDER_ID)
  assert.equal(decoded.candidate.text, 'ывапро')
  assert.equal(decoded.candidate.senderProviderUserId, SENDER_ID)
  assert.equal(decoded.candidate.protocolChatId, CHAT_ID)
  assert.equal(decoded.candidate.senderLow32, '320893994')
  assert.equal(decoded.candidate.webRouteLow32, WEB_ROUTE_ID)
  assert.equal(decoded.candidate.rawSnapshotEvidence.carrierIndex, 7)
  assert.match(decoded.candidate.rawSnapshotEvidence.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number.isFinite(decoded.candidate.providerTimestampMs))
})

test('decodes the proven seq 69360 carrier at outer index zero and Buffer JSON replay form', () => {
  const carrier = reconnectCarrier({ providerMessageId: SECOND_PROVIDER_ID, text: 'у' })
  const payload = reconnectPayload({
    index: 0,
    carrier,
    carrierValue: { type: 'Buffer', data: [...carrier] },
  })
  const decoded = decodeOpcode19ReconnectPayload(payload)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.candidate.providerMessageId, SECOND_PROVIDER_ID)
  assert.equal(decoded.candidate.text, 'у')
  assert.equal(decoded.candidate.rawSnapshotEvidence.carrierEncoding, 'buffer_json')
})

test('fails closed for outer ambiguity, malformed, truncated and oversized snapshots', () => {
  const ambiguous = reconnectPayload()
  ambiguous[2] = 'abcd'
  assert.equal(decodeOpcode19ReconnectPayload(ambiguous).reason, 'carrier_count_mismatch')
  assert.equal(decodeOpcode19ReconnectPayload(Array(14).fill(null)).reason, 'outer_shape_mismatch')

  const complete = reconnectCarrier({ suffixNoise: false })
  const prevOffset = complete.indexOf(Buffer.from('ad70726576', 'hex'))
  const truncated = complete.subarray(0, prevOffset + 3)
  assert.equal(decodeOpcode19ReconnectPayload(reconnectPayload({ carrier: truncated })).ok, false)

  const oversized = Array(15).fill(null)
  oversized[0] = Buffer.alloc(OPCODE19_MAX_SNAPSHOT_BYTES + 1).toString('hex')
  assert.equal(decodeOpcode19ReconnectPayload(oversized).reason, 'snapshot_oversized')
})

test('fails closed for invalid UTF-8 and non-empty attachment shapes', () => {
  const invalidUtf8 = reconnectCarrier({ text: 'x', suffixNoise: false })
  const textKey = invalidUtf8.indexOf(Buffer.from('a474657874', 'hex'))
  invalidUtf8[textKey + 6] = 0xff
  assert.equal(decodeOpcode19ReconnectPayload(reconnectPayload({ carrier: invalidUtf8 })).reason, 'text_invalid_utf8')

  const attached = reconnectCarrier({ suffixNoise: false })
  const attaches = attached.indexOf(Buffer.from('a8617474616368657390', 'hex'))
  attached[attaches + 9] = 0x91
  assert.equal(decodeOpcode19ReconnectPayload(reconnectPayload({ carrier: attached })).ok, false)

  const wrongSenderField = reconnectCarrier({ suffixNoise: false })
  const senderField = wrongSenderField.indexOf(Buffer.from('a673656e646572cf', 'hex'))
  wrongSenderField[senderField + 1] = 0x74
  assert.equal(
    decodeOpcode19ReconnectPayload(reconnectPayload({ carrier: wrongSenderField })).reason,
    'sender_field_mismatch',
  )

  const wrongRouteField = reconnectCarrier({ suffixNoise: false })
  const routeField = wrongRouteField.indexOf(Buffer.from('a5726f757465cf', 'hex'))
  wrongRouteField[routeField + 1] = 0x74
  assert.equal(
    decodeOpcode19ReconnectPayload(reconnectPayload({ carrier: wrongRouteField })).reason,
    'route_field_mismatch',
  )
})

test('binds only one exact account, owner, route and sender identity', () => {
  const decoded = decodeOpcode19ReconnectPayload(reconnectPayload())
  const bound = bindOpcode19ReconnectMessage(decoded, exactBindingContext())
  assert.equal(bound.ok, true)
  assert.equal(bound.messageEnvelope.chatId, CHAT_ID)
  assert.equal(bound.messageEnvelope.message.sender, SENDER_ID)
  assert.equal(bound.messageEnvelope.message.text, 'ывапро')

  const ambiguous = exactBindingContext()
  ambiguous.bindings.push({ ...ambiguous.bindings[0], fencingToken: 'fence-43' })
  assert.equal(bindOpcode19ReconnectMessage(decoded, ambiguous).reason, 'binding_match_count_mismatch')
  assert.equal(bindOpcode19ReconnectMessage(decoded, exactBindingContext({
    binding: { routeOwnerAccountId: 'another-account' },
  })).reason, 'binding_match_count_mismatch')
  assert.equal(bindOpcode19ReconnectMessage(decoded, exactBindingContext({
    context: { ownerProviderUserId: '902000000002' },
  })).reason, 'binding_match_count_mismatch')
  assert.equal(bindOpcode19ReconnectMessage(decoded, exactBindingContext({
    binding: { senderProviderUserId: '902264026155' },
  })).reason, 'binding_match_count_mismatch')
  assert.equal(bindOpcode19ReconnectMessage(decoded, exactBindingContext({
    binding: { protocolChatId: '902454841099' },
  })).reason, 'binding_match_count_mismatch')
})

test('durable spool is 0700/0600, collision-fenced and deletes only exact acknowledgement', t => {
  const { directory, spool } = temporarySpool(t)
  const decoded = decodeOpcode19ReconnectPayload(reconnectPayload())
  const record = {
    schemaVersion: 1,
    providerMessageId: decoded.candidate.providerMessageId,
    source: 'opcode19_reconnect_snapshot',
    candidate: decoded.candidate,
  }
  const stored = spool.put(record)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(stored.path).mode & 0o777, 0o600)
  assert.equal(spool.list().length, 1)
  assert.throws(
    () => spool.acknowledge(record.providerMessageId, '0'.repeat(64)),
    error => error.code === 'OPCODE19_SPOOL_ACK_MISMATCH',
  )
  assert.equal(spool.list().length, 1)

  assert.throws(
    () => spool.put({ ...record, candidate: { ...record.candidate, text: 'other text' } }),
    error => error.code === 'OPCODE19_PROVIDER_ID_COLLISION',
  )
  spool.acknowledge(record.providerMessageId, stored.contentHash)
  assert.deepEqual(spool.getHealth(), { pending: 0, state: 'empty' })
})

test('spool fsync precedes synchronous CRM handler and exact durable ACK removes it', async t => {
  const { capture, directory, spool, transport } = configuredTransport(t)
  const messages = []
  transport.onMessage(message => {
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.json'))
    assert.equal(files.length, 1, 'spool record must exist before CRM delivery starts')
    if (messages.length === 0) {
      assert.equal(transport._emittedMsgIds.has(`id:${message.id}`), false)
    }
    assert.deepEqual(message.opcode19Binding, exactBindingContext().bindings[0])
    messages.push(message)
    return durableAck(message)
  })

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload()))
  assert.equal(messages.length, 1, 'handler invocation remains synchronous')
  assert.deepEqual(await transport.waitForOpcode19Deliveries(), { settled: true, pending: 0 })
  assert.equal(spool.list().length, 0)
  const captured = JSON.parse(capture.records.at(-1).raw)
  assert.equal(captured.kind, 'message')
  assert.equal(captured.direction, 'inbound')
  assert.equal(captured.providerMessageId, FIRST_PROVIDER_ID)
  assert.equal(captured.senderProviderUserId, SENDER_ID)
  assert.equal(captured.protocolChatId, CHAT_ID)
  assert.equal(captured.webRouteId, WEB_ROUTE_ID)
  assert.equal(captured.text, 'ывапро')
  assert.deepEqual(captured.attachments, [])
  assert.match(captured.providerOccurredAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(captured.routeEvidence, [
    { identityKind: 'provider_user_id', identityValue: SENDER_ID },
    { identityKind: 'protocol_chat_id', identityValue: CHAT_ID },
    { identityKind: 'web_route_id', identityValue: WEB_ROUTE_ID },
  ])
  assert.match(captured.opcode19ReconnectSnapshot.sha256, /^[0-9a-f]{64}$/)

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload(), 2))
  await transport.waitForOpcode19Deliveries()
  assert.equal(messages.length, 2, 'CRM provider-ID idempotency remains the durable authority')
  assert.equal(spool.list().length, 0)
})

test('a completed delivery never reuses a stale ACK for the same provider ID with changed identity', async t => {
  const { spool, transport } = configuredTransport(t)
  let calls = 0
  transport.onMessage(message => {
    calls += 1
    if (calls === 1) return durableAck(message)
    throw Object.assign(new Error('CRM rejected changed provider identity'), {
      code: 'MAX_PROVIDER_IDENTITY_CONFLICT',
    })
  })

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload(), 1))
  await transport.waitForOpcode19Deliveries()
  assert.equal(spool.list().length, 0)

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload({ text: 'changed identity' }), 2))
  await transport.waitForOpcode19Deliveries()
  assert.equal(calls, 2, 'the second content identity must reach the CRM authority')
  assert.equal(spool.list().length, 1, 'the rejected changed identity remains retryable')
})

test('non-durable, rejected and identity-mismatched acknowledgements remain retryable', async t => {
  const { spool, transport } = configuredTransport(t)
  let mode = 'non-durable'
  transport.onMessage(message => {
    if (mode === 'non-durable') return { durable: false }
    if (mode === 'reject') return Promise.reject(Object.assign(new Error('CRM unavailable'), { code: 'CRM_DOWN' }))
    if (mode === 'wrong-id') return durableAck(message, { providerMessageId: SECOND_PROVIDER_ID })
    return durableAck(message)
  })

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload()))
  await transport.waitForOpcode19Deliveries()
  assert.equal(spool.list().length, 1)
  assert.equal(transport._emittedMsgIds.has(`id:${FIRST_PROVIDER_ID}`), false)

  for (const failureMode of ['reject', 'wrong-id']) {
    mode = failureMode
    const result = await transport.drainOpcode19DeliverySpool()
    assert.equal(result.acknowledged, 0)
    assert.equal(spool.list().length, 1)
  }
  mode = 'success'
  const result = await transport.drainOpcode19DeliverySpool()
  assert.equal(result.acknowledged, 1)
  assert.equal(spool.list().length, 0)
})

test('restart after a lost CRM acknowledgement drains the retained provider ID without a duplicate Message', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-op19-restart-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'spool')
  const durableMessageIds = new Set()

  const firstProcess = new TransportInterceptor()
  const firstSpool = new Opcode19DeliverySpool(directory)
  firstProcess.setOpcode19DeliverySpool(firstSpool)
  firstProcess.setOpcode19ReconnectBindingResolver(() => exactBindingContext())
  firstProcess._myUserId = OWNER_ID
  firstProcess.onMessage(message => {
    durableMessageIds.add(message.id)
    throw Object.assign(new Error('CRM committed but acknowledgement was lost'), {
      code: 'ACK_LOST_AFTER_COMMIT',
    })
  })

  firstProcess._handleBinaryFrame(binaryAuthFrame(reconnectPayload()))
  await firstProcess.waitForOpcode19Deliveries()
  assert.equal(durableMessageIds.size, 1)
  assert.equal(firstSpool.list().length, 1)

  const restartedProcess = new TransportInterceptor()
  const restartedSpool = new Opcode19DeliverySpool(directory)
  restartedProcess.setOpcode19DeliverySpool(restartedSpool)
  restartedProcess.setOpcode19ReconnectBindingResolver(() => exactBindingContext())
  restartedProcess._myUserId = OWNER_ID
  let replayAttempts = 0
  restartedProcess.onMessage(message => {
    replayAttempts += 1
    const deduped = durableMessageIds.has(message.id)
    durableMessageIds.add(message.id)
    return durableAck(message, { deduped })
  })

  const firstDrain = await restartedProcess.drainOpcode19DeliverySpool()
  const secondDrain = await restartedProcess.drainOpcode19DeliverySpool()
  assert.deepEqual(firstDrain, {
    attempted: 1,
    acknowledged: 1,
    retained: 0,
    stoppedReason: null,
  })
  assert.deepEqual(secondDrain, {
    attempted: 0,
    acknowledged: 0,
    retained: 0,
    stoppedReason: null,
  })
  assert.equal(replayAttempts, 1)
  assert.equal(durableMessageIds.size, 1)
  assert.equal(restartedSpool.list().length, 0)
})

test('a blocked route does not prevent a different conversation spool lane from draining', async t => {
  const secondChatId = '902454841099'
  const secondSenderId = '902264026155'
  const secondRouteId = '511708939'
  const { spool } = temporarySpool(t)
  const first = decodeOpcode19ReconnectPayload(reconnectPayload())
  const second = decodeOpcode19ReconnectPayload(reconnectPayload({
    providerMessageId: SECOND_PROVIDER_ID,
    text: 'другой чат',
    senderId: secondSenderId,
    chatId: secondChatId,
  }))
  for (const decoded of [first, second]) {
    spool.put({
      schemaVersion: 1,
      providerMessageId: decoded.candidate.providerMessageId,
      source: 'opcode19_reconnect_snapshot',
      candidate: decoded.candidate,
    })
  }

  const transport = new TransportInterceptor()
  transport.setOpcode19DeliverySpool(spool)
  transport._myUserId = OWNER_ID
  transport.setOpcode19ReconnectBindingResolver(candidate => {
    if (candidate.protocolChatId === CHAT_ID) {
      return { accountId: ACCOUNT_ID, ownerProviderUserId: OWNER_ID, bindings: [] }
    }
    return exactBindingContext({
      binding: {
        protocolChatId: secondChatId,
        senderProviderUserId: secondSenderId,
        webRouteId: secondRouteId,
      },
    })
  })
  const delivered = []
  transport.onMessage(message => {
    delivered.push(message.id)
    return durableAck(message)
  })

  const result = await transport.drainOpcode19DeliverySpool()
  assert.deepEqual(result, {
    attempted: 2,
    acknowledged: 1,
    retained: 1,
    stoppedReason: 'binding_match_count_mismatch',
  })
  assert.deepEqual(delivered, [SECOND_PROVIDER_ID])
  assert.deepEqual(spool.list().map(entry => entry.providerMessageId), [FIRST_PROVIDER_ID])
})

test('cold start persists decoded candidate but performs no CRM action until exact owner and route exist', async t => {
  const { capture, spool, transport } = configuredTransport(t, { authenticated: false })
  transport.setOpcode19ReconnectBindingResolver(() => ({
    accountId: ACCOUNT_ID,
    ownerProviderUserId: OWNER_ID,
    bindings: [],
  }))
  let deliveries = 0
  transport.onMessage(message => {
    deliveries += 1
    return durableAck(message)
  })

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload()))
  await transport.waitForOpcode19Deliveries()
  assert.equal(deliveries, 0)
  assert.equal(spool.list().length, 1)
  assert.deepEqual(transport.getOpcode19DeliveryHealth(), { pending: 1, state: 'retained' })
  assert.equal(JSON.parse(capture.records.at(-1).raw).kind, 'opcode19_reconnect_candidate')

  transport._myUserId = OWNER_ID
  transport.setOpcode19ReconnectBindingResolver(() => exactBindingContext())
  const result = await transport.drainOpcode19DeliverySpool()
  assert.equal(result.acknowledged, 1)
  assert.equal(deliveries, 1)
  assert.equal(spool.list().length, 0)
})

test('old authenticated owner mismatch never journals a bound message or invokes CRM', async t => {
  const { capture, spool, transport } = configuredTransport(t)
  transport._myUserId = '902000000099'
  let deliveries = 0
  transport.onMessage(message => {
    deliveries += 1
    return durableAck(message)
  })
  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload()))
  await transport.waitForOpcode19Deliveries()
  assert.equal(deliveries, 0)
  assert.equal(spool.list().length, 1)
  assert.equal(JSON.parse(capture.records.at(-1).raw).kind, 'opcode19_reconnect_candidate')
})

test('an owner proven on an older socket generation cannot bind the reconnect journal or CRM delivery', async t => {
  const { capture, spool, transport } = configuredTransport(t)
  transport._captureSocketGeneration = 2
  transport._authenticatedOwnerSocketGeneration = 1
  let deliveries = 0
  transport.onMessage(message => {
    deliveries += 1
    return durableAck(message)
  })

  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload()))
  await transport.waitForOpcode19Deliveries()
  assert.equal(deliveries, 0)
  assert.equal(spool.list().length, 1)
  assert.equal(JSON.parse(capture.records.at(-1).raw).kind, 'opcode19_reconnect_candidate')

  transport._authenticatedOwnerSocketGeneration = 2
  const drained = await transport.drainOpcode19DeliverySpool()
  assert.equal(drained.acknowledged, 1)
  assert.equal(deliveries, 1)
  assert.equal(spool.list().length, 0)
})

test('identical text with distinct provider IDs remains two durable messages', async t => {
  const { transport } = configuredTransport(t)
  const ids = []
  transport.onMessage(message => {
    ids.push(message.id)
    return durableAck(message)
  })
  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload({ text: 'у' }), 1))
  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload({ providerMessageId: SECOND_PROVIDER_ID, text: 'у' }), 2))
  await transport.waitForOpcode19Deliveries()
  assert.deepEqual(ids, [FIRST_PROVIDER_ID, SECOND_PROVIDER_ID])
})

test('mixed opcode128/19 burst keeps й → ц → у → у → у → к with the first у only in opcode19', async t => {
  const { transport } = configuredTransport(t)
  const delivered = []
  let lane = Promise.resolve()
  transport.onMessage(message => {
    const operation = lane.then(() => {
      delivered.push({ text: message.text, id: message.id, source: message.source || 'opcode128' })
      return durableAck(message)
    })
    lane = operation.then(() => undefined, () => undefined)
    return operation
  })
  const op128 = (id, text, sequence) => transport._processDecodedFrame({
    opcode: OP.INCOMING_MSG,
    cmd: 0,
    seq: sequence,
    payload: {
      chatId: CHAT_ID,
      message: { id, sender: SENDER_ID, text, time: 1_785_783_000_000 + sequence, attaches: [] },
    },
  })

  op128('d3019fc8d4774a04b1', 'й', 1)
  op128('d3019fc8d4774a04b2', 'ц', 2)
  transport._handleBinaryFrame(binaryAuthFrame(reconnectPayload({
    providerMessageId: FIRST_PROVIDER_ID,
    text: 'у',
  }), 3))
  op128('d3019fc8d4774a04bd', 'у', 4)
  op128('d3019fc8d4774a04be', 'у', 5)
  op128('d3019fc8d4774a04bf', 'к', 6)

  await transport.waitForOpcode19Deliveries()
  await lane
  assert.deepEqual(delivered.map(item => item.text), ['й', 'ц', 'у', 'у', 'у', 'к'])
  assert.equal(new Set(delivered.map(item => item.id)).size, 6)
  assert.equal(delivered.filter(item => item.source === 'reconnect_snapshot').length, 1)
  assert.equal(delivered[2].source, 'reconnect_snapshot')
})

test('concurrent replay of one provider ID shares one in-flight durable action', async t => {
  const { transport } = configuredTransport(t)
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  transport.onMessage(async message => {
    calls += 1
    await gate
    return durableAck(message)
  })
  const decoded = decodeOpcode19ReconnectPayload(reconnectPayload())
  const bound = bindOpcode19ReconnectMessage(decoded, exactBindingContext())
  const message = transport._normalizedOpcode19Message(bound)
  const first = transport._deliverOpcode19ReconnectMessage(message, bound)
  const second = transport._deliverOpcode19ReconnectMessage(message, bound)
  assert.equal(calls, 1)
  release()
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('normal opcode 128 message and opcode 180 raw behavior remain unchanged', async () => {
  const transport = new TransportInterceptor()
  transport._myUserId = OWNER_ID
  const messages = []
  const raw = []
  transport.onMessage(message => { messages.push(message) })
  transport.onRawFrame(frame => raw.push(frame.opcode))

  transport._processDecodedFrame({
    opcode: OP.INCOMING_MSG,
    cmd: 0,
    seq: 1,
    payload: {
      chatId: CHAT_ID,
      message: {
        id: SECOND_PROVIDER_ID,
        sender: SENDER_ID,
        text: 'к',
        time: Date.now(),
        attaches: [],
      },
    },
  })
  transport._processDecodedFrame({ opcode: OP.MARK_READ, cmd: 0, seq: 2, payload: { chatId: CHAT_ID } })
  await Promise.resolve()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, 'к')
  assert.deepEqual(raw, [OP.INCOMING_MSG, OP.MARK_READ])
})
