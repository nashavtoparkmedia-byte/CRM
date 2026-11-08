import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { OUTBOX_MAX_ATTEMPTS_V1 } from '@/infrastructure/outbox/v1'
import {
  GuardedChannelMessageError,
  type AppendGuardedChannelMessageCommandV1,
  type ChannelMessageJsonV1,
  type GuardedConversationKindV1,
  type GuardedSenderAttributionV1,
  type HeldChannelMessageReasonV1,
} from '../../../../contracts/messaging/v1'
import { inboundNotificationIntentV1, persistsWithNotificationIntentV1 } from '../../internal/mobile-push/inbound-notification-intent'
import { newDeliveryEvidenceRecordV1 } from './delivery-state-policy'
import { decideGuardedAppendV1, type ConversationPersonBindingV1 } from './guarded-append-policy'
import type { GuardedAppendSettlementV1, GuardedChannelMessagePersistencePortV1 } from './guarded-channel-message-handler'

/**
 * Messaging guarded atomic append (R-21) on PostgreSQL.
 *
 * Every write runs in ONE transaction that takes, in this order:
 *   1. the conversation row (`SELECT … FOR UPDATE`), so the binding it judges
 *      is the binding it commits against: a link, merge remap or unlink must
 *      update that same row and therefore waits, or is waited for;
 *   2. one transaction advisory lock per provider-event key, in sorted order,
 *      so the same key cannot be written twice across Message and the held
 *      store, which no single unique index spans.
 * Each transaction takes exactly one conversation lock, before any key lock,
 * so two of them can never wait on each other in a cycle. Locks wait at most
 * `lock_timeout`; contention rolls everything back and is reported retryable.
 *
 * A visible event commits with its workflow projection and, inbound, its
 * notification intent; a held event commits alone. Nothing here resolves a
 * person or changes a conversation's binding.
 */

type GuardedDb = Prisma.TransactionClient

const LOCK_TIMEOUT = '2000ms'
/** Separates these single-key advisory locks from any other user of the one-bigint key space. */
const EVENT_KEY_LOCK_SEED = 2121
const TRANSACTION_OPTIONS = {
  // The enum's own string value; the import above is type-only.
  isolationLevel: 'ReadCommitted' as Prisma.TransactionIsolationLevel,
  maxWait: 2_000,
  timeout: 10_000,
} as const
const CONTENTION_SQLSTATES = new Set(['55P03', '40001', '40P01', '57014'])

interface LockedConversation {
  id: string
  channel: string
  chatType: string
  contactId: string | null
  contactIdentityId: string | null
  driverId: string | null
}

interface GuardedEvent {
  chatId: string
  channel: string
  direction: 'inbound' | 'outbound'
  type: string
  content: string
  externalId: string
  sentAt: Date
  metadata: Record<string, unknown>
}

type GuardedAudit = Record<string, ChannelMessageJsonV1>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function bindingOf(conversation: LockedConversation): ConversationPersonBindingV1 {
  return {
    contactId: conversation.contactId,
    contactIdentityId: conversation.contactIdentityId,
    driverId: conversation.driverId,
  }
}

function attributionEvidence(attribution: GuardedSenderAttributionV1): GuardedAudit {
  if (attribution.status === 'proven') {
    return { status: 'proven', contactId: attribution.contactId, contactIdentityId: attribution.contactIdentityId }
  }
  if (attribution.status === 'unproven') return { status: 'unproven', reason: attribution.reason }
  return { status: 'not_applicable' }
}

async function lockConversation(transaction: GuardedDb, chatId: string, kind: GuardedConversationKindV1): Promise<LockedConversation> {
  await transaction.$queryRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true) AS "configured"`
  const rows = await transaction.$queryRaw<LockedConversation[]>`
    SELECT "id", "channel"::text AS "channel", "chatType", "contactId", "contactIdentityId", "driverId"
    FROM "Chat"
    WHERE "id" = ${chatId}
    FOR UPDATE
  `
  if (rows.length !== 1) throw new GuardedChannelMessageError('CONVERSATION_NOT_FOUND', 'The conversation does not exist')
  if (rows[0].chatType !== kind) {
    throw new GuardedChannelMessageError('CONVERSATION_KIND_MISMATCH', 'The conversation is not of the stated kind')
  }
  return rows[0]
}

async function lockEventKeys(transaction: GuardedDb, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(CAST(${key} AS text), CAST(${EVENT_KEY_LOCK_SEED} AS bigint))) IS NULL AS "locked"
    `
  }
}

function isOwnEvent(
  row: { chatId: string; direction: string; channel: string | null },
  event: { chatId: string; direction: string; channel: string },
): boolean {
  return row.chatId === event.chatId && row.direction === event.direction && row.channel === event.channel
}

