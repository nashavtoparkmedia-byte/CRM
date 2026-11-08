/**
 * Messaging guarded atomic append (R-21).
 *
 * One provider event is appended to one admitted conversation in ONE
 * transaction, and only where the conversation's person binding is what the
 * caller proved for this event's sender. An event whose sender does not prove
 * the conversation's binding is never shown in that person's conversation: it
 * is HELD — durable, but in a Messaging-owned store that no conversation view
 * reads — until a later guarded release proves the binding.
 *
 * Messaging owns the append, its idempotency, its atomicity and the hold.
 * Contacts owns person truth: the caller passes the outcome of Contacts'
 * resolution and of `messaging.EnsureConversationContactLinkCommand.v1`, and
 * this contract only compares that outcome with the conversation's current
 * binding. It resolves no person, links nothing and changes no binding.
 */
import type { ChannelMessageJsonV1, ChannelMessageTypeV1 } from './channel-message-commands'

export const APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1 = 'messaging.AppendGuardedChannelMessageCommand.v1' as const
export const APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1 = 'messaging.AppendGuardedChannelMessageResult.v1' as const
export const RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1 = 'messaging.ReleaseHeldChannelMessagesCommand.v1' as const
export const RELEASE_HELD_CHANNEL_MESSAGES_RESULT_V1 = 'messaging.ReleaseHeldChannelMessagesResult.v1' as const
export const HELD_CHANNEL_MESSAGES_QUERY_V1 = 'messaging.HeldChannelMessagesQuery.v1' as const
export const HELD_CHANNEL_MESSAGES_RESULT_V1 = 'messaging.HeldChannelMessagesResult.v1' as const
export const RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1 = 'messaging.RunHeldChannelMessageRetentionCommand.v1' as const
export const RUN_HELD_CHANNEL_MESSAGE_RETENTION_RESULT_V1 = 'messaging.RunHeldChannelMessageRetentionResult.v1' as const
/** Held events follow the delivered-message retention: a held row whose event is older than this is deleted. */
export const HELD_CHANNEL_MESSAGE_RETENTION_DAYS_V1 = 365

export type GuardedConversationKindV1 = 'private' | 'group'
export type GuardedChannelV1 = 'telegram' | 'whatsapp' | 'max'
export type GuardedMessageTypeV1 = Exclude<ChannelMessageTypeV1, 'system' | 'call'>

/**
 * What the caller proved about the conversation's peer for THIS event: the
 * sender of an inbound event, the recipient of an outbound one (an own
 * message or a bot reply carries the peer's proof, never the sending account).
 * The caller derives it server-side from Contacts; it is never taken from a
 * client, an operator form or any request body (A1).
 *   proven         — Contacts resolved the sender's provider identity and the
 *                    conversation link was ensured for exactly this identity;
 *   unproven       — Contacts could not attribute the sender (a bounded code,
 *                    e.g. `CONTACT_RESOLUTION_BLOCKED:phone_evidence_blocked`,
 *                    or a link refusal such as `CONTACT_CONVERSATION_OWNERSHIP_MISMATCH`);
 *   not_applicable — a group conversation, which has no person binding.
 */
export type GuardedSenderAttributionV1 =
  | { status: 'proven'; contactId: string; contactIdentityId: string }
  | { status: 'unproven'; reason: string }
  | { status: 'not_applicable' }

/** Why an event was held instead of shown. */
export type HeldChannelMessageReasonV1 =
  /** The sender is proven but the conversation carries no person binding. */
  | 'binding_absent'
  /** The sender is proven and the conversation is bound to another contact or identity. */
  | 'binding_mismatch'
  /** The sender is not proven and the conversation is bound to a person. */
  | 'attribution_unproven'
  /** A group conversation carries a person binding. */
  | 'group_person_bound'

export const HELD_CHANNEL_MESSAGE_REASONS_V1: readonly HeldChannelMessageReasonV1[] = Object.freeze([
  'binding_absent',
  'binding_mismatch',
  'attribution_unproven',
  'group_person_bound',
])

