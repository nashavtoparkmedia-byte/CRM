'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const {
  createMaxProviderProfileEvidence,
  isBoundMaxPhoneEvidence,
  uiRouteIdForProtocolChat,
} = require('../contacts/MaxPhoneEvidence')
const {
  createReactionEventDeduper,
  reactionSnapshotEvent,
  reactionSnapshotMessageId,
} = require('../lib/MaxReactionEvents')
const {
  extractDomAttachmentFileName,
  preferredDomImageName,
} = require('../lib/MaxDomAttachments')
const { maxReplyTargetId } = require('../transport/TransportInterceptor')

test('trusted MAX phone evidence is bound to provider identity and exact UI route', () => {
  const evidence = createMaxProviderProfileEvidence({
    providerIdentityId: '902264026154',
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
    observedAt: '2026-07-24T15:47:30.000Z',
  })

  assert.equal(uiRouteIdForProtocolChat('902454841098'), '511708938')
  assert.deepEqual(evidence, {
    sourceKind: 'provider_profile',
    trustedForAutomaticResolution: true,
    observedAt: '2026-07-24T15:47:30.000Z',
    providerIdentityId: '902264026154',
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
  })
  assert.equal(isBoundMaxPhoneEvidence(evidence), true)
})

test('MAX phone evidence rejects a mismatched or unbound route', () => {
  assert.equal(createMaxProviderProfileEvidence({
    providerIdentityId: '902264026154',
    protocolChatId: '902454841098',
    uiRouteId: '902454841098',
  }), null)
  assert.equal(isBoundMaxPhoneEvidence({
    sourceKind: 'provider_profile',
    trustedForAutomaticResolution: true,
  }), false)
})

test('real opcode 155 fixture takes provider message id from the complex map key', () => {
  const payload = {
    1: 'messageId',
    chatId: 902454841098,
    counters: [{ reaction: '👍', totalCount: 1 }],
    __complexEntries: [{
      key: { __maxId: true, hex: 'd3019f94d27c7a306f' },
    }],
  }

  assert.equal(reactionSnapshotMessageId(payload), 'd3019f94d27c7a306f')
  assert.deepEqual(reactionSnapshotEvent(payload, value => value), {
    externalMsgId: 'd3019f94d27c7a306f',
    counters: [{ reaction: '👍', count: 1 }],
  })
})

test('ambiguous complex reaction keys are rejected', () => {
  assert.equal(reactionSnapshotMessageId({
    counters: [{ reaction: '👍', count: 1 }],
    __complexEntries: [
      { key: { __maxId: true, hex: 'd3019f94d27c7a306f' } },
      { key: { __maxId: true, hex: 'd3019f94d27c7a3070' } },
    ],
  }), null)
})

test('an empty opcode 155 snapshot keeps its provider id and clears reactions', () => {
  assert.deepEqual(reactionSnapshotEvent({
    chatId: 902454841098,
    counters: [],
    __complexEntries: [{
      key: { __maxId: true, hex: 'd3019f94d27c7a306f' },
    }],
  }, value => value), {
    externalMsgId: 'd3019f94d27c7a306f',
    counters: [],
  })
})

test('reaction echoes are idempotent while add and remove remain distinct events', () => {
  let now = 1000
  const claim = createReactionEventDeduper({ ttlMs: 5000, now: () => now })
  const added = {
    externalMsgId: 'd3019f94d27c7a306f',
    counters: [{ reaction: '👍', count: 1 }],
  }
  const removed = {
    externalMsgId: 'd3019f94d27c7a306f',
    counters: [],
  }

  assert.equal(claim(added), true)
  assert.equal(claim(added), false)
  assert.equal(claim(removed), true)
  assert.equal(claim(removed), false)
  now += 5001
  assert.equal(claim(added), true)
})

test('DOM file fixture reads the filename from the message row, not the icon button', () => {
  const text = 'Документ-2026-06-20-063407.pdf\nPDF\n1.2 МБ'
  assert.equal(extractDomAttachmentFileName(text), 'Документ-2026-06-20-063407.pdf')
})

test('DOM image fixture preserves an original JPEG name when exposed by the image', () => {
  assert.equal(preferredDomImageName({
    alt: '1782637424_ac795bb3420d5e66f06408cc1e9250ac_1782637424.jpeg',
    url: 'blob:https://web.max.ru/fixture',
  }), '1782637424_ac795bb3420d5e66f06408cc1e9250ac_1782637424.jpeg')
})

test('inbound reply target accepts the real MAX id from a structured link', () => {
  assert.equal(maxReplyTargetId({
    type: 'REPLY',
    messageId: { __maxId: true, hex: 'd3019f94c8d5d852f0' },
  }), 'd3019f94c8d5d852f0')
})

test('inbound reply preserves a direct structured id from legacy sanitized events', () => {
  assert.equal(maxReplyTargetId({
    type: 'REPLY',
    messageId: 'd30101',
  }), 'd30101')
  assert.equal(maxReplyTargetId({
    type: 'REPLY',
    messageId: 'd30101',
    replyToMessageId: 'd30102',
  }), null)
})

test('inbound reply target accepts a single complex MAX id only with a reply marker', () => {
  const complex = {
    __complexEntries: [{
      key: {
        REPLY: { __maxId: true, hex: 'd3019f94c8d5d852f0' },
      },
    }],
  }
  assert.equal(maxReplyTargetId(complex), 'd3019f94c8d5d852f0')
  assert.equal(maxReplyTargetId({
    __complexEntries: [{ key: { __maxId: true, hex: 'd3019f94c8d5d852f0' } }],
  }), null)
})

test('outbound reaction confirmation uses the complex-key provider id parser', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  assert.match(
    source,
    /data\.opcode === 155 && matches\(reactionSnapshotMessageId\(payload\)\)/,
  )
})
