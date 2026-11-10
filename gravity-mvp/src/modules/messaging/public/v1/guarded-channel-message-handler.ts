import {
  APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1,
  HELD_CHANNEL_MESSAGES_RESULT_V1,
  HELD_CHANNEL_MESSAGE_REASONS_V1,
  HELD_CHANNEL_MESSAGE_RETENTION_DAYS_V1,
  RELEASE_HELD_CHANNEL_MESSAGES_RESULT_V1,
  RUN_HELD_CHANNEL_MESSAGE_RETENTION_RESULT_V1,
  parseAppendGuardedChannelMessageCommandV1,
  parseHeldChannelMessagesQueryV1,
  parseReleaseHeldChannelMessagesCommandV1,
  parseRunHeldChannelMessageRetentionCommandV1,
  type AppendGuardedChannelMessageCommandV1,
  type AppendGuardedChannelMessageResultV1,
  type HeldChannelMessageReasonV1,
  type HeldChannelMessagesQueryV1,
  type HeldChannelMessagesResultV1,
  type ReleaseHeldChannelMessagesCommandV1,
  type ReleaseHeldChannelMessagesResultV1,
  type RunHeldChannelMessageRetentionCommandV1,
  type RunHeldChannelMessageRetentionResultV1,
} from '../../../../contracts/messaging/v1'

/** What the persistence side settled for one event, before the contract envelope. */
export type GuardedAppendSettlementV1 =
  | { outcome: 'appended'; messageId: string }
  | { outcome: 'held'; heldMessageId: string; holdReason: HeldChannelMessageReasonV1 }
  | { outcome: 'duplicate'; messageId: string | null; heldMessageId: string | null; visible: boolean }
  | { outcome: 'key_conflict' }

export interface GuardedReleaseSettlementV1 {
  released: number
  remaining: number
  keyConflicts: number
  senderMismatches: number
  holdReason: HeldChannelMessageReasonV1 | null
}

export interface GuardedChannelMessagePersistencePortV1 {
  append(input: Omit<AppendGuardedChannelMessageCommandV1, 'contract'>): Promise<GuardedAppendSettlementV1>
  release(input: Omit<ReleaseHeldChannelMessagesCommandV1, 'contract' | 'limit'> & { limit: number }): Promise<GuardedReleaseSettlementV1>
  countHeld(input: { chatId: string | null }): Promise<Partial<Record<HeldChannelMessageReasonV1, number>>>
  /** Deletes (unless dryRun) at most `limit` held rows whose event is older than `before`, oldest first; returns how many were selected. */
  purgeHeld(input: { before: Date; limit: number; dryRun: boolean }): Promise<number>
}

const DEFAULT_RELEASE_LIMIT = 100
const DEFAULT_RETENTION_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000

export function createAppendGuardedChannelMessageHandlerV1(port: GuardedChannelMessagePersistencePortV1) {
  return async function appendGuardedChannelMessageV1(
    command: AppendGuardedChannelMessageCommandV1 | unknown,
  ): Promise<AppendGuardedChannelMessageResultV1> {
    const { contract: _contract, ...input } = parseAppendGuardedChannelMessageCommandV1(command)
    const settled = await port.append(input)
    const contract = APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1
    switch (settled.outcome) {
      case 'appended':
        return { contract, outcome: 'appended', messageId: settled.messageId, heldMessageId: null, holdReason: null, visible: true, newlyRecorded: true }
      case 'held':
        return { contract, outcome: 'held', messageId: null, heldMessageId: settled.heldMessageId, holdReason: settled.holdReason, visible: false, newlyRecorded: true }
      case 'duplicate':
        return { contract, outcome: 'duplicate', messageId: settled.messageId, heldMessageId: settled.heldMessageId, holdReason: null, visible: settled.visible, newlyRecorded: false }
      case 'key_conflict':
        return { contract, outcome: 'key_conflict', messageId: null, heldMessageId: null, holdReason: null, visible: false, newlyRecorded: false }
    }
  }
}

export function createReleaseHeldChannelMessagesHandlerV1(port: GuardedChannelMessagePersistencePortV1) {
  return async function releaseHeldChannelMessagesV1(
    command: ReleaseHeldChannelMessagesCommandV1 | unknown,
  ): Promise<ReleaseHeldChannelMessagesResultV1> {
    const parsed = parseReleaseHeldChannelMessagesCommandV1(command)
    const settled = await port.release({
      chatId: parsed.chatId,
      conversationKind: parsed.conversationKind,
      attribution: parsed.attribution,
      limit: parsed.limit ?? DEFAULT_RELEASE_LIMIT,
    })
    const outcome = settled.released > 0
      ? 'released'
      : settled.remaining === 0 && settled.keyConflicts === 0 && settled.senderMismatches === 0 && settled.holdReason === null
        ? 'nothing_held'
        : 'still_held'
    return { contract: RELEASE_HELD_CHANNEL_MESSAGES_RESULT_V1, outcome, ...settled }
  }
}

export function createHeldChannelMessagesQueryHandlerV1(port: GuardedChannelMessagePersistencePortV1) {
  return async function heldChannelMessagesV1(
    query: HeldChannelMessagesQueryV1 | unknown,
  ): Promise<HeldChannelMessagesResultV1> {
    const parsed = parseHeldChannelMessagesQueryV1(query)
    const counted = await port.countHeld({ chatId: parsed.chatId ?? null })
    const byReason = Object.fromEntries(
      HELD_CHANNEL_MESSAGE_REASONS_V1.map(reason => [reason, counted[reason] ?? 0]),
    ) as Record<HeldChannelMessageReasonV1, number>
    const held = Object.values(byReason).reduce((sum, count) => sum + count, 0)
    return { contract: HELD_CHANNEL_MESSAGES_RESULT_V1, held, byReason }
  }
}

export function createRunHeldChannelMessageRetentionHandlerV1(port: GuardedChannelMessagePersistencePortV1, now: () => number = Date.now) {
  return async function runHeldChannelMessageRetentionV1(
    command: RunHeldChannelMessageRetentionCommandV1 | unknown,
  ): Promise<RunHeldChannelMessageRetentionResultV1> {
    const parsed = parseRunHeldChannelMessageRetentionCommandV1(command)
    const selectedCount = await port.purgeHeld({
      before: new Date(now() - HELD_CHANNEL_MESSAGE_RETENTION_DAYS_V1 * DAY_MS),
      limit: parsed.limit ?? DEFAULT_RETENTION_LIMIT,
      dryRun: parsed.dryRun,
    })
    return { contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_RESULT_V1, dryRun: parsed.dryRun, selectedCount }
  }
}
