import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// R-22 read-side binding trust against real PostgreSQL: the real inbox read
// (MessageService.listConversations), the real workflow group writes
// (ConversationWorkflowService) and Contacts' real peer-identity query behind
// the binding audit. The data reproduces the R-22 shapes: two people sharing one
// stale driverId, a Telegram conversation linked to another peer's identity, a
// conversation linked to another contact's identity, and a legacy driver-only
// conversation.
//
// Runs only against a disposable database named by
// MESSAGING_EVIDENCE_TEST_DATABASE_URL (the Prisma client must point at the
// same database through DATABASE_URL); skipped otherwise. The inbox read takes
// the 400 most recent conversations, so the database must hold no others.

const TEST_DATABASE_URL = process.env.MESSAGING_EVIDENCE_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({ buildCanonicalContactSummary: vi.fn(() => ({ title: 'x' })) }))

import { prisma } from '@/lib/prisma'
import { MessageService } from '@/lib/MessageService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { CONVERSATION_BINDING_AUDIT_QUERY_V1 } from '../../../../contracts/messaging/v1'
import { auditConversationBindingsV1 } from './index'

const RUN = `r22b${Date.now().toString(36)}`
const id = (name: string) => `${RUN}_${name}`
const PEER = { a: '700001', b: '700002', c: '700003' }

type Entry = { id: string; allChatIds: string[]; personBinding?: string; contactId: string | null; driverId: string | null; contact: unknown; driver: unknown }

async function inbox(): Promise<Entry[]> {
  return (await MessageService.listConversations()) as Entry[]
}

function entryOf(entries: Entry[], chatId: string): Entry {
  const found = entries.find(entry => entry.allChatIds.includes(chatId))
  if (!found) throw new Error(`no inbox entry holds ${chatId}`)
  return found
}

async function chatState(chatId: string) {
  return prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { unreadCount: true, requiresResponse: true, status: true } })
}

