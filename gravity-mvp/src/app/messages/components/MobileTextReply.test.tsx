import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/messages',
}))
// The composer's «improve draft» popover imports a server action; it plays no
// part in sending and must not pull server code into jsdom.
vi.mock('../improve-draft-actions', () => ({ improveDraftAction: vi.fn() }))

import MessageFeed from './MessageFeed'
import MessageInputArea from './MessageInputArea'
import { useMessages, type Message, type RetryPersistedDelivery } from '../hooks/useMessages'

// Mobile Text Reply v1, client side. One tap is one intent, one intent is one
// clientMessageId, and the answer to it — from its own request, the SSE stream
// or the history poll, in any order — settles exactly one row in exactly the
// conversation it was sent from.

const INBOUND = 'Можно уточнить время смены?'
const SENDING = 'Отправляется'
const DELIVERED = 'Доставлено'
const SENT = 'Отправлено'
const NOT_SENT = 'Не отправлено'
const UNKNOWN = 'Статус доставки неизвестен'
const RETRY = 'Повторить'

let sequence = 0
const chatId = (name: string) => `${name}-${++sequence}`

// ── Fake transport ───────────────────────────────────────────────────────────

type Reply =
  | { status: number; body: unknown }
  | { network: true }
  | { pending: Promise<Reply> }

function deferred() {
  let resolve!: (value: Reply) => void
  const promise = new Promise<Reply>((r) => { resolve = r })
  return { promise, resolve }
}

const historyReplies = new Map<string, Reply[]>()
const sendReplies: Reply[] = []
interface SendBody { chatId: string; content: string; channel: string; clientMessageId: string; quotedMsgId?: string }
const sendBodies: SendBody[] = []

async function respond(next: Reply): Promise<unknown> {
  if ('pending' in next) return respond(await next.pending)
  if ('network' in next) throw new TypeError('Failed to fetch')
  return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body }
}

class FakeEventSource {
  static open: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) { FakeEventSource.open.push(this) }
  close() { this.closed = true }
}

function push(chat: string, data: Record<string, unknown>) {
  for (const source of FakeEventSource.open) {
    if (!source.closed && source.url === `/api/messages/stream/${chat}`) {
      source.onmessage?.({ data: JSON.stringify({ type: 'message', data }) })
    }
  }
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sendBodies.push(JSON.parse(String(init.body)))
      const next = sendReplies.shift()
      if (!next) throw new Error('test transport has no send reply queued')
      return respond(next)
    }
    const id = new URL(input, 'http://crm.test').searchParams.get('chatId') ?? ''
    const next = (historyReplies.get(id) ?? []).shift()
    // An unqueued read stays in flight: the view keeps what it has.
    return respond(next ?? { pending: new Promise(() => {}) })
  }))
  vi.stubGlobal('EventSource', FakeEventSource)
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  // jsdom has no media queries; the composer only asks whether it is on touch.
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
  }
})

