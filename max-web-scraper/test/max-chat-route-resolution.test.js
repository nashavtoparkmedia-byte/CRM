'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveMaxUiRouteId } = require('../contacts/MaxChatRoutes')

test('derives MAX Web route from every protocol dialog id', () => {
  assert.deepEqual(resolveMaxUiRouteId('901967525678'), {
    uiRouteId: '24393518',
    source: 'protocol_low32',
  })
  assert.deepEqual(resolveMaxUiRouteId('902454841098'), {
    uiRouteId: '511708938',
    source: 'protocol_low32',
  })
  assert.deepEqual(resolveMaxUiRouteId('902144614300'), {
    uiRouteId: '201482140',
    source: 'protocol_low32',
  })
})

test('keeps explicit accepted overrides and short routes stable', () => {
  assert.deepEqual(resolveMaxUiRouteId('901967525678', {
    overrides: { '901967525678': '24393518' },
  }), {
    uiRouteId: '24393518',
    source: 'static_override',
  })
  assert.deepEqual(resolveMaxUiRouteId('24393518'), {
    uiRouteId: '24393518',
    source: 'protocol_chat_id',
  })
})

test('uses participant fallback only when the protocol id is already a short route', () => {
  assert.deepEqual(resolveMaxUiRouteId('24393518', { participantRouteId: '902158371854' }), {
    uiRouteId: '902158371854',
    source: 'dialog_participant',
  })
  assert.equal(
    resolveMaxUiRouteId('901967525678', { participantRouteId: '902158371854' }).uiRouteId,
    '24393518',
  )
})
