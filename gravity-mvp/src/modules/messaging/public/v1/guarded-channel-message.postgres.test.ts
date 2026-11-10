import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// R-21 guarded atomic append against real PostgreSQL: the real row lock on
// "Chat", the real advisory key locks, the real unique indexes of Message and
// HeldChannelMessage, the real P2002 a foreign writer raises, the real
// lock_timeout, the real CASCADE and CHECK constraints, and the real workflow
// projection SQL. Nothing below the Messaging adapter is a stand-in.
//
// Runs only against a disposable database named by
// MESSAGING_EVIDENCE_TEST_DATABASE_URL (the Prisma client must point at the
// same database through DATABASE_URL); skipped otherwise.

const TEST_DATABASE_URL = process.env.MESSAGING_EVIDENCE_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

import { prisma } from '@/lib/prisma'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import {
  APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
  GuardedChannelMessageError,
  HELD_CHANNEL_MESSAGES_QUERY_V1,
  RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
  type GuardedSenderAttributionV1,
} from '../../../../contracts/messaging/v1'
import { appendGuardedChannelMessageV1, heldChannelMessagesV1, releaseHeldChannelMessagesV1 } from './index'
import { legacyPrismaGuardedChannelMessagePortV1 } from './legacy-prisma-guarded-channel-message-adapter'
import { deriveDeliveryStateV1 } from './delivery-state-policy'
import { persistsWithNotificationIntentV1 } from '../../internal/mobile-push/inbound-notification-intent'

const RUN = `r21g${Date.now().toString(36)}`
const ids = {
  contactA: `${RUN}_ca`,
  contactB: `${RUN}_cb`,
  identityA: `${RUN}_ia`,
  identityB: `${RUN}_ib`,
  driverA: `${RUN}_da`,
}
const PROVEN_A: GuardedSenderAttributionV1 = { status: 'proven', contactId: ids.contactA, contactIdentityId: ids.identityA }
const PROVEN_B: GuardedSenderAttributionV1 = { status: 'proven', contactId: ids.contactB, contactIdentityId: ids.identityB }
const UNPROVEN: GuardedSenderAttributionV1 = { status: 'unproven', reason: 'CONTACT_RESOLUTION_BLOCKED:phone_evidence_blocked' }
const GROUP: GuardedSenderAttributionV1 = { status: 'not_applicable' }

let sequence = 0
const createdChats: string[] = []

async function chat(binding: { contactId?: string; contactIdentityId?: string; driverId?: string } = {}, chatType: 'private' | 'group' = 'private') {
  sequence += 1
  const id = `${RUN}_chat${sequence}`
  createdChats.push(id)
  await prisma.chat.create({
    data: {
      id,
      channel: 'telegram',
      externalChatId: `telegram:${RUN}:${sequence}`,
      chatType,
      contactId: binding.contactId ?? null,
      contactIdentityId: binding.contactIdentityId ?? null,
      driverId: binding.driverId ?? null,
    },
  })
  return id
}

function key(label: string) {
  return `telegram:7001:${RUN}:update%3A${label}`
}

function append(chatId: string, attribution: GuardedSenderAttributionV1, externalId: string, overrides: Record<string, unknown> = {}) {
  return appendGuardedChannelMessageV1({
    contract: APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
    chatId,
    conversationKind: attribution.status === 'not_applicable' ? 'group' : 'private',
    attribution,
    channel: 'telegram',
    direction: 'inbound',
    type: 'text',
    content: `text ${externalId}`,
    externalId,
    sentAt: new Date(),
    metadata: { providerEventId: externalId },
    ...overrides,
  })
}

function release(chatId: string, attribution: GuardedSenderAttributionV1 | Record<string, unknown>, limit?: number) {
  return releaseHeldChannelMessagesV1({
    contract: RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
    chatId,
    conversationKind: attribution.status === 'not_applicable' ? 'group' : 'private',
    attribution,
    ...(limit ? { limit } : {}),
  })
}

