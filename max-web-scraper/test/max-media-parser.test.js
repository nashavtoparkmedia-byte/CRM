'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { TransportInterceptor } = require('../transport/TransportInterceptor')

const oggRootAttaches = require('./fixtures/max-op128-root-ogg.json')
const mp4Loose = require('./fixtures/max-op128-loose-mp4.json')
const looseNoSource = require('./fixtures/max-op128-loose-media-no-source.json')

test('normalizes OGG from root payload.attaches with token 110', () => {
  const transport = new TransportInterceptor()
  const msg = transport._normalizeMaxMsg(oggRootAttaches)

  assert.equal(msg.type, 'audio')
  assert.equal(msg.id, 'd3019f2c1a30712703')
  assert.equal(msg.chatId, 902454841098)
  assert.equal(msg.attachments.length, 1)

  const attachment = msg.attachments[0]
  assert.equal(attachment.type, 'audio')
  assert.equal(attachment.token, 'fixture-ogg-token')
  assert.equal(attachment.fileId, 'fixture-ogg-token')
  assert.equal(attachment.mimeType, 'audio/ogg')
  assert.equal(attachment.name, 'voice-note.ogg')
  assert.equal(attachment.size, 13704527)
  assert.equal(attachment.duration, 4)
})

test('keeps root OGG attaches when loose-media consume runs first', () => {
  const transport = new TransportInterceptor()
  const payload = structuredClone(oggRootAttaches)

  transport._consumeLooseMediaForMessage(payload)
  const msg = transport._normalizeMaxMsg(payload)

  assert.equal(msg.type, 'audio')
  assert.equal(msg.attachments.length, 1)
  assert.equal(msg.attachments[0].type, 'audio')
  assert.equal(msg.attachments[0].fileId, 'fixture-ogg-token')
  assert.equal(msg.attachments[0].token, 'fixture-ogg-token')
  assert.equal(msg.attachments[0].name, 'voice-note.ogg')
})

test('promotes loose MP4 media hints into a resolvable video attachment', () => {
  const transport = new TransportInterceptor()
  const payload = structuredClone(mp4Loose)
  const looseItems = transport._collectLooseMedia(payload.loose)

  transport._pendingLooseMedia.push({ ts: Date.now(), items: looseItems })
  transport._consumeLooseMediaForMessage(payload)
  const msg = transport._normalizeMaxMsg(payload)

  assert.equal(msg.type, 'video')
  assert.equal(msg.attachments.length, 1)

  const attachment = msg.attachments[0]
  assert.equal(attachment.type, 'video')
  assert.equal(attachment.videoId, '17565274016389')
  assert.equal(attachment.token, 'fixture-video-token')
  assert.equal(attachment.mimeType, 'video/mp4')
  assert.equal(attachment.duration, 3000)
  assert.ok(attachment.thumbnail.includes('getImage'))
})

test('does not create an attachment when loose media has no download source', () => {
  const transport = new TransportInterceptor()
  const payload = structuredClone(looseNoSource)
  const looseItems = transport._collectLooseMedia(payload.loose)

  transport._pendingLooseMedia.push({ ts: Date.now(), items: looseItems })
  transport._consumeLooseMediaForMessage(payload)

  assert.equal(payload.message.attaches, undefined)
})
