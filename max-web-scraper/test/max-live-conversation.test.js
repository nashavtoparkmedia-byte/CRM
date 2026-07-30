'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assessProviderText,
  buildProviderHistorySnapshot,
  low32RouteId,
  normalizeRussianPhone,
  protocolChatIdForUiRouteCandidate,
  providerPeerUserId,
} = require('../lib/MaxLiveConversation')
const { maxMsgpackDecodeAll } = require('../transport/TransportInterceptor')

const ACCOUNT_ID = 'max-personal-test-account'
const PROTOCOL_CHAT_ID = '900000000123'
const UI_ROUTE_ID = '2351835259'
const PROVIDER_USER_ID = '900000000456'
const OWNER_USER_ID = '900000000789'
const START = Date.parse('2026-07-30T06:20:00.000Z')
const END = Date.parse('2026-07-30T14:40:00.000Z')

function decimalProviderId(providerId) {
  return BigInt(`0x${providerId.slice(2)}`).toString()
}

function snapshot(candidates, overrides = {}) {
  return buildProviderHistorySnapshot({
    accountId: ACCOUNT_ID,
    protocolChatId: PROTOCOL_CHAT_ID,
    uiRouteId: UI_ROUTE_ID,
    providerUserId: PROVIDER_USER_ID,
    ownerUserId: OWNER_USER_ID,
    phone: '+7 (999) 000-00-11',
    phoneEvidence: {
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: true,
      providerIdentityId: PROVIDER_USER_ID,
      protocolChatId: PROTOCOL_CHAT_ID,
      uiRouteId: UI_ROUTE_ID,
      observedAt: '2026-07-30T15:00:50.766Z',
    },
    candidates,
    windowStart: START,
    windowEnd: END,
    providerChatId: PROTOCOL_CHAT_ID,
    routeMatchCount: 1,
    ...overrides,
  })
}

for (const [input, expected] of [
  ['+7 (999) 000-00-11', '+79990000011'],
  ['8 999 000 00 11', '+79990000011'],
  ['9990000011', '+79990000011'],
  ['+1 999 083 8709', null],
  ['999083870', null],
]) {
  test(`strict Russian phone normalization: ${input}`, () => {
    assert.equal(normalizeRussianPhone(input), expected)
  })
}