describeWithDatabase('R-22 conversation binding trust (PostgreSQL)', () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
      throw new Error('DATABASE_URL must equal MESSAGING_EVIDENCE_TEST_DATABASE_URL for this suite')
    }
    const base = Date.now()
    await prisma.driver.create({ data: { id: id('driver'), yandexDriverId: id('yd'), fullName: 'Driver of A' } })
    for (const person of ['a', 'b', 'c'] as const) {
      await prisma.contact.create({ data: { id: id(`contact_${person}`), displayName: `Person ${person.toUpperCase()}` } })
      await prisma.contactIdentity.create({ data: { id: id(`tg_${person}`), contactId: id(`contact_${person}`), channel: 'telegram', externalId: PEER[person] } })
    }
    await prisma.contactIdentity.create({ data: { id: id('wa_a'), contactId: id('contact_a'), channel: 'whatsapp', externalId: '79990000001' } })
    await prisma.contactIdentity.create({ data: { id: id('wa_c'), contactId: id('contact_c'), channel: 'whatsapp', externalId: '79990000003' } })
    const chat = (name: string, data: Record<string, unknown>, minutesAgo: number) => prisma.chat.create({
      data: { id: id(name), channel: 'telegram', chatType: 'private', unreadCount: 2, requiresResponse: true, lastMessageAt: new Date(base - minutesAgo * 60_000), ...data } as never,
    })
    // Person A: Telegram and WhatsApp, both bound to A; Telegram also carries A's driver.
    await chat('a_tg', { externalChatId: `telegram:${PEER.a}`, contactId: id('contact_a'), contactIdentityId: id('tg_a'), driverId: id('driver') }, 1)
    await chat('a_wa', { channel: 'whatsapp', externalChatId: '79990000001@c.us', contactId: id('contact_a'), contactIdentityId: id('wa_a') }, 2)
    // Person B: bound to B, but carries A's driver (the stale projection R-22 names).
    await chat('b_tg', { externalChatId: `telegram:${PEER.b}`, contactId: id('contact_b'), contactIdentityId: id('tg_b'), driverId: id('driver') }, 3)
    // Peer C's conversation linked to A's Telegram identity: a different person's messages under A.
    await chat('c_as_a', { externalChatId: `telegram:${PEER.c}`, contactId: id('contact_a'), contactIdentityId: id('tg_a'), driverId: id('driver') }, 4)
    // Bound to A, linked to C's identity: the identity belongs to another contact.
    await chat('a_with_c_identity', { externalChatId: `telegram:${PEER.a}9`, contactId: id('contact_a'), contactIdentityId: id('tg_c') }, 5)
    // Bound to A on WhatsApp through C's WhatsApp identity: only the identity's
    // own contact contradicts it (no Telegram peer rule applies).
    await chat('a_with_c_wa', { channel: 'whatsapp', externalChatId: '79990000003@c.us', contactId: id('contact_a'), contactIdentityId: id('wa_c') }, 7)
    // A group conversation that names contact A: never part of A's private entry.
    await chat('a_group', { externalChatId: `telegram:-100${RUN}`, chatType: 'group', contactId: id('contact_a') }, 8)
    // Legacy: a driver and no contact at all.
    await chat('legacy_driver', { channel: 'max', externalChatId: `max:${RUN}`, driverId: id('driver') }, 6)
  })

  afterAll(async () => {
    await prisma.chat.deleteMany({ where: { id: { startsWith: RUN } } })
    await prisma.contactIdentity.deleteMany({ where: { id: { startsWith: RUN } } })
    await prisma.contact.deleteMany({ where: { id: { startsWith: RUN } } })
    await prisma.driver.deleteMany({ where: { id: id('driver') } })
    await prisma.$disconnect()
  })

  it('the inbox merges one person by contact and never two people by a shared driver', async () => {
    const entries = await inbox()
    const a = entryOf(entries, id('a_tg'))
    expect([...a.allChatIds].sort()).toEqual([id('a_tg'), id('a_wa')].sort())
    const b = entryOf(entries, id('b_tg'))
    expect(b.allChatIds).toEqual([id('b_tg')])
    expect(b.id).not.toBe(a.id)
  })

  it('a conversation provably of another person stands alone, without that person shown', async () => {
    const entries = await inbox()
    for (const name of ['c_as_a', 'a_with_c_identity', 'a_with_c_wa']) {
      const entry = entryOf(entries, id(name))
      expect(entry.allChatIds).toEqual([id(name)])
      expect(entry).toMatchObject({ personBinding: 'contradicted', contactId: null, driverId: null, contact: null, driver: null })
    }
    expect(entryOf(entries, id('a_tg')).allChatIds).not.toContain(id('c_as_a'))
    expect(entryOf(entries, id('a_tg')).allChatIds).not.toContain(id('a_with_c_wa'))
  })

  it('a legacy driver-only conversation stands alone instead of joining the driver', async () => {
    const entries = await inbox()
    const legacy = entryOf(entries, id('legacy_driver'))
    expect(legacy.allChatIds).toEqual([id('legacy_driver')])
    expect(legacy.personBinding).toBe('unbound')
  })

  it('marking one person read reaches all of that person, and nobody else', async () => {
    await ConversationWorkflowService.markRead(id('a_tg'))
    expect(await chatState(id('a_tg'))).toMatchObject({ unreadCount: 0, requiresResponse: false })
    expect(await chatState(id('a_wa'))).toMatchObject({ unreadCount: 0 })
    // c_as_a and a_with_c_identity still name contact A in the database, but
    // their bindings are provably other people's: they keep their unread state,
    // and so does B, who only shares the driver.
    expect(await chatState(id('c_as_a'))).toMatchObject({ unreadCount: 2, requiresResponse: true })
    expect(await chatState(id('a_with_c_identity'))).toMatchObject({ unreadCount: 2, requiresResponse: true })
    expect(await chatState(id('a_with_c_wa'))).toMatchObject({ unreadCount: 2, requiresResponse: true })
    expect(await chatState(id('b_tg'))).toMatchObject({ unreadCount: 2, requiresResponse: true })
    expect(await chatState(id('legacy_driver'))).toMatchObject({ unreadCount: 2 })
    // The group chat names contact A but is not part of A's private entry.
    expect(await chatState(id('a_group'))).toMatchObject({ unreadCount: 2, requiresResponse: true })
  })

  it('a group chat that names a contact is read and resolved on its own', async () => {
    await prisma.chat.updateMany({ where: { id: { startsWith: RUN } }, data: { unreadCount: 2, requiresResponse: true, status: 'open' } })
    await ConversationWorkflowService.markRead(id('a_group'))
    expect(await chatState(id('a_group'))).toMatchObject({ unreadCount: 0 })
    expect(await chatState(id('a_tg'))).toMatchObject({ unreadCount: 2 })
    expect(await chatState(id('a_wa'))).toMatchObject({ unreadCount: 2 })

    await ConversationWorkflowService.resolveChat(id('a_tg'))
    expect(await chatState(id('a_tg'))).toMatchObject({ status: 'resolved' })
    expect(await chatState(id('a_wa'))).toMatchObject({ status: 'resolved' })
    expect(await chatState(id('a_group'))).toMatchObject({ status: 'open' })
    expect(await chatState(id('a_with_c_wa'))).toMatchObject({ status: 'open' })
  })

  it('a contradicted or driver-only conversation is read and assigned on its own', async () => {
    await prisma.chat.updateMany({ where: { id: { startsWith: RUN } }, data: { unreadCount: 2, requiresResponse: true } })
    await ConversationWorkflowService.markRead(id('c_as_a'))
    expect(await chatState(id('c_as_a'))).toMatchObject({ unreadCount: 0 })
    expect(await chatState(id('a_tg'))).toMatchObject({ unreadCount: 2 })
    expect(await chatState(id('a_wa'))).toMatchObject({ unreadCount: 2 })

    await ConversationWorkflowService.markRead(id('legacy_driver'))
    expect(await chatState(id('legacy_driver'))).toMatchObject({ unreadCount: 0 })
    expect(await chatState(id('a_tg'))).toMatchObject({ unreadCount: 2 })
    expect(await chatState(id('b_tg'))).toMatchObject({ unreadCount: 2 })

    const user = `${RUN}_user`
    await ConversationWorkflowService.assignChat(id('legacy_driver'), user)
    const assigned = await prisma.$queryRaw<Array<{ id: string; assignedToUserId: string | null }>>`
      SELECT id, "assignedToUserId" FROM "Chat" WHERE id LIKE ${`${RUN}%`}
    `
    expect(assigned.filter(row => row.assignedToUserId === user).map(row => row.id)).toEqual([id('legacy_driver')])
  })

  it('the read-only audit counts the stored bindings with Contacts\' own peer query and writes nothing', async () => {
    const before = await prisma.chat.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } })
    const result = await auditConversationBindingsV1({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, limit: 500 })

    expect(result.checked).toBe(4)
    expect(result.states).toEqual({ consistent: 2, unverifiable: 0, contradicted: 2 })
    expect([...result.contradictedChatIds].sort()).toEqual([id('a_with_c_identity'), id('c_as_a')].sort())
    expect(result.peer.ready).toBe(2)
    expect([...result.peerNotOfContactChatIds].sort()).toEqual([id('a_with_c_identity'), id('c_as_a')].sort())
    expect(result.nextAfterChatId).toBeNull()

    const after = await prisma.chat.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } })
    expect(after).toEqual(before)
  })
})
