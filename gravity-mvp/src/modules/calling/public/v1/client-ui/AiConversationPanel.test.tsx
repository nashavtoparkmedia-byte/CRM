// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConversationViewV1 } from '@/contracts/calling/v1/ai-conversation'

const actions = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
}))

vi.mock('../ai-conversation-actions', () => ({
  listAiConversationsForContactActionV1: actions.list,
  startAiConversationActionV1: actions.start,
}))

import AiConversationPanel, { AI_CONVERSATION_POLL_MS } from './AiConversationPanel'

const CONTACT = 'contact-1'

function view(overrides: Partial<AiConversationViewV1> = {}): AiConversationViewV1 {
  return {
    conversationId: 'aiconv_1', contactId: CONTACT, initiation: 'manual', mode: 'simulated', state: 'completed', failure: null,
    destinationMasked: '+•••••••4567', startedAt: '2026-11-08T10:00:00.000Z', answeredAt: '2026-11-08T10:00:02.000Z',
    endedAt: '2026-11-08T10:00:20.000Z', updatedAt: '2026-11-08T10:00:20.000Z', occupiedUntil: null,
    transcript: [
      { ordinal: 1, speaker: 'assistant', text: 'Здравствуйте!' },
      { ordinal: 2, speaker: 'person', text: 'Слушаю.' },
    ],
    outcome: { qualification: 'qualified', summary: 'Кандидат подходит', score: 82, classification: 'qualified' },
    ...overrides,
  }
}

const listed = (conversations: AiConversationViewV1[], mode: 'simulated' | 'disabled' = 'simulated') => ({
  ok: true, result: { contract: 'calling.AiConversationsForContactResult.v1', status: 'ok', mode, conversations },
})

beforeEach(() => {
  actions.list.mockReset()
  actions.start.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AiConversationPanel', () => {
  it('shows the OFF state with a disabled button when the runtime is disabled', async () => {
    actions.list.mockResolvedValue(listed([], 'disabled'))
    render(<AiConversationPanel contactId={CONTACT} />)
    expect(await screen.findByText(/AI-звонки выключены/u)).toBeTruthy()
    expect((screen.getByTestId('ai-conversation-start') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('ai-conversation-variant')).toBeNull()
  })

  it('starts one conversation per click with an opaque request id and the chosen simulation scenario', async () => {
    actions.list.mockResolvedValue(listed([]))
    let resolve!: (value: unknown) => void
    actions.start.mockReturnValue(new Promise(r => { resolve = r }))
    render(<AiConversationPanel contactId={CONTACT} />)
    const button = await screen.findByTestId('ai-conversation-start')
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByTestId('ai-conversation-variant'), { target: { value: 'interrupted' } })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(actions.start).toHaveBeenCalledTimes(1)
    const command = actions.start.mock.calls[0][0]
    expect(command).toMatchObject({ contract: 'calling.StartAiConversationCommand.v1', contactId: CONTACT, simulationVariant: 'interrupted' })
    expect(command.requestId).toMatch(/^[A-Za-z0-9_-]{16,128}$/u)
    expect(Object.keys(command).sort()).toEqual(['contactId', 'contract', 'requestId', 'simulationVariant'])
    await act(async () => {
      resolve({ ok: true, result: { contract: 'calling.StartAiConversationResult.v1', status: 'accepted', duplicate: false, conversation: view({ state: 'queued', transcript: [], outcome: null, endedAt: null }) } })
    })
  })

  it('shows refusals in plain words and never starts', async () => {
    actions.list.mockResolvedValue(listed([]))
    actions.start.mockResolvedValue({ ok: true, result: { contract: 'calling.StartAiConversationResult.v1', status: 'refused', reason: 'identity_unconfirmed', retryable: false, activeConversationId: null } })
    render(<AiConversationPanel contactId={CONTACT} />)
    const button = await screen.findByTestId('ai-conversation-start')
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    expect(await screen.findByText('Личность не подтверждена — AI-звонок недоступен.')).toBeTruthy()
  })

  it('asks to sign in again when the session expired', async () => {
    actions.list.mockResolvedValue({ ok: true, result: { contract: 'calling.AiConversationsForContactResult.v1', status: 'unauthenticated' } })
    render(<AiConversationPanel contactId={CONTACT} />)
    const notice = await screen.findByTestId('ai-conversation-unauthenticated')
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/settings/integrations/access?next=%2Fcontacts%2Fcontact-1')
    expect((screen.getByTestId('ai-conversation-start') as HTMLButtonElement).disabled).toBe(true)
  })

  it('polls while a conversation is live and stops once it ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    actions.list
      .mockResolvedValueOnce(listed([view({ state: 'in_conversation', endedAt: null, outcome: null })]))
      .mockResolvedValue(listed([view()]))
    render(<AiConversationPanel contactId={CONTACT} />)
    expect(await screen.findByText('Идёт разговор')).toBeTruthy()
    expect((screen.getByTestId('ai-conversation-start') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_CONVERSATION_POLL_MS + 10) })
    expect(await screen.findByText('Завершён')).toBeTruthy()
    const calls = actions.list.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_CONVERSATION_POLL_MS * 3) })
    expect(actions.list.mock.calls.length).toBe(calls)
  })

  it('shows the transcript, the structured outcome and failure reasons of the history', async () => {
    actions.list.mockResolvedValue(listed([
      view({ conversationId: 'aiconv_2', state: 'failed', failure: 'provider_rejected', transcript: [], outcome: null }),
      view(),
    ]))
    render(<AiConversationPanel contactId={CONTACT} />)
    const rows = await screen.findAllByTestId('ai-conversation-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1].querySelector('button')!)
    expect(await screen.findByText('Здравствуйте!')).toBeTruthy()
    const outcome = screen.getByTestId('ai-conversation-outcome')
    expect(within(outcome).getByText('Кандидат подходит')).toBeTruthy()
    expect(within(outcome).getByText('оценка 82/100')).toBeTruthy()
    expect(within(outcome).getByText('Квалифицирован')).toBeTruthy()
    fireEvent.click(rows[0].querySelector('button')!)
    expect(await screen.findByTestId('ai-conversation-failure')).toBeTruthy()
    expect(screen.getAllByText('Оператор связи отклонил вызов.').length).toBeGreaterThan(0)
  })
})
