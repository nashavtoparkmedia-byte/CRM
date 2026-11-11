import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/contacts/:id answers only a verified staff or integration-admin
 * session (Security 2026-11-12). Without one it answers 401, and the Messages
 * contact panel must say so instead of going blank: useContact reports
 * `unauthorized` (no retry), and the drawer shows one line with «Войти».
 */

const navigation = vi.hoisted(() => ({ toggleProfileDrawer: vi.fn(), updateQuery: vi.fn() }))
vi.mock('../hooks/useChatNavigation', () => ({ useChatNavigation: () => navigation }))
vi.mock('../hooks/useConversations', () => ({
  useConversations: () => ({ conversations: [{ id: 'chat-1', contactId: 'contact-1', channel: 'telegram', name: 'Сергей', metadata: {} }] }),
  refreshConversations: vi.fn(),
}))
vi.mock('../contact-card-link-actions', () => ({ resolveContactPersonCardLinkAction: vi.fn(async () => null) }))

import { useContact } from '../hooks/useContact'
import ContactProfileDrawer from './ContactProfileDrawer'

let fetchMock: ReturnType<typeof vi.fn>

function respond(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/contacts/contact-1') return respond(401, { error: 'Unauthorized' })
    return respond(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const contactCalls = () => fetchMock.mock.calls.filter(([input]) => String(input) === '/api/contacts/contact-1').length

describe('useContact on a refused contact read', () => {
  it('reports unauthorized on 401, keeps no contact and does not retry', async () => {
    const { result } = renderHook(() => useContact('contact-1'))
    await waitFor(() => expect(result.current.unauthorized).toBe(true))
    expect(result.current.contact).toBeNull()
    expect(contactCalls()).toBe(1)
  })

  it('refetch reports a 401 the same way, and a later success clears it', async () => {
    const { result } = renderHook(() => useContact('contact-1'))
    await waitFor(() => expect(result.current.unauthorized).toBe(true))
    fetchMock.mockImplementation((input: RequestInfo | URL) => String(input) === '/api/contacts/contact-1'
      ? respond(200, { id: 'contact-1', displayName: 'Громов Сергей (демо)', phones: [], identities: [] })
      : respond(404, {}))
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.contact).not.toBeNull())
    expect(result.current.unauthorized).toBe(false)
  })

  it('a 200 answer is the contact, not unauthorized', async () => {
    fetchMock.mockImplementation(() => respond(200, { id: 'contact-1', displayName: 'Громов Сергей (демо)', phones: [], identities: [] }))
    const { result } = renderHook(() => useContact('contact-1'))
    await waitFor(() => expect(result.current.contact).not.toBeNull())
    expect(result.current.unauthorized).toBe(false)
  })
})

describe('ContactProfileDrawer without a verified session', () => {
  it('shows one sign-in line with a «Войти» link instead of the panel, after a single read', async () => {
    render(<ContactProfileDrawer chatId="chat-1" />)
    expect(await screen.findByText(/Чтобы видеть данные человека, войдите в CRM со своим паролем/u)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Войти' }).getAttribute('href')).toBe('/login')
    expect(contactCalls()).toBe(1)
  })
})
