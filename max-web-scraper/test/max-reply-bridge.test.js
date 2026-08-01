'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const {
  MaxWebReplyBridge,
  providerDecimalFromId,
  providerIdFromDecimal,
  selectInboundReplyCandidate,
  selectReplyTargetCandidate,
  uiRouteIdFromProviderChatId,
} = require('../reply/MaxWebReplyBridge')

test('MAX provider id conversion is exact and reversible', () => {
  const providerId = 'd3019f4dcf27c35ecf'
  const decimal = providerDecimalFromId(providerId)
  const signedDecimal = BigInt.asIntN(64, BigInt(decimal)).toString()
  assert.equal(providerIdFromDecimal(decimal), providerId)
  assert.equal(providerIdFromDecimal(signedDecimal), providerId)
  assert.equal(uiRouteIdFromProviderChatId('902454841098'), '511708938')
})

test('provider-backed DOM reply restores only body and exact reply identity', async () => {
  const providerMessageId = 'd3019f50829ca56efb'
  const replyToExternalId = 'd3019f50829ca56ef0'
  const bridge = new MaxWebReplyBridge({
    evaluate: async () => ({
      ok: true,
      providerChatId: '511708938',
      routeMatchCount: 1,
      message: {
        id: providerDecimalFromId(providerMessageId),
        text: 'Ответил',
        timestamp: 1783762168000,
        isOutgoing: false,
        replyToId: providerDecimalFromId(replyToExternalId),
      },
    }),
  })

  const result = await bridge.readProviderMessage(
    '902454841098',
    providerMessageId,
    { uiChatId: '511708938' },
  )

  assert.deepEqual(result, {
    providerMessageId,
    providerChatId: '511708938',
    routeMatchCount: 1,
    text: 'Ответил',
    exactText: 'Ответил',
    timestamp: 1783762168000,
    isOutgoing: false,
    replyToExternalId,
  })
})

test('provider-backed DOM lookup rejects a different provider identity', async () => {
  const bridge = new MaxWebReplyBridge({
    evaluate: async () => ({
      ok: true,
      providerChatId: '511708938',
      routeMatchCount: 1,
      message: {
        id: providerDecimalFromId('d3019f50829ca56efa'),
        text: 'wrong message',
        timestamp: 1783762168000,
        isOutgoing: false,
        replyToId: null,
      },
    }),
  })

  await assert.rejects(
    bridge.readProviderMessage('902454841098', 'd3019f50829ca56efb', { uiChatId: '511708938' }),
    /provider identity mismatch/,
  )
})

test('DOM-only inbound reply resolves by strict body, quote, chat history link and time', () => {
  const receivedAt = Date.parse('2026-07-11T12:06:07.000Z')
  const providerMessageId = 'd3019f50829ca56f10'
  const replyToExternalId = 'd3019f50829ca56efb'
  const result = selectInboundReplyCandidate([
    {
      id: providerDecimalFromId(providerMessageId),
      text: 'ответ пришел',
      timestamp: receivedAt - 220,
      isOutgoing: false,
      replyToId: providerDecimalFromId(replyToExternalId),
      quotedText: 'Для ответа',
    },
    {
      id: providerDecimalFromId('d3019f50829ca56f11'),
      text: 'ответ пришел',
      timestamp: receivedAt - 100,
      isOutgoing: false,
      replyToId: null,
      quotedText: '',
    },
    {
      id: providerDecimalFromId('d3019f50829ca56f12'),
      text: 'ответ пришел',
      timestamp: receivedAt - 50,
      isOutgoing: false,
      replyToId: providerDecimalFromId('d3019f50829ca56ef0'),
      quotedText: 'Другой текст',
    },
  ], {
    bodyText: 'ответ пришел',
    quotedText: 'Для ответа',
    receivedAt,
  })

  assert.deepEqual(result, {
    providerMessageId,
    replyToExternalId,
    timestamp: receivedAt - 220,
    reason: 'unique_strict_reply_match',
  })
})

test('DOM-only identical replies remain unresolved when provider history is ambiguous', () => {
  const receivedAt = Date.parse('2026-07-11T12:06:07.000Z')
  const candidates = ['10', '11'].map(suffix => ({
    id: providerDecimalFromId(`d3019f50829ca56f${suffix}`),
    text: 'ответ пришел',
    timestamp: receivedAt,
    isOutgoing: false,
    replyToId: providerDecimalFromId('d3019f50829ca56efb'),
    quotedText: 'Для ответа',
  }))

  const result = selectInboundReplyCandidate(candidates, {
    bodyText: 'ответ пришел',
    quotedText: 'Для ответа',
    receivedAt,
  })

  assert.equal(result.providerMessageId, null)
  assert.equal(result.reason, 'ambiguous_strict_reply_match')
})

