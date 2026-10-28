// The card read model bound to Messaging's real RCQ1 handler, exactly as a
// composition binds it, over an in-memory conversation and Contact store whose
// links and merges can change in the middle of a read.

import { describe, expect, test } from 'vitest'

import { CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, CONTACT_CARD_FOR_CONVERSATION_RESULT_V1 } from '@/contracts/contacts/v1'
import { RESOLVE_CONVERSATION_CONTACT_QUERY_V1 } from '@/contracts/messaging/v1'
import { createResolveConversationContactHandlerV1 } from '@/modules/messaging/public/v1/resolve-conversation-contact-handler'

import { createContactCardForConversationHandlerV1, type ContactCardSourceV1 } from './contact-card-for-conversation'

type Store = {
  chats: Record<string, { contactId: string | null; metadata?: unknown }>
  /** contactId → mergedIntoContactId (null when canonical); absent when the Contact does not exist. */
  contacts: Record<string, string | null>
}

function source(id: string, mergedInto: string | null): ContactCardSourceV1 {
  return {
    id,
    displayName: `${id.toUpperCase()}-NAME`,
    displayNameSource: 'provider',
    primaryPhoneId: null,
    isArchived: false,
    customFields: mergedInto === null ? {} : { mergedIntoContactId: mergedInto },
    phones: [],
    identities: [],
    mergedFromCount: 0,
    confirmedPersonName: null,
  }
}

function compose(store: Store, onSourceRead: (contactId: string) => void = () => {}) {
  const rcq1Queries: unknown[] = []
  const resolveConversationContactV1 = createResolveConversationContactHandlerV1({
    async findConversationContact(chatId) {
      const chat = store.chats[chatId]
      if (!chat) return null
      const resolution = (chat.metadata as { contactResolution?: { status?: string } } | undefined)?.contactResolution
      return { contactId: chat.contactId, contactResolutionStatus: resolution?.status ?? null }
    },
    async canonicalContactId(contactId) {
      let cursor: string | null = contactId
      for (let depth = 0; cursor !== null && depth < 32; depth += 1) {
        if (!(cursor in store.contacts)) return null
        const next: string | null = store.contacts[cursor]
        if (next === null) return cursor
        cursor = next
      }
      return null
    },
  })
  const read = createContactCardForConversationHandlerV1({
    authority: {
      currentPrincipal: async () => ({ kind: 'integration_admin_session' }),
      mayReadConversation: async () => true,
      mayReadContact: async () => true,
    },
    // The binding a composition writes: the exact Chat.id, RCQ1's own query contract, nothing else.
    resolveConversation: chatId => {
      const rcq1Query = { contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId }
      rcq1Queries.push(rcq1Query)
      return resolveConversationContactV1(rcq1Query)
    },
    cardSource: {
      async findContactCardSource(contactId) {
        onSourceRead(contactId)
        return contactId in store.contacts ? source(contactId, store.contacts[contactId]) : null
      },
    },
  })
  return { read, rcq1Queries }
}

const query = (chatId: string) => ({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId })
const nothing = (status: string) => ({ contract: CONTACT_CARD_FOR_CONVERSATION_RESULT_V1, status })

describe('Contact card over the real RCQ1 handler', () => {
  test('a conversation linked to a merged-away Contact shows the canonical survivor', async () => {
    const { read, rcq1Queries } = compose({
      chats: { 'chat-1': { contactId: 'contact-old' } },
      contacts: { 'contact-old': 'contact-a', 'contact-a': null },
    })
    const result = await read(query('chat-1'))
    expect(result.status).toBe('confirmed')
    if (result.status === 'confirmed') expect(result.card.contactId).toBe('contact-a')
    expect(rcq1Queries).toEqual([
      { contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId: 'chat-1' },
      { contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId: 'chat-1' },
    ])
  })

  test('RCQ1 ambiguous → conflict; not_found → missing; unlinked → unresolved; link to a deleted Contact → unresolved', async () => {
    const store: Store = {
      chats: {
        'chat-ambiguous': { contactId: 'contact-a', metadata: { contactResolution: { status: 'ambiguous' } } },
        'chat-unlinked': { contactId: null },
        'chat-dangling': { contactId: 'contact-gone' },
      },
      contacts: { 'contact-a': null },
    }
    const { read } = compose(store)
    expect(await read(query('chat-ambiguous'))).toEqual(nothing('conflict'))
    expect(await read(query('chat-unknown'))).toEqual(nothing('missing'))
    expect(await read(query('chat-unlinked'))).toEqual(nothing('unresolved'))
    expect(await read(query('chat-dangling'))).toEqual(nothing('unresolved'))
  })

  test('the conversation is relinked to another person while the card is read → refused, no data', async () => {
    const store: Store = { chats: { 'chat-1': { contactId: 'contact-a' } }, contacts: { 'contact-a': null, 'contact-b': null } }
    const { read } = compose(store, () => { store.chats['chat-1'].contactId = 'contact-b' })
    expect(await read(query('chat-1'))).toEqual(nothing('refused'))
  })

  test('the Contact is merged into another while the card is read → refused, no data', async () => {
    const store: Store = { chats: { 'chat-1': { contactId: 'contact-a' } }, contacts: { 'contact-a': null, 'contact-c': null } }
    const { read } = compose(store, () => { store.contacts['contact-a'] = 'contact-c' })
    expect(await read(query('chat-1'))).toEqual(nothing('refused'))
  })

  test('the conversation becomes ambiguous while the card is read → refused', async () => {
    const store: Store = { chats: { 'chat-1': { contactId: 'contact-a' } }, contacts: { 'contact-a': null } }
    const { read } = compose(store, () => { store.chats['chat-1'].metadata = { contactResolution: { status: 'ambiguous' } } })
    expect(await read(query('chat-1'))).toEqual(nothing('refused'))
  })

  test('the conversation is deleted while the card is read → refused', async () => {
    const store: Store = { chats: { 'chat-1': { contactId: 'contact-a' } }, contacts: { 'contact-a': null } }
    const { read } = compose(store, () => { delete store.chats['chat-1'] })
    expect(await read(query('chat-1'))).toEqual(nothing('refused'))
  })
})
