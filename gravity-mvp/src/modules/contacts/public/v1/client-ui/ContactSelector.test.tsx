/**
 * ContactSelector proven as a picker that can only ever select a concrete
 * ContactLookup.v1 item.
 *
 * These tests pin what the selector must NOT do as much as what it shows: it
 * never turns typed text into a selection, never auto-selects on Enter, Blur or
 * Tab, never lets a slow answer for an old query replace a newer one, never
 * re-orders or re-composes what the lookup returned, and never renders a value
 * the lookup item does not own — however much extra data a transport smuggles in.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

import ContactSelector, { CONTACT_SELECTOR_DEBOUNCE_MS, type ContactLookupClientV1 } from './ContactSelector'
import type { ContactLookupItemV1, ContactLookupResultV1 } from '../contact-lookup'

function item(contactId: string, displayTitle: string, channels: string[] = []): ContactLookupItemV1 {
  return { contactId, displayName: displayTitle, displayTitle, primaryPhone: null, channels }
}

const IVAN = item('contact-ivan', 'Иван Петров · +7 900 123-45-67', ['telegram', 'whatsapp'])
const PETR = item('contact-petr', 'Пётр Сидоров', ['max'])
const ANNA = item('contact-anna', 'Анна Смирнова', [])

function result(items: ContactLookupItemV1[], truncated = false): ContactLookupResultV1 {
  return { items, total: items.length, truncated }
}

/** A lookup whose answers the test releases explicitly, in any order. */
function controlledLookup() {
  const calls: Array<{ query: string; resolve: (value: ContactLookupResultV1) => void; reject: (error: unknown) => void }> = []
  const lookup: ContactLookupClientV1 = vi.fn((input: { query: string }) => new Promise<ContactLookupResultV1>((resolve, reject) => {
    calls.push({ query: input.query, resolve, reject })
  }))
  return { lookup, calls }
}

/** A controlled host that records every committed selection. */
function Harness(props: {
  lookup: ContactLookupClientV1
  initial?: ContactLookupItemV1 | null
  disabled?: boolean
  onCommit?: (value: ContactLookupItemV1 | null) => void
}) {
  const [value, setValue] = useState<ContactLookupItemV1 | null>(props.initial ?? null)
  return (
    <ContactSelector
      label="Контакт для объединения"
      lookup={props.lookup}
      value={value}
      disabled={props.disabled}
      onChange={(next) => {
        props.onCommit?.(next)
        setValue(next)
      }}
    />
  )
}

function input(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } })
}

async function flushDebounce() {
  await act(async () => { vi.advanceTimersByTime(CONTACT_SELECTOR_DEBOUNCE_MS) })
}

async function settle() {
  await act(async () => { await Promise.resolve() })
}

function key(name: string) {
  fireEvent.keyDown(input(), { key: name })
}

