'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  estimateDomRecoveryTimestampMs,
  hasDirectDomTimestampAnchor,
  normalizeProviderTimestamp,
  providerMessageTimestampMs,
} = require('../lib/MaxMessageOrdering')

function direct(sentAtMs) {
  return { _directHit: { sentAtMs } }
}

test('late DOM recovery orders message 1 before direct messages 2 and 3', () => {
  const candidates = [
    { text: '1', _pendingLiveProviderCandidate: true },
    { text: '2', ...direct(Date.parse('2026-07-25T10:00:02.000Z')) },
    { text: '3', ...direct(Date.parse('2026-07-25T10:00:03.000Z')) },
  ]

  assert.equal(hasDirectDomTimestampAnchor(candidates), true)
  assert.equal(
    estimateDomRecoveryTimestampMs(candidates, 0),
    Date.parse('2026-07-25T10:00:01.000Z'),
  )
})

test('DOM recovery interpolates between two provider timestamp anchors', () => {
  const candidates = [
    direct(Date.parse('2026-07-25T10:00:00.000Z')),
    { text: 'middle' },
    direct(Date.parse('2026-07-25T10:00:04.000Z')),
  ]

  assert.equal(
    estimateDomRecoveryTimestampMs(candidates, 1),
    Date.parse('2026-07-25T10:00:02.000Z'),
  )
})

test('anchorless recovery remains ordered by DOM position near recovery time', () => {
  const nowMs = Date.parse('2026-07-25T10:01:00.000Z')
  const candidates = [{ text: 'first' }, { text: 'second' }, { text: 'third' }]

  assert.equal(hasDirectDomTimestampAnchor(candidates), false)
  assert.deepEqual(
    candidates.map((_, index) => estimateDomRecoveryTimestampMs(candidates, index, nowMs)),
    [
      Date.parse('2026-07-25T10:00:57.000Z'),
      Date.parse('2026-07-25T10:00:58.000Z'),
      Date.parse('2026-07-25T10:00:59.000Z'),
    ],
  )
})

test('zero timestamp is still treated as a real deterministic anchor', () => {
  const candidates = [{ text: 'before' }, direct(0)]
  assert.equal(hasDirectDomTimestampAnchor(candidates), true)
  assert.equal(estimateDomRecoveryTimestampMs(candidates, 0, 10_000), -1000)
})

test('real MAX provider message id restores millisecond order when opaque time cannot be parsed', () => {
  const nowMs = Date.parse('2026-07-30T13:20:50.000Z')
  const ids = [
    'd3019fb32f2a284a8b',
    'd3019fb32f2f125165',
    'd3019fb32f350c6e35',
    'd3019fb32f3d033327',
    'd3019fb32f42526c10',
  ]
  const timestamps = ids.map(id => providerMessageTimestampMs(id, nowMs))

  assert.deepEqual([...timestamps].sort((a, b) => a - b), timestamps)
  assert.equal(timestamps[2], Date.parse('2026-07-30T13:20:43.276Z'))
  assert.equal(
    normalizeProviderTimestamp({ __maxId: true, hex: 'd300001300f22aa474' }, ids[2], nowMs),
    timestamps[2],
  )
})

test('valid provider timestamp remains authoritative over message-id fallback', () => {
  const explicit = Date.parse('2026-07-30T13:20:43.306Z')
  assert.equal(normalizeProviderTimestamp(explicit, 'd3019fb32f350c6e35'), explicit)
  assert.equal(normalizeProviderTimestamp(new Date(explicit), 'd3019fb32f350c6e35'), explicit)
})
