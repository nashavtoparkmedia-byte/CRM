'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  extractCompactReactionSnapshots,
  extractMaxMessageIdsFromBinaryFrame,
  reactionCapabilityEmojis,
  recoverReactionCatalog,
} = require('../lib/MaxReactionProtocol')

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'max-inbound-reaction-op180.json'),
  'utf8',
))

test('real compact op180 add maps to the exact requested provider message', () => {
  const snapshots = extractCompactReactionSnapshots(fixture.messagesReactions, {
    requestedMessageIds: fixture.requestedMessageIds,
    supportedEmojis: ['👍', '⚡️'],
  })

  assert.deepEqual(
    snapshots.get('d3019f98f1eb2b3fb2'),
    [{ reaction: '👍', count: 1 }],
  )
  assert.equal(snapshots.has('d3019f95cf51d94789'), false)
})

test('exact one-message empty snapshot represents reaction removal', () => {
  const target = 'd3019f98f1eb2b3fb2'
  const fingerprint = [...Buffer.from(target, 'hex').subarray(3, 8)]
  const messagesReactions = {
    84: {
      type: 'Buffer',
      data: [
        ...Buffer.from('counters'),
        0x90,
        ...fingerprint,
      ],
    },
  }

  const snapshots = extractCompactReactionSnapshots(messagesReactions, {
    requestedMessageIds: [target],
    supportedEmojis: ['👍'],
  })

  assert.deepEqual(snapshots.get(target), [])
})

test('binary op180 request correlation retains exact d301 ids', () => {
  const ids = ['d3019f98f1eb2b3fb2', 'd3019f95cf51d94789']
  const parts = [Buffer.alloc(9)]
  for (const id of ids) {
    const raw = Buffer.from(id, 'hex')
    raw[0] = 0xcf
    parts.push(Buffer.from([0xc7, 0x09, 0x01]), raw)
  }

  assert.deepEqual(extractMaxMessageIdsFromBinaryFrame(Buffer.concat(parts)), ids)
})

test('provider catalog recovery handles compact primitive id/emoji pairs', () => {
  const catalog = recoverReactionCatalog([
    { id: 1, emoji: '👍' },
    117,
    '⚡️',
    { nested: [215, '❤️'] },
  ])

  assert.deepEqual(catalog, [
    { id: 1, emoji: '👍' },
    { id: 117, emoji: '⚡️' },
    { id: 215, emoji: '❤️' },
  ])
  assert.deepEqual(reactionCapabilityEmojis(catalog), ['👍', '⚡️', '❤️'])
})

test('compact snapshot replay is deterministic and cannot duplicate a counter', () => {
  const first = extractCompactReactionSnapshots(fixture.messagesReactions, {
    requestedMessageIds: fixture.requestedMessageIds,
    supportedEmojis: ['👍', '👍🏻'],
  })
  const replay = extractCompactReactionSnapshots(fixture.messagesReactions, {
    requestedMessageIds: fixture.requestedMessageIds,
    supportedEmojis: ['👍', '👍🏻'],
  })

  assert.deepEqual(
    [...replay.entries()],
    [...first.entries()],
  )
  assert.equal(first.get('d3019f98f1eb2b3fb2').length, 1)
})

test('runtime does not forward generic op180 deep events or suffix-match messages', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const webhookSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'gravity-mvp', 'src', 'app', 'api', 'webhook', 'max', 'reaction', 'route.ts'),
    'utf8',
  )

  assert.match(indexSource, /\[53, 135, 155\]\.includes\(data\.opcode\)/)
  assert.doesNotMatch(indexSource, /\[53, 135, 155, 180\]/)
  assert.doesNotMatch(webhookSource, /externalId:\s*\{\s*contains:/)
  assert.match(webhookSource, /channel:\s*'max'/)
})
