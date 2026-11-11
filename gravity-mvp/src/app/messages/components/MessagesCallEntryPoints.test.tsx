// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactSearchResult } from '../hooks/useContactSearch'

/**
 * Communication Workspace P2 (Calling integration), messages side.
 *
 * Every call from the messages screen goes through Calling's CallButton, which names a Contact
 * (and optionally one of its Contacts phone ids) and lets Calling decide whether to dial that
 * Contact's verified phone. Nothing here dials a number: not the chat id, not the driver's
 * phone and not text typed into the new-chat search box (Owner: a new number is called only
 * after creating a Contact).
 */

const search = vi.hoisted(() => ({ results: [] as ContactSearchResult[] }))
const conversation = vi.hoisted(() => ({ startByContact: vi.fn(), startByPhone: vi.fn() }))

vi.mock('@/modules/calling/public/v1/client-ui/CallButton', () => ({
    default: (props: { contactId?: string; phoneId?: string; phoneNumber?: string }) => (
        <button
            type="button"
            data-testid="calling-call-button"
            data-contact-id={props.contactId ?? ''}
            data-phone-id={props.phoneId ?? ''}
            data-phone-number={props.phoneNumber ?? ''}
        />
    ),
}))
// A registered SIP client with the placeholder-call hooks, so a stray dial path would run to its fetch.
vi.mock('@/modules/calling/public/v1/sip-client-context', () => ({
    useSip: () => ({ status: 'registered', startPlaceholderOutbound: vi.fn(), cancelPlaceholderOutbound: vi.fn(), setActiveCallFsUuid: vi.fn() }),
}))
vi.mock('../hooks/useContactSearch', () => ({
    useContactSearch: () => ({ results: search.results, loading: false, total: search.results.length }),
}))
vi.mock('../hooks/useStartConversation', () => ({
    useStartConversation: () => ({
        loading: false,
        error: null,
        startByContact: conversation.startByContact,
        startByPhone: conversation.startByPhone,
        clearError: vi.fn(),
    }),
}))

import NewChatPopover from './NewChatPopover'

const ivan: ContactSearchResult = {
    id: 'contact-ivan',
    displayName: 'Иван Петров',
    masterSource: 'manual',
    phones: [{ id: 'phone-ivan-1', phone: '+79990000001', isPrimary: true, source: 'manual' }],
    identities: [],
    channels: ['telegram'],
    hasChat: { telegram: 'chat-ivan-tg' },
}

const fetchSpy = vi.fn()

function openPhoneChannel(typed: string) {
    const onSelectChat = vi.fn()
    const onClose = vi.fn()
    render(<NewChatPopover onClose={onClose} onSelectChat={onSelectChat} />)
    fireEvent.click(screen.getByRole('button', { name: /^Тел/ }))
    const input = screen.getByPlaceholderText('+7 922 215-57-50')
    fireEvent.change(input, { target: { value: typed } })
    return { input, onSelectChat, onClose }
}

describe('messages call entry points', () => {
    beforeEach(() => {
        search.results = []
        conversation.startByContact.mockReset()
        conversation.startByPhone.mockReset()
        fetchSpy.mockReset()
        fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
        vi.stubGlobal('fetch', fetchSpy)
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
        })
    })
    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('offers a found contact a call only through Calling, by contact id', () => {
        search.results = [ivan]
        openPhoneChannel('+79990000001')

        const buttons = screen.getAllByTestId('calling-call-button')
        expect(buttons).toHaveLength(1)
        expect(buttons[0].dataset.contactId).toBe('contact-ivan')
        expect(buttons[0].dataset.phoneNumber).toBe('')
        // The row itself is not a call target, and the footer has no «Позвонить».
        expect(screen.queryByRole('button', { name: /Иван Петров/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Позвонить/ })).toBeNull()
    })

    it('never dials text typed into the search box', async () => {
        const { input } = openPhoneChannel('+79990000002')

        fireEvent.keyDown(input, { key: 'Enter' })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(screen.queryByTestId('calling-call-button')).toBeNull()
        expect(screen.getByText('Контакт не найден. Позвонить можно только контакту — сначала создайте его.')).toBeTruthy()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(conversation.startByPhone).not.toHaveBeenCalled()
        expect(conversation.startByContact).not.toHaveBeenCalled()
    })

    it('does not dial a found contact on Enter either', async () => {
        search.results = [ivan]
        const { input } = openPhoneChannel('+79990000001')

        fireEvent.keyDown(input, { key: 'Enter' })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(conversation.startByContact).not.toHaveBeenCalled()
    })

    it('keeps the text channels opening the contact chat as before', () => {
        search.results = [ivan]
        const onSelectChat = vi.fn()
        render(<NewChatPopover onClose={vi.fn()} onSelectChat={onSelectChat} />)
        fireEvent.change(screen.getByPlaceholderText('Телефон или имя...'), { target: { value: 'Иван' } })

        fireEvent.click(screen.getByRole('button', { name: /Иван Петров/ }))

        expect(onSelectChat).toHaveBeenCalledWith('chat-ivan-tg')
        expect(screen.queryByTestId('calling-call-button')).toBeNull()
        expect(fetchSpy).not.toHaveBeenCalled()
    })
})

describe('messages call entry points in source', () => {
    const messagesRoot = path.resolve(__dirname, '..')
    const sources = (function walk(dir: string): string[] {
        return readdirSync(dir).flatMap(name => {
            const full = path.join(dir, name)
            if (statSync(full).isDirectory()) return walk(full)
            return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [full] : []
        })
    })(messagesRoot)
    const read = (relative: string) => readFileSync(path.join(messagesRoot, relative), 'utf8')

    it('never posts to the originate route and never hands CallButton a number', () => {
        expect(sources.length).toBeGreaterThan(10)
        for (const file of sources) {
            const text = readFileSync(file, 'utf8')
            expect(text, file).not.toMatch(/\/api\/calls\/originate/)
            expect(text, file).not.toMatch(/<CallButton\b[^>]*\bphoneNumber=/)
            expect(text, file).not.toMatch(/startPlaceholderOutbound|setActiveCallFsUuid/)
        }
    })

    it('names the Contact in the chat header and the Contact phone in the profile drawer', () => {
        expect(read('components/ChatHeader.tsx')).toContain('<CallButton contactId={contact.id} label="" />')
        expect(read('components/ContactProfileDrawer.tsx')).toContain('<CallButton contactId={contact.id} phoneId={phone.id} label="" />')
        expect(read('components/NewChatPopover.tsx')).toContain('<CallButton contactId={contact.id} label="" />')
    })
})