test('DOM-recovered reply target resolves by strict chat history context', () => {
  const sentAt = '2026-07-10T20:54:13.900Z'
  const result = selectReplyTargetCandidate([
    { id: providerDecimalFromId('d3019f4dcf27c35ecf'), text: 'Для ответа', timestamp: Date.parse(sentAt) - 320, isOutgoing: false },
    { id: providerDecimalFromId('d3019f4dcf27c35ed0'), text: 'Другой текст', timestamp: Date.parse(sentAt), isOutgoing: false },
  ], { text: 'Для ответа', sentAt, direction: 'inbound' })

  assert.equal(result.providerMessageId, 'd3019f4dcf27c35ecf')
  assert.equal(result.reason, 'unique_strict_match')
})

test('same text uses the uniquely nearest provider event without content dedup', () => {
  const sentAtMs = Date.parse('2026-07-10T20:54:13.900Z')
  const result = selectReplyTargetCandidate([
    { id: providerDecimalFromId('d3019f4dcf27c35ec1'), text: '4', timestamp: sentAtMs - 1700, isOutgoing: false },
    { id: providerDecimalFromId('d3019f4dcf27c35ec2'), text: '4', timestamp: sentAtMs - 620, isOutgoing: false },
    { id: providerDecimalFromId('d3019f4dcf27c35ec3'), text: '4', timestamp: sentAtMs + 40, isOutgoing: false },
  ], { text: '4', sentAt: new Date(sentAtMs).toISOString(), direction: 'inbound' })

  assert.equal(result.providerMessageId, 'd3019f4dcf27c35ec3')
  assert.equal(result.reason, 'nearest_strict_match')
})

test('repeated outbound text cannot reuse an id from the pre-action provider snapshot', () => {
  const sentAtMs = Date.parse('2026-07-30T09:09:26.000Z')
  const oldId = 'd3019f4dcf27c35ec1'
  const newId = 'd3019f4dcf27c35ec2'
  const result = selectReplyTargetCandidate([
    { id: providerDecimalFromId(oldId), text: 'Одинаковое сообщение', timestamp: sentAtMs - 1200, isOutgoing: true },
    { id: providerDecimalFromId(newId), text: 'Одинаковое сообщение', timestamp: sentAtMs + 80, isOutgoing: true },
  ], { text: 'Одинаковое сообщение', sentAt: sentAtMs, direction: 'outbound' }, {
    excludedProviderMessageIds: [oldId],
  })
  assert.equal(result.providerMessageId, newId)
  assert.equal(result.reason, 'unique_strict_match')
})

test('outbound reply confirmation requires the exact reply target when supplied', () => {
  const sentAtMs = Date.parse('2026-08-01T06:52:33.000Z')
  const wrongTarget = 'd3019f4dcf27c35ec1'
  const exactTarget = 'd3019f4dcf27c35ec2'
  const result = selectReplyTargetCandidate([
    { id: providerDecimalFromId('d3019f4dcf27c35ec3'), text: 'Ответ', timestamp: sentAtMs + 40, isOutgoing: true, replyToId: providerDecimalFromId(wrongTarget) },
    { id: providerDecimalFromId('d3019f4dcf27c35ec4'), text: 'Ответ', timestamp: sentAtMs + 80, isOutgoing: true, replyToId: providerDecimalFromId(exactTarget) },
  ], {
    text: 'Ответ',
    sentAt: sentAtMs,
    direction: 'outbound',
    replyToProviderMessageId: exactTarget,
  })

  assert.equal(result.providerMessageId, 'd3019f4dcf27c35ec4')
  assert.equal(result.reason, 'unique_strict_match')
})

test('only a pre-action repeated-text match remains unknown until a new provider row appears', () => {
  const sentAtMs = Date.parse('2026-07-30T09:09:26.000Z')
  const oldId = 'd3019f4dcf27c35ec1'
  const result = selectReplyTargetCandidate([
    { id: providerDecimalFromId(oldId), text: 'Одинаковое сообщение', timestamp: sentAtMs - 1200, isOutgoing: true },
  ], { text: 'Одинаковое сообщение', sentAt: sentAtMs, direction: 'outbound' }, {
    excludedProviderMessageIds: [oldId],
  })
  assert.equal(result.providerMessageId, null)
  assert.equal(result.reason, 'no_strict_match')
})

