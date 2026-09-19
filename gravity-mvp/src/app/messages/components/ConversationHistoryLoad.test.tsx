import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/messages',
}))

import MessageFeed from './MessageFeed'
import { fetchMessageHistory, prefetchMessages, useMessages, type Message } from '../hooks/useMessages'

// ── Fixtures: the same conversations the Android acceptance seed creates ─────

const TG_GREETING = 'Здравствуйте, это тестовый диалог Telegram.'
const TG_REPLY = 'Это тестовый ответ оператора.'
const WA_MESSAGE = 'Тестовое сообщение WhatsApp.'

const EMPTY = 'Нет сообщений'
const FAILED = 'Не удалось загрузить сообщения'
const RETRY = 'Повторить'

function message(id: string, direction: Message['direction'], channel: string, content: string, sentAt: string): Message {
  return { id, direction, type: 'text', content, sentAt, status: 'delivered', channel }
}

const telegramHistory = [
  message('tg-1', 'inbound', 'telegram', TG_GREETING, '2026-09-17T09:00:00.000Z'),
  message('tg-2', 'outbound', 'telegram', TG_REPLY, '2026-09-17T09:01:00.000Z'),
]
const whatsappHistory = [
  message('wa-1', 'inbound', 'whatsapp', WA_MESSAGE, '2026-09-17T09:02:00.000Z'),
]

// The message cache is module state shared by every test in this file, exactly
// as it is shared by every conversation in the app. Unique ids keep tests
// independent without reaching into it.
let sequence = 0
const chatId = (name: string) => `${name}-${++sequence}`

// ── Fake transport ───────────────────────────────────────────────────────────

type Reply =
  | { status: number; body: unknown }
  | { status: number; invalidJson: true }
  | { network: true }
  | { pending: Promise<Reply> }

const replies = new Map<string, Reply[]>()
const requestedChats: string[] = []

function reply(id: string, ...queue: Reply[]) {
  replies.set(id, [...(replies.get(id) ?? []), ...queue])
}

function deferred() {
  let resolve!: (value: Reply) => void
  const promise = new Promise<Reply>((r) => { resolve = r })
  return { promise, resolve }
}

async function respond(next: Reply): Promise<unknown> {
  if ('pending' in next) return respond(await next.pending)
  if ('network' in next) throw new TypeError('Failed to fetch')
  if ('invalidJson' in next) {
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => { throw new SyntaxError('Unexpected token') } }
  }
  return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body }
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const id = new URL(input, 'http://crm.test').searchParams.get('chatId') ?? ''
    requestedChats.push(id)
    const queue = replies.get(id) ?? []
    const next = queue.shift()
    if (!next) throw new Error(`test transport has no reply queued for chat ${id}`)
    return respond(next)
  }))
  // jsdom has neither; the hook only needs them to exist.
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} })
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const quietConsole = () => vi.spyOn(console, 'error').mockImplementation(() => {})

// ── The read pane as the app composes it ─────────────────────────────────────

function ReadPane({ chatId: id }: { chatId: string }) {
  const history = useMessages(id)
  return (
    <MessageFeed
      chatId={id}
      channelTab="all"
      uiItems={history.uiItems}
      isLoading={history.isLoading}
      hasLoadedHistory={history.hasLoadedHistory}
      historyLoadFailed={history.historyLoadFailed}
      isRetryingHistory={history.isRetryingHistory}
      onRetryHistoryLoad={() => { void history.retryHistoryLoad() }}
      hasMoreHistory={history.hasMoreHistory}
      onLoadMore={history.loadMoreHistory}
    />
  )
}

// The same remount boundary ChatWorkspace applies: key={effectiveChatId}.
function Conversation({ chatId: id }: { chatId: string }) {
  return <ReadPane key={id} chatId={id} />
}

const settled = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

// ── 1. Classifying a single read ─────────────────────────────────────────────

describe('fetchMessageHistory classifies a read, never guessing empty', () => {
  test('HTTP 200 with messages is a loaded conversation', async () => {
    const id = chatId('classify-ok')
    reply(id, { status: 200, body: [{ ...telegramHistory[0], channel: undefined }] })
    const result = await fetchMessageHistory(id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages.map((m) => m.content)).toEqual([TG_GREETING])
      expect(result.messages[0].channel).toBe('whatsapp') // existing channel fallback kept
    }
  })

  test('HTTP 200 with [] is a genuine empty conversation', async () => {
    const id = chatId('classify-empty')
    reply(id, { status: 200, body: [] })
    expect(await fetchMessageHistory(id)).toEqual({ ok: true, messages: [] })
  })

  test('a non-2xx status is a failure and its body is not read as a list', async () => {
    const id = chatId('classify-500')
    reply(id, { status: 500, body: [] }) // even an array body must not count
    expect(await fetchMessageHistory(id)).toEqual({ ok: false, reason: 'http', status: 500 })
  })

  test('HTTP 200 with a non-array payload is a failure, not empty', async () => {
    const id = chatId('classify-object')
    reply(id, { status: 200, body: { error: 'Internal Server Error' } })
    expect(await fetchMessageHistory(id)).toEqual({ ok: false, reason: 'malformed', status: 200 })
  })

  test('HTTP 200 with an unparseable body is a failure, not empty', async () => {
    const id = chatId('classify-json')
    reply(id, { status: 200, invalidJson: true })
    expect(await fetchMessageHistory(id)).toEqual({ ok: false, reason: 'malformed', status: 200 })
  })

  test('a network rejection is a failure', async () => {
    const id = chatId('classify-network')
    reply(id, { network: true })
    expect(await fetchMessageHistory(id)).toEqual({ ok: false, reason: 'network' })
  })
})

