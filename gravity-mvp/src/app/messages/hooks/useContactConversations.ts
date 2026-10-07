"use client"

// M3A6D useContactConversations — the client lifecycle of
// messaging.ContactConversationsQuery.v1 for the conversation screens.
//
// It asks the landed Messaging transport (readContactConversationsAction) and
// keeps the newest answer, nothing more: it reads no Chat, derives no
// conversation, backfills nothing and creates nothing. The two decision helpers
// below turn an answer into what a screen may DO, and both fail closed: only a
// complete Messaging answer can prove that a conversation does not exist.

import { useEffect, useMemo, useRef, useState } from 'react'

import {
    CONTACT_CONVERSATIONS_QUERY_V1,
    contactChannelConversationsV1,
    type ContactConversationsChannelV1,
    type ContactConversationsEntryV1,
    type ContactConversationsFoundV1,
} from '@/contracts/messaging/v1/contact-conversations-query'
import { readContactConversationsAction } from '../contact-conversations-actions'

export type ContactConversationsStateV1 =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; entries: ReadonlyMap<string, ContactConversationsEntryV1> }
    | { status: 'unavailable' }

/**
 * The conversation context of these Contacts, refreshed whenever the id list
 * changes. An answer for an older list never replaces a newer one, and an empty
 * list asks nothing.
 */
export function useContactConversations(contactIds: readonly string[]): ContactConversationsStateV1 {
    const key = JSON.stringify(contactIds)
    const [state, setState] = useState<{ key: string; value: ContactConversationsStateV1 }>({ key: '[]', value: { status: 'idle' } })
    const sequenceRef = useRef(0)

    useEffect(() => {
        const sequence = ++sequenceRef.current
        const ids = JSON.parse(key) as string[]
        if (ids.length === 0) {
            setState({ key, value: { status: 'idle' } })
            return
        }
        setState({ key, value: { status: 'loading' } })
        const apply = (value: ContactConversationsStateV1) => {
            if (sequence === sequenceRef.current) setState({ key, value })
        }
        readContactConversationsAction({ contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: ids }).then(
            (answer) => {
                if (!answer.ok) return apply({ status: 'unavailable' })
                const entries = new Map<string, ContactConversationsEntryV1>()
                for (const entry of answer.result.contacts) {
                    if (ids.includes(entry.contactId)) entries.set(entry.contactId, entry)
                }
                apply({ status: 'ready', entries })
            },
            () => apply({ status: 'unavailable' }),
        )
        return () => { sequenceRef.current += 1 }
    }, [key])

    // Until the effect for a new list has run, the old list's answer is not this list's answer.
    return useMemo(() => (state.key === key ? state.value : { status: contactIds.length === 0 ? 'idle' : 'loading' } as ContactConversationsStateV1), [state, key, contactIds.length])
}

/** What a screen may do about one Contact on one channel. */
export type ContactChannelDecisionV1 =
    | { kind: 'open'; conversationId: string }
    | { kind: 'start'; canonicalContactId: string }
    | { kind: 'unknown' }
    | { kind: 'not_found' }
    | { kind: 'unavailable' }
    | { kind: 'loading' }

/**
 * present → open its primary conversation; absent → the existing start-by-contact
 * flow may run for the canonical Contact; anything else is no evidence and
 * permits no creation.
 */
export function contactChannelDecisionV1(
    state: ContactConversationsStateV1,
    contactId: string,
    channel: ContactConversationsChannelV1,
): ContactChannelDecisionV1 {
    if (state.status === 'idle' || state.status === 'loading') return { kind: 'loading' }
    if (state.status === 'unavailable') return { kind: 'unavailable' }
    const entry = state.entries.get(contactId)
    if (!entry) return { kind: 'unavailable' }
    const lookup = contactChannelConversationsV1(entry, channel)
    if (lookup.kind === 'present') return { kind: 'open', conversationId: lookup.primaryConversationId }
    if (lookup.kind === 'absent') return { kind: 'start', canonicalContactId: (entry as ContactConversationsFoundV1).canonicalContactId }
    return { kind: lookup.kind }
}

/** Every conversation id the answer KNOWS for this Contact; a truncated answer may know fewer than exist. */
export function knownConversationIdsV1(entry: ContactConversationsFoundV1): string[] {
    return entry.channels.flatMap((channel) => channel.conversations.map((conversation) => conversation.conversationId))
}

/**
 * Whether a Contact found by search may be offered as an extra Contact beside
 * the visible conversations. Only a complete answer with no visible conversation
 * proves it is not already represented; a known visible conversation hides it
 * even when the answer is truncated, and missing ids in a truncated answer prove
 * nothing.
 */
export function isExtraContactV1(state: ContactConversationsStateV1, contactId: string, visibleConversationIds: ReadonlySet<string>): boolean {
    if (state.status !== 'ready') return false
    const entry = state.entries.get(contactId)
    if (!entry || entry.status !== 'found') return false
    if (knownConversationIdsV1(entry).some((conversationId) => visibleConversationIds.has(conversationId))) return false
    return entry.truncated === false
}

/** The found entry of a Contact, or null when the answer proves nothing about it. */
export function foundContactConversationsV1(state: ContactConversationsStateV1, contactId: string): ContactConversationsFoundV1 | null {
    if (state.status !== 'ready') return null
    const entry = state.entries.get(contactId)
    return entry && entry.status === 'found' ? entry : null
}

/** The «новый чат» hint of a search row: a complete answer with no conversation at all. */
export function hasProvenNoConversationV1(state: ContactConversationsStateV1, contactId: string): boolean {
    const entry = foundContactConversationsV1(state, contactId)
    return entry !== null && entry.truncated === false && entry.latestConversationId === null
}