beforeEach(() => {
  sendReplies.length = 0
  sendBodies.length = 0
  FakeEventSource.open = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const quietConsole = () => vi.spyOn(console, 'error').mockImplementation(() => {})
const settled = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

function history(chat: string, ...messages: Message[]) {
  historyReplies.set(chat, [...(historyReplies.get(chat) ?? []), { status: 200, body: messages }])
}

function inbound(chat: string): Message {
  return { id: `${chat}-in`, direction: 'inbound', type: 'text', content: INBOUND, sentAt: '2026-09-18T08:00:00.000Z', status: 'delivered', channel: 'max' }
}

function canonical(body: SendBody, id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    chatId: body.chatId,
    clientMessageId: body.clientMessageId,
    direction: 'outbound',
    type: 'text',
    content: body.content,
    channel: 'max',
    status,
    sentAt: new Date().toISOString(),
    ...extra,
  }
}

// ── The reply pane as ChatWorkspace composes it ──────────────────────────────

function ReplyPane({ chatId: id, retry }: { chatId: string; retry?: RetryPersistedDelivery }) {
  const reply = useMessages(id, { retryPersistedDelivery: retry })
  return (
    <>
      <MessageFeed
        chatId={id}
        channelTab="max"
        uiItems={reply.uiItems}
        isLoading={reply.isLoading}
        hasLoadedHistory={reply.hasLoadedHistory}
        historyLoadFailed={reply.historyLoadFailed}
        isRetryingHistory={reply.isRetryingHistory}
        onRetryHistoryLoad={() => { void reply.retryHistoryLoad() }}
        hasMoreHistory={reply.hasMoreHistory}
        onLoadMore={reply.loadMoreHistory}
        onRetry={(message) => { void reply.retryMessage(message) }}
      />
      <MessageInputArea
        chatId={id}
        activeChannelTab="max"
        replyContext={null}
        onClearReply={() => {}}
        manualSendChannelMode="max"
        setManualSendChannelMode={() => {}}
        onSendMessage={(content, channel) => { void reply.sendMessage(content, channel) }}
      />
    </>
  )
}

// The remount boundary ChatWorkspace applies: key={effectiveChatId}.
function Conversation({ chatId: id, retry }: { chatId: string; retry?: RetryPersistedDelivery }) {
  return <ReplyPane key={id} chatId={id} retry={retry} />
}

async function open(chat: string, retry?: RetryPersistedDelivery, ...messages: Message[]) {
  history(chat, inbound(chat), ...messages)
  const view = render(<Conversation chatId={chat} retry={retry} />)
  await screen.findByText(INBOUND)
  return view
}

function type(text: string) {
  fireEvent.change(screen.getByPlaceholderText('Написать сообщение...'), { target: { value: text } })
}

function sendButton() {
  return screen.getByRole('button', { name: 'Отправить' })
}

async function sendText(text: string) {
  type(text)
  fireEvent.click(sendButton())
  await settled()
}

const statuses = (name: string) => screen.queryAllByRole('img', { name })

// ── 1. The normal path ───────────────────────────────────────────────────────

describe('a text send settles through the canonical path', () => {
  test('optimistic sending, then the settled status, in one row carrying one clientMessageId', async () => {
    const chat = chatId('normal')
    await open(chat)
    const answer = deferred()
    sendReplies.push({ pending: answer.promise })

    await sendText('Выходите к 9:00')

    expect(sendBodies).toHaveLength(1)
    expect(sendBodies[0]).toMatchObject({ chatId: chat, content: 'Выходите к 9:00', channel: 'max' })
    expect(sendBodies[0].clientMessageId).toMatch(/^cmid-/)
    expect(screen.getAllByText('Выходите к 9:00')).toHaveLength(1)
    expect(statuses(SENDING)).toHaveLength(1)

    answer.resolve({ status: 200, body: { success: true, id: 'msg_1', status: 'delivered', clientMessageId: sendBodies[0].clientMessageId } })
    await settled()

    expect(screen.getAllByText('Выходите к 9:00')).toHaveLength(1)
    expect(statuses(SENDING)).toHaveLength(0)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })

  test('a transport that accepted without proof shows as sent, not delivered', async () => {
    const chat = chatId('pending')
    await open(chat)
    sendReplies.push({ status: 200, body: { success: true, id: 'msg_p', status: 'sent', deliveryConfirmed: false } })

    await sendText('Принято')

    expect(statuses(SENT)).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(0)
  })

  test('two taps before the composer re-renders send one intent', async () => {
    const chat = chatId('double-tap')
    await open(chat)
    sendReplies.push({ status: 200, body: { success: true, id: 'msg_dt', status: 'delivered' } })
    sendReplies.push({ status: 200, body: { success: true, id: 'msg_dt2', status: 'delivered' } })
    type('Один раз')
    const button = sendButton()

    // Both taps land before React re-renders the cleared composer.
    await act(async () => {
      button.click()
      button.click()
    })
    await settled()

    expect(sendBodies).toHaveLength(1)
    expect(screen.getAllByText('Один раз')).toHaveLength(1)
  })

  test('the same text sent twice on purpose is two intents, never merged by content', async () => {
    const chat = chatId('same-text')
    await open(chat)
    sendReplies.push({ status: 200, body: { success: true, id: 'msg_a', status: 'delivered' } })
    sendReplies.push({ status: 200, body: { success: true, id: 'msg_b', status: 'delivered' } })

    await sendText('Ок')
    await sendText('Ок')

    expect(sendBodies).toHaveLength(2)
    expect(sendBodies[0].clientMessageId).not.toBe(sendBodies[1].clientMessageId)
    expect(screen.getAllByText('Ок')).toHaveLength(2)
  })
})

// ── 2. Failure, and what «Повторить» means ───────────────────────────────────

describe('failures and retry', () => {
  test('a terminal delivery failure is shown and not offered for retry', async () => {
    const chat = chatId('terminal')
    await open(chat)
    sendReplies.push({ status: 200, body: { success: false, id: 'msg_t', status: 'failed', error: 'Контакт не найден в MAX', retryable: false, deliveryOutcome: 'terminal' } })

    await sendText('Не дойдёт')

    expect(statuses(NOT_SENT)).toHaveLength(1)
    expect(screen.queryByText(RETRY)).toBeNull()
  })

  test('an unknown delivery outcome says so and is never offered for retry', async () => {
    const chat = chatId('unknown')
    await open(chat)
    sendReplies.push({ status: 200, body: { success: false, id: 'msg_u', status: 'failed', error: 'Timeout: MAX Web reply', retryable: false, deliveryOutcome: 'unknown' } })

    await sendText('Может быть дошло')

    expect(statuses(UNKNOWN)).toHaveLength(1)
    expect(screen.getByText('Статус неизвестен')).toBeTruthy()
    expect(screen.queryByText(RETRY)).toBeNull()
  })

  test('an HTTP error leaves the intent unanswered; «Повторить» resends it with the SAME clientMessageId', async () => {
    quietConsole()
    const chat = chatId('http-error')
    await open(chat)
    sendReplies.push({ status: 500, body: { error: 'Internal Server Error' } })

    await sendText('Повтор того же')

    expect(statuses(NOT_SENT)).toHaveLength(1)
    const retry = deferred()
    sendReplies.push({ pending: retry.promise })
    fireEvent.click(screen.getByText(RETRY))
    await settled()

    expect(sendBodies).toHaveLength(2)
    expect(sendBodies[1].clientMessageId).toBe(sendBodies[0].clientMessageId)
    expect(sendBodies[1]).toMatchObject({ chatId: chat, content: 'Повтор того же', channel: 'max' })
    expect(statuses(SENDING)).toHaveLength(1)

    retry.resolve({ status: 200, body: { success: true, id: 'msg_h', status: 'delivered' } })
    await settled()
    expect(statuses(DELIVERED)).toHaveLength(1)
    expect(screen.getAllByText('Повтор того же')).toHaveLength(1)
  })

  test('a lost answer: the resent intent is answered with the row the server already has', async () => {
    quietConsole()
    const chat = chatId('lost')
    await open(chat)
    sendReplies.push({ network: true })

    await sendText('Ответ потерялся')
    expect(statuses(NOT_SENT)).toHaveLength(1)

    sendReplies.push({ status: 200, body: { success: true, duplicate: true, id: 'msg_l', status: 'delivered', clientMessageId: sendBodies[0].clientMessageId } })
    fireEvent.click(screen.getByText(RETRY))
    await settled()

    expect(sendBodies.map((body) => body.clientMessageId)).toEqual([sendBodies[0].clientMessageId, sendBodies[0].clientMessageId])
    expect(screen.getAllByText('Ответ потерялся')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })

  test('two taps on «Повторить» for an unanswered intent resend it once', async () => {
    quietConsole()
    const chat = chatId('resend-double')
    await open(chat)
    sendReplies.push({ network: true })
    await sendText('Один повтор')
    sendReplies.push({ pending: new Promise(() => {}) })
    sendReplies.push({ pending: new Promise(() => {}) })
    const button = screen.getByText(RETRY)

    await act(async () => {
      button.click()
      button.click()
    })

    expect(sendBodies).toHaveLength(2)
    expect(sendBodies[1].clientMessageId).toBe(sendBodies[0].clientMessageId)
  })

  test('a canonical report settles an unanswered intent without any retry', async () => {
    quietConsole()
    const chat = chatId('lost-then-sse')
    await open(chat)
    sendReplies.push({ network: true })
    await sendText('Сервер знает')

    act(() => push(chat, canonical(sendBodies[0], 'msg_s', 'delivered')))
    await settled()

    expect(statuses(DELIVERED)).toHaveLength(1)
    expect(screen.queryByText(RETRY)).toBeNull()
    expect(sendBodies).toHaveLength(1)
  })

  test('a safe failure answered by the owner offers «Повторить» for that persisted row', async () => {
    const chat = chatId('safe-answer')
    const retry = vi.fn<RetryPersistedDelivery>(() => new Promise(() => {}))
    await open(chat, retry)
    sendReplies.push({ status: 200, body: { success: false, id: 'msg_sa', status: 'failed', error: 'ECONNREFUSED', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 } })

    await sendText('Безопасно повторить')
    fireEvent.click(screen.getByText(RETRY))
    await settled()

    expect(retry).toHaveBeenCalledWith('msg_sa')
    expect(sendBodies).toHaveLength(1)
  })

  test.each([
    ['a v1 row marked retryable with no outcome', { error: 'Timeout', errorCode: 'TIMEOUT', retryable: true }],
    ['a v1 row with schema version 1', { error: 'Timeout', errorCode: 'TIMEOUT', retryable: true, errorSchemaVersion: 1 }],
    ['a safe outcome without a schema version', { error: 'ECONNREFUSED', retryable: true, deliveryOutcome: 'safe_to_redeliver' }],
    ['an unknown outcome marked retryable', { error: 'Timeout', retryable: true, deliveryOutcome: 'unknown', errorSchemaVersion: 2 }],
  ])('a persisted failure that is %s offers no «Повторить»', async (_name, metadata) => {
    const chat = chatId('legacy')
    const legacy: Message = {
      id: 'msg_legacy', clientMessageId: 'cmid-legacy', direction: 'outbound', type: 'text', content: 'Старая ошибка',
      sentAt: '2026-09-18T08:01:00.000Z', status: 'failed', channel: 'max', metadata,
    }
    const retry = vi.fn<RetryPersistedDelivery>()
    await open(chat, retry, legacy)

    expect(screen.getByText('Старая ошибка')).toBeTruthy()
    expect(screen.queryByText(RETRY)).toBeNull()
    expect(retry).not.toHaveBeenCalled()
  })

  test('«Повторить» on a persisted failure retries that message, not a new send', async () => {
    const chat = chatId('persisted')
    const failed: Message = {
      id: 'msg_f', clientMessageId: 'cmid-original', direction: 'outbound', type: 'text', content: 'Сохранённая ошибка',
      sentAt: '2026-09-18T08:01:00.000Z', status: 'failed', channel: 'max',
      metadata: { error: 'ECONNREFUSED', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 },
    }
    let resolveRetry!: (value: Awaited<ReturnType<RetryPersistedDelivery>>) => void
    const retry = vi.fn<RetryPersistedDelivery>(() => new Promise((resolve) => { resolveRetry = resolve }))
    await open(chat, retry, failed)

    fireEvent.click(screen.getByText(RETRY))
    await settled()
    expect(statuses(SENDING)).toHaveLength(1)

    resolveRetry({ ok: true, error: null, message: { id: 'msg_f', status: 'delivered', externalId: null, error: null, retryable: false, deliveryOutcome: null, errorSchemaVersion: null } })
    await settled()

    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('msg_f')
    expect(sendBodies).toHaveLength(0)
    expect(screen.getAllByText('Сохранённая ошибка')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })

  test('a second tap on «Повторить» while the retry runs does not start another', async () => {
    const chat = chatId('retry-double')
    const failed: Message = {
      id: 'msg_rd', clientMessageId: 'cmid-rd', direction: 'outbound', type: 'text', content: 'Двойной повтор',
      sentAt: '2026-09-18T08:01:00.000Z', status: 'failed', channel: 'max',
      metadata: { error: 'ECONNREFUSED', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 },
    }
    const retry = vi.fn<RetryPersistedDelivery>(() => new Promise(() => {}))
    await open(chat, retry, failed)
    const button = screen.getByText(RETRY)

    await act(async () => {
      button.click()
      button.click()
    })

    expect(retry).toHaveBeenCalledTimes(1)
  })

  test('a retry the owner refuses shows the canonical failure it reports', async () => {
    const chat = chatId('retry-refused')
    const failed: Message = {
      id: 'msg_rr', clientMessageId: 'cmid-rr', direction: 'outbound', type: 'text', content: 'Отказ',
      sentAt: '2026-09-18T08:01:00.000Z', status: 'failed', channel: 'max',
      metadata: { error: 'ECONNREFUSED', retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 },
    }
    const retry = vi.fn<RetryPersistedDelivery>(async () => ({
      ok: false,
      error: 'Timeout: MAX Web reply',
      message: { id: 'msg_rr', status: 'failed', externalId: null, error: 'Timeout: MAX Web reply', retryable: false, deliveryOutcome: 'unknown', errorSchemaVersion: 2 },
    }))
    await open(chat, retry, failed)

    fireEvent.click(screen.getByText(RETRY))
    await settled()

    expect(statuses(UNKNOWN)).toHaveLength(1)
    expect(screen.queryByText(RETRY)).toBeNull()
  })
})

// ── 3. Reports arriving out of order ─────────────────────────────────────────

describe('SSE, poll and answer in any order settle one row', () => {
  test('SSE created row, then SSE settled row, then the late answer', async () => {
    const chat = chatId('sse-first')
    await open(chat)
    const answer = deferred()
    sendReplies.push({ pending: answer.promise })
    await sendText('Гонка')
    const body = sendBodies[0]

    act(() => push(chat, canonical(body, 'msg_r', 'sent')))
    await settled()
    // Accepted, not settled: still one row, still sending.
    expect(screen.getAllByText('Гонка')).toHaveLength(1)
    expect(statuses(SENDING)).toHaveLength(1)

    act(() => push(chat, canonical(body, 'msg_r', 'delivered')))
    await settled()
    expect(screen.getAllByText('Гонка')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)

    answer.resolve({ status: 200, body: { success: true, id: 'msg_r', status: 'delivered' } })
    await settled()
    expect(screen.getAllByText('Гонка')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })

  test('the created row pushed after the settled row cannot move it back', async () => {
    const chat = chatId('late-created')
    await open(chat)
    sendReplies.push({ pending: new Promise(() => {}) })
    await sendText('Порядок')
    const body = sendBodies[0]

    act(() => push(chat, canonical(body, 'msg_lc', 'delivered')))
    await settled()
    act(() => push(chat, canonical(body, 'msg_lc', 'sent')))
    await settled()

    expect(screen.getAllByText('Порядок')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
    expect(statuses(SENT)).toHaveLength(0)
  })

  test('a stale answer arriving after the settled row cannot move it back', async () => {
    const chat = chatId('stale-answer')
    await open(chat)
    const answer = deferred()
    sendReplies.push({ pending: answer.promise })
    await sendText('Не назад')
    const body = sendBodies[0]

    act(() => push(chat, canonical(body, 'msg_st', 'delivered')))
    await settled()
    answer.resolve({ status: 200, body: { success: true, duplicate: true, id: 'msg_st', status: 'sent' } })
    await settled()

    expect(statuses(DELIVERED)).toHaveLength(1)
    expect(statuses(SENT)).toHaveLength(0)
  })

  test('a poll that already holds the canonical row does not duplicate the optimistic one', async () => {
    const chat = chatId('poll')
    await open(chat)
    const answer = deferred()
    sendReplies.push({ pending: answer.promise })
    await sendText('Опрос')
    const body = sendBodies[0]

    history(chat, inbound(chat), canonical(body, 'msg_po', 'sent') as Message)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settled()

    expect(screen.getAllByText('Опрос')).toHaveLength(1)
    expect(statuses(SENDING)).toHaveLength(1)

    answer.resolve({ status: 200, body: { success: true, id: 'msg_po', status: 'delivered' } })
    await settled()
    expect(screen.getAllByText('Опрос')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })

  test('a reaction update without a status does not disturb delivery state', async () => {
    const chat = chatId('reaction')
    await open(chat)
    sendReplies.push({ status: 200, body: { success: true, id: 'msg_re', status: 'delivered' } })
    await sendText('С реакцией')

    act(() => push(chat, { id: 'msg_re', metadata: { reactions: [{ emoji: '👍' }] } }))
    await settled()

    expect(statuses(DELIVERED)).toHaveLength(1)
  })
})

// ── 4. Switching conversations while a send is pending ───────────────────────

describe('a late answer belongs to the conversation it was sent from', () => {
  test('A pending → switch to B → A answers: B is untouched; A shows the settled row', async () => {
    const chatA = chatId('switch-a')
    const chatB = chatId('switch-b')
    const view = await open(chatA)
    const answer = deferred()
    sendReplies.push({ pending: answer.promise })
    await sendText('Только для A')
    expect(sendBodies[0].chatId).toBe(chatA)

    history(chatB, { id: 'b-in', direction: 'inbound', type: 'text', content: 'Сообщение B', sentAt: '2026-09-18T08:00:00.000Z', status: 'delivered', channel: 'max' })
    view.rerender(<Conversation chatId={chatB} />)
    await screen.findByText('Сообщение B')

    answer.resolve({ status: 200, body: { success: true, id: 'msg_a', status: 'delivered' } })
    await settled()

    expect(screen.queryByText('Только для A')).toBeNull()
    expect(statuses(DELIVERED)).toHaveLength(0)
    expect(screen.getByText('Сообщение B')).toBeTruthy()

    view.rerender(<Conversation chatId={chatA} />)
    await settled()
    expect(screen.getAllByText('Только для A')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })

  test('switching away and back before the answer: the remounted view of A still settles', async () => {
    const chatA = chatId('back-a')
    const chatB = chatId('back-b')
    const view = await open(chatA)
    const answer = deferred()
    sendReplies.push({ pending: answer.promise })
    await sendText('Вернулся')

    history(chatB, { id: 'bb-in', direction: 'inbound', type: 'text', content: 'Другой чат', sentAt: '2026-09-18T08:00:00.000Z', status: 'delivered', channel: 'max' })
    view.rerender(<Conversation chatId={chatB} />)
    await screen.findByText('Другой чат')
    view.rerender(<Conversation chatId={chatA} />)
    await settled()
    expect(statuses(SENDING)).toHaveLength(1)

    answer.resolve({ status: 200, body: { success: true, id: 'msg_back', status: 'delivered' } })
    await settled()

    expect(screen.getAllByText('Вернулся')).toHaveLength(1)
    expect(statuses(DELIVERED)).toHaveLength(1)
  })
})
