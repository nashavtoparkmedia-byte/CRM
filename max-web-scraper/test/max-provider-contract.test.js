'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { MessageSync } = require('../sync/MessageSync')
const { MessageParser } = require('../parser/MessageParser')
const { TransportInterceptor, OP } = require('../transport/TransportInterceptor')
const { buildMaxTextMessage } = require('../pipeline/MessageEnvelope')

const maxEvents = require('../../gravity-mvp/src/lib/__tests__/fixtures/provider-contracts/max-events.json')
const replyFixture = require('../forensics/fixtures/reply.json')
const imageFixture = require('../forensics/fixtures/image-caption.json')

function tempDedupPath() {
  return path.join(
    os.tmpdir(),
    `max-provider-contract-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  )
}

test('MAX repeated inbound text is keyed by provider ID and replay is deduplicated', () => {
  const dedupPath = tempDedupPath()
  const sync = new MessageSync({ dedupPath })
  try {
    const [first, second] = maxEvents.repeatedInbound.map(message =>
      MessageParser.normalizeHistoryMessage({ ...message, chatId: maxEvents.chatId }),
    )
    first.chatId = maxEvents.chatId
    second.chatId = maxEvents.chatId

    assert.equal(sync.isDuplicate(first), false)
    sync.markSeen(first)
    assert.equal(sync.isDuplicate(second), false)
    sync.markSeen(second)
    assert.equal(sync.isDuplicate(first), true)

    const afterReconnect = new MessageSync({ dedupPath })
    assert.equal(afterReconnect.isDuplicate(first), true)
    assert.equal(afterReconnect.isDuplicate(second), true)
  } finally {
    try { fs.unlinkSync(dedupPath) } catch {}
  }
})

test('MAX text without provider ID is never content-deduplicated', () => {
  const dedupPath = tempDedupPath()
  const sync = new MessageSync({ dedupPath })
  try {
    const event = {
      id: null,
      chatId: maxEvents.chatId,
      text: 'Legacy without provider ID',
      timestamp: 1784383200000,
    }
    sync.markSeen(event)
    assert.equal(sync.isDuplicate({ ...event }), false)
    assert.equal(sync.isDuplicate({ ...event, timestamp: 1784383260000 }), false)
  } finally {
    try { fs.unlinkSync(dedupPath) } catch {}
  }
})

test('MAX catch-up fetch normalizes two equal texts with different IDs', async () => {
  const sync = new MessageSync({ dedupPath: tempDedupPath() })
  const calls = []
  const transport = {
    async sendFrame(opcode, payload, options) {
      calls.push({ opcode, payload, options })
      return { messages: maxEvents.repeatedInbound }
    },
  }

  const messages = await sync.fetchMissedForChat(
    transport,
    Number(maxEvents.chatId),
    1784383199000,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].opcode, OP.GET_HISTORY)
  assert.equal(calls[0].options.waitResponse, true)
  assert.deepEqual(messages.map(message => message.id), ['d301aa01', 'd301aa02'])
})

test('MAX media, captions, files, and replies stay in structured fields', () => {
  const transport = new TransportInterceptor()

  const image = transport._normalizeMaxMsg(imageFixture)
  assert.equal(image.text, 'Подпись к изображению')
  assert.equal(image.type, 'image')
  assert.equal(image.attachments.length, 1)
  assert.equal(image.text.includes('attaches'), false)

  const imageWithoutCaption = transport._normalizeMaxMsg({
    ...imageFixture,
    message: { ...imageFixture.message, id: 'd301-image-only', text: '' },
  })
  assert.equal(imageWithoutCaption.text, '')
  assert.equal(imageWithoutCaption.type, 'image')
  assert.equal(imageWithoutCaption.attachments.length, 1)

  const file = transport._normalizeMaxMsg({
    chatId: maxEvents.chatId,
    message: maxEvents.file,
  })
  assert.equal(file.text, 'Договор')
  assert.equal(file.type, 'document')
  assert.deepEqual(file.attachments[0], {
    type: 'file',
    url: null,
    name: 'contract.pdf',
    size: 2048,
    mimeType: null,
    previewData: null,
    thumbnail: null,
    duration: null,
    photoId: null,
    videoId: null,
    fileId: 'fixture-file-id',
    token: 'fixture-token',
  })

  const reply = transport._normalizeMaxMsg(replyFixture)
  assert.equal(reply.text, 'Ответ без служебных полей в тексте')
  assert.equal(reply.replyToMessageId, 'd30101')
  assert.equal(reply.text.includes('prevM'), false)
})

test('MAX repeated outbound text and replies each build one provider message', () => {
  const first = buildMaxTextMessage('Одинаковый текст', null, -101)
  const second = buildMaxTextMessage('Одинаковый текст', null, -102)
  const reply = buildMaxTextMessage('Ответ', 'd301-original', -103)

  assert.equal(first.text, 'Одинаковый текст')
  assert.equal(second.text, 'Одинаковый текст')
  assert.notEqual(first.cid, second.cid)
  assert.equal(reply.text, 'Ответ')
  assert.equal(reply.link.messageId, 'd301-original')
  assert.equal(JSON.stringify(reply).includes('prevM'), false)
})
