/**
 * M3A6D NewChatPopover on ContactLookup.v1 + ContactConversationsQuery.v1.
 *
 * The Contacts lookup transport and the landed Messaging action are fakes the
 * tests answer, and the real shared hooks run between them and the popover. So
 * every decision is proven end to end: an existing conversation is opened, only a
 * proven absence starts one, and unknown, not_found, unavailable or loading
 * evidence creates nothing. The raw-phone, normalization and Calling paths are
 * driven unchanged.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContactLookupItemV1, ContactLookupResultV1 } from '@/modules/contacts/public/v1/contact-lookup'
import {
    CONTACT_CONVERSATIONS_RESULT_V1,
    type ContactConversationsEntryV1,
} from '@/contracts/messaging/v1/contact-conversations-query'

const mocks = vi.hoisted(() => ({
    lookup: vi.fn(),
    conversations: vi.fn(),
    startByContact: vi.fn(),
    startByPhone: vi.fn(),
    startPlaceholderOutbound: vi.fn(),
    setActiveCallFsUuid: vi.fn(),
    toast: Object.assign(vi.fn(), { error: vi.fn() }),
    fetch: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1/client-ui/http-contact-lookup-client', () => ({
    createHttpContactLookupClientV1: () => mocks.lookup,
}))
vi.mock('../contact-conversations-actions', () => ({ readContactConversationsAction: mocks.conversations }))
vi.mock('../hooks/useStartConversation', () => ({
    useStartConversation: () => ({
        loading: false,
        error: null,
        startByContact: mocks.startByContact,
        startByPhone: mocks.startByPhone,
        clearError: vi.fn(),
    }),
}))
vi.mock('@/modules/calling/public/v1/sip-client-context', () => ({
    useSip: () => ({ startPlaceholderOutbound: mocks.startPlaceholderOutbound, setActiveCallFsUuid: mocks.setActiveCallFsUuid, status: 'registered' }),
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))

import NewChatPopover from './NewChatPopover'

function item(contactId: string, overrides: Partial<ContactLookupItemV1> = {}): ContactLookupItemV1 {
    return {
        contactId,
        displayName: `Иван ${contactId}`,
        displayTitle: `Иван ${contactId} · +7 922 215-57-50`,
        primaryPhone: '+7 922 215-57-50',
        channels: ['telegram'],
        ...overrides,
    }
}

function lookupAnswer(items: ContactLookupItemV1[]): ContactLookupResultV1 {
    return { items, total: items.length, truncated: false }
}

function found(contactId: string, channels: Array<[string, string]>, options: { truncated?: boolean; canonicalContactId?: string } = {}): ContactConversationsEntryV1 {
    return {
        contactId,
        status: 'found',
        canonicalContactId: options.canonicalContactId ?? contactId,
        channels: channels.map(([channel, conversationId]) => ({
            channel: channel as 'telegram',
            primaryConversationId: conversationId,
            conversations: [{ conversationId, lastActivityAt: null }],
        })),
        latestConversationId: channels[0]?.[1] ?? null,
        truncated: options.truncated ?? false,
    }
}

function answerConversations(...entries: ContactConversationsEntryV1[]) {
    mocks.conversations.mockResolvedValue({ ok: true, result: { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: entries } })
}

let onSelectChat: ReturnType<typeof vi.fn>
let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
    vi.clearAllMocks()
    onSelectChat = vi.fn()
    onClose = vi.fn()
    mocks.lookup.mockResolvedValue(lookupAnswer([]))
    mocks.conversations.mockResolvedValue({ ok: true, result: { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] } })
    mocks.startByContact.mockResolvedValue({ chatId: 'chat-created', channel: 'telegram', isNew: true })
    mocks.startByPhone.mockResolvedValue({ chatId: 'chat-by-phone', channel: 'telegram', isNew: true })
    mocks.fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ status: 'confirmed', reachable: true }) }))
    vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

function mount(initialQuery?: string) {
    return render(<NewChatPopover onClose={onClose} onSelectChat={onSelectChat} initialQuery={initialQuery} />)
}

function input() {
    return screen.getByPlaceholderText(/Телефон или имя|\+7 922/) as HTMLInputElement
}

async function search(text: string) {
    fireEvent.change(input(), { target: { value: text } })
    await waitFor(() => expect(mocks.lookup).toHaveBeenCalledWith({ query: text, limit: 8 }))
}

async function row(name: string) {
    return waitFor(() => screen.getByText(name).closest('button') as HTMLButtonElement)
}

const legacyFetches = () => mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/api/contacts/search'))

describe('NewChatPopover — Contact lookup and conversation context', () => {
    it('opens the existing conversation on the selected channel and creates nothing', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        answerConversations(found('c-1', [['telegram', 'chat-tg']]))
        mount()
        await search('Иван')
        await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())

        fireEvent.click(await row('Иван c-1'))

        await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('chat-tg'))
        expect(mocks.startByContact).not.toHaveBeenCalled()
        expect(screen.queryByTestId('new-chat-hint')).toBeNull()
    })

    it('starts by contact only on a proven absence, for the canonical Contact, and shows «новый чат»', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        answerConversations(found('c-1', [['whatsapp', 'chat-wa']], { canonicalContactId: 'c-survivor' }))
        mount()
        await search('Иван')
        await waitFor(() => expect(screen.getByTestId('new-chat-hint').textContent).toBe('новый чат'))

        fireEvent.click(await row('Иван c-1'))

        await waitFor(() => expect(mocks.startByContact).toHaveBeenCalledWith('c-survivor', 'tg'))
        await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('chat-created'))
    })

    it('never treats a channel missing from a truncated answer as absent', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        answerConversations(found('c-1', [['whatsapp', 'chat-wa']], { truncated: true }))
        mount()
        await search('Иван')
        await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())
        await act(async () => { await Promise.resolve() })

        expect(screen.queryByTestId('new-chat-hint')).toBeNull()
        fireEvent.click(await row('Иван c-1'))

        await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled())
        expect(mocks.startByContact).not.toHaveBeenCalled()
        expect(onSelectChat).not.toHaveBeenCalled()
    })

    it.each([
        ['not_found', () => answerConversations({ contactId: 'c-1', status: 'not_found' })],
        ['unavailable', () => mocks.conversations.mockResolvedValue({ ok: false, error: 'unavailable' })],
        ['a failed transport', () => mocks.conversations.mockRejectedValue(new Error('network'))],
    ])('fails closed on %s', async (_label, arrange) => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        arrange()
        mount()
        await search('Иван')
        await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())
        await act(async () => { await Promise.resolve() })

        expect(screen.queryByTestId('new-chat-hint')).toBeNull()
        fireEvent.click(await row('Иван c-1'))

        await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled())
        expect(mocks.startByContact).not.toHaveBeenCalled()
        expect(onSelectChat).not.toHaveBeenCalled()
    })

    it('creates nothing while the conversation context is still loading', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        mocks.conversations.mockReturnValue(new Promise(() => {}))
        mount()
        await search('Иван')

        fireEvent.click(await row('Иван c-1'))

        await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
        expect(mocks.startByContact).not.toHaveBeenCalled()
        expect(onSelectChat).not.toHaveBeenCalled()
    })

    it('shows identity channels from ContactLookup only, never one known only from a conversation', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1', { channels: ['whatsapp'] })]))
        answerConversations(found('c-1', [['telegram', 'chat-tg']]))
        mount()
        await search('Иван')
        const contactRow = await row('Иван c-1')
        await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())

        expect(contactRow.textContent).toContain('WA')
        expect(contactRow.textContent).not.toContain('TG')
    })

    it('marks channel-picker identity from ContactLookup only, never from a conversation', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1', { channels: ['whatsapp'] })]))
        answerConversations(found('c-1', [['telegram', 'chat-tg']]))
        mount()
        await search('Иван')
        await row('Иван c-1')
        await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())
        await act(async () => { await Promise.resolve() })

        const pickerButton = (label: string) => screen.getAllByRole('button').find((button) => button.textContent?.startsWith(label)) as HTMLButtonElement
        expect(pickerButton('WA').textContent).toContain('CRM')
        expect(pickerButton('TG').textContent).not.toContain('CRM')
        expect(pickerButton('TG').textContent).toContain('новый')
    })

    it('starts the new-number flow for a phone with no Contact, after the lookup proves it', async () => {
        mount()
        await search('+7 922 215-57-50')
        await waitFor(() => expect(screen.getByText(/Новый номер/)).toBeTruthy())

        fireEvent.keyDown(input(), { key: 'Enter' })

        await waitFor(() => expect(mocks.startByPhone).toHaveBeenCalledWith('+7 922 215-57-50', 'tg'))
        expect(mocks.startByContact).not.toHaveBeenCalled()
    })

    it('normalizes a phone typed into the phone channel', async () => {
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Тел' }))
        fireEvent.change(input(), { target: { value: '89221234567' } })
        expect(input().value).toBe('+79221234567')
    })

    it('calls the single matched Contact\'s phone on the phone channel', async () => {
        // placeCall warms the microphone first; jsdom has no media devices.
        vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(() => Promise.reject(new Error('no media'))) } })
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Тел' }))
        fireEvent.change(input(), { target: { value: 'Иван' } })

        fireEvent.click(await row('Иван c-1'))

        await waitFor(() => expect(mocks.startPlaceholderOutbound).toHaveBeenCalledWith('+7 922 215-57-50', 'Иван c-1'))
        await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/calls/originate', expect.objectContaining({ method: 'POST' })))
        const originate = mocks.fetch.mock.calls.find(([url]) => url === '/api/calls/originate')
        expect(JSON.parse(originate?.[1]?.body as string)).toEqual({ phoneNumber: '+7 922 215-57-50' })
    })

    it('never auto-picks a Contact when Enter meets several matches', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1'), item('c-2')]))
        answerConversations(found('c-1', [['telegram', 'chat-1']]), found('c-2', [['telegram', 'chat-2']]))
        mount()
        await search('Иван')
        await row('Иван c-2')
        await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())

        fireEvent.keyDown(input(), { key: 'Enter' })
        await act(async () => { await Promise.resolve() })

        expect(onSelectChat).not.toHaveBeenCalled()
        expect(mocks.startByContact).not.toHaveBeenCalled()
        expect(mocks.startByPhone).not.toHaveBeenCalled()
    })

    it('never reaches the legacy contact search', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        answerConversations(found('c-1', [['telegram', 'chat-tg']]))
        mount()
        await search('Иван')
        await row('Иван c-1')
        expect(legacyFetches()).toEqual([])
    })
})

describe('NewChatPopover — initialQuery auto-start', () => {
    it('starts the phone flow for a phone with no Contact match', async () => {
        mount('+79221234567')
        await waitFor(() => expect(mocks.startByPhone).toHaveBeenCalledTimes(1))
        expect(mocks.startByPhone).toHaveBeenCalledWith('+79221234567', 'wa')
    })

    it('never starts the phone flow for a non-phone query with no match', async () => {
        mount('Иван Петров')
        await waitFor(() => expect(mocks.lookup).toHaveBeenCalled())
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
        expect(mocks.startByPhone).not.toHaveBeenCalled()
        expect(mocks.startByContact).not.toHaveBeenCalled()
    })

    it('never auto-selects or acts when several Contacts match', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1'), item('c-2')]))
        answerConversations(found('c-1', [['whatsapp', 'chat-1']]), found('c-2', [['whatsapp', 'chat-2']]))
        mount('+79221234567')
        await waitFor(() => expect(screen.getByText('Иван c-2')).toBeTruthy())
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

        expect(onSelectChat).not.toHaveBeenCalled()
        expect(mocks.startByPhone).not.toHaveBeenCalled()
        expect(mocks.startByContact).not.toHaveBeenCalled()
    })

    it('opens the existing conversation of a single matched Contact', async () => {
        mocks.lookup.mockResolvedValue(lookupAnswer([item('c-1')]))
        answerConversations(found('c-1', [['whatsapp', 'chat-wa']]))
        mount('+79221234567')
        await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('chat-wa'))
        expect(mocks.startByPhone).not.toHaveBeenCalled()
        expect(mocks.startByContact).not.toHaveBeenCalled()
    })

    it('does nothing when the lookup fails', async () => {
        mocks.lookup.mockRejectedValue(new Error('down'))
        mount('+79221234567')
        await waitFor(() => expect(mocks.lookup).toHaveBeenCalled())
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
        expect(mocks.startByPhone).not.toHaveBeenCalled()
    })
})