test('ambiguous duplicate target is rejected instead of replying to the wrong message', () => {
  const sentAtMs = Date.parse('2026-07-10T20:54:13.900Z')
  const result = selectReplyTargetCandidate([
    { id: providerDecimalFromId('d3019f4dcf27c35ec1'), text: '4', timestamp: sentAtMs - 50, isOutgoing: false },
    { id: providerDecimalFromId('d3019f4dcf27c35ec2'), text: '4', timestamp: sentAtMs + 50, isOutgoing: false },
  ], { text: '4', sentAt: new Date(sentAtMs).toISOString(), direction: 'inbound' })

  assert.equal(result.providerMessageId, null)
  assert.equal(result.reason, 'ambiguous_strict_match')
})

test('wrong direction, stale history and placeholder ids are never selected', () => {
  const sentAtMs = Date.parse('2026-07-10T20:54:13.900Z')
  const result = selectReplyTargetCandidate([
    { id: '-1', text: 'Для ответа', timestamp: sentAtMs, isOutgoing: false },
    { id: providerDecimalFromId('d3019f4dcf27c35ec1'), text: 'Для ответа', timestamp: sentAtMs, isOutgoing: true },
    { id: providerDecimalFromId('d3019f4dcf27c35ec2'), text: 'Для ответа', timestamp: sentAtMs - 180_000, isOutgoing: false },
  ], { text: 'Для ответа', sentAt: new Date(sentAtMs).toISOString(), direction: 'inbound' })

  assert.equal(result.providerMessageId, null)
  assert.equal(result.reason, 'no_strict_match')
})

test('MAX Web provider lookup accepts a structurally fenced minified store export', async () => {
  const providerMessageId = 'd3019f4dcf27c35ecf'
  const providerNumericId = BigInt(providerDecimalFromId(providerMessageId))
  const chatId = 902454841098n
  const uiRouteId = 511708938n
  const message = {
    id: providerNumericId,
    text: { plain: 'exact provider-backed text' },
    time: 1785380000000,
    isOut: true,
    link: null,
  }
  const providerStore = {
    values: [message],
    getLazy: async id => id === providerNumericId ? message : null,
  }
  const chat = { id: uiRouteId, messages: [message], lastMessage: message }
  const store = {
    chats: { values: [], getLazy: async id => id === chatId ? chat : null },
    messages: { get: id => id === uiRouteId ? providerStore : { values: [], getLazy: async () => null } },
    profile: { viewer: { id: 1n } },
  }
  const previousWindow = global.window
  global.window = {
    __crmMaxCoreModule: {
      module: { Ya: store },
      url: 'https://web.max.ru/_app/immutable/chunks/current.js',
      store,
      storeExportKey: 'Ya',
      legacySendPrimitives: false,
    },
  }
  try {
    const bridge = new MaxWebReplyBridge({ evaluate: (callback, args) => callback(args) })
    const result = await bridge.resolveProviderId(String(chatId), {
      text: message.text.plain,
      direction: 'outbound',
    }, { uiChatId: '511708938' })

    assert.equal(result.providerMessageId, providerMessageId)
    assert.equal(result.reason, 'unique_strict_match')
    assert.equal(result.providerChatId, String(uiRouteId))
    assert.equal(result.routeMatchCount, 1)
  } finally {
    global.window = previousWindow
  }
})