export interface AppendGuardedChannelMessageCommandV1 {
  contract: typeof APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1
  /** The admitted conversation (`Chat.id`). */
  chatId: string
  conversationKind: GuardedConversationKindV1
  attribution: GuardedSenderAttributionV1
  channel: GuardedChannelV1
  direction: 'inbound' | 'outbound'
  type: GuardedMessageTypeV1
  content: string
  /** The exact provider-event key. One key is one event, in exactly one conversation. */
  externalId: string
  sentAt: Date
  /** Event provenance. `delivery` and `guardedAppend` are written only by Messaging. */
  metadata?: { [key: string]: ChannelMessageJsonV1 }
}

/**
 * - appended:     a new visible Message, its workflow projection and (inbound)
 *                 its notification intent committed together;
 * - held:         a new held event, invisible to every conversation view;
 * - duplicate:    this exact event was already recorded in this conversation,
 *                 visible or held; nothing was written;
 * - key_conflict: the key is held by another conversation, direction or
 *                 channel; nothing was written.
 * `newlyRecorded` is true only for appended and held. A caller runs an event's
 * follow-up effects (bot replies, enrichment, automation) only when it is true,
 * so a redelivered event never repeats them.
 */
export type AppendGuardedChannelMessageResultV1 =
  | {
    contract: typeof APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1
    outcome: 'appended'
    messageId: string
    heldMessageId: null
    holdReason: null
    visible: true
    newlyRecorded: true
  }
  | {
    contract: typeof APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1
    outcome: 'held'
    messageId: null
    heldMessageId: string
    holdReason: HeldChannelMessageReasonV1
    visible: false
    newlyRecorded: true
  }
  | {
    contract: typeof APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1
    outcome: 'duplicate'
    /** The visible row, when the event is (or was released) visible. */
    messageId: string | null
    /** The held row, when the event was held. */
    heldMessageId: string | null
    holdReason: null
    visible: boolean
    newlyRecorded: false
  }
  | {
    contract: typeof APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1
    outcome: 'key_conflict'
    messageId: null
    heldMessageId: null
    holdReason: null
    visible: false
    newlyRecorded: false
  }

/**
 * What a release must carry: a fresh Contacts proof of the conversation's
 * person (private), or `not_applicable` for a group. An unproven sender never
 * releases anything.
 */
export type GuardedReleaseAttributionV1 =
  | { status: 'proven'; contactId: string; contactIdentityId: string }
  | { status: 'not_applicable' }

export interface ReleaseHeldChannelMessagesCommandV1 {
  contract: typeof RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1
  chatId: string
  conversationKind: GuardedConversationKindV1
  /**
   * A fresh proof, judged against the conversation's binding at release time.
   * Each held event is also judged against the sender it was held with: an
   * event held for another proven identity stays held.
   */
  attribution: GuardedReleaseAttributionV1
  /** At most this many held events are released in this call (1..500, default 100). */
  limit?: number
}

/**
 * - released:     at least one held event became visible in this call;
 * - still_held:   the binding is still not proven (holdReason), every
 *                 candidate's key is taken by another conversation, or every
 *                 remaining event was held for another proven identity;
 * - nothing_held: the conversation holds no event.
 */
export interface ReleaseHeldChannelMessagesResultV1 {
  contract: typeof RELEASE_HELD_CHANNEL_MESSAGES_RESULT_V1
  outcome: 'released' | 'still_held' | 'nothing_held'
  released: number
  /** Held events of this conversation that are still held after this call. */
  remaining: number
  keyConflicts: number
  /** Held events whose recorded sender is another proven identity than this proof; they stay held. */
  senderMismatches: number
  holdReason: HeldChannelMessageReasonV1 | null
}

export interface HeldChannelMessagesQueryV1 {
  contract: typeof HELD_CHANNEL_MESSAGES_QUERY_V1
  /** One conversation; omitted, the whole store. */
  chatId?: string
}

/** Counts only: no content, sender or provider identifier crosses this result. */
export interface HeldChannelMessagesResultV1 {
  contract: typeof HELD_CHANNEL_MESSAGES_RESULT_V1
  held: number
  byReason: Record<HeldChannelMessageReasonV1, number>
}

/**
 * One bounded retention pass over the held store (A2): held rows, released or
 * not, whose event (`sentAt`) is older than HELD_CHANNEL_MESSAGE_RETENTION_DAYS_V1
 * are deleted, oldest first. A released row already carries no content; this
 * removes its key and stamp with the same policy as the visible message.
 */