for (const text of [
  'Кириллица без потерь',
  'emoji 🧭🙂',
  'строка 1\nстрока 2',
  'https://example.test/a?x=1&y=2',
  '+7 (999) 000-00-00',
  '**жирный** _текст_',
  'символы: № «» — € →',
  'Одинаковое сообщение',
]) {
  test(`exact provider Unicode is accepted: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(assessProviderText(text), { accepted: true, reason: null, text })
  })
}

for (const [value, reason] of [
  [Buffer.from('binary'), 'provider_text_not_string'],
  [null, 'provider_text_not_string'],
  ['bad\uFFFDtext', 'provider_text_invalid_utf8'],
  ['bad\u0000text', 'provider_text_control_bytes'],
  ['body attaches x prevMsg metadata', 'provider_text_protocol_fragment'],
  ['ttl=12 unread=4', 'provider_text_protocol_fragment'],
]) {
  test(`unsafe provider text is quarantined: ${reason}`, () => {
    const result = assessProviderText(value)
    assert.equal(result.accepted, false)
    assert.equal(result.reason, reason)
    assert.equal(result.text, null)
  })
}

test('dialog identity resolves only the one non-owner participant', () => {
  assert.equal(providerPeerUserId({
    type: 'DIALOG',
    participants: { [OWNER_USER_ID]: {}, [PROVIDER_USER_ID]: {} },
  }, OWNER_USER_ID), PROVIDER_USER_ID)
  assert.equal(providerPeerUserId({
    type: 'DIALOG',
    owner: OWNER_USER_ID,
    participants: { '42': 0, [PROVIDER_USER_ID]: {} },
  }, OWNER_USER_ID), PROVIDER_USER_ID)
  assert.equal(providerPeerUserId({
    type: 'DIALOG',
    participants: { [PROVIDER_USER_ID]: {} },
  }, OWNER_USER_ID), null)
  assert.equal(providerPeerUserId({
    type: 'GROUP',
    participants: { [OWNER_USER_ID]: {}, [PROVIDER_USER_ID]: {} },
  }, OWNER_USER_ID), null)
})

test('protocol chat and UI route binding is exact and ambiguity fails closed', () => {
  assert.equal(low32RouteId(PROTOCOL_CHAT_ID), UI_ROUTE_ID)
  assert.equal(protocolChatIdForUiRouteCandidate(UI_ROUTE_ID, [[PROTOCOL_CHAT_ID, {}]]), PROTOCOL_CHAT_ID)
  assert.equal(protocolChatIdForUiRouteCandidate(UI_ROUTE_ID, [
    [PROTOCOL_CHAT_ID, {}],
    [String(BigInt(PROTOCOL_CHAT_ID) + (1n << 32n)), {}],
  ]), null)
})

test('history snapshot preserves exact Unicode and stable provider ordering', () => {
  const first = 'd30100000000000001'
  const second = 'd30100000000000002'
  const result = snapshot([
    {
      id: decimalProviderId(second),
      text: 'Вторая 🧭',
      timestamp: (START + 20_000) / 1000,
      isOutgoing: true,
      attachmentCount: 0,
    },
    {
      id: decimalProviderId(first),
      text: 'Первая\nстрока',
      timestamp: START + 10_000,
      isOutgoing: false,
      attachmentCount: 0,
    },
  ])

  assert.equal(result.profile.phone, '+79990000011')
  assert.deepEqual(result.messages.map(message => message.providerMessageId), [first, second])
  assert.equal(result.messages[0].text, 'Первая\nстрока')
  assert.equal(result.messages[1].text, 'Вторая 🧭')
  assert.equal(result.messages[1].direction, 'outbound')
})

test('same provider text with different ids remains two logical messages', () => {
  const ids = ['d30100000000000002', 'd30100000000000003']
  const result = snapshot(ids.map((id, index) => ({
    id: decimalProviderId(id),
    text: 'Одинаковое сообщение',
    timestamp: START + 30_000 + index,
    isOutgoing: true,
    attachmentCount: 0,
  })))
  assert.deepEqual(result.messages.map(message => message.providerMessageId), ids)
  assert.equal(result.messages.length, 2)
})

test('damaged provider text remains evidence but cannot become CRM text', () => {
  const id = 'd30100000000000004'
  const result = snapshot([{
    id: decimalProviderId(id),
    text: 'bad\uFFFDtext',
    timestamp: START + 40_000,
    isOutgoing: false,
    attachmentCount: 0,
  }])
  assert.deepEqual(result.messages[0], {
    providerMessageId: id,
    direction: 'inbound',
    providerUserId: PROVIDER_USER_ID,
    timestamp: START + 40_000,
    text: null,
    textDisposition: 'quarantined',
    quarantineReason: 'provider_text_invalid_utf8',
    messageType: 'text',
    attachmentCount: 0,
  })
})

test('history snapshot rejects account, route and participant ambiguity', () => {
  assert.throws(() => snapshot([], { accountId: '' }), /account is invalid/)
  assert.throws(() => snapshot([], { uiRouteId: '1' }), /route binding is invalid/)
  assert.throws(() => snapshot([], { routeMatchCount: 2 }), /provider route is ambiguous/)
  assert.throws(() => snapshot([], { providerUserId: OWNER_USER_ID }), /participant binding is invalid/)
})

test('invalid MessagePack UTF-8 is tagged and never materialized with replacement characters', () => {
  const diagnostics = []
  const [decoded] = maxMsgpackDecodeAll(Buffer.from([0xa2, 0xc3, 0x28]), {
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  })
  assert.equal(decoded.__maxInvalidUtf8, true)
  assert.equal(decoded.kind, 'invalid_utf8_string')
  assert.equal(JSON.stringify(decoded).includes('\uFFFD'), false)
  assert.equal(diagnostics.length, 1)
})