test('MAX Web reply loads provider history before reading target candidates', () => {
  const source = fs.readFileSync(require.resolve('../reply/MaxWebReplyBridge'), 'utf8')
  const historyLoad = source.indexOf('await core.module.ro({ chat, from: historyFrom })')
  const chatRouteLookup = source.indexOf('Array.from(core.store.chats.values || [])')
  const providerStoreRead = source.indexOf('core.store.messages.get(chatKey).values')
  const candidateRead = source.indexOf('const candidates = []')

  assert.notEqual(historyLoad, -1, 'missing MAX chatLoadHistory action')
  assert.notEqual(chatRouteLookup, -1, 'missing strict MAX chat route lookup')
  assert.notEqual(providerStoreRead, -1, 'missing MAX provider message store read')
  assert.notEqual(candidateRead, -1, 'missing candidate read')
  assert.ok(chatRouteLookup < historyLoad, 'provider chat must resolve before history load')
  assert.ok(historyLoad < providerStoreRead, 'history must load before provider store is read')
  assert.ok(providerStoreRead < candidateRead, 'provider store must be read before candidates')
  assert.doesNotMatch(source, /this\.page\.goto\(/)
})

test('read-only provider history pagination advances by exact oldest provider timestamp', async () => {
  const chatId = 902197592419n
  const uiRouteId = 254460259n
  const base = Date.parse('2026-07-30T15:40:00.000Z')
  const messages = [0, 1, 2, 3].map(index => ({
    id: BigInt(providerDecimalFromId(`d3019fb3a90000000${index}`)),
    text: { plain: `message-${index}` },
    time: base - index * 60_000,
    isOut: false,
    link: null,
  }))
  const providerStore = { values: [messages[0]] }
  const chat = { id: uiRouteId, messages: [], lastMessage: messages[0] }
  let historyCalls = 0
  const store = {
    chats: { values: [], getLazy: async id => id === chatId ? chat : null },
    messages: { get: id => id === uiRouteId ? providerStore : { values: [] } },
    profile: { viewer: { id: 1n } },
  }
  const previousWindow = global.window
  global.window = {
    __crmMaxCoreModule: {
      module: {
        Wa: store,
        ro: async () => {
          historyCalls += 1
          if (messages[historyCalls]) providerStore.values.push(messages[historyCalls])
        },
      },
      store,
      storeExportKey: 'Wa',
      legacySendPrimitives: true,
    },
  }
  try {
    const bridge = new MaxWebReplyBridge({ evaluate: (callback, args) => callback(args) })
    const result = await bridge.readCandidates(String(chatId), {}, {
      uiChatId: String(uiRouteId),
      historyWindowStart: base - 3 * 60_000,
      historyMaxPages: 10,
    })
    assert.equal(historyCalls, 3)
    assert.equal(result.historyPagesLoaded, 3)
    assert.equal(result.historyOldestTimestamp, base - 3 * 60_000)
    assert.equal(result.candidates.length, 4)
  } finally {
    global.window = previousWindow
  }
})

test('MAX Web reply returns strict provider confirmation from the message store', () => {
  const source = fs.readFileSync(require.resolve('../reply/MaxWebReplyBridge'), 'utf8')
  const beforeSnapshot = source.indexOf('const beforeProviderIds = new Set(')
  const sendAction = source.indexOf('await core.module.ia({ chat, message: pending })')
  const confirmation = source.indexOf('providerMessageDecimal: confirmedProviderId')

  assert.notEqual(beforeSnapshot, -1, 'missing provider-store snapshot')
  assert.notEqual(sendAction, -1, 'missing MAX send action')
  assert.notEqual(confirmation, -1, 'missing provider confirmation result')
  assert.ok(beforeSnapshot < sendAction, 'snapshot must happen before send')
  assert.ok(sendAction < confirmation, 'confirmation must happen after send')
  assert.match(source, /new core\.module\.Is\(chatKey,[\s\S]*?replyTo: replyKey/)
  assert.match(source, /new core\.module\.Ps\(draft\)/)
  assert.doesNotMatch(source, /await core\.module\.\$i\(\{ chat, message: pending \}\)/)
  assert.match(source, /BigInt\.asUintN\(64, BigInt\(message\?\.link\?\.id\)\) !== replyKey/)
  assert.match(source, /providerHex\.startsWith\('01'\)/)
})

test('MAX Web reply invokes the current sendChatMessage action instead of the wrapper factory', async () => {
  const targetProviderMessageId = 'd3019f50829ca56ef0'
  const replyProviderMessageId = 'd3019f50829ca56ef1'
  const replyKey = BigInt(providerDecimalFromId(targetProviderMessageId))
  const replyMessageKey = BigInt(providerDecimalFromId(replyProviderMessageId))
  const chatId = 902454841098n
  const uiRouteId = 511708938n
  const target = {
    id: replyKey,
    text: { plain: 'quoted target' },
    time: 1785576000000,
    isOut: true,
    link: null,
  }
  const providerStore = {
    values: [target],
    getLazy: async id => id === replyKey ? target : null,
  }
  const chat = { id: uiRouteId, messages: [target], lastMessage: target }
  const store = {
    chats: { values: [chat], getLazy: async id => id === chatId ? chat : null },
    messages: { get: id => id === uiRouteId ? providerStore : { values: [], getLazy: async () => null } },
    profile: { viewer: { id: 1n } },
  }
  let sendActionCalls = 0
  const module = {
    Ya: store,
    Is: class ReplyDraft {
      constructor(replyChatId, input) {
        this.chatId = replyChatId
        this.replyTo = input.replyTo
        this.text = { plain: input.text, toApiElements: () => [] }
        this.attaches = []
      }
    },
    Ps: class PendingMessage {
      constructor(draft) {
        this.id = 0n
        this.chatId = draft.chatId
        this.text = draft.text
        this.link = { id: draft.replyTo }
        this.attaches = []
        this.type = 'USER'
      }
    },
    ia: async ({ chat: actionChat, message }) => {
      sendActionCalls += 1
      assert.equal(actionChat, chat)
      assert.equal(message.text.plain, 'reply body')
      assert.equal(message.link.id, replyKey)
      providerStore.values.push({
        id: replyMessageKey,
        text: { plain: 'reply body' },
        time: 1785576001000,
        isOut: true,
        link: { id: replyKey },
      })
    },
    $i: async () => {
      throw new Error('legacy wrapper factory must not be invoked')
    },
  }
  const previousWindow = global.window
  global.window = {
    __crmMaxCoreModule: {
      module,
      url: 'https://web.max.ru/_app/immutable/chunks/current.js',
      store,
      storeExportKey: 'Ya',
      legacySendPrimitives: false,
    },
  }
  try {
    const bridge = new MaxWebReplyBridge({ evaluate: (callback, args) => callback(args) })
    const result = await bridge.sendReply(
      String(chatId),
      'reply body',
      targetProviderMessageId,
      '1785576000123',
      { uiChatId: String(uiRouteId) },
    )

    assert.equal(sendActionCalls, 1)
    assert.equal(result.ok, true)
    assert.equal(result.providerMessageId, replyProviderMessageId)
    assert.equal(result.providerCandidateCount, 1)
  } finally {
    global.window = previousWindow
  }
})

test('MAX Web reply preserves BigInt chat keys after strict route correlation', () => {
  const source = fs.readFileSync(require.resolve('../reply/MaxWebReplyBridge'), 'utf8')

  assert.match(source, /await core\.store\.chats\.getLazy\(requestedChatKey\)/)
  assert.match(source, /const requestedChatKey = BigInt\(String\(args\.chatId\)\)/)
  assert.match(source, /const chatKey = chat\.id/)
  assert.doesNotMatch(source, /const chatKey = Number\(args\.chatId\)/)
  assert.doesNotMatch(source, /core\.store\.chats\.get\(chatKey\)/)
})

test('real provider reply target still route-correlates the MAX Web chat before send', () => {
  const bridgeSource = fs.readFileSync(require.resolve('../reply/MaxWebReplyBridge'), 'utf8')
  const scraperSource = fs.readFileSync(require.resolve('../index'), 'utf8')
  const sendStart = bridgeSource.indexOf('async sendReply(')
  const sendEnd = bridgeSource.indexOf('\n  }\n}', sendStart)
  const sendBlock = bridgeSource.slice(sendStart, sendEnd)

  assert.notEqual(sendStart, -1)
  assert.notEqual(sendEnd, -1)
  assert.match(sendBlock, /const requestedChatKey = BigInt\(String\(args\.chatId\)\)/)
  assert.match(sendBlock, /const uiRouteKey = BigInt\(String\(args\.uiRouteId\)\)/)
  assert.match(sendBlock, /let routeMatches = Array\.from\(core\.store\.chats\.values \|\| \[\]\)/)
  assert.match(sendBlock, /const chat = routeMatches\.length === 1/)
  assert.match(sendBlock, /: await core\.store\.chats\.getLazy\(requestedChatKey\)/)
  assert.doesNotMatch(sendBlock, /if \(!core\.legacySendPrimitives/)
  assert.match(sendBlock, /typeof core\.module\.ia !== 'function'/)
  assert.match(sendBlock, /typeof core\.module\.Is !== 'function'/)
  assert.match(sendBlock, /typeof core\.module\.Ps !== 'function'/)
  assert.match(scraperSource, /replyBridge\.sendReply\([\s\S]*?\{ uiChatId: directUiRouteId \}[\s\S]*?\)/)
})