async function conversation(chatId: string) {
  return prisma.chat.findUniqueOrThrow({
    where: { id: chatId },
    select: { unreadCount: true, requiresResponse: true, status: true, contactId: true, contactIdentityId: true, driverId: true },
  })
}

async function visibleCount(chatId: string) {
  return prisma.message.count({ where: { chatId } })
}

async function heldRows(chatId: string) {
  return prisma.heldChannelMessage.findMany({ where: { chatId }, orderBy: { sentAt: 'asc' } })
}

function meta(value: unknown): Record<string, any> {
  return (value ?? {}) as Record<string, any>
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describeWithDatabase('R-21 guarded atomic append (PostgreSQL)', () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
      throw new Error('DATABASE_URL must equal MESSAGING_EVIDENCE_TEST_DATABASE_URL for this suite')
    }
    await prisma.contact.create({ data: { id: ids.contactA, displayName: 'Person A' } })
    await prisma.contact.create({ data: { id: ids.contactB, displayName: 'Person B' } })
    await prisma.contactIdentity.create({ data: { id: ids.identityA, contactId: ids.contactA, channel: 'telegram', externalId: `${RUN}_peer_a` } })
    await prisma.contactIdentity.create({ data: { id: ids.identityB, contactId: ids.contactB, channel: 'telegram', externalId: `${RUN}_peer_b` } })
    await prisma.driver.create({ data: { id: ids.driverA, yandexDriverId: `${RUN}_yd_a`, fullName: 'Driver A' } })
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await prisma.domainOutboxEvent.deleteMany({ where: { aggregateId: { in: (await prisma.message.findMany({ where: { chatId: { in: createdChats } }, select: { id: true } })).map(row => row.id) } } })
    await prisma.chat.deleteMany({ where: { id: { in: createdChats } } })
    await prisma.driver.deleteMany({ where: { id: ids.driverA } })
    await prisma.contactIdentity.deleteMany({ where: { id: { in: [ids.identityA, ids.identityB] } } })
    await prisma.contact.deleteMany({ where: { id: { in: [ids.contactA, ids.contactB] } } })
    await prisma.$disconnect()
  })

  it('a proven sender is appended to its own conversation with workflow and notification intent in one commit', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA, driverId: ids.driverA })
    const result = await append(chatId, PROVEN_A, key('own'))

    expect(result).toMatchObject({ outcome: 'appended', visible: true, newlyRecorded: true, heldMessageId: null })
    const message = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId! } })
    expect(message).toMatchObject({ chatId, direction: 'inbound', status: 'delivered', channel: 'telegram', externalId: key('own') })
    expect(meta(message.metadata)).toMatchObject({ providerEventId: key('own'), guardedAppend: { v: 1, attribution: 'proven' } })
    expect(await conversation(chatId)).toMatchObject({ unreadCount: 1, requiresResponse: true })
    expect(await heldRows(chatId)).toHaveLength(0)
    const intents = await prisma.domainOutboxEvent.count({ where: { aggregateId: message.id } })
    expect(intents).toBe(persistsWithNotificationIntentV1({ direction: 'inbound', type: 'text', channel: 'telegram', metadata: message.metadata }) ? 1 : 0)
  })

  it('a redelivered event is a duplicate: no second row, no second workflow step', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const first = await append(chatId, PROVEN_A, key('redeliver'))
    const second = await append(chatId, PROVEN_A, key('redeliver'))

    expect(second).toMatchObject({ outcome: 'duplicate', messageId: first.messageId, visible: true, newlyRecorded: false })
    expect(await visibleCount(chatId)).toBe(1)
    expect((await conversation(chatId)).unreadCount).toBe(1)
  })

  it('a sender who does not prove the bound person is held: durable, invisible, and no workflow', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA, driverId: ids.driverA })
    const result = await append(chatId, PROVEN_B, key('other-person'))

    expect(result).toMatchObject({ outcome: 'held', holdReason: 'binding_mismatch', visible: false, newlyRecorded: true, messageId: null })
    expect(await visibleCount(chatId)).toBe(0)
    expect(await conversation(chatId)).toMatchObject({ unreadCount: 0, requiresResponse: false, contactId: ids.contactA, driverId: ids.driverA })
    const [held] = await heldRows(chatId)
    expect(held).toMatchObject({ id: result.heldMessageId, externalId: key('other-person'), holdReason: 'binding_mismatch', senderContactIdentityId: ids.identityB, releasedAt: null, releasedMessageId: null })
    expect(meta(held.holdEvidence)).toEqual({
      v: 1,
      attribution: { status: 'proven', contactId: ids.contactB, contactIdentityId: ids.identityB },
      binding: { contactId: ids.contactA, contactIdentityId: ids.identityA, driverId: ids.driverA },
    })

    const again = await append(chatId, PROVEN_B, key('other-person'))
    expect(again).toMatchObject({ outcome: 'duplicate', heldMessageId: held.id, messageId: null, visible: false, newlyRecorded: false })
    expect(await heldRows(chatId)).toHaveLength(1)
    expect(await heldChannelMessagesV1({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1, chatId })).toMatchObject({ held: 1, byReason: { binding_mismatch: 1 } })
  })

  it('an unproven sender is held where a person is bound and shown only where nobody is', async () => {
    const bound = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const driverOnly = await chat({ driverId: ids.driverA })
    const unbound = await chat()

    expect(await append(bound, UNPROVEN, key('unproven-bound'))).toMatchObject({ outcome: 'held', holdReason: 'attribution_unproven' })
    expect(await append(driverOnly, UNPROVEN, key('unproven-driver'))).toMatchObject({ outcome: 'held', holdReason: 'attribution_unproven' })
    expect(await append(unbound, UNPROVEN, key('unproven-unbound'))).toMatchObject({ outcome: 'appended', visible: true })
    expect(await conversation(unbound)).toMatchObject({ unreadCount: 1, contactId: null, contactIdentityId: null, driverId: null })
    expect(await append(unbound, PROVEN_A, key('proven-unbound'))).toMatchObject({ outcome: 'held', holdReason: 'binding_absent' })
  })

  it('a group event is shown only while the group is bound to nobody, with the group workflow', async () => {
    const group = await chat({}, 'group')
    const boundGroup = await chat({ driverId: ids.driverA }, 'group')

    expect(await append(group, GROUP, key('group'))).toMatchObject({ outcome: 'appended' })
    expect(await conversation(group)).toMatchObject({ unreadCount: 1, requiresResponse: false })
    expect(await append(boundGroup, GROUP, key('group-bound'))).toMatchObject({ outcome: 'held', holdReason: 'group_person_bound' })
  })

  it('an own outbound echo is provider-accepted evidence, never delivered', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    await append(chatId, PROVEN_A, key('before-echo'))
    const result = await append(chatId, PROVEN_A, key('echo'), { direction: 'outbound' })

    const row = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId! } })
    expect(row.status).toBe('sent')
    expect(meta(row.metadata).delivery).toMatchObject({ v: 1, evidence: 'provider_echo', source: 'echo' })
    expect(deriveDeliveryStateV1(row)).toBe('provider_accepted')
    expect(await conversation(chatId)).toMatchObject({ requiresResponse: false })
    expect(await prisma.domainOutboxEvent.count({ where: { aggregateId: row.id } })).toBe(0)
  })

  it('one key in another conversation is a key conflict, visible or held, and writes nothing', async () => {
    const owner = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const other = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    await append(owner, PROVEN_A, key('taken'))
    await append(owner, PROVEN_B, key('taken-held'))

    expect(await append(other, PROVEN_A, key('taken'))).toMatchObject({ outcome: 'key_conflict', newlyRecorded: false })
    expect(await append(other, PROVEN_A, key('taken-held'))).toMatchObject({ outcome: 'key_conflict', newlyRecorded: false })
    expect(await append(owner, PROVEN_A, key('taken'), { direction: 'outbound' })).toMatchObject({ outcome: 'key_conflict' })
    expect(await visibleCount(other)).toBe(0)
    expect(await heldRows(other)).toHaveLength(0)
    expect((await conversation(other)).unreadCount).toBe(0)
  })

  it('a failure after the insert rolls the whole append back; the retry records it exactly once', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const spy = vi.spyOn(ConversationWorkflowService, 'onInboundMessage').mockRejectedValueOnce(new Error('workflow down'))

    await expect(append(chatId, PROVEN_A, key('partial'))).rejects.toThrow('workflow down')
    expect(await visibleCount(chatId)).toBe(0)
    expect(await heldRows(chatId)).toHaveLength(0)
    expect((await conversation(chatId)).unreadCount).toBe(0)

    spy.mockRestore()
    expect(await append(chatId, PROVEN_A, key('partial'))).toMatchObject({ outcome: 'appended' })
    expect(await visibleCount(chatId)).toBe(1)
    expect((await conversation(chatId)).unreadCount).toBe(1)
  })

  it('eight concurrent deliveries of one event record it once', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const results = await Promise.all(Array.from({ length: 8 }, () => append(chatId, PROVEN_A, key('storm'))))

    expect(results.filter(result => result.outcome === 'appended')).toHaveLength(1)
    expect(results.filter(result => result.outcome === 'duplicate')).toHaveLength(7)
    expect(new Set(results.map(result => result.messageId)).size).toBe(1)
    expect(await visibleCount(chatId)).toBe(1)
    expect((await conversation(chatId)).unreadCount).toBe(1)
  })

  it('eight concurrent held deliveries of one event hold it once', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const results = await Promise.all(Array.from({ length: 8 }, () => append(chatId, PROVEN_B, key('held-storm'))))

    expect(results.filter(result => result.outcome === 'held')).toHaveLength(1)
    expect(results.filter(result => result.outcome === 'duplicate')).toHaveLength(7)
    expect(await heldRows(chatId)).toHaveLength(1)
  })

  it('different events appended concurrently are all recorded, none collapsed', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => append(chatId, PROVEN_A, key(`distinct-${index}`), { content: 'одинаковый текст' })))

    expect(results.every(result => result.outcome === 'appended')).toBe(true)
    expect(await visibleCount(chatId)).toBe(6)
    expect((await conversation(chatId)).unreadCount).toBe(6)
  })

  it('a rebinding committed while the append waits is the binding it judges', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    let rebindLocked!: () => void
    const locked = new Promise<void>(resolve => { rebindLocked = resolve })
    const rebind = prisma.$transaction(async db => {
      await db.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${chatId} FOR UPDATE`
      rebindLocked()
      await sleep(400)
      await db.chat.update({ where: { id: chatId }, data: { contactId: ids.contactB, contactIdentityId: ids.identityB } })
    }, { timeout: 10_000 })

    await locked
    const result = await append(chatId, PROVEN_A, key('during-rebind'))
    await rebind

    expect(result).toMatchObject({ outcome: 'held', holdReason: 'binding_mismatch' })
    expect(await visibleCount(chatId)).toBe(0)
  })

  it('a conversation locked past lock_timeout is reported retryable and nothing is written', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    let holderLocked!: () => void
    const locked = new Promise<void>(resolve => { holderLocked = resolve })
    const holder = prisma.$transaction(async db => {
      await db.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${chatId} FOR UPDATE`
      holderLocked()
      // Held well past the 2 s lock_timeout, so a slow start of the append cannot outlast the holder.
      await sleep(6_000)
    }, { timeout: 15_000 })

    await locked
    const error = await append(chatId, PROVEN_A, key('contended')).catch((caught: unknown) => caught)
    await holder

    expect(error).toBeInstanceOf(GuardedChannelMessageError)
    expect(error).toMatchObject({ code: 'CONTENDED', retryable: true })
    expect(await visibleCount(chatId)).toBe(0)
    expect(await heldRows(chatId)).toHaveLength(0)
    expect(await append(chatId, PROVEN_A, key('contended'))).toMatchObject({ outcome: 'appended' })
  }, 20_000)

  it('a foreign writer that commits the key mid-append makes it a key conflict, not a second row', async () => {
    const target = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    const foreign = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    let foreignInserted!: () => void
    const inserted = new Promise<void>(resolve => { foreignInserted = resolve })
    const writer = prisma.$transaction(async db => {
      await db.message.create({ data: { chatId: foreign, direction: 'inbound', channel: 'telegram', content: 'foreign', externalId: key('foreign-race'), status: 'delivered' } })
      foreignInserted()
      await sleep(500)
    }, { timeout: 10_000 })

    await inserted
    const result = await append(target, PROVEN_A, key('foreign-race'))
    await writer

    expect(result).toMatchObject({ outcome: 'key_conflict', newlyRecorded: false })
    expect(await visibleCount(target)).toBe(0)
    expect((await conversation(target)).unreadCount).toBe(0)
  })

  it('a held event is released only under a proof of the current binding, once, in order', async () => {
    const chatId = await chat({ contactId: ids.contactB, contactIdentityId: ids.identityB })
    const base = Date.now()
    for (let index = 0; index < 3; index += 1) {
      await append(chatId, PROVEN_A, key(`release-${index}`), { sentAt: new Date(base + index * 1000) })
    }
    expect(await heldRows(chatId)).toHaveLength(3)

    expect(await release(chatId, PROVEN_A)).toMatchObject({ outcome: 'still_held', released: 0, remaining: 3, holdReason: 'binding_mismatch' })
    await expect(release(chatId, UNPROVEN)).rejects.toThrow('a release needs a proven sender')
    expect(await visibleCount(chatId)).toBe(0)

    // Contacts' own link repair rebinds the conversation; Messaging only reads the result.
    await prisma.chat.update({ where: { id: chatId }, data: { contactId: ids.contactA, contactIdentityId: ids.identityA } })

    expect(await release(chatId, PROVEN_A, 2)).toMatchObject({ outcome: 'released', released: 2, remaining: 1, keyConflicts: 0 })
    expect(await release(chatId, PROVEN_A)).toMatchObject({ outcome: 'released', released: 1, remaining: 0 })
    expect(await release(chatId, PROVEN_A)).toMatchObject({ outcome: 'nothing_held', released: 0, remaining: 0 })

    const messages = await prisma.message.findMany({ where: { chatId }, orderBy: { sentAt: 'asc' } })
    expect(messages.map(message => message.externalId)).toEqual([key('release-0'), key('release-1'), key('release-2')])
    expect(meta(messages[0].metadata).guardedAppend).toMatchObject({ v: 1, attribution: 'proven', holdReason: 'binding_mismatch' })
    expect((await conversation(chatId)).unreadCount).toBe(3)
    const held = await heldRows(chatId)
    expect(held.every(row => row.releasedAt !== null)).toBe(true)
    expect(held.map(row => row.releasedMessageId)).toEqual(messages.map(message => message.id))

    expect(await append(chatId, PROVEN_A, key('release-1'))).toMatchObject({ outcome: 'duplicate', messageId: messages[1].id, visible: true })
    expect(await heldChannelMessagesV1({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1, chatId })).toMatchObject({ held: 0 })
  })

  it('an unproven sender never releases a held event, even in a conversation bound to nobody', async () => {
    const chatId = await chat({ contactId: ids.contactB, contactIdentityId: ids.identityB })
    expect(await append(chatId, UNPROVEN, key('unproven-held'))).toMatchObject({ outcome: 'held', holdReason: 'attribution_unproven' })
    // The binding is removed; an unproven append would now be visible, but a release needs a proof.
    await prisma.chat.update({ where: { id: chatId }, data: { contactId: null, contactIdentityId: null } })

    await expect(release(chatId, UNPROVEN)).rejects.toThrow('a release needs a proven sender')
    // The adapter refuses on its own too, below the contract parser.
    expect(await legacyPrismaGuardedChannelMessagePortV1.release({ chatId, conversationKind: 'private', attribution: UNPROVEN as never, limit: 100 }))
      .toEqual({ released: 0, remaining: 1, keyConflicts: 0, senderMismatches: 0, holdReason: 'attribution_unproven' })
    expect(await visibleCount(chatId)).toBe(0)
    expect((await heldRows(chatId))[0]).toMatchObject({ senderContactIdentityId: null, releasedAt: null })
  })

  it('a release never moves an event held for another proven identity, and that event cannot starve the rest', async () => {
    const chatId = await chat()
    const base = Date.now()
    await append(chatId, PROVEN_B, key('sender-b'), { sentAt: new Date(base) })
    await append(chatId, PROVEN_A, key('sender-a-1'), { sentAt: new Date(base + 1000) })
    await append(chatId, PROVEN_A, key('sender-a-2'), { sentAt: new Date(base + 2000) })
    expect((await heldRows(chatId)).map(row => [row.holdReason, row.senderContactIdentityId])).toEqual([
      ['binding_absent', ids.identityB],
      ['binding_absent', ids.identityA],
      ['binding_absent', ids.identityA],
    ])
    await prisma.chat.update({ where: { id: chatId }, data: { contactId: ids.contactA, contactIdentityId: ids.identityA } })

    expect(await release(chatId, PROVEN_A, 1)).toMatchObject({ outcome: 'released', released: 1, remaining: 2, senderMismatches: 1 })
    expect(await release(chatId, PROVEN_A, 1)).toMatchObject({ outcome: 'released', released: 1, remaining: 1, senderMismatches: 1 })
    expect(await release(chatId, PROVEN_A)).toMatchObject({ outcome: 'still_held', released: 0, remaining: 1, keyConflicts: 0, senderMismatches: 1, holdReason: null })

    const messages = await prisma.message.findMany({ where: { chatId }, orderBy: { sentAt: 'asc' } })
    expect(messages.map(message => message.externalId)).toEqual([key('sender-a-1'), key('sender-a-2')])
    expect((await heldRows(chatId)).filter(row => row.releasedAt === null).map(row => row.externalId)).toEqual([key('sender-b')])
    expect((await conversation(chatId)).unreadCount).toBe(2)
  })

  it('an identity Contacts moved to another contact still releases its own held events', async () => {
    const merged = { from: `${RUN}_cm1`, into: `${RUN}_cm2`, identity: `${RUN}_im` }
    await prisma.contact.create({ data: { id: merged.from, displayName: 'Before merge' } })
    await prisma.contact.create({ data: { id: merged.into, displayName: 'After merge' } })
    await prisma.contactIdentity.create({ data: { id: merged.identity, contactId: merged.from, channel: 'telegram', externalId: `${RUN}_peer_m` } })
    const chatId = await chat()
    expect(await append(chatId, { status: 'proven', contactId: merged.from, contactIdentityId: merged.identity }, key('merged')))
      .toMatchObject({ outcome: 'held', holdReason: 'binding_absent' })

    // Contacts merges the person: the identity is the same, its contact changed.
    await prisma.contactIdentity.update({ where: { id: merged.identity }, data: { contactId: merged.into } })
    await prisma.chat.update({ where: { id: chatId }, data: { contactId: merged.into, contactIdentityId: merged.identity } })
    expect(await release(chatId, { status: 'proven', contactId: merged.into, contactIdentityId: merged.identity }))
      .toMatchObject({ outcome: 'released', released: 1, remaining: 0, senderMismatches: 0 })
    expect(await visibleCount(chatId)).toBe(1)

    await prisma.chat.delete({ where: { id: chatId } })
    await prisma.contactIdentity.delete({ where: { id: merged.identity } })
    await prisma.contact.deleteMany({ where: { id: { in: [merged.from, merged.into] } } })
  })

  it('a release never takes a key another conversation already shows', async () => {
    const chatId = await chat({ contactId: ids.contactB, contactIdentityId: ids.identityB })
    const elsewhere = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    await append(chatId, PROVEN_A, key('release-conflict'))
    await prisma.message.create({ data: { chatId: elsewhere, direction: 'inbound', channel: 'telegram', content: 'x', externalId: key('release-conflict'), status: 'delivered' } })
    await prisma.chat.update({ where: { id: chatId }, data: { contactId: ids.contactA, contactIdentityId: ids.identityA } })

    expect(await release(chatId, PROVEN_A)).toMatchObject({ outcome: 'still_held', released: 0, remaining: 1, keyConflicts: 1 })
    expect(await visibleCount(chatId)).toBe(0)
  })

  it('a deleted conversation takes its held events with it', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    await append(chatId, PROVEN_B, key('cascade'))
    expect(await heldRows(chatId)).toHaveLength(1)

    await prisma.chat.delete({ where: { id: chatId } })
    expect(await prisma.heldChannelMessage.count({ where: { externalId: key('cascade') } })).toBe(0)
  })

  it('the table refuses an unknown hold reason and a half-released row', async () => {
    const chatId = await chat()
    const base = { chatId, channel: 'telegram' as const, direction: 'inbound' as const, content: 'x', sentAt: new Date() }
    await expect(prisma.heldChannelMessage.create({ data: { ...base, externalId: key('bad-reason'), holdReason: 'guessed' } })).rejects.toThrow()
    await expect(prisma.heldChannelMessage.create({ data: { ...base, externalId: key('half'), holdReason: 'binding_mismatch', releasedAt: new Date() } })).rejects.toThrow()
    await expect(prisma.heldChannelMessage.create({ data: { ...base, direction: 'system', externalId: key('system'), holdReason: 'binding_mismatch' } })).rejects.toThrow()
    // The sender column always equals the proven sender of the hold evidence.
    const proven = { v: 1, attribution: { status: 'proven', contactId: ids.contactA, contactIdentityId: ids.identityA } }
    await expect(prisma.heldChannelMessage.create({ data: { ...base, externalId: key('sender-no-evidence'), holdReason: 'binding_absent', senderContactIdentityId: ids.identityA } })).rejects.toThrow()
    await expect(prisma.heldChannelMessage.create({ data: { ...base, externalId: key('evidence-no-sender'), holdReason: 'binding_absent', holdEvidence: proven } })).rejects.toThrow()
    await expect(prisma.heldChannelMessage.create({ data: { ...base, externalId: key('sender-other'), holdReason: 'binding_absent', holdEvidence: proven, senderContactIdentityId: ids.identityB } })).rejects.toThrow()
    await prisma.heldChannelMessage.create({ data: { ...base, externalId: key('sender-ok'), holdReason: 'binding_absent', holdEvidence: proven, senderContactIdentityId: ids.identityA } })
    expect(await prisma.heldChannelMessage.count({ where: { chatId } })).toBe(1)
  })

  it('refuses a missing conversation, another channel or another kind without writing', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    await expect(append(`${RUN}_missing`, PROVEN_A, key('missing'))).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', retryable: false })
    await expect(append(chatId, PROVEN_A, key('channel'), { channel: 'max' })).rejects.toMatchObject({ code: 'CONVERSATION_CHANNEL_MISMATCH' })
    await expect(append(chatId, GROUP, key('kind'))).rejects.toMatchObject({ code: 'CONVERSATION_KIND_MISMATCH' })
    expect(await visibleCount(chatId)).toBe(0)
    expect(await heldRows(chatId)).toHaveLength(0)
  })

  it('a proven sender is held when the conversation is bound to the same contact through another identity', async () => {
    const otherIdentityOfA = `${RUN}_ia2`
    await prisma.contactIdentity.create({ data: { id: otherIdentityOfA, contactId: ids.contactA, channel: 'telegram', externalId: `${RUN}_peer_a2` } })
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: otherIdentityOfA })

    expect(await append(chatId, PROVEN_A, key('same-contact-other-identity'))).toMatchObject({ outcome: 'held', holdReason: 'binding_mismatch' })
    expect(await visibleCount(chatId)).toBe(0)

    const unlinked = await chat({ contactId: ids.contactA })
    expect(await append(unlinked, PROVEN_A, key('same-contact-no-identity'))).toMatchObject({ outcome: 'held', holdReason: 'binding_mismatch' })
    expect(await visibleCount(unlinked)).toBe(0)
    await prisma.chat.deleteMany({ where: { id: { in: [chatId, unlinked] } } })
    await prisma.contactIdentity.delete({ where: { id: otherIdentityOfA } })
  })

  // R-22 on the write side (d): a proof that merely equals a binding R-22 proves is
  // another person's (for example one read back from the conversation) shows nothing
  // and releases nothing.
  it('a proof equal to a binding whose identity belongs to another contact is held and never releases', async () => {
    const contaminated = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityB })
    const readBack: GuardedSenderAttributionV1 = { status: 'proven', contactId: ids.contactA, contactIdentityId: ids.identityB }

    expect(await append(contaminated, readBack, key('contradicted-foreign-identity'))).toMatchObject({ outcome: 'held', holdReason: 'binding_mismatch', newlyRecorded: true })
    expect(await visibleCount(contaminated)).toBe(0)
    expect(await conversation(contaminated)).toMatchObject({ unreadCount: 0, requiresResponse: false })
    expect(await release(contaminated, readBack)).toMatchObject({ outcome: 'still_held', holdReason: 'binding_mismatch', released: 0 })
    expect(await visibleCount(contaminated)).toBe(0)

    // Contacts repairs the binding to the identity's own contact; the true proof releases.
    await prisma.chat.update({ where: { id: contaminated }, data: { contactId: ids.contactB } })
    expect(await release(contaminated, PROVEN_B)).toMatchObject({ outcome: 'released', released: 1, remaining: 0 })
    expect(await visibleCount(contaminated)).toBe(1)
    await prisma.chat.delete({ where: { id: contaminated } })
  })

  it('a proof equal to a binding whose numeric Telegram identity names another peer is held and never releases', async () => {
    const digits = `${Date.now()}`.slice(-9)
    const wrongPeerIdentity = `${RUN}_iwp`
    await prisma.contactIdentity.create({ data: { id: wrongPeerIdentity, contactId: ids.contactA, channel: 'telegram', externalId: `1${digits}` } })
    const chatId = `${RUN}_chat_peer`
    createdChats.push(chatId)
    await prisma.chat.create({ data: { id: chatId, channel: 'telegram', externalChatId: `telegram:2${digits}`, chatType: 'private', contactId: ids.contactA, contactIdentityId: wrongPeerIdentity } })
    const readBack: GuardedSenderAttributionV1 = { status: 'proven', contactId: ids.contactA, contactIdentityId: wrongPeerIdentity }

    expect(await append(chatId, readBack, key('contradicted-peer'))).toMatchObject({ outcome: 'held', holdReason: 'binding_mismatch' })
    expect(await release(chatId, readBack)).toMatchObject({ outcome: 'still_held', holdReason: 'binding_mismatch', released: 0 })
    expect(await visibleCount(chatId)).toBe(0)
    const [held] = await heldRows(chatId)
    expect(meta(held.holdEvidence).binding).toMatchObject({ contactId: ids.contactA, contactIdentityId: wrongPeerIdentity, contradicted: true })

    await prisma.chat.delete({ where: { id: chatId } })
    await prisma.contactIdentity.delete({ where: { id: wrongPeerIdentity } })
  })

  it('held events never appear in a conversation read of Message', async () => {
    const chatId = await chat({ contactId: ids.contactA, contactIdentityId: ids.identityA })
    await append(chatId, PROVEN_A, key('mine'))
    await append(chatId, PROVEN_B, key('not-mine'))

    const read = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, include: { messages: true } })
    expect(read.messages.map(message => message.externalId)).toEqual([key('mine')])
  })
})