function options(): HTMLElement[] {
  return screen.queryAllByRole('option')
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ContactSelector states', () => {
  it('starts idle with a labelled, collapsed combobox and no results', () => {
    const { lookup } = controlledLookup()
    render(<Harness lookup={lookup} />)
    const box = input()
    expect(box).toHaveProperty('value', '')
    expect(box.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('combobox', { name: 'Контакт для объединения' })).toBe(box)
    expect(options()).toHaveLength(0)
    expect(screen.queryByTestId('contact-selector-empty')).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('asks the lookup only after the debounce, and only for a query the contract accepts', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    for (const refused of ['', ' ', 'и', '12', '+7']) {
      type(refused)
      await flushDebounce()
    }
    expect(lookup).not.toHaveBeenCalled()

    type('Иван')
    await act(async () => { vi.advanceTimersByTime(CONTACT_SELECTOR_DEBOUNCE_MS - 1) })
    expect(lookup).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(calls[0].query).toBe('Иван')
  })

  it('shows a loading state while the latest valid query is pending', async () => {
    const { lookup } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Иван')
    expect(screen.getByTestId('contact-selector-loading').textContent).toContain('Поиск')
    await flushDebounce()
    expect(screen.getByTestId('contact-selector-loading')).toBeTruthy()
    expect(options()).toHaveLength(0)
  })

  it('renders results in exactly the order the lookup returned', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result([PETR, ANNA, IVAN]))
    await settle()
    expect(options().map(option => option.textContent)).toEqual([
      'Пётр СидоровMAX',
      'Анна Смирнова',
      'Иван Петров · +7 900 123-45-67Telegram · WhatsApp',
    ])
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('contact-selector-status').textContent).toBe('Найдено контактов: 3')
  })

  it('shows the empty state only after a valid query completed with no items', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Нико')
    expect(screen.queryByTestId('contact-selector-empty')).toBeNull()
    await flushDebounce()
    expect(screen.queryByTestId('contact-selector-empty')).toBeNull()
    calls[0].resolve(result([]))
    await settle()
    expect(screen.getByTestId('contact-selector-empty').textContent).toBe('Контакты не найдены')
    expect(screen.getByTestId('contact-selector-status').textContent).toBe('Контакты не найдены')
  })

  it('shows a generic error, never the raw cause, and keeps the committed selection', async () => {
    const { lookup, calls } = controlledLookup()
    const commits: Array<ContactLookupItemV1 | null> = []
    render(<Harness lookup={lookup} initial={IVAN} onCommit={next => commits.push(next)} />)
    // Typing away un-commits by design; the failure itself must commit nothing more.
    type('Петр')
    await flushDebounce()
    const before = commits.length
    calls[0].reject(new Error('PrismaClientKnownRequestError P2024 at db.internal:5432 secret-token-123'))
    await settle()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Не удалось выполнить поиск контактов.')
    expect(document.body.innerHTML).not.toContain('P2024')
    expect(document.body.innerHTML).not.toContain('secret-token-123')
    expect(document.body.innerHTML).not.toContain('db.internal')
    expect(commits.length).toBe(before)
  })

  it('treats a synchronously throwing lookup as the same generic error', async () => {
    const lookup: ContactLookupClientV1 = () => { throw new Error('transport exploded: token=abc') }
    render(<Harness lookup={lookup} />)
    type('Иван')
    await flushDebounce()
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Не удалось выполнить поиск контактов.')
    expect(document.body.innerHTML).not.toContain('token=abc')
  })

  it('shows a non-selectable footer when the lookup truncated', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result([IVAN, PETR], true))
    await settle()
    const footer = screen.getByTestId('contact-selector-truncated')
    expect(footer.textContent).toBe('Показаны первые результаты — уточните поиск.')
    expect(footer.getAttribute('role')).toBeNull()
    expect(options()).toHaveLength(2)
  })

  it('returns to idle, hiding stale results, when the query becomes invalid', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Иван')
    await flushDebounce()
    calls[0].resolve(result([IVAN]))
    await settle()
    expect(options()).toHaveLength(1)
    type('И')
    expect(options()).toHaveLength(0)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('contact-selector-loading')).toBeNull()
  })
})

describe('ContactSelector selection', () => {
  async function openWith(items: ContactLookupItemV1[], onCommit?: (value: ContactLookupItemV1 | null) => void) {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} onCommit={onCommit} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result(items))
    await settle()
    return { lookup, calls }
  }

  it('selects exactly the clicked item and shows its title', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    await openWith([IVAN, PETR, ANNA], next => commits.push(next))
    fireEvent.click(options()[1])
    expect(commits).toEqual([PETR])
    expect(input().value).toBe('Пётр Сидоров')
    expect(options()).toHaveLength(0)
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps focus on the input across a pointer press so blur cannot steal the click', async () => {
    await openWith([IVAN])
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    options()[0].dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('moves with ArrowDown and ArrowUp and selects the highlighted option on Enter', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    await openWith([IVAN, PETR, ANNA], next => commits.push(next))
    key('ArrowDown')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    key('ArrowDown')
    key('ArrowDown')
    key('ArrowDown')
    expect(options()[2].getAttribute('aria-selected')).toBe('true')
    key('ArrowUp')
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id)
    key('Enter')
    expect(commits).toEqual([PETR])
    expect(input().value).toBe('Пётр Сидоров')
  })

  it('jumps to the first and last option with Home and End', async () => {
    await openWith([IVAN, PETR, ANNA])
    key('End')
    expect(options()[2].getAttribute('aria-selected')).toBe('true')
    key('Home')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
  })

  it('selects nothing on Enter when no option is highlighted', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    await openWith([IVAN, PETR], next => commits.push(next))
    key('Enter')
    expect(commits).toEqual([])
    expect(input().value).toBe('Ив')
  })

  it('closes on Escape without inventing a selection', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    await openWith([IVAN, PETR], next => commits.push(next))
    key('ArrowDown')
    key('Escape')
    expect(options()).toHaveLength(0)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().getAttribute('aria-activedescendant')).toBeNull()
    expect(commits).toEqual([])
    expect(input().value).toBe('Ив')
  })

  it('never auto-selects on Tab or blur, even with an option highlighted', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    await openWith([IVAN, PETR], next => commits.push(next))
    key('ArrowDown')
    key('Tab')
    fireEvent.blur(input())
    expect(commits).toEqual([])
    expect(input().value).toBe('Ив')
    expect(options()).toHaveLength(0)
  })

  it('never turns typed text into a selection', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    const { lookup } = controlledLookup()
    render(<Harness lookup={lookup} onCommit={next => commits.push(next)} />)
    type('Иван Петров · +7 900 123-45-67')
    key('Enter')
    fireEvent.blur(input())
    await flushDebounce()
    expect(commits).toEqual([])
  })

  it('un-commits a selection as soon as the operator edits its text', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} initial={IVAN} onCommit={next => commits.push(next)} />)
    expect(input().value).toBe(IVAN.displayTitle)
    type('Иван Петро')
    expect(commits).toEqual([null])
    // The text the operator typed survives the onChange(null) echo and is now a query.
    expect(input().value).toBe('Иван Петро')
    await flushDebounce()
    expect(calls.map(call => call.query)).toEqual(['Иван Петро'])
  })

  it('clears through an accessible button, commits null and returns focus', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    const { lookup } = controlledLookup()
    render(<Harness lookup={lookup} initial={IVAN} onCommit={next => commits.push(next)} />)
    const button = screen.getByRole('button', { name: 'Очистить выбор контакта' })
    fireEvent.click(button)
    expect(commits).toEqual([null])
    expect(input().value).toBe('')
    expect(document.activeElement).toBe(input())
    expect(screen.queryByRole('button', { name: 'Очистить выбор контакта' })).toBeNull()
  })

  it('follows a value cleared from outside without erasing operator typing', async () => {
    const { lookup } = controlledLookup()
    const { rerender } = render(
      <ContactSelector label="Контакт" lookup={lookup} value={IVAN} onChange={() => {}} />,
    )
    expect(input().value).toBe(IVAN.displayTitle)
    rerender(<ContactSelector label="Контакт" lookup={lookup} value={null} onChange={() => {}} />)
    expect(input().value).toBe('')
    rerender(<ContactSelector label="Контакт" lookup={lookup} value={PETR} onChange={() => {}} />)
    expect(input().value).toBe(PETR.displayTitle)
  })
})

