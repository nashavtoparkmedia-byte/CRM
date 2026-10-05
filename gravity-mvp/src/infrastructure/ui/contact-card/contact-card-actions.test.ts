import { beforeEach, describe, expect, it, vi } from 'vitest'

// M3A2 Contact Card composition, proven end to end over real public semantics.
//
// RCQ1 is the real Messaging handler over an in-memory Chat table, and its
// canonical Contact comes from the real Contacts merge-lineage handler over an
// in-memory Contact table, so the composition is proven against the authority it
// consumes rather than a stub of it. Only the Contacts card summary read is a
// fake, recording every Contact it is asked for.

import { createResolveConversationContactHandlerV1 } from '@/modules/messaging/public/v1/resolve-conversation-contact-handler'
import { createResolveContactLineageHandlerV1 } from '@/modules/contacts/public/v1/contact-lineage-handler'
import type { ContactCardSummaryV1 } from '@/modules/contacts/public/v1/contact-card-summary'

type ChatRow = { id: string; contactId: string | null; resolutionStatus: string | null }
type ContactRow = { id: string; mergedIntoContactId: string | null }

let chats: ChatRow[]
let contacts: ContactRow[]
let summaries: Map<string, ContactCardSummaryV1>
let reads: string[]

const lineage = createResolveContactLineageHandlerV1({
  async findRedirect(contactId) {
    reads.push(`lineage:${contactId}`)
    const row = contacts.find((contact) => contact.id === contactId)
    return row ? { id: row.id, mergedIntoContactId: row.mergedIntoContactId } : null
  },
  async findMergedContactIds(survivorId) {
    return contacts.filter((contact) => contact.mergedIntoContactId === survivorId).map((contact) => contact.id)
  },
})

const resolveConversationContact = createResolveConversationContactHandlerV1({
  async findConversationContact(chatId) {
    reads.push(`chat:${chatId}`)
    const row = chats.find((chat) => chat.id === chatId)
    return row ? { contactId: row.contactId, contactResolutionStatus: row.resolutionStatus } : null
  },
  async canonicalContactId(contactId) {
    return (await lineage(contactId))?.canonicalContactId ?? null
  },
})

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  summary: vi.fn(),
}))

vi.mock('@/modules/messaging/public/v1', () => ({ resolveConversationContactV1: mocks.resolve }))
vi.mock('@/modules/contacts/public/v1', () => ({ getContactCardSummaryV1: mocks.summary }))

import { loadContactCardForConversationV1 } from './contact-card-actions'

function summaryFor(contactId: string): ContactCardSummaryV1 {
  return {
    contactId,
    displayName: `Контакт ${contactId}`,
    displayTitle: `Контакт ${contactId}`,
    primaryPhone: '+7 900 123-45-67',
    phoneCount: 1,
    channels: [{ channel: 'telegram', identityCount: 1, hasActiveIdentity: true, conflictState: 'clear' }],
    hasIdentityConflict: false,
    source: 'chat',
    lineage: { mergedFromCount: 0 },
  }
}

const summaryReads = () => reads.filter((read) => read.startsWith('summary:'))

beforeEach(() => {
  chats = []
  contacts = []
  summaries = new Map()
  reads = []
  mocks.resolve.mockReset().mockImplementation(resolveConversationContact)
  mocks.summary.mockReset().mockImplementation(async (contactId: string) => {
    reads.push(`summary:${contactId}`)
    return summaries.get(contactId) ?? null
  })
})

