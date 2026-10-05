/**
 * The M3A2 Contact Card shell proven against its server composition alone.
 *
 * The load action is replaced by a controllable fake, so every RCQ1 answer, a
 * failure, a slow stale answer and a chat switch can be driven exactly. The
 * Contacts core panel is replaced by a recorder, so the summary it receives is
 * compared by identity. Global fetch and the timer functions are spied to prove
 * the shell itself performs no request and schedules nothing.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContactCardSummaryV1 } from '@/modules/contacts/public/v1/contact-card-summary'
import type { ContactCardLoadResultV1 } from './contact-card-actions'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  panelProps: [] as Array<{ summary: unknown }>,
}))

vi.mock('./contact-card-actions', () => ({ loadContactCardForConversationV1: mocks.load }))
vi.mock('@/modules/contacts/public/v1/client-ui/ContactCorePanel', () => ({
  default: (props: { summary: { displayTitle: string } }) => {
    mocks.panelProps.push(props)
    if (props.summary.displayTitle === 'THROWS') throw new Error('panel defect')
    return <section data-testid="contact-core-panel">{props.summary.displayTitle}</section>
  },
}))

import ContactCardShell from './ContactCardShell'

function summaryFor(contactId: string, displayTitle = `Контакт ${contactId}`): ContactCardSummaryV1 {
  return {
    contactId,
    displayName: displayTitle,
    displayTitle,
    primaryPhone: null,
    phoneCount: 0,
    channels: [],
    hasIdentityConflict: false,
    source: 'chat',
    lineage: { mergedFromCount: 0 },
  }
}

function deferred() {
  let resolve!: (value: ContactCardLoadResultV1) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<ContactCardLoadResultV1>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let fetchSpy: ReturnType<typeof vi.fn>
let intervalSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mocks.load.mockReset()
  mocks.panelProps.length = 0
  fetchSpy = vi.fn(() => { throw new Error('the shell must not fetch') })
  vi.stubGlobal('fetch', fetchSpy)
  intervalSpy = vi.spyOn(globalThis, 'setInterval')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  intervalSpy.mockRestore()
})

async function settle() {
  await act(async () => { await Promise.resolve() })
}

describe('ContactCardShell', () => {
  it('loads the exact chat once and shows the header and close control while loading', async () => {
    const pending = deferred()
    mocks.load.mockReturnValueOnce(pending.promise)
    render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)

    expect(screen.getByTestId('contact-card-loading')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeTruthy()
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledWith('chat-1')
    expect(screen.queryByTestId('contact-core-panel')).toBeNull()
  })

  it('renders the Contacts core panel with exactly the resolved summary', async () => {
    const summary = summaryFor('contact-1')
    mocks.load.mockResolvedValueOnce({ status: 'resolved', summary })
    render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    await settle()

    expect(screen.getByTestId('contact-core-panel').textContent).toBe('Контакт contact-1')
    expect(mocks.panelProps.at(-1)?.summary).toBe(summary)
    expect(screen.queryByTestId('contact-card-loading')).toBeNull()
  })

  it.each([
    ['unresolved', 'contact-card-unresolved', 'Контакт не определён'],
    ['ambiguous', 'contact-card-ambiguous', 'Контакт неоднозначен'],
    ['not_found', 'contact-card-chat-not-found', 'Чат не найден'],
    ['contact_not_found', 'contact-card-contact-not-found', 'Контакт не найден'],
  ] as const)('shows %s explicitly and never renders a Contact', async (status, testId, title) => {
    mocks.load.mockResolvedValueOnce({ status })
    render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    await settle()

    expect(screen.getByTestId(testId).textContent).toContain(title)
    expect(screen.queryByTestId('contact-core-panel')).toBeNull()
    expect(mocks.panelProps).toEqual([])
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('shows a failed load with one manual retry and no automatic one', async () => {
    mocks.load.mockResolvedValueOnce({ status: 'failed' })
    render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    await settle()

    expect(screen.getByTestId('contact-card-failed')).toBeTruthy()
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(intervalSpy).not.toHaveBeenCalled()

    const summary = summaryFor('contact-1')
    mocks.load.mockResolvedValueOnce({ status: 'resolved', summary })
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(screen.getByTestId('contact-card-loading')).toBeTruthy()
    await settle()

    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(mocks.load).toHaveBeenLastCalledWith('chat-1')
    expect(mocks.panelProps.at(-1)?.summary).toBe(summary)
  })

  it('treats a rejected load as a failure, never as a Contact', async () => {
    mocks.load.mockRejectedValueOnce(new Error('transport down'))
    render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    await settle()

    expect(screen.getByTestId('contact-card-failed')).toBeTruthy()
    expect(screen.queryByText(/transport down/u)).toBeNull()
    expect(mocks.panelProps).toEqual([])
  })

  it('invalidates the old card as soon as the chat switches', async () => {
    mocks.load.mockResolvedValueOnce({ status: 'resolved', summary: summaryFor('contact-1') })
    const view = render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    await settle()
    expect(screen.getByTestId('contact-core-panel').textContent).toBe('Контакт contact-1')

    const pending = deferred()
    mocks.load.mockReturnValueOnce(pending.promise)
    view.rerender(<ContactCardShell chatId="chat-2" onClose={() => {}} />)

    expect(screen.queryByTestId('contact-core-panel')).toBeNull()
    expect(screen.getByTestId('contact-card-loading')).toBeTruthy()
    expect(mocks.load).toHaveBeenLastCalledWith('chat-2')
  })

  it('never lets a slow answer for the previous chat replace the current card', async () => {
    const slowOld = deferred()
    const fastNew = deferred()
    mocks.load.mockReturnValueOnce(slowOld.promise).mockReturnValueOnce(fastNew.promise)
    const view = render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    view.rerender(<ContactCardShell chatId="chat-2" onClose={() => {}} />)

    await act(async () => { fastNew.resolve({ status: 'resolved', summary: summaryFor('contact-2') }) })
    await act(async () => { slowOld.resolve({ status: 'resolved', summary: summaryFor('contact-1') }) })

    expect(screen.getByTestId('contact-core-panel').textContent).toBe('Контакт contact-2')
    expect(mocks.panelProps.map((props) => (props.summary as ContactCardSummaryV1).contactId)).not.toContain('contact-1')
  })

  it('never lets a slow failure for the previous chat replace the current card', async () => {
    const slowOld = deferred()
    mocks.load.mockReturnValueOnce(slowOld.promise).mockResolvedValueOnce({ status: 'unresolved' })
    const view = render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    view.rerender(<ContactCardShell chatId="chat-2" onClose={() => {}} />)
    await settle()

    await act(async () => { slowOld.reject(new Error('late failure')) })

    expect(screen.getByTestId('contact-card-unresolved')).toBeTruthy()
    expect(screen.queryByTestId('contact-card-failed')).toBeNull()
  })

  it('drops an answer that arrives after the card was closed', async () => {
    const pending = deferred()
    mocks.load.mockReturnValueOnce(pending.promise)
    const view = render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    view.unmount()

    await act(async () => { pending.resolve({ status: 'resolved', summary: summaryFor('contact-1') }) })

    expect(mocks.panelProps).toEqual([])
  })

  it('closes through the host callback only', async () => {
    mocks.load.mockResolvedValueOnce({ status: 'unresolved' })
    const onClose = vi.fn()
    render(<ContactCardShell chatId="chat-1" onClose={onClose} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('contains a panel render failure inside its slot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.load.mockResolvedValueOnce({ status: 'resolved', summary: summaryFor('contact-1', 'THROWS') })
    render(<ContactCardShell chatId="chat-1" onClose={() => {}} />)
    await settle()

    expect(screen.getByTestId('contact-card-panel-failed')).toBeTruthy()
    expect(screen.getByTestId('contact-card-shell')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeTruthy()
    error.mockRestore()
  })

  it('performs no request, probe or schedule of its own in any state', async () => {
    for (const result of [
      { status: 'resolved', summary: summaryFor('contact-1') },
      { status: 'unresolved' },
      { status: 'ambiguous' },
      { status: 'not_found' },
      { status: 'contact_not_found' },
      { status: 'failed' },
    ] as ContactCardLoadResultV1[]) {
      mocks.load.mockResolvedValueOnce(result)
      render(<ContactCardShell chatId={`chat-${result.status}`} onClose={() => {}} />)
      await settle()
      cleanup()
    }

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(intervalSpy).not.toHaveBeenCalled()
  })
})