describe('ContactSelector async correctness', () => {
  it('never lets a slow answer for an older query replace a newer one', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    type('Пёт')
    await flushDebounce()
    expect(calls.map(call => call.query)).toEqual(['Ив', 'Пёт'])
    calls[1].resolve(result([PETR]))
    await settle()
    calls[0].resolve(result([IVAN, ANNA]))
    await settle()
    expect(options().map(option => option.textContent)).toEqual(['Пётр СидоровMAX'])
  })

  it('ignores an older answer that arrives while the newer query is still pending', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    type('Пёт')
    await flushDebounce()
    calls[0].resolve(result([IVAN]))
    await settle()
    expect(options()).toHaveLength(0)
    expect(screen.getByTestId('contact-selector-loading')).toBeTruthy()
  })

  it('ignores an answer that arrives after a selection was committed', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} onCommit={next => commits.push(next)} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result([IVAN]))
    await settle()
    type('Ива')
    await flushDebounce()
    // Select is impossible now (the newer query is pending), but clear also
    // supersedes it: the late answer must not reopen the list.
    fireEvent.click(screen.getByRole('button', { name: 'Очистить выбор контакта' }))
    calls[1].resolve(result([IVAN, PETR]))
    await settle()
    expect(options()).toHaveLength(0)
    expect(commits).toEqual([null])
  })

  it('does not call the lookup or update state after unmount', async () => {
    const { lookup, calls } = controlledLookup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    type('Ива')
    unmount()
    await flushDebounce()
    expect(calls).toHaveLength(1)
    calls[0].resolve(result([IVAN]))
    await settle()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('ContactSelector boundary', () => {
  it('renders channel names as presentation only, never as a capability', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result([item('contact-x', 'Контакт X', ['telegram', 'some_future_channel'])]))
    await settle()
    const text = options()[0].textContent ?? ''
    expect(text).toContain('Telegram · some_future_channel')
    for (const claim of ['онлайн', 'доступен', 'недоступен', 'Написать', 'Доставлено', 'online', 'available', 'ready']) {
      expect(document.body.textContent?.toLowerCase()).not.toContain(claim.toLowerCase())
    }
  })

  it('renders the lookup title as given and never re-composes it from name and phone', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result([{
      contactId: 'contact-z',
      displayName: 'NAME-ONLY-SENTINEL',
      displayTitle: 'TITLE-FROM-LOOKUP',
      primaryPhone: 'PHONE-SENTINEL',
      channels: [],
    }]))
    await settle()
    expect(document.body.innerHTML).toContain('TITLE-FROM-LOOKUP')
    expect(document.body.innerHTML).not.toContain('NAME-ONLY-SENTINEL')
    expect(document.body.innerHTML).not.toContain('PHONE-SENTINEL')
  })

  it('never renders a provider, chat, route, reachability or Fleet value a transport smuggles in', async () => {
    const smuggled = {
      ...IVAN,
      externalId: 'EXT-902100000001',
      providerAccountId: 'PA-tg-bot-7712345678',
      providerTargetId: 'PT-79990001122@c.us',
      chatId: 'CHAT-cl9x0000smuggled',
      hasChat: { telegram: 'CHAT-cl9x0000smuggled' },
      conversationRoute: 'ROUTE-max-personal-0123',
      reachabilityStatus: 'REACH-confirmed-smuggled',
      sessionId: 'SESSION-abcdef',
      transportRef: 'TRANSPORT-max-personal-0123456789',
      driverId: 'DRIVER-smuggled-42',
      conflictState: 'CONFLICT-smuggled',
      metadata: { username: 'USERNAME-smuggled' },
    } as unknown as ContactLookupItemV1
    const { lookup, calls } = controlledLookup()
    const { container } = render(<Harness lookup={lookup} initial={smuggled} />)
    type('Ив')
    await flushDebounce()
    calls[0].resolve({ ...result([smuggled]), externalIds: ['EXT-RESULT-LEVEL'] } as unknown as ContactLookupResultV1)
    await settle()
    key('ArrowDown')
    const surface = [
      container.innerHTML,
      document.body.textContent ?? '',
      ...Array.from(container.querySelectorAll('*')).flatMap(element => Array.from(element.attributes).map(attribute => attribute.value)),
    ].join('\n')
    for (const value of [
      'EXT-902100000001', 'PA-tg-bot-7712345678', 'PT-79990001122@c.us', 'CHAT-cl9x0000smuggled',
      'ROUTE-max-personal-0123', 'REACH-confirmed-smuggled', 'SESSION-abcdef',
      'TRANSPORT-max-personal-0123456789', 'DRIVER-smuggled-42', 'CONFLICT-smuggled',
      'USERNAME-smuggled', 'EXT-RESULT-LEVEL',
    ]) {
      expect(surface).not.toContain(value)
    }
    // The canonical contact id is the selection value, not display text either.
    expect(surface).not.toContain(IVAN.contactId)
  })

  it('does nothing while disabled', async () => {
    const commits: Array<ContactLookupItemV1 | null> = []
    const { lookup } = controlledLookup()
    render(<Harness lookup={lookup} disabled initial={IVAN} onCommit={next => commits.push(next)} />)
    expect(input().disabled).toBe(true)
    type('Иван')
    await flushDebounce()
    key('ArrowDown')
    key('Enter')
    expect(lookup).not.toHaveBeenCalled()
    expect(commits).toEqual([])
    expect(screen.queryByRole('button', { name: 'Очистить выбор контакта' })).toBeNull()
    expect(input().value).toBe(IVAN.displayTitle)
  })

  it('wires the combobox, listbox and options together accessibly', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    const box = input()
    const listbox = screen.getByRole('listbox', { hidden: true })
    expect(box.getAttribute('aria-autocomplete')).toBe('list')
    expect(box.getAttribute('aria-controls')).toBe(listbox.id)
    expect(document.getElementById(listbox.getAttribute('aria-labelledby') ?? '')?.textContent)
      .toBe('Контакт для объединения')
    type('Ив')
    await flushDebounce()
    calls[0].resolve(result([IVAN, PETR]))
    await settle()
    const rendered = options()
    expect(new Set(rendered.map(option => option.id)).size).toBe(2)
    for (const option of rendered) {
      expect(listbox.contains(option)).toBe(true)
      expect(option.getAttribute('aria-selected')).toBe('false')
    }
    expect(box.getAttribute('aria-activedescendant')).toBeNull()
    key('ArrowDown')
    expect(box.getAttribute('aria-activedescendant')).toBe(rendered[0].id)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
  })

  it('does not flood the live region on every keystroke', async () => {
    const { lookup, calls } = controlledLookup()
    render(<Harness lookup={lookup} />)
    const status = screen.getByTestId('contact-selector-status')
    type('Ив')
    type('Ива')
    type('Иван')
    expect(status.textContent).toBe('')
    await flushDebounce()
    expect(status.textContent).toBe('')
    calls[0].resolve(result([IVAN]))
    await settle()
    expect(status.textContent).toBe('Найдено контактов: 1')
  })
})