/** The settlement of an event whose key is already recorded, or null when the key is free. */
async function recordedEvent(
  transaction: Pick<GuardedDb, 'message' | 'heldChannelMessage'>,
  event: { chatId: string; direction: string; channel: string; externalId: string },
): Promise<GuardedAppendSettlementV1 | null> {
  const visible = await transaction.message.findUnique({
    where: { externalId: event.externalId },
    select: { id: true, chatId: true, direction: true, channel: true },
  })
  if (visible) {
    return isOwnEvent(visible, event)
      ? { outcome: 'duplicate', messageId: visible.id, heldMessageId: null, visible: true }
      : { outcome: 'key_conflict' }
  }
  const held = await transaction.heldChannelMessage.findUnique({
    where: { externalId: event.externalId },
    select: { id: true, chatId: true, direction: true, channel: true, releasedMessageId: true },
  })
  if (held) {
    return isOwnEvent(held, event)
      ? { outcome: 'duplicate', messageId: held.releasedMessageId, heldMessageId: held.id, visible: held.releasedMessageId !== null }
      : { outcome: 'key_conflict' }
  }
  return null
}

/** Writes one visible Message with its workflow projection and, inbound, its notification intent. */
async function writeVisible(transaction: GuardedDb, kind: GuardedConversationKindV1, event: GuardedEvent, audit: GuardedAudit): Promise<string> {
  const outbound = event.direction === 'outbound'
  const now = new Date()
  const metadata: Record<string, unknown> = {
    ...event.metadata,
    guardedAppend: audit,
    // S2: an own message observed at the provider proves provider acceptance, never device delivery.
    ...(outbound ? { delivery: newDeliveryEvidenceRecordV1('provider_echo', 'echo', now) } : {}),
  }
  const message = await transaction.message.create({
    data: {
      chatId: event.chatId,
      direction: event.direction,
      type: event.type as Prisma.MessageCreateInput['type'],
      content: event.content,
      externalId: event.externalId,
      sentAt: event.sentAt,
      channel: event.channel as Prisma.MessageCreateInput['channel'],
      status: outbound ? 'sent' : 'delivered',
      metadata: metadata as Prisma.InputJsonValue,
    },
  })
  if (!outbound && persistsWithNotificationIntentV1({ direction: message.direction, type: message.type, channel: message.channel, metadata: message.metadata })) {
    const intent = inboundNotificationIntentV1(message, now)
    if (intent) {
      await transaction.domainOutboxEvent.createMany({
        data: [{
          eventId: intent.eventId,
          eventType: intent.eventType,
          eventVersion: intent.eventVersion,
          aggregateType: intent.aggregate.type,
          aggregateId: intent.aggregate.id,
          payload: intent as unknown as Prisma.InputJsonValue,
          maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
          correlationId: intent.correlationId,
          causationId: intent.causationId,
        }],
        skipDuplicates: true,
      })
    }
  }
  if (kind === 'group') {
    if (!outbound) await ConversationWorkflowService.onGroupInboundMessage(event.chatId, event.sentAt, transaction)
  } else if (outbound) {
    await ConversationWorkflowService.onOutboundMessage(event.chatId, event.sentAt, transaction)
  } else {
    await ConversationWorkflowService.onInboundMessage(event.chatId, event.sentAt, transaction)
  }
  return message.id
}

