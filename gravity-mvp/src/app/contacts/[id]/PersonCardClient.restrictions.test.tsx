import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * «Ограничения связи» in block 3 (V2 Q4): the current state is shown, the
 * dialog sends the complete state with the version it was opened on and a
 * required reason, and never an actor; a stale version is explained.
 */
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/modules/contacts/public/v1/client-ui/DriverPersonSearchModal', () => ({ default: () => null }))

import { CardActions, restrictionSummaryV1 } from './PersonCardClient'

const VOICE = { denyAll: false, denyMessage: false, denyVoice: true }
const NONE = { denyAll: false, denyMessage: false, denyVoice: false }
const URL_ = '/api/contacts/contact-1/communication-policy'
let fetchMock: ReturnType<typeof vi.fn>

const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== URL_) return respond(404, {})
    if (!init?.method) return respond(200, { status: 'found', canonicalContactId: 'contact-1', isArchived: false, version: 1, restriction: VOICE })
    return respond(200, { status: 'applied', version: 2, restriction: NONE })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')

describe('«Ограничения связи» on the person card', () => {
  it('summarises the three flags in plain words', () => {
    expect(restrictionSummaryV1(NONE)).toBe('нет')
    expect(restrictionSummaryV1(VOICE)).toBe('не звонить')
    expect(restrictionSummaryV1({ denyAll: false, denyMessage: true, denyVoice: true })).toBe('не писать · не звонить')
    expect(restrictionSummaryV1({ denyAll: true, denyMessage: false, denyVoice: true })).toBe('не связываться совсем')
  })

  it('shows the current state, requires a reason, and lifts with the opened version and no actor', async () => {
    render(<CardActions contactId="contact-1" displayName="Громов" conversations={[]} />)
    await waitFor(() => expect(screen.getByTestId('restriction-summary').textContent).toBe('Ограничения связи: не звонить'))

    fireEvent.click(screen.getByRole('button', { name: 'Ограничения связи' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Не звонить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Укажите причину.')
    expect(posts()).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'разрешил снова' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(screen.getByTestId('restriction-summary').textContent).toBe('Ограничения связи: нет'))
    expect(posts()).toHaveLength(1)
    const body = JSON.parse(String((posts()[0][1] as RequestInit).body))
    expect(Object.keys(body).sort()).toEqual(['expectedVersion', 'reason', 'requestId', 'restriction'])
    expect(body).toMatchObject({ expectedVersion: 1, restriction: NONE, reason: 'разрешил снова' })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('explains a change someone else made first', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return respond(200, { status: 'found', canonicalContactId: 'contact-1', isArchived: false, version: 1, restriction: VOICE })
      return respond(409, { error: 'Conflict', code: 'VERSION_CONFLICT', currentVersion: 2 })
    })
    render(<CardActions contactId="contact-1" displayName="Громов" conversations={[]} />)
    await waitFor(() => expect(screen.getByTestId('restriction-summary').textContent).toBe('Ограничения связи: не звонить'))
    fireEvent.click(screen.getByRole('button', { name: 'Ограничения связи' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Не писать' }))
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'просил не писать' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect((await screen.findByRole('alert')).textContent).toContain('ограничения изменил кто-то другой')
  })

  it('without a reader session the button is off and the summary says so', async () => {
    fetchMock.mockImplementation(() => respond(401, { error: 'Unauthorized' }))
    render(<CardActions contactId="contact-1" displayName="Громов" conversations={[]} />)
    await waitFor(() => expect(screen.getByTestId('restriction-summary').textContent).toBe('Ограничения связи: нет прав на просмотр'))
    expect(screen.getByRole('button', { name: 'Ограничения связи' })).toHaveProperty('disabled', true)
  })
})

describe('«Проверить» in «Мессенджеры» (W5)', () => {
  it('sends only the row\'s ids, never a number, and shows the answered state', async () => {
    const { MessengersTable } = await import('./PersonCardClient')
    fetchMock.mockImplementation(() => respond(200, { channel: 'whatsapp', status: 'confirmed', reachable: true, confirmed: true, retryable: false }))
    render(<MessengersTable contactId="contact-1" rows={[{
      key: 'r1', identityId: 'identity-1', phoneId: 'phone-1', channel: 'whatsapp', channelLabel: 'WhatsApp', account: '+7 999 100-01-01',
      reachability: 'unknown', bot: 'not_applicable', preference: null, conversationId: null, channelTab: null, writable: false, note: null,
    }]} />)
    expect(screen.getByText('Не проверен')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }))
    await waitFor(() => expect(screen.getByText('Есть')).toBeTruthy())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/contacts/contact-1/reachability')
    expect(JSON.parse(String(init.body))).toEqual({ channel: 'whatsapp', phoneId: 'phone-1', identityId: 'identity-1' })
  })
})
