import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildPersonalMaxHistoryPlan,
  hasDamagedPersonalMaxText,
  isPersonalMaxNativeMessage,
  normalizePersonalMaxProfilePhone,
  personalMaxNativeMetadata,
  type PersonalMaxProviderMessage,
} from '../personal-max-live-conversation'

const provider = (
  providerMessageId: string,
  text: string | null,
  direction: 'inbound' | 'outbound' = 'inbound',
  timestamp = Date.parse('2026-07-30T06:30:00.000Z'),
): PersonalMaxProviderMessage => ({
  providerMessageId,
  direction,
  providerUserId: direction === 'outbound' ? '900000000789' : '900000000456',
  timestamp,
  text,
  textDisposition: 'exact_unicode',
  messageType: 'text',
  attachmentCount: 0,
})

describe('Personal MAX exact Unicode and phone identity', () => {
  it.each([
    ['+7 (999) 000-00-11', '+79990000011'],
    ['8 999 000 00 11', '+79990000011'],
    ['9990000011', '+79990000011'],
    ['+1 999 083 8709', null],
    ['999083870', null],
  ])('strictly normalizes %s', (input, expected) => {
    expect(normalizePersonalMaxProfilePhone(input)).toBe(expected)
  })

  it.each([
    'bad\uFFFDtext',
    'bad\u0000text',
    'body attaches x prevMsg metadata',
    'ttl=12 unread=4',
  ])('detects damaged provider text %j', text => {
    expect(hasDamagedPersonalMaxText(text)).toBe(true)
  })

  it.each([
    'Кириллица без потерь',
    'emoji 🧭🙂',
    'строка 1\nстрока 2',
    'https://example.test/a?x=1&y=2',
    '**жирный** _текст_',
    'символы: № «» — € →',
  ])('preserves safe Unicode %j', text => {
    expect(hasDamagedPersonalMaxText(text)).toBe(false)
  })

  it('marks direct MAX outbound as provider-present without delivery/read claim', () => {
    const metadata = personalMaxNativeMetadata({
      accountId: 'max-personal-account',
      protocolChatId: '900000000123',
      uiRouteId: '2351835259',
      providerUserId: '900000000456',
      source: 'history',
    })
    expect(isPersonalMaxNativeMessage(metadata)).toBe(true)
    expect(metadata.retryable).toBe(false)
    expect(metadata.maxDelivery).toEqual({
      status: 'provider_present',
      deliveryConfirmed: false,
      retryable: false,
    })
  })
})

