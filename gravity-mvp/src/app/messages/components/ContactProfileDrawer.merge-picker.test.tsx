/**
 * The ContactProfileDrawer merge picker proven after its migration to the
 * Contacts-owned ContactSelector.
 *
 * The picker now answers only "which Contact did the operator pick" through
 * ContactLookup.v1. Everything else is the existing merge flow and must be
 * unchanged: the survivor/loser expression, the explicit confirmation, the
 * merge-to command and its error display, and the post-merge refresh. These
 * tests drive the real drawer with its data hooks stubbed and a fetch router
 * standing in for the server.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  contact: null as Record<string, unknown> | null,
  refetchContact: vi.fn(),
  refreshConversations: vi.fn(),
  legacySearch: vi.fn(() => ({ results: [], loading: false, total: 0 })),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/app/messages/hooks/useChatNavigation', () => ({
  useChatNavigation: () => ({ toggleProfileDrawer: vi.fn(), updateQuery: vi.fn() }),
}))
vi.mock('@/app/messages/hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: [{
      id: 'chat-1',
      name: 'Чат',
      channel: 'telegram',
      externalChatId: 'tg-chat-1',
      lastMessageAt: '2026-10-01T00:00:00.000Z',
      unreadCount: 0,
      requiresResponse: false,
      status: 'open',
      contactId: 'contact-current',
      metadata: {},
    }],
    isLoading: false,
    setConversations: vi.fn(),
  }),
  refreshConversations: harness.refreshConversations,
}))
vi.mock('@/app/messages/hooks/useContact', async importOriginal => ({
  ...await importOriginal<typeof import('@/app/messages/hooks/useContact')>(),
  useContact: () => ({ contact: harness.contact, isLoading: false, error: null, refetch: harness.refetchContact }),
}))
vi.mock('@/app/messages/hooks/useChannelStatus', () => ({ useChannelStatus: () => ({ channelStatus: {} }) }))
// The legacy hook must no longer be reached by this consumer at all.
vi.mock('@/app/messages/hooks/useContactSearch', () => ({ useContactSearch: harness.legacySearch }))
// The manual-link modal's server actions pull the provider runtime (and its
// browser automation) into the import graph; the merge picker never reaches them.
vi.mock('@/app/messages/link-chat-actions', () => ({
  searchDriversForLinking: vi.fn(async () => []),
  linkChatToDriverManually: vi.fn(async () => ({ success: false })),
}))
vi.mock('@/modules/work-management/public/v1/task-view', () => ({ WorkTaskCreateModalV1: () => null }))
vi.mock('@/modules/calling/public/v1/client-ui/CallButton', () => ({ default: () => null }))
vi.mock('@/app/messages/components/DriverTasksWidget', () => ({ default: () => null }))

import ContactProfileDrawer from './ContactProfileDrawer'

const CURRENT = {
  contactId: 'contact-current',
  displayName: 'Текущий Контакт',
  displayTitle: 'Текущий Контакт · +7 900 000-00-01',
  primaryPhone: '+7 900 000-00-01',
  channels: ['telegram'],
}
const OTHER = {
  contactId: 'contact-other',
  displayName: 'Пётр Сидоров',
  displayTitle: 'Пётр Сидоров · +7 900 123-45-67',
  primaryPhone: '+7 900 123-45-67',
  channels: ['whatsapp'],
  // Provider and Messaging data a server must never send; the browser client
  // drops it before it can reach the picker or the merge flow.
  externalId: 'EXT-902100000001',
  providerAccountId: 'PA-tg-bot-7712345678',
  hasChat: { whatsapp: 'CHAT-smuggled' },
  reachabilityStatus: 'REACH-smuggled',
}

function contactRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-current',
    displayName: 'Текущий Контакт',
    displayNameSource: 'manual',
    masterSource: 'chat',
    yandexDriverId: null,
    primaryPhoneId: null,
    notes: null,
    tags: [],
    customFields: {},
    isArchived: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    phones: [],
    identities: [],
    chats: [],
    driver: null,
    driverProfiles: [],
    driverConfirmations: [],
    identityConflicts: [],
    mergeHistory: [],
    ...overrides,
  }
}

type MergeReply = { status: number; body: unknown }
let lookupItems: unknown[] = []
let mergeReply: MergeReply = { status: 200, body: { status: 'merged' } }
const requests: Array<{ url: string; method: string; body?: string }> = []

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  harness.contact = contactRecord()
  harness.refetchContact.mockReset()
  harness.refreshConversations.mockReset()
  harness.legacySearch.mockClear()
  lookupItems = [CURRENT, OTHER]
  mergeReply = { status: 200, body: { status: 'merged' } }
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.startsWith('/api/contacts/lookup?')) {
      return jsonResponse({ items: lookupItems, total: lookupItems.length, truncated: false })
    }
    if (url.includes('/merge-to/')) return jsonResponse(mergeReply.body, mergeReply.status)
    return jsonResponse({})
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function openContactMergePicker() {
  render(<ContactProfileDrawer chatId="chat-1" />)
  fireEvent.click(screen.getByTitle('Объединить контакт'))
  fireEvent.click(screen.getByText('С другим контактом'))
  return screen.getByRole('combobox', { name: 'Контакт для объединения' }) as HTMLInputElement
}

async function search(box: HTMLInputElement, text: string) {
  fireEvent.change(box, { target: { value: text } })
  return screen.findAllByRole('option')
}

function mergeRequests() {
  return requests.filter(request => request.url.includes('/merge-to/'))
}

function confirmButton() {
  // The dialog's own action button, distinct from the quick-action opener.
  return screen.getAllByRole('button', { name: /Объединить/ }).find(button => button.getAttribute('title') === null)!
}

describe('merge picker integration', () => {
  it('mounts ContactSelector over ContactLookup.v1 and never reaches the legacy search', async () => {
    const box = openContactMergePicker()
    await search(box, 'Пётр')
    const lookups = requests.filter(request => request.url.startsWith('/api/contacts/lookup?'))
    expect(lookups.map(request => request.url)).toEqual(['/api/contacts/lookup?q=%D0%9F%D1%91%D1%82%D1%80'])
    expect(requests.some(request => request.url.includes('/api/contacts/search'))).toBe(false)
    expect(harness.legacySearch).not.toHaveBeenCalled()
  })

  it('commits the selected canonical contactId and asks for confirmation before merging', async () => {
    const box = openContactMergePicker()
    const options = await search(box, 'Пётр')
    fireEvent.click(options[1])
    expect(screen.getByText(/Влить/).textContent).toBe('Влить Текущий Контакт в Пётр Сидоров?')
    // Selecting is not merging: nothing is sent until the operator confirms.
    expect(mergeRequests()).toEqual([])
    fireEvent.click(confirmButton())
    await screen.findByText('Контакты объединены')
    expect(mergeRequests().map(request => [request.url, request.method])).toEqual([
      ['/api/contacts/contact-current/merge-to/contact-other', 'POST'],
    ])
  })

  it('selects with the keyboard alone', async () => {
    const box = openContactMergePicker()
    await search(box, 'Пётр')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByText(/Влить/).textContent).toBe('Влить Текущий Контакт в Пётр Сидоров?')
  })

  it('never turns typed text into a merge target', async () => {
    const box = openContactMergePicker()
    await search(box, OTHER.displayTitle)
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.blur(box)
    expect(screen.queryByText(/Влить/)).toBeNull()
    expect(mergeRequests()).toEqual([])
  })

  it('keeps the target empty after Escape or clearing', async () => {
    const box = openContactMergePicker()
    await search(box, 'Пётр')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByText(/Влить/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Очистить выбор контакта' }))
    expect(box.value).toBe('')
    expect(screen.queryByText(/Влить/)).toBeNull()
    expect(mergeRequests()).toEqual([])
  })

  it('returns to an empty picker when the confirmation is cancelled', async () => {
    const box = openContactMergePicker()
    fireEvent.click((await search(box, 'Пётр'))[1])
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    const fresh = screen.getByRole('combobox', { name: 'Контакт для объединения' }) as HTMLInputElement
    expect(fresh.value).toBe('')
    expect(screen.queryByText(/Влить/)).toBeNull()
    expect(mergeRequests()).toEqual([])
    // A later choice still flows through the unchanged command.
    fireEvent.click((await search(fresh, 'Пётр'))[1])
    fireEvent.click(confirmButton())
    await screen.findByText('Контакты объединены')
    expect(mergeRequests()).toHaveLength(1)
  })
})

describe('merge invariants', () => {
  it('refuses the current Contact as its own merge target', async () => {
    const box = openContactMergePicker()
    fireEvent.click((await search(box, 'Текущий'))[0])
    expect(screen.getByText('Это текущий контакт — выберите другой.')).toBeTruthy()
    expect(screen.queryByText(/Влить/)).toBeNull()
    expect(mergeRequests()).toEqual([])
    // Choosing another Contact afterwards clears the note and proceeds.
    const again = screen.getByRole('combobox', { name: 'Контакт для объединения' }) as HTMLInputElement
    fireEvent.click((await search(again, 'Пётр'))[1])
    expect(screen.queryByText('Это текущий контакт — выберите другой.')).toBeNull()
    expect(screen.getByText(/Влить/)).toBeTruthy()
  })

  it('keeps the survivor/loser expression: a driver-linked current Contact survives', async () => {
    harness.contact = contactRecord({ yandexDriverId: 'driver-1' })
    const box = openContactMergePicker()
    fireEvent.click((await search(box, 'Пётр'))[1])
    expect(screen.getByText(/Влить/).textContent).toBe('Влить Пётр Сидоров в текущий контакт Текущий Контакт?')
    fireEvent.click(confirmButton())
    await screen.findByText('Контакты объединены')
    expect(mergeRequests().map(request => request.url)).toEqual(['/api/contacts/contact-other/merge-to/contact-current'])
  })

  it('shows a server rejection and runs no success refresh', async () => {
    for (const reply of [
      { status: 409, body: { error: 'Source contact is linked to a driver', code: 'SOURCE_HAS_DRIVER' } },
      { status: 400, body: { error: 'Cannot merge contact into itself', code: 'SELF_MERGE' } },
      { status: 409, body: { error: 'Contact is archived', code: 'CONTACT_ARCHIVED' } },
    ]) {
      mergeReply = reply
      const box = openContactMergePicker()
      fireEvent.click((await search(box, 'Пётр'))[1])
      fireEvent.click(confirmButton())
      await screen.findByText((reply.body as { error: string }).error)
      expect(screen.queryByText('Контакты объединены')).toBeNull()
      expect(harness.refetchContact).not.toHaveBeenCalled()
      expect(harness.refreshConversations).not.toHaveBeenCalled()
      cleanup()
      requests.length = 0
    }
  })

  it('runs both existing refreshes after a successful merge', async () => {
    const box = openContactMergePicker()
    fireEvent.click((await search(box, 'Пётр'))[1])
    await act(async () => { fireEvent.click(confirmButton()) })
    await screen.findByText('Контакты объединены')
    await waitFor(() => expect(harness.refetchContact).toHaveBeenCalledTimes(1))
    expect(harness.refreshConversations).toHaveBeenCalledTimes(1)
  })
})

describe('merge picker boundary', () => {
  it('renders lookup presentation only and no provider or Messaging value', async () => {
    const box = openContactMergePicker()
    await search(box, 'Пётр')
    const surface = document.body.innerHTML
    expect(surface).toContain(OTHER.displayTitle)
    for (const value of ['EXT-902100000001', 'PA-tg-bot-7712345678', 'CHAT-smuggled', 'REACH-smuggled']) {
      expect(surface).not.toContain(value)
    }
  })
})