async function writeHeld(
  transaction: GuardedDb,
  event: GuardedEvent,
  reason: HeldChannelMessageReasonV1,
  attribution: GuardedSenderAttributionV1,
  conversation: LockedConversation,
): Promise<string> {
  const held = await transaction.heldChannelMessage.create({
    data: {
      chatId: event.chatId,
      channel: event.channel as Prisma.HeldChannelMessageCreateInput['channel'],
      direction: event.direction,
      type: event.type as Prisma.HeldChannelMessageCreateInput['type'],
      content: event.content,
      externalId: event.externalId,
      sentAt: event.sentAt,
      metadata: event.metadata as Prisma.InputJsonValue,
      holdReason: reason,
      holdEvidence: {
        v: 1,
        attribution: attributionEvidence(attribution),
        binding: { ...bindingOf(conversation) },
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  return held.id
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002')
}

/** Lock timeout, serialization failure, deadlock or a cancelled statement: nothing was written. */
function isContention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, meta, message } = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown }
  if (code === 'P2034' || code === 'P2028' || code === 'P2024') return true
  if (code === 'P2010' && CONTENTION_SQLSTATES.has(String(meta?.code))) return true
  return typeof message === 'string' && /lock timeout|deadlock detected|could not serialize access/i.test(message)
}

function settledFailure(error: unknown): unknown {
  if (error instanceof GuardedChannelMessageError) return error
  if (isContention(error)) {
    return new GuardedChannelMessageError('CONTENDED', 'The guarded write met contention and wrote nothing')
  }
  return error
}

function guardedEvent(input: Omit<AppendGuardedChannelMessageCommandV1, 'contract'>): GuardedEvent {
  return {
    chatId: input.chatId,
    channel: input.channel,
    direction: input.direction,
    type: input.type,
    content: input.content,
    externalId: input.externalId,
    sentAt: input.sentAt,
    metadata: { ...(input.metadata ?? {}) },
  }
}

export const legacyPrismaGuardedChannelMessagePortV1: GuardedChannelMessagePersistencePortV1 = {
  async append(input) {
    const event = guardedEvent(input)
    try {
      return await prisma.$transaction(async transaction => {
        const conversation = await lockConversation(transaction, event.chatId, input.conversationKind)
        if (conversation.channel !== event.channel) {
          throw new GuardedChannelMessageError('CONVERSATION_CHANNEL_MISMATCH', 'The event channel is not the conversation channel')
        }
        await lockEventKeys(transaction, [event.externalId])
        const recorded = await recordedEvent(transaction, event)
        if (recorded) return recorded

        const decision = decideGuardedAppendV1(input.conversationKind, input.attribution, bindingOf(conversation))
        if (decision.visible) {
          const messageId = await writeVisible(transaction, input.conversationKind, event, { v: 1, attribution: input.attribution.status })
          return { outcome: 'appended', messageId } as const
        }
        const heldMessageId = await writeHeld(transaction, event, decision.reason, input.attribution, conversation)
        return { outcome: 'held', heldMessageId, holdReason: decision.reason } as const
      }, TRANSACTION_OPTIONS)
    } catch (error: unknown) {
      // A writer outside these locks took the key first. The transaction rolled
      // back; the committed winner decides: this event's own row is a duplicate,
      // anything else a key conflict.
      if (isUniqueViolation(error)) {
        const winner = await recordedEvent(prisma, event)
        if (winner) return winner
      }
      throw settledFailure(error)
    }
  },

  async release(input) {
    try {
      return await prisma.$transaction(async transaction => {
        const conversation = await lockConversation(transaction, input.chatId, input.conversationKind)
        const pending = await transaction.heldChannelMessage.findMany({
          where: { chatId: input.chatId, releasedAt: null },
          orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
          take: input.limit,
        })
        if (pending.length === 0) return { released: 0, remaining: 0, keyConflicts: 0, holdReason: null }

        const decision = decideGuardedAppendV1(input.conversationKind, input.attribution, bindingOf(conversation))
        if (!decision.visible) {
          const remaining = await transaction.heldChannelMessage.count({ where: { chatId: input.chatId, releasedAt: null } })
          return { released: 0, remaining, keyConflicts: 0, holdReason: decision.reason }
        }

        await lockEventKeys(transaction, pending.map(held => held.externalId))
        const releasedAt = new Date()
        let released = 0
        let keyConflicts = 0
        for (const held of pending) {
          const event: GuardedEvent = {
            chatId: held.chatId,
            channel: held.channel,
            direction: held.direction === 'outbound' ? 'outbound' : 'inbound',
            type: held.type,
            content: held.content,
            externalId: held.externalId,
            sentAt: held.sentAt,
            metadata: record(held.metadata),
          }
          const visible = await transaction.message.findUnique({
            where: { externalId: held.externalId },
            select: { id: true, chatId: true, direction: true, channel: true },
          })
          let messageId: string
          if (visible) {
            if (!isOwnEvent(visible, event)) {
              keyConflicts += 1
              continue
            }
            // Already visible through another writer: only the hold is settled.
            messageId = visible.id
          } else {
            messageId = await writeVisible(transaction, input.conversationKind, event, {
              v: 1,
              attribution: input.attribution.status,
              releasedFrom: held.id,
              heldAt: held.heldAt.toISOString(),
              holdReason: held.holdReason,
            })
          }
          await transaction.heldChannelMessage.update({
            where: { id: held.id },
            data: { releasedAt, releasedMessageId: messageId },
          })
          released += 1
        }
        const remaining = await transaction.heldChannelMessage.count({ where: { chatId: input.chatId, releasedAt: null } })
        return { released, remaining, keyConflicts, holdReason: null }
      }, TRANSACTION_OPTIONS)
    } catch (error: unknown) {
      // A writer outside these locks took a released key mid-flight: nothing of
      // this release committed, and the next attempt sees that row.
      if (isUniqueViolation(error)) {
        throw new GuardedChannelMessageError('CONTENDED', 'A held event key was taken concurrently; nothing was released')
      }
      throw settledFailure(error)
    }
  },

  async countHeld(input) {
    const rows = await prisma.heldChannelMessage.groupBy({
      by: ['holdReason'],
      where: { releasedAt: null, ...(input.chatId ? { chatId: input.chatId } : {}) },
      _count: { _all: true },
    })
    return Object.fromEntries(rows.map(row => [row.holdReason, row._count._all])) as Partial<Record<HeldChannelMessageReasonV1, number>>
  },
}