describe('Personal MAX provider-id history plan', () => {
  it('creates native outbound once and preserves its exact text', () => {
    const item = provider('d30100000000000001', 'Принял 🧭', 'outbound')
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [item],
      existingMessages: [],
      dispatches: [],
    })
    expect(plan.creates).toEqual([item])
    expect(plan.quarantined).toEqual([])
  })

  it('keeps identical provider texts as distinct messages when ids differ', () => {
    const messages = [
      provider('d30100000000000002', 'Одинаковое сообщение', 'outbound', 1000),
      provider('d30100000000000003', 'Одинаковое сообщение', 'outbound', 1001),
    ]
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: messages,
      existingMessages: [],
      dispatches: [],
    })
    expect(plan.creates.map(item => item.providerMessageId)).toEqual(messages.map(item => item.providerMessageId))
  })

  it('is idempotent after provider ids exist', () => {
    const messages = [
      provider('d30100000000000002', 'Одинаковое сообщение', 'outbound', 1000),
      provider('d30100000000000003', 'Одинаковое сообщение', 'outbound', 1001),
    ]
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: messages,
      existingMessages: messages.map((item, index) => ({
        id: `message-${index}`,
        externalId: item.providerMessageId,
        direction: item.direction,
        content: item.text!,
        sentAt: new Date(item.timestamp),
        metadata: { origin: 'max_native' },
      })),
      dispatches: [],
    })
    expect(plan.creates).toEqual([])
    expect(plan.repairs).toEqual([])
    expect(plan.unchangedProviderMessageIds).toEqual(messages.map(item => item.providerMessageId))
  })

  it('repairs the same evidence row from exact provider-store text', () => {
    const item = provider('d30100000000000004', 'Точный русский текст\n🙂')
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [item],
      existingMessages: [{
        id: 'damaged-message',
        externalId: item.providerMessageId,
        direction: 'inbound',
        content: 'bad\uFFFDtext attaches prevMsg',
        sentAt: new Date(item.timestamp),
      }],
      dispatches: [],
    })
    expect(plan.repairs).toEqual([{
      messageId: 'damaged-message',
      providerMessageId: item.providerMessageId,
      exactText: item.text,
      direction: 'inbound',
      sentAt: item.timestamp,
      origin: 'max_provider',
    }])
    expect(plan.creates).toEqual([])
  })

  it('repairs a provider id that DOM recovery assigned the wrong direction and prior text', () => {
    const item = provider('d30100000000000012', 'Ответ менеджера', 'outbound', 2000)
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [item],
      existingMessages: [{
        id: 'misbound-dom-message',
        externalId: item.providerMessageId,
        direction: 'inbound',
        content: 'Предыдущее сообщение водителя',
        sentAt: new Date(2100),
        metadata: { source: 'live_dom_recovery' },
      }],
      dispatches: [],
    })
    expect(plan.repairs).toEqual([{
      messageId: 'misbound-dom-message',
      providerMessageId: item.providerMessageId,
      exactText: 'Ответ менеджера',
      direction: 'outbound',
      sentAt: 2000,
      origin: 'max_native',
    }])
  })

  it('upgrades one strongly route-scoped live placeholder instead of creating a second bubble', () => {
    const item = provider('d30100000000000013', 'Точное сообщение', 'inbound', 3000)
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [item],
      existingMessages: [{
        id: 'live-placeholder',
        externalId: 'max-dom-902000000123-safe',
        direction: 'inbound',
        content: item.text!,
        sentAt: new Date(3100),
        metadata: {
          providerAccountId: 'max-personal-account',
          protocolChatId: '902000000123',
          uiRouteId: '2351835259',
        },
      }],
      dispatches: [],
      identity: {
        accountId: 'max-personal-account',
        protocolChatId: '902000000123',
        uiRouteId: '2351835259',
      },
    })
    expect(plan.creates).toEqual([])
    expect(plan.placeholderLinks).toEqual([{
      messageId: 'live-placeholder',
      providerMessageId: item.providerMessageId,
      exactText: item.text,
      direction: 'inbound',
      sentAt: 3000,
    }])
  })

  it('fails closed when equal provider messages make one placeholder identity ambiguous', () => {
    const first = provider('d30100000000000014', 'Одинаковое сообщение', 'inbound', 4000)
    const second = provider('d30100000000000015', 'Одинаковое сообщение', 'inbound', 4001)
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [first, second],
      existingMessages: [{
        id: 'ambiguous-placeholder',
        externalId: 'max-dom-902000000123-ambiguous',
        direction: 'inbound',
        content: first.text!,
        sentAt: new Date(4050),
        metadata: {
          providerAccountId: 'max-personal-account',
          protocolChatId: '902000000123',
          uiRouteId: '2351835259',
        },
      }],
      dispatches: [],
      identity: {
        accountId: 'max-personal-account',
        protocolChatId: '902000000123',
        uiRouteId: '2351835259',
      },
    })
    expect(plan.placeholderLinks).toEqual([])
    expect(plan.creates.map(item => item.providerMessageId)).toEqual([
      first.providerMessageId,
      second.providerMessageId,
    ])
  })

  it('links a provider-confirmed CRM echo to the optimistic bubble', () => {
    const item = provider('d30100000000000005', 'CRM text', 'outbound')
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [item],
      existingMessages: [{
        id: 'optimistic-message',
        externalId: null,
        clientMessageId: 'client-message-1',
        direction: 'outbound',
        content: 'CRM text',
        sentAt: new Date(item.timestamp),
      }],
      dispatches: [{
        providerMessageId: item.providerMessageId,
        clientMessageId: 'client-message-1',
        state: 'provider_confirmed',
      }],
    })
    expect(plan.echoLinks).toEqual([{
      messageId: 'optimistic-message',
      providerMessageId: item.providerMessageId,
      clientMessageId: 'client-message-1',
    }])
    expect(plan.creates).toEqual([])
  })

  it('fails closed instead of duplicating an unresolved CRM dispatch', () => {
    const item = provider('d30100000000000006', 'CRM text', 'outbound')
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [item],
      existingMessages: [],
      dispatches: [{
        providerMessageId: item.providerMessageId,
        clientMessageId: 'client-message-1',
        state: 'awaiting_confirmation',
      }],
    })
    expect(plan.creates).toEqual([])
    expect(plan.quarantined).toEqual([item])
  })

  it('quarantines damaged, provider-quarantined and empty non-attachment rows', () => {
    const damaged = provider('d30100000000000007', 'bad\uFFFDtext')
    const quarantined = {
      ...provider('d30100000000000008', null),
      textDisposition: 'quarantined' as const,
      quarantineReason: 'provider_text_invalid_utf8',
    }
    const empty = provider('d30100000000000009', null)
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [damaged, quarantined, empty],
      existingMessages: [],
      dispatches: [],
    })
    expect(plan.creates).toEqual([])
    expect(plan.quarantined.map(item => item.providerMessageId)).toEqual([
      damaged.providerMessageId,
      quarantined.providerMessageId,
      empty.providerMessageId,
    ])
  })

  it('orders same-time events deterministically by provider id', () => {
    const high = provider('d30100000000000011', 'high', 'inbound', 1000)
    const low = provider('d30100000000000010', 'low', 'outbound', 1000)
    const plan = buildPersonalMaxHistoryPlan({
      providerMessages: [high, low],
      existingMessages: [],
      dispatches: [],
    })
    expect(plan.creates.map(item => item.providerMessageId)).toEqual([
      low.providerMessageId,
      high.providerMessageId,
    ])
  })
})

describe('Personal MAX webhook source contract', () => {
  const webhook = fs.readFileSync('src/app/api/webhooks/max/route.ts', 'utf8')

  it('fences provider account and canonical protocol/participant identity', () => {
    expect(webhook).toContain("reason: 'account_mismatch'")
    expect(webhook).toContain('normalizeMaxChatId(protocolChatId || chatId)')
    expect(webhook).toContain('providerUserIdString = providerUserId ? String(providerUserId) : senderIdString')
  })

  it('links a durable CRM echo before projecting direct-native provider events', () => {
    const echoLookup = webhook.indexOf('prisma.maxOutboundDispatch.findFirst')
    const nativeProjection = webhook.indexOf('const isNativeMaxOutbound')
    expect(echoLookup).toBeGreaterThan(-1)
    expect(nativeProjection).toBeGreaterThan(echoLookup)
    expect(webhook).toContain("skipped: 'crm_echo_reconciliation_required'")
    expect(webhook).toContain('personalMaxNativeMetadata')
  })

  it('does not run live workflow transitions for history rows', () => {
    expect(webhook).toContain('if (!isOutgoing && !isHistoryReplay)')
    expect(webhook).toContain('else if (isOutgoing && !isHistoryReplay)')
  })
})