export interface RunHeldChannelMessageRetentionCommandV1 {
  contract: typeof RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1
  dryRun: boolean
  /** Rows in this pass (1..1000, default 200). */
  limit?: number
}

export interface RunHeldChannelMessageRetentionResultV1 {
  contract: typeof RUN_HELD_CHANNEL_MESSAGE_RETENTION_RESULT_V1
  dryRun: boolean
  /** Rows selected; deleted unless dryRun. */
  selectedCount: number
}

export class GuardedChannelMessageCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: GuardedChannelMessageCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'GuardedChannelMessageCommandValidationError'
    this.code = code
  }
}

/**
 * A guarded write that wrote nothing. `retryable` is true only for contention
 * (lock timeout, serialization or deadlock): the whole transaction rolled
 * back, so the same command may be sent again unchanged.
 */
export class GuardedChannelMessageError extends Error {
  readonly code:
    | 'CONVERSATION_NOT_FOUND'
    | 'CONVERSATION_CHANNEL_MISMATCH'
    | 'CONVERSATION_KIND_MISMATCH'
    | 'CONTENDED'
  readonly retryable: boolean

  constructor(code: GuardedChannelMessageError['code'], message: string) {
    super(message)
    this.name = 'GuardedChannelMessageError'
    this.code = code
    this.retryable = code === 'CONTENDED'
  }
}

const GUARDED_TYPES = new Set<string>(['text', 'image', 'audio', 'video', 'sticker', 'voice', 'document'])
const CHANNELS = new Set<string>(['telegram', 'whatsapp', 'max'])
const RESERVED_METADATA_KEYS = new Set<string>(['delivery', 'guardedAppend'])
/** A bounded refusal code, never free text: `CODE` or `CODE:detail`. */
const UNPROVEN_REASON = /^[A-Z][A-Z0-9_]{0,63}(?::[A-Za-z0-9_.-]{1,64})?$/
const MAX_EXTERNAL_ID_LENGTH = 512
const MAX_RELEASE_LIMIT = 500

