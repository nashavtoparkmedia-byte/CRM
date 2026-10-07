/**
 * M3A6D conversation context: the client lifecycle over the landed Messaging
 * transport, and the two fail-closed decision helpers both screens use.
 *
 * The transport is a fake whose answers are released by hand. Answers are real
 * ContactConversationsResult.v1 shapes, so the helpers are proven against the
 * contract's own contactChannelConversationsV1, not a re-statement of it.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    CONTACT_CONVERSATIONS_QUERY_V1,
    CONTACT_CONVERSATIONS_RESULT_V1,
    type ContactConversationsEntryV1,
    type ContactConversationsFoundV1,
} from '@/contracts/messaging/v1/contact-conversations-query'

type ActionAnswer = { ok: true; result: { contract: string; contacts: ContactConversationsEntryV1[] } } | { ok: false; error: string }

const mocks = vi.hoisted(() => ({
    calls: [] as Array<{ query: unknown; resolve: (value: unknown) => void; reject: (reason: unknown) => void }>,
}))

vi.mock('../contact-conversations-actions', () => ({
    readContactConversationsAction: vi.fn((query: unknown) => new Promise((resolve, reject) => {
        mocks.calls.push({ query, resolve, reject })
    })),
}))

import {
    contactChannelDecisionV1,
    hasProvenNoConversationV1,
    isExtraContactV1,
    useContactConversations,
    type ContactConversationsStateV1,
} from './useContactConversations'
import { readContactConversationsAction } from '../contact-conversations-actions'

function found(contactId: string, channels: Array<[string, string[]]>, options: { truncated?: boolean; canonicalContactId?: string } = {}): ContactConversationsFoundV1 {
    const contexts = channels.map(([channel, ids]) => ({
        channel: channel as ContactConversationsFoundV1['channels'][number]['channel'],
        primaryConversationId: ids[0],
        conversations: ids.map((conversationId) => ({ conversationId, lastActivityAt: null })),
    }))
    return {
        contactId,
        status: 'found',
        canonicalContactId: options.canonicalContactId ?? contactId,
        channels: contexts,
        latestConversationId: contexts[0]?.primaryConversationId ?? null,
        truncated: options.truncated ?? false,
    }
}

const notFound = (contactId: string): ContactConversationsEntryV1 => ({ contactId, status: 'not_found' })

function ok(contacts: ContactConversationsEntryV1[]): ActionAnswer {
    return { ok: true, result: { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts } }
}

function ready(...entries: ContactConversationsEntryV1[]): ContactConversationsStateV1 {
    return { status: 'ready', entries: new Map(entries.map((entry) => [entry.contactId, entry])) }
}

beforeEach(() => {
    mocks.calls.length = 0
    vi.mocked(readContactConversationsAction).mockClear()
})

describe('useContactConversations', () => {
    it('asks nothing for no Contacts', () => {
        const { result } = renderHook(() => useContactConversations([]))
        expect(result.current).toEqual({ status: 'idle' })
        expect(readContactConversationsAction).not.toHaveBeenCalled()
    })

    it('asks the landed Messaging transport with the exact contract and ids, in order', async () => {
        const { result } = renderHook(() => useContactConversations(['c-2', 'c-1']))
        expect(result.current).toEqual({ status: 'loading' })
        expect(readContactConversationsAction).toHaveBeenCalledTimes(1)
        expect(mocks.calls[0].query).toEqual({ contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: ['c-2', 'c-1'] })

        await act(async () => { mocks.calls[0].resolve(ok([found('c-2', [['telegram', ['chat-a']]]), notFound('c-1')])) })
        expect(result.current.status).toBe('ready')
        if (result.current.status === 'ready') {
            expect(result.current.entries.get('c-1')).toEqual(notFound('c-1'))
            expect(result.current.entries.get('c-2')?.status).toBe('found')
        }
    })

    it('does not ask again while the same ids are passed as a new array', () => {
        const { rerender } = renderHook(({ ids }) => useContactConversations(ids), { initialProps: { ids: ['c-1'] } })
        rerender({ ids: ['c-1'] })
        rerender({ ids: ['c-1'] })
        expect(readContactConversationsAction).toHaveBeenCalledTimes(1)
    })

    it('reports a refused or failed answer as unavailable, never as a Contact without conversations', async () => {
        const { result, rerender } = renderHook(({ ids }) => useContactConversations(ids), { initialProps: { ids: ['c-1'] } })
        await act(async () => { mocks.calls[0].resolve({ ok: false, error: 'unavailable' }) })
        expect(result.current).toEqual({ status: 'unavailable' })

        rerender({ ids: ['c-2'] })
        await act(async () => { mocks.calls[1].reject(new Error('network')) })
        expect(result.current).toEqual({ status: 'unavailable' })
    })

    it('never lets the answer for an older id list replace a newer one', async () => {
        const { result, rerender } = renderHook(({ ids }) => useContactConversations(ids), { initialProps: { ids: ['c-old'] } })
        rerender({ ids: ['c-new'] })
        expect(result.current).toEqual({ status: 'loading' })

        await act(async () => { mocks.calls[1].resolve(ok([found('c-new', [['telegram', ['chat-new']]])])) })
        await act(async () => { mocks.calls[0].resolve(ok([found('c-old', [['telegram', ['chat-old']]])])) })

        await waitFor(() => expect(result.current.status).toBe('ready'))
        if (result.current.status === 'ready') {
            expect([...result.current.entries.keys()]).toEqual(['c-new'])
        }
    })

    it('ignores an entry for a Contact it did not ask about', async () => {
        const { result } = renderHook(() => useContactConversations(['c-1']))
        await act(async () => { mocks.calls[0].resolve(ok([found('c-1', []), found('c-intruder', [['telegram', ['chat-x']]])])) })
        if (result.current.status === 'ready') expect([...result.current.entries.keys()]).toEqual(['c-1'])
    })
})

describe('contactChannelDecisionV1', () => {
    it('opens the channel\'s primary conversation when it is present', () => {
        const state = ready(found('c-1', [['whatsapp', ['chat-w1', 'chat-w2']], ['telegram', ['chat-t1']]]))
        expect(contactChannelDecisionV1(state, 'c-1', 'telegram')).toEqual({ kind: 'open', conversationId: 'chat-t1' })
        expect(contactChannelDecisionV1(state, 'c-1', 'whatsapp')).toEqual({ kind: 'open', conversationId: 'chat-w1' })
    })

    it('starts only on a proven absence, and for the canonical Contact Messaging returned', () => {
        const state = ready(found('c-merged', [['telegram', ['chat-t1']]], { canonicalContactId: 'c-survivor' }))
        expect(contactChannelDecisionV1(state, 'c-merged', 'max')).toEqual({ kind: 'start', canonicalContactId: 'c-survivor' })
    })

    it('never treats a channel missing from a truncated answer as absent', () => {
        const state = ready(found('c-1', [['telegram', ['chat-t1']]], { truncated: true }))
        expect(contactChannelDecisionV1(state, 'c-1', 'max')).toEqual({ kind: 'unknown' })
        // Positive evidence stays valid even when truncated.
        expect(contactChannelDecisionV1(state, 'c-1', 'telegram')).toEqual({ kind: 'open', conversationId: 'chat-t1' })
    })

    it('fails closed for not_found, unavailable, loading and a missing entry', () => {
        expect(contactChannelDecisionV1(ready(notFound('c-1')), 'c-1', 'telegram')).toEqual({ kind: 'not_found' })
        expect(contactChannelDecisionV1({ status: 'unavailable' }, 'c-1', 'telegram')).toEqual({ kind: 'unavailable' })
        expect(contactChannelDecisionV1({ status: 'loading' }, 'c-1', 'telegram')).toEqual({ kind: 'loading' })
        expect(contactChannelDecisionV1({ status: 'idle' }, 'c-1', 'telegram')).toEqual({ kind: 'loading' })
        expect(contactChannelDecisionV1(ready(found('c-other', [])), 'c-1', 'telegram')).toEqual({ kind: 'unavailable' })
    })
})

describe('isExtraContactV1', () => {
    const visible = new Set(['chat-visible'])

    it('hides a Contact whose known conversation is visible', () => {
        expect(isExtraContactV1(ready(found('c-1', [['telegram', ['chat-visible']]])), 'c-1', visible)).toBe(false)
    })

    it('keeps hiding it when the answer is truncated', () => {
        expect(isExtraContactV1(ready(found('c-1', [['telegram', ['chat-other', 'chat-visible']]], { truncated: true })), 'c-1', visible)).toBe(false)
    })

    it('shows a Contact only on a complete answer with no visible conversation', () => {
        expect(isExtraContactV1(ready(found('c-1', [['telegram', ['chat-hidden']]])), 'c-1', visible)).toBe(true)
        expect(isExtraContactV1(ready(found('c-1', [])), 'c-1', visible)).toBe(true)
    })

    it('does not show a Contact whose truncated answer merely lacks a visible id', () => {
        expect(isExtraContactV1(ready(found('c-1', [['telegram', ['chat-hidden']]], { truncated: true })), 'c-1', visible)).toBe(false)
    })

    it('does not show a Contact on not_found, unavailable, loading or a missing entry', () => {
        expect(isExtraContactV1(ready(notFound('c-1')), 'c-1', visible)).toBe(false)
        expect(isExtraContactV1({ status: 'unavailable' }, 'c-1', visible)).toBe(false)
        expect(isExtraContactV1({ status: 'loading' }, 'c-1', visible)).toBe(false)
        expect(isExtraContactV1(ready(), 'c-1', visible)).toBe(false)
    })
})

describe('hasProvenNoConversationV1', () => {
    it('is true only for a complete answer with no conversation at all', () => {
        expect(hasProvenNoConversationV1(ready(found('c-1', [])), 'c-1')).toBe(true)
        expect(hasProvenNoConversationV1(ready(found('c-1', [['telegram', ['chat-t1']]])), 'c-1')).toBe(false)
        expect(hasProvenNoConversationV1(ready({ ...found('c-1', []), truncated: true }), 'c-1')).toBe(false)
        expect(hasProvenNoConversationV1(ready(notFound('c-1')), 'c-1')).toBe(false)
        expect(hasProvenNoConversationV1({ status: 'unavailable' }, 'c-1')).toBe(false)
        expect(hasProvenNoConversationV1({ status: 'loading' }, 'c-1')).toBe(false)
    })
})