// ── 2. What the operator sees ────────────────────────────────────────────────

describe('conversation history, as the operator sees it', () => {
  test('a conversation with messages shows its history and no empty or error state', async () => {
    const id = chatId('visible-ok')
    reply(id, { status: 200, body: telegramHistory })
    render(<Conversation chatId={id} />)

    expect(await screen.findByText(TG_GREETING)).toBeTruthy()
    expect(screen.getByText(TG_REPLY)).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  test('a successful empty conversation says «Нет сообщений» and is not an error', async () => {
    const id = chatId('visible-empty')
    reply(id, { status: 200, body: [] })
    render(<Conversation chatId={id} />)

    expect(await screen.findByText(EMPTY)).toBeTruthy()
    expect(screen.queryByText(FAILED)).toBeNull()
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull()
  })

  test('an HTTP 500 shows an explicit failure with Retry, never «Нет сообщений»', async () => {
    quietConsole()
    const id = chatId('visible-500')
    reply(id, { status: 500, body: { error: 'Internal Server Error' } })
    render(<Conversation chatId={id} />)

    expect(await screen.findByText(FAILED)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: RETRY })).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  test('a malformed success payload shows the failure, not a false empty conversation', async () => {
    quietConsole()
    const id = chatId('visible-malformed')
    reply(id, { status: 200, body: { data: telegramHistory } })
    render(<Conversation chatId={id} />)

    expect(await screen.findByText(FAILED)).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  test('a network failure shows the failure state', async () => {
    quietConsole()
    const id = chatId('visible-network')
    reply(id, { network: true })
    render(<Conversation chatId={id} />)

    expect(await screen.findByText(FAILED)).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  test('«Нет сообщений» is not shown while the first read is still pending', async () => {
    const id = chatId('visible-pending')
    const slow = deferred()
    reply(id, { pending: slow.promise })
    render(<Conversation chatId={id} />)
    await settled()

    expect(screen.queryByText(EMPTY)).toBeNull()
    expect(screen.queryByText(FAILED)).toBeNull()

    await act(async () => { slow.resolve({ status: 200, body: telegramHistory }) })
    expect(await screen.findByText(TG_GREETING)).toBeTruthy()
  })
})

// ── 3. Retry ─────────────────────────────────────────────────────────────────

describe('retrying a failed first read', () => {
  test('Retry reloads the current conversation and replaces the error with its history', async () => {
    quietConsole()
    const id = chatId('retry-ok')
    reply(id, { status: 500, body: { error: 'down' } }, { status: 200, body: telegramHistory })
    render(<Conversation chatId={id} />)

    fireEvent.click(await screen.findByRole('button', { name: RETRY }))

    expect(await screen.findByText(TG_GREETING)).toBeTruthy()
    expect(screen.getByText(TG_REPLY)).toBeTruthy()
    expect(screen.queryByText(FAILED)).toBeNull()
    expect(screen.queryByText(EMPTY)).toBeNull()
    expect(requestedChats.filter((c) => c === id)).toHaveLength(2)
  })

  test('Retry that finds a genuinely empty conversation shows «Нет сообщений»', async () => {
    quietConsole()
    const id = chatId('retry-empty')
    reply(id, { network: true }, { status: 200, body: [] })
    render(<Conversation chatId={id} />)

    fireEvent.click(await screen.findByRole('button', { name: RETRY }))

    expect(await screen.findByText(EMPTY)).toBeTruthy()
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  test('a pending retry cannot be stormed: repeated taps send one request', async () => {
    quietConsole()
    const id = chatId('retry-storm')
    const slow = deferred()
    reply(id, { status: 503, body: {} }, { pending: slow.promise })
    render(<Conversation chatId={id} />)

    fireEvent.click(await screen.findByRole('button', { name: RETRY }))
    // While pending the control reads «Загрузка…» and is disabled.
    const pendingButton = () => screen.getByRole('button', { name: /Повторить|Загрузка…/ }) as HTMLButtonElement
    await waitFor(() => expect(pendingButton().disabled).toBe(true))
    expect(pendingButton().textContent).toBe('Загрузка…')
    for (let i = 0; i < 5; i++) fireEvent.click(pendingButton())
    await settled()

    expect(requestedChats.filter((c) => c === id)).toHaveLength(2)

    await act(async () => { slow.resolve({ status: 200, body: whatsappHistory }) })
    expect(await screen.findByText(WA_MESSAGE)).toBeTruthy()
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  test('a retry that fails again keeps the failure visible and Retry usable', async () => {
    quietConsole()
    const id = chatId('retry-fails')
    reply(id, { status: 500, body: {} }, { status: 502, body: {} })
    render(<Conversation chatId={id} />)

    fireEvent.click(await screen.findByRole('button', { name: RETRY }))
    await waitFor(() => expect(requestedChats.filter((c) => c === id)).toHaveLength(2))
    await settled()

    expect(screen.getByText(FAILED)).toBeTruthy()
    expect((screen.getByRole('button', { name: RETRY }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(EMPTY)).toBeNull()
  })
})

// ── 4. Cached history and background refresh ─────────────────────────────────

describe('cached history survives a failed background refresh', () => {
  test('cached history stays on screen when revalidation fails', async () => {
    quietConsole()
    const id = chatId('cache-revalidate')
    reply(id, { status: 200, body: telegramHistory })
    await prefetchMessages(id) // a real successful read warms the cache

    reply(id, { status: 500, body: { error: 'down' } })
    render(<Conversation chatId={id} />)

    // Visible at once, from cache, before the background read settles.
    expect(screen.getByText(TG_GREETING)).toBeTruthy()

    await waitFor(() => expect(requestedChats.filter((c) => c === id)).toHaveLength(2))
    await settled()

    expect(screen.getByText(TG_GREETING)).toBeTruthy()
    expect(screen.getByText(TG_REPLY)).toBeTruthy()
    expect(screen.queryByText(FAILED)).toBeNull()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  test('a failed prefetch leaves nothing in the cache to pass off as history', async () => {
    quietConsole()
    const id = chatId('cache-failed-prefetch')
    reply(id, { status: 500, body: [] })
    await prefetchMessages(id)

    reply(id, { status: 500, body: {} })
    render(<Conversation chatId={id} />)

    expect(await screen.findByText(FAILED)).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })
})

// ── 5. Switching conversations ───────────────────────────────────────────────

describe('switching conversations never shows the previous conversation', () => {
  test('opening B after A shows only B history', async () => {
    const a = chatId('switch-tg')
    const b = chatId('switch-wa')
    reply(a, { status: 200, body: telegramHistory })
    reply(b, { status: 200, body: whatsappHistory })

    const { rerender } = render(<Conversation chatId={a} />)
    expect(await screen.findByText(TG_GREETING)).toBeTruthy()

    rerender(<Conversation chatId={b} />)
    expect(await screen.findByText(WA_MESSAGE)).toBeTruthy()
    expect(screen.queryByText(TG_GREETING)).toBeNull()
    expect(screen.queryByText(TG_REPLY)).toBeNull()
  })

  test('a late response for A cannot land in B after the switch', async () => {
    const a = chatId('late-tg')
    const b = chatId('late-wa')
    const slowA = deferred()
    reply(a, { pending: slowA.promise })
    reply(b, { status: 200, body: whatsappHistory })

    const { rerender } = render(<Conversation chatId={a} />)
    await settled()
    rerender(<Conversation chatId={b} />)
    expect(await screen.findByText(WA_MESSAGE)).toBeTruthy()

    await act(async () => { slowA.resolve({ status: 200, body: telegramHistory }) })
    await settled()

    expect(screen.getByText(WA_MESSAGE)).toBeTruthy()
    expect(screen.queryByText(TG_GREETING)).toBeNull()
    expect(screen.queryByText(TG_REPLY)).toBeNull()
  })

  test('B failing to load shows B failure, not A cached history', async () => {
    quietConsole()
    const a = chatId('fail-after-tg')
    const b = chatId('fail-after-wa')
    reply(a, { status: 200, body: telegramHistory })
    reply(b, { status: 500, body: {} })

    const { rerender } = render(<Conversation chatId={a} />)
    expect(await screen.findByText(TG_GREETING)).toBeTruthy()

    rerender(<Conversation chatId={b} />)
    expect(await screen.findByText(FAILED)).toBeTruthy()
    expect(screen.queryByText(TG_GREETING)).toBeNull()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  test('the hook alone keeps history keyed to its chat even without a remount', async () => {
    const a = chatId('unkeyed-tg')
    const b = chatId('unkeyed-wa')
    reply(a, { status: 200, body: telegramHistory })
    reply(b, { status: 200, body: whatsappHistory })

    const { rerender } = render(<ReadPane chatId={a} />)
    expect(await screen.findByText(TG_GREETING)).toBeTruthy()

    rerender(<ReadPane chatId={b} />)
    // The previous chat's history is cleared immediately, whatever happens next.
    expect(screen.queryByText(TG_GREETING)).toBeNull()
    expect(screen.queryByText(TG_REPLY)).toBeNull()
  })
})