function invalid(message: string): never {
  throw new GuardedChannelMessageCommandValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function envelope(input: unknown, expected: string, prefix: string, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(input)) invalid('command must be an object')
  const extra = Object.keys(input).filter(key => !fields.includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (input.contract !== expected) {
    if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
      throw new GuardedChannelMessageCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${expected}`)
  }
  return input
}

function requiredId(value: unknown, key: string, max = 191): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim() || value.length > max) {
    invalid(`${key} is required`)
  }
  return value
}

function conversationKind(value: unknown): GuardedConversationKindV1 {
  if (value !== 'private' && value !== 'group') invalid('conversationKind is invalid')
  return value
}

function attribution(value: unknown, kind: GuardedConversationKindV1): GuardedSenderAttributionV1 {
  if (!isRecord(value)) invalid('attribution must be an object')
  if (value.status === 'proven') {
    const extra = Object.keys(value).filter(key => !['status', 'contactId', 'contactIdentityId'].includes(key))
    if (extra.length > 0) invalid(`attribution has unsupported field(s): ${extra.sort().join(', ')}`)
    if (kind !== 'private') invalid('a group conversation has no proven sender')
    return {
      status: 'proven',
      contactId: requiredId(value.contactId, 'attribution.contactId'),
      contactIdentityId: requiredId(value.contactIdentityId, 'attribution.contactIdentityId'),
    }
  }
  if (value.status === 'unproven') {
    const extra = Object.keys(value).filter(key => !['status', 'reason'].includes(key))
    if (extra.length > 0) invalid(`attribution has unsupported field(s): ${extra.sort().join(', ')}`)
    if (kind !== 'private') invalid('a group conversation has no sender attribution')
    if (typeof value.reason !== 'string' || !UNPROVEN_REASON.test(value.reason)) {
      invalid('attribution.reason must be a bounded refusal code')
    }
    return { status: 'unproven', reason: value.reason }
  }
  if (value.status === 'not_applicable') {
    if (Object.keys(value).length !== 1) invalid('attribution has unsupported field(s)')
    if (kind !== 'group') invalid('a private conversation needs a sender attribution')
    return { status: 'not_applicable' }
  }
  invalid('attribution.status is invalid')
}

function isJson(value: unknown, depth = 0): value is ChannelMessageJsonV1 {
  if (depth > 16) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isJson(item, depth + 1))
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(value).every(item => isJson(item, depth + 1))
  }
  return false
}

export function parseAppendGuardedChannelMessageCommandV1(input: unknown): AppendGuardedChannelMessageCommandV1 {
  const value = envelope(
    input,
    APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
    'messaging.AppendGuardedChannelMessageCommand.',
    ['contract', 'chatId', 'conversationKind', 'attribution', 'channel', 'direction', 'type', 'content', 'externalId', 'sentAt', 'metadata'],
  )
  const chatId = requiredId(value.chatId, 'chatId')
  const kind = conversationKind(value.conversationKind)
  const sender = attribution(value.attribution, kind)
  if (typeof value.channel !== 'string' || !CHANNELS.has(value.channel)) invalid('channel is invalid')
  if (value.direction !== 'inbound' && value.direction !== 'outbound') invalid('direction is invalid')
  if (typeof value.type !== 'string' || !GUARDED_TYPES.has(value.type)) invalid('type is invalid')
  if (typeof value.content !== 'string') invalid('content must be a string')
  const externalId = requiredId(value.externalId, 'externalId', MAX_EXTERNAL_ID_LENGTH)
  if (!(value.sentAt instanceof Date) || Number.isNaN(value.sentAt.getTime())) invalid('sentAt must be a valid Date')
  let metadata: { [key: string]: ChannelMessageJsonV1 } | undefined
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || !isJson(value.metadata)) invalid('metadata must be a JSON object')
    const reserved = Object.keys(value.metadata).filter(key => RESERVED_METADATA_KEYS.has(key))
    if (reserved.length > 0) invalid(`metadata may not set ${reserved.sort().join(', ')}`)
    metadata = value.metadata as { [key: string]: ChannelMessageJsonV1 }
  }
  return {
    contract: APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
    chatId,
    conversationKind: kind,
    attribution: sender,
    channel: value.channel as GuardedChannelV1,
    direction: value.direction,
    type: value.type as GuardedMessageTypeV1,
    content: value.content,
    externalId,
    sentAt: value.sentAt,
    ...(metadata ? { metadata } : {}),
  }
}

export function parseReleaseHeldChannelMessagesCommandV1(input: unknown): ReleaseHeldChannelMessagesCommandV1 {
  const value = envelope(
    input,
    RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
    'messaging.ReleaseHeldChannelMessagesCommand.',
    ['contract', 'chatId', 'conversationKind', 'attribution', 'limit'],
  )
  const chatId = requiredId(value.chatId, 'chatId')
  const kind = conversationKind(value.conversationKind)
  const sender = attribution(value.attribution, kind)
  if (sender.status === 'unproven') invalid('a release needs a proven sender')
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_RELEASE_LIMIT) {
      invalid(`limit must be an integer from 1 to ${MAX_RELEASE_LIMIT}`)
    }
  }
  return {
    contract: RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
    chatId,
    conversationKind: kind,
    attribution: sender,
    ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
  }
}

export function parseHeldChannelMessagesQueryV1(input: unknown): HeldChannelMessagesQueryV1 {
  const value = envelope(input, HELD_CHANNEL_MESSAGES_QUERY_V1, 'messaging.HeldChannelMessagesQuery.', ['contract', 'chatId'])
  return {
    contract: HELD_CHANNEL_MESSAGES_QUERY_V1,
    ...(value.chatId !== undefined ? { chatId: requiredId(value.chatId, 'chatId') } : {}),
  }
}

const MAX_RETENTION_LIMIT = 1000

export function parseRunHeldChannelMessageRetentionCommandV1(input: unknown): RunHeldChannelMessageRetentionCommandV1 {
  const value = envelope(
    input,
    RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1,
    'messaging.RunHeldChannelMessageRetentionCommand.',
    ['contract', 'dryRun', 'limit'],
  )
  if (typeof value.dryRun !== 'boolean') invalid('dryRun must be a boolean')
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_RETENTION_LIMIT) {
      invalid(`limit must be an integer from 1 to ${MAX_RETENTION_LIMIT}`)
    }
  }
  return {
    contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1,
    dryRun: value.dryRun,
    ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
  }
}
