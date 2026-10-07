/**
 * M3A6D ChatList extra Contacts on ContactLookup.v1 + ContactConversationsQuery.v1.
 *
 * One operator search box still filters the loaded conversations and asks
 * Contacts for more people. A found Contact is offered as an extra row only when
 * Messaging's COMPLETE answer proves none of its conversations is already
 * visible; a known visible conversation hides it even from a truncated answer,
 * and truncated, not_found, unavailable or loading evidence never shows it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { ContactLookupItemV1 } from '@/modules/contacts/public/v1/contact-lookup'
import {
    CONTACT_CONVERSATIONS_RESULT_V1,
    type ContactConversationsEntryV1,
} from '@/contracts/messaging/v1/contact-conversations-query'

const mocks = vi.hoisted(() => ({
    lookup: vi.fn(),
    conversations: vi.fn(),
    startByContact: vi.fn(),
    loadedConversations: [] as unknown[],
    fetch: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1/client-ui/http-contact-lookup-client', () => ({
    createHttpContactLookupClientV1: () => mocks.lookup,
}))
vi.mock('../contact-conversations-actions', () => ({ readContactConversationsAction: mocks.conversations }))
vi.mock('../hooks/useStartConversation', () => ({
    useStartConversation: () => ({ loading: false, error: null, startByContact: mocks.startByContact, startByPhone: vi.fn(), clearError: vi.fn() }),
}))
vi.mock('../hooks/useConversations', () => ({
    useConversations: () => ({ conversations: mocks.loadedConversations, setConversations: vi.fn(), isLoading: false }),
    markChatRead: vi.fn(),
    releaseStickyUnread: vi.fn(),
    isStickyUnread: () => false,
}))
vi.mock('../hooks/useChatNavigation', () => ({ useChatNavigation: () => ({ setChatId: vi.fn(), setListTab: vi.fn() }) }))
vi.mock('../hooks/useMessages', () => ({ prefetchMessages: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('react-virtuoso', () => ({
    Virtuoso: ({ data, itemContent }: { data: Array<{ id: string; name: string }>; itemContent: (index: number, item: unknown) => unknown }) => (
        <div data-testid="conversation-list">{data.map((conversation) => <div key={conversation.id} data-testid={`conversation-${conversation.id}`}>{conversation.name}</div>)}</div>
    ),
}))
vi.mock('./NewChatPopover', () => ({ default: () => null }))
vi.mock('./AiInternToggle', () => ({ default: () => null }))
vi.mock('./LeadStatusBadge', () => ({ LeadStatusBadge: () => null }))
vi.mock('@/modules/calling/public/v1/client-ui/CallToolbar', () => ({ default: () => null }))

import ChatList from './ChatList'

function item(contactId: string, overrides: Partial<ContactLookupItemV1> = {}): ContactLookupItemV1 {
    return { contactId, displayName: `Пётр ${contactId}`, displayTitle: `Пётр ${contactId}`, primaryPhone: null, channels: [], ...overrides }
}

function found(contactId: string, conversationIds: string[], options: { truncated?: boolean; canonicalContactId?: string } = {}): ContactConversationsEntryV1 {
    return {
        contactId,
        status: 'found',
        canonicalContactId: options.canonicalContactId ?? contactId,
        channels: conversationIds.length === 0 ? [] : [{
            channel: 'telegram',
            primaryConversationId: conversationIds[0],
            conversations: conversationIds.map((conversationId) => ({ conversationId, lastActivityAt: null })),
        }],
        latestConversationId: conversationIds[0] ?? null,
        truncated: options.truncated ?? false,
    }
}

function conversation(id: string, name: string) {
    return {
        id, name, channel: 'telegram', chatType: 'private', externalChatId: `tg:${id}`, lastMessageAt: '2026-10-07T00:00:00.000Z',
        unreadCount: 0, requiresResponse: false, status: 'open', allChatIds: [id], channelChats: {}, allChannels: ['telegram'],
    }
}

function answerConversations(...entries: ContactConversationsEntryV1[]) {
    mocks.conversations.mockResolvedValue({ ok: true, result: { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: entries } })
}

let onSelectChat: Mock<(id: string, channelHint?: string) => void>

beforeEach(() => {
    vi.clearAllMocks()
    onSelectChat = vi.fn<(id: string, channelHint?: string) => void>()
    mocks.loadedConversations = [conversation('chat-visible', 'Пётр Иванов')]
    mocks.lookup.mockResolvedValue({ items: [], total: 0, truncated: false })
    mocks.startByContact.mockResolvedValue({ chatId: 'chat-created', channel: 'telegram', isNew: true })
    mocks.fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

async function searchFor(text: string, items: ContactLookupItemV1[]) {
    mocks.lookup.mockResolvedValue({ items, total: items.length, truncated: false })
    render(<ChatList selectedChatId={null} activeListTab="all" onSelectChat={onSelectChat} />)
    fireEvent.change(screen.getByPlaceholderText('Поиск...'), { target: { value: text } })
    await waitFor(() => expect(mocks.lookup).toHaveBeenCalledWith({ query: text, limit: 8 }))
    if (items.length > 0) await waitFor(() => expect(mocks.conversations).toHaveBeenCalled())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
}

const extraRow = (name: string) => screen.queryByText(name)

describe('ChatList — one search box, extra Contacts proven by Messaging', () => {
    it('keeps one search input that still filters the loaded conversations', async () => {
        await searchFor('Пётр', [])
        expect(screen.getAllByPlaceholderText('Поиск...')).toHaveLength(1)
        expect(screen.getByTestId('conversation-chat-visible')).toBeTruthy()
    })

    it('hides a Contact whose known conversation is already visible', async () => {
        answerConversations(found('c-1', ['chat-visible']))
        await searchFor('Пётр', [item('c-1')])
        expect(extraRow('Пётр c-1')).toBeNull()
    })

    it('still hides it when the answer is truncated', async () => {
        answerConversations(found('c-1', ['chat-other', 'chat-visible'], { truncated: true }))
        await searchFor('Пётр', [item('c-1')])
        expect(extraRow('Пётр c-1')).toBeNull()
    })

    it('shows a Contact on a complete answer with no visible conversation, and opens its latest one', async () => {
        answerConversations(found('c-1', ['chat-hidden-latest', 'chat-hidden-older']))
        await searchFor('Пётр', [item('c-1')])

        fireEvent.click(screen.getByText('Пётр c-1'))

        expect(onSelectChat).toHaveBeenCalledWith('chat-hidden-latest')
        expect(mocks.startByContact).not.toHaveBeenCalled()
        expect(screen.queryByTestId('new-chat-hint')).toBeNull()
    })

    it('does not show a Contact whose truncated answer merely lacks a visible id', async () => {
        answerConversations(found('c-1', ['chat-hidden'], { truncated: true }))
        await searchFor('Пётр', [item('c-1')])
        expect(extraRow('Пётр c-1')).toBeNull()
    })

    it.each([
        ['not_found', () => answerConversations({ contactId: 'c-1', status: 'not_found' })],
        ['unavailable', () => mocks.conversations.mockResolvedValue({ ok: false, error: 'unavailable' })],
        ['a failed transport', () => mocks.conversations.mockRejectedValue(new Error('network'))],
        ['loading', () => mocks.conversations.mockReturnValue(new Promise(() => {}))],
    ])('does not show a Contact on %s', async (_label, arrange) => {
        arrange()
        await searchFor('Пётр', [item('c-1')])
        expect(extraRow('Пётр c-1')).toBeNull()
        expect(mocks.startByContact).not.toHaveBeenCalled()
    })

    it('shows «новый чат» only on a complete answer with no conversation, and starts for the canonical Contact', async () => {
        answerConversations(found('c-1', [], { canonicalContactId: 'c-survivor' }))
        await searchFor('Пётр', [item('c-1')])

        expect(screen.getByTestId('new-chat-hint').textContent).toBe('новый чат')
        fireEvent.click(screen.getByText('Пётр c-1'))

        await waitFor(() => expect(mocks.startByContact).toHaveBeenCalledWith('c-survivor', 'tg'))
        await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('chat-created'))
    })

    it('shows identity channel badges from ContactLookup only', async () => {
        answerConversations(found('c-1', ['chat-hidden']))
        await searchFor('Пётр', [item('c-1', { channels: ['whatsapp'] })])

        const contactRow = screen.getByText('Пётр c-1').closest('button') as HTMLButtonElement
        expect(contactRow.textContent).toContain('WA')
        expect(contactRow.textContent).not.toContain('TG')
    })

    it('never reaches the legacy contact search and reads conversations only through Messaging', async () => {
        answerConversations(found('c-1', ['chat-hidden']))
        await searchFor('Пётр', [item('c-1')])
        expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/api/contacts/search'))).toEqual([])
        expect(mocks.conversations).toHaveBeenCalledWith({ contract: 'messaging.ContactConversationsQuery.v1', contactIds: ['c-1'] })
    })
})
