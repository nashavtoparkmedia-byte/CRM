'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { deriveMaxChatKind } = require('../lib/ChatKind')

test('MAX DIALOG provider model is private', () => {
  assert.equal(deriveMaxChatKind({ type: 'DIALOG' }), 'private')
})

test('MAX group provider model types are group', () => {
  for (const type of ['CHAT', 'GROUP', 'GROUP_CHAT', 'CHANNEL']) {
    assert.equal(deriveMaxChatKind({ type }), 'group')
  }
})

test('missing or unrecognized provider type is unknown', () => {
  assert.equal(deriveMaxChatKind(), 'unknown')
  assert.equal(deriveMaxChatKind({ title: 'Alice' }), 'unknown')
  assert.equal(deriveMaxChatKind({ type: 'FUTURE_KIND' }), 'unknown')
})

test('deterministic precedence is group over unknown over private', () => {
  assert.equal(deriveMaxChatKind({ type: 'DIALOG' }, { type: 'FUTURE_KIND' }), 'unknown')
  assert.equal(deriveMaxChatKind({ type: 'FUTURE_KIND' }, { type: 'GROUP' }, { type: 'DIALOG' }), 'group')
})

test('names and participant counts never classify a chat', () => {
  assert.equal(deriveMaxChatKind({ name: 'Private Alice', participants: { 1: {}, 2: {} } }), 'unknown')
})