describe('loadContactCardForConversationV1', () => {
  it('resolves the exact persisted Chat.id and reads the summary of that Contact only', async () => {
    chats.push({ id: 'chat-1', contactId: 'contact-1', resolutionStatus: null })
    contacts.push({ id: 'contact-1', mergedIntoContactId: null })
    summaries.set('contact-1', summaryFor('contact-1'))

    const result = await loadContactCardForConversationV1('chat-1')

    expect(result).toEqual({ status: 'resolved', summary: summaries.get('contact-1') })
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.resolve).toHaveBeenCalledWith({ contract: 'messaging.ResolveConversationContactQuery.v1', chatId: 'chat-1' })
    expect(reads).toEqual(['chat:chat-1', 'lineage:contact-1', 'summary:contact-1'])
  })

  it('passes the summary through unchanged', async () => {
    chats.push({ id: 'chat-1', contactId: 'contact-1', resolutionStatus: null })
    contacts.push({ id: 'contact-1', mergedIntoContactId: null })
    const summary = summaryFor('contact-1')
    summaries.set('contact-1', summary)

    const result = await loadContactCardForConversationV1('chat-1')

    expect(result.status === 'resolved' && result.summary).toBe(summary)
  })

  it('shows the canonical survivor of a merged-away Contact, never the merged-away one', async () => {
    chats.push({ id: 'chat-1', contactId: 'contact-old', resolutionStatus: null })
    contacts.push({ id: 'contact-old', mergedIntoContactId: 'contact-survivor' })
    contacts.push({ id: 'contact-survivor', mergedIntoContactId: null })
    summaries.set('contact-old', summaryFor('contact-old'))
    summaries.set('contact-survivor', summaryFor('contact-survivor'))

    const result = await loadContactCardForConversationV1('chat-1')

    expect(result).toEqual({ status: 'resolved', summary: summaries.get('contact-survivor') })
    expect(summaryReads()).toEqual(['summary:contact-survivor'])
  })

  it('fails closed on a broken merge lineage and reads no summary', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    chats.push({ id: 'chat-1', contactId: 'contact-a', resolutionStatus: null })
    contacts.push({ id: 'contact-a', mergedIntoContactId: 'contact-b' })
    contacts.push({ id: 'contact-b', mergedIntoContactId: 'contact-a' })
    summaries.set('contact-a', summaryFor('contact-a'))
    summaries.set('contact-b', summaryFor('contact-b'))

    expect(await loadContactCardForConversationV1('chat-1')).toEqual({ status: 'failed' })
    expect(summaryReads()).toEqual([])
    error.mockRestore()
  })

  it('keeps an unresolved conversation unresolved and reads no summary', async () => {
    chats.push({ id: 'chat-1', contactId: null, resolutionStatus: null })

    expect(await loadContactCardForConversationV1('chat-1')).toEqual({ status: 'unresolved' })
    expect(summaryReads()).toEqual([])
  })

  it('keeps a conversation linked to a vanished Contact unresolved and reads no summary', async () => {
    chats.push({ id: 'chat-1', contactId: 'contact-gone', resolutionStatus: null })

    expect(await loadContactCardForConversationV1('chat-1')).toEqual({ status: 'unresolved' })
    expect(summaryReads()).toEqual([])
  })

  it('keeps an ambiguous conversation ambiguous even with a stale Contact link', async () => {
    chats.push({ id: 'chat-1', contactId: 'contact-stale', resolutionStatus: 'ambiguous' })
    contacts.push({ id: 'contact-stale', mergedIntoContactId: null })
    summaries.set('contact-stale', summaryFor('contact-stale'))

    expect(await loadContactCardForConversationV1('chat-1')).toEqual({ status: 'ambiguous' })
    expect(reads).toEqual(['chat:chat-1'])
  })

  it('answers not_found for an unknown Chat.id and reads nothing else', async () => {
    chats.push({ id: 'chat-other', contactId: 'contact-1', resolutionStatus: null })
    contacts.push({ id: 'contact-1', mergedIntoContactId: null })
    summaries.set('contact-1', summaryFor('contact-1'))

    expect(await loadContactCardForConversationV1('chat-unknown')).toEqual({ status: 'not_found' })
    expect(reads).toEqual(['chat:chat-unknown'])
  })

  it('fails closed when the resolved Contact has no card summary, without looking elsewhere', async () => {
    chats.push({ id: 'chat-1', contactId: 'contact-1', resolutionStatus: null })
    chats.push({ id: 'chat-2', contactId: 'contact-2', resolutionStatus: null })
    contacts.push({ id: 'contact-1', mergedIntoContactId: null })
    contacts.push({ id: 'contact-2', mergedIntoContactId: null })
    summaries.set('contact-2', summaryFor('contact-2'))

    expect(await loadContactCardForConversationV1('chat-1')).toEqual({ status: 'contact_not_found' })
    expect(summaryReads()).toEqual(['summary:contact-1'])
    expect(reads.filter((read) => read.startsWith('chat:'))).toEqual(['chat:chat-1'])
  })

  it('fails closed when the summary read fails, and returns no cause', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    chats.push({ id: 'chat-1', contactId: 'contact-1', resolutionStatus: null })
    contacts.push({ id: 'contact-1', mergedIntoContactId: null })
    mocks.summary.mockRejectedValueOnce(new Error('database detail'))

    const result = await loadContactCardForConversationV1('chat-1')

    expect(result).toEqual({ status: 'failed' })
    expect(JSON.stringify(result)).not.toContain('database detail')
    error.mockRestore()
  })

  it('fails closed when RCQ1 rejects the query, and reads no summary', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await loadContactCardForConversationV1('')).toEqual({ status: 'failed' })
    expect(reads).toEqual([])
    error.mockRestore()
  })
})
