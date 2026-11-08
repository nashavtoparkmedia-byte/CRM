import { describe, expect, it, vi } from 'vitest'
import {
  APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
  APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1,
  GuardedChannelMessageCommandValidationError,
  GuardedChannelMessageError,
  HELD_CHANNEL_MESSAGES_QUERY_V1,
  HELD_CHANNEL_MESSAGES_RESULT_V1,
  RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
  RELEASE_HELD_CHANNEL_MESSAGES_RESULT_V1,
  parseAppendGuardedChannelMessageCommandV1,
  parseHeldChannelMessagesQueryV1,
  parseReleaseHeldChannelMessagesCommandV1,
  parseRunHeldChannelMessageRetentionCommandV1,
  RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1,
  RUN_HELD_CHANNEL_MESSAGE_RETENTION_RESULT_V1,
} from '../../../../contracts/messaging/v1'
import { decideGuardedAppendV1, hasConversationPersonBindingV1, type ConversationPersonBindingV1 } from './guarded-append-policy'
import {
  createAppendGuardedChannelMessageHandlerV1,
  createHeldChannelMessagesQueryHandlerV1,
  createReleaseHeldChannelMessagesHandlerV1,
  createRunHeldChannelMessageRetentionHandlerV1,
  type GuardedChannelMessagePersistencePortV1,
} from './guarded-channel-message-handler'

const PROVEN = { status: 'proven', contactId: 'contact-a', contactIdentityId: 'identity-a' } as const
const UNPROVEN = { status: 'unproven', reason: 'CONTACT_RESOLUTION_BLOCKED:phone_evidence_blocked' } as const
const SENT_AT = new Date('2026-11-08T09:00:00.000Z')

function appendCommand(overrides: Record<string, unknown> = {}) {
  return {
    contract: APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
    chatId: 'chat-1',
    conversationKind: 'private',
    attribution: PROVEN,
    channel: 'telegram',
    direction: 'inbound',
    type: 'text',
    content: 'привет',
    externalId: 'telegram:7001:4242:update%3A9001',
    sentAt: SENT_AT,
    metadata: { providerEventId: 'update:9001', providerPeerId: '4242' },
    ...overrides,
  }
}

const UNBOUND: ConversationPersonBindingV1 = { contactId: null, contactIdentityId: null, driverId: null }
const BOUND_A: ConversationPersonBindingV1 = { contactId: 'contact-a', contactIdentityId: 'identity-a', driverId: 'driver-a' }

describe('guarded append contract', () => {
  it('accepts the exact private proven command and returns a normalized copy', () => {
    const parsed = parseAppendGuardedChannelMessageCommandV1(appendCommand())
    expect(parsed).toEqual(appendCommand())
    expect(parsed.attribution).not.toBe(PROVEN)
  })

  it('accepts an unproven private command with a bounded refusal code', () => {
    expect(parseAppendGuardedChannelMessageCommandV1(appendCommand({ attribution: UNPROVEN })).attribution).toEqual(UNPROVEN)
    expect(parseAppendGuardedChannelMessageCommandV1(appendCommand({
      attribution: { status: 'unproven', reason: 'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH' },
    })).attribution.status).toBe('unproven')
  })

  it('accepts a group command only with not_applicable attribution', () => {
    const group = appendCommand({ conversationKind: 'group', attribution: { status: 'not_applicable' } })
    expect(parseAppendGuardedChannelMessageCommandV1(group).conversationKind).toBe('group')
    expect(() => parseAppendGuardedChannelMessageCommandV1(appendCommand({ conversationKind: 'group' }))).toThrow(/group conversation/)
    expect(() => parseAppendGuardedChannelMessageCommandV1(appendCommand({ conversationKind: 'group', attribution: UNPROVEN }))).toThrow(/group conversation/)
    expect(() => parseAppendGuardedChannelMessageCommandV1(appendCommand({ attribution: { status: 'not_applicable' } }))).toThrow(/private conversation/)
  })

  it.each([
    ['not an object', null],
    ['unknown field', appendCommand({ driverId: 'driver-a' })],
    ['wrong contract', appendCommand({ contract: 'messaging.CreateChannelMessageCommand.v1' })],
    ['empty chatId', appendCommand({ chatId: '' })],
    ['padded chatId', appendCommand({ chatId: ' chat-1' })],
    ['unknown kind', appendCommand({ conversationKind: 'channel' })],
    ['attribution missing', appendCommand({ attribution: undefined })],
    ['attribution status unknown', appendCommand({ attribution: { status: 'guessed', contactId: 'contact-a' } })],
    ['proven without identity', appendCommand({ attribution: { status: 'proven', contactId: 'contact-a' } })],
    ['proven with a driver', appendCommand({ attribution: { ...PROVEN, driverId: 'driver-a' } })],
    ['unproven free text', appendCommand({ attribution: { status: 'unproven', reason: 'could not find the person' } })],
    ['unproven without reason', appendCommand({ attribution: { status: 'unproven' } })],
    ['not_applicable with extra', appendCommand({ conversationKind: 'group', attribution: { status: 'not_applicable', contactId: 'x' } })],
    ['unknown channel', appendCommand({ channel: 'phone' })],
    ['system direction', appendCommand({ direction: 'system' })],
    ['system type', appendCommand({ type: 'system' })],
    ['call type', appendCommand({ type: 'call' })],
    ['content not string', appendCommand({ content: 42 })],
    ['empty externalId', appendCommand({ externalId: '' })],
    ['oversized externalId', appendCommand({ externalId: 'x'.repeat(513) })],
    ['sentAt string', appendCommand({ sentAt: SENT_AT.toISOString() })],
    ['sentAt invalid', appendCommand({ sentAt: new Date('nope') })],
    ['metadata array', appendCommand({ metadata: [] })],
    ['metadata with a Date', appendCommand({ metadata: { at: new Date() } })],
    ['metadata with NaN', appendCommand({ metadata: { n: Number.NaN } })],
    ['metadata sets delivery evidence', appendCommand({ metadata: { delivery: { v: 1, evidence: 'read_receipt' } } })],
    ['metadata sets the guard audit', appendCommand({ metadata: { guardedAppend: { v: 1 } } })],
  ])('rejects %s', (_name, input) => {
    expect(() => parseAppendGuardedChannelMessageCommandV1(input)).toThrow(GuardedChannelMessageCommandValidationError)
  })

  it('names an unsupported version distinctly', () => {
    try {
      parseAppendGuardedChannelMessageCommandV1(appendCommand({ contract: 'messaging.AppendGuardedChannelMessageCommand.v2' }))
      throw new Error('accepted')
    } catch (error) {
      expect((error as GuardedChannelMessageCommandValidationError).code).toBe('UNSUPPORTED_CONTRACT_VERSION')
    }
  })

  it('parses release and held-count envelopes strictly', () => {
    const release = { contract: RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1, chatId: 'chat-1', conversationKind: 'private', attribution: PROVEN }
    expect(parseReleaseHeldChannelMessagesCommandV1(release)).toEqual(release)
    expect(parseReleaseHeldChannelMessagesCommandV1({ ...release, limit: 500 }).limit).toBe(500)
    for (const limit of [0, 501, 1.5, '10']) {
      expect(() => parseReleaseHeldChannelMessagesCommandV1({ ...release, limit })).toThrow(GuardedChannelMessageCommandValidationError)
    }
    expect(() => parseReleaseHeldChannelMessagesCommandV1({ ...release, externalId: 'x' })).toThrow(GuardedChannelMessageCommandValidationError)
    // No release without a proof: an unproven sender is refused before any persistence.
    expect(() => parseReleaseHeldChannelMessagesCommandV1({ ...release, attribution: { status: 'unproven', reason: 'CONTACT_RESOLUTION_BLOCKED' } }))
      .toThrow('a release needs a proven sender')
    expect(() => parseReleaseHeldChannelMessagesCommandV1({ ...release, attribution: { status: 'not_applicable' } })).toThrow(GuardedChannelMessageCommandValidationError)
    expect(parseReleaseHeldChannelMessagesCommandV1({ ...release, conversationKind: 'group', attribution: { status: 'not_applicable' } }).attribution)
      .toEqual({ status: 'not_applicable' })
    expect(parseHeldChannelMessagesQueryV1({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1 })).toEqual({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1 })
    expect(parseHeldChannelMessagesQueryV1({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1, chatId: 'chat-1' }).chatId).toBe('chat-1')
    expect(() => parseHeldChannelMessagesQueryV1({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1, chatId: '' })).toThrow()
  })

  it('parses the held retention command strictly', () => {
    const retention = { contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1, dryRun: true }
    expect(parseRunHeldChannelMessageRetentionCommandV1(retention)).toEqual(retention)
    expect(parseRunHeldChannelMessageRetentionCommandV1({ ...retention, limit: 1000 }).limit).toBe(1000)
    for (const bad of [{ ...retention, dryRun: 'yes' }, { contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1 }, { ...retention, limit: 0 }, { ...retention, limit: 1001 }, { ...retention, chatId: 'x' }]) {
      expect(() => parseRunHeldChannelMessageRetentionCommandV1(bad)).toThrow(GuardedChannelMessageCommandValidationError)
    }
  })

  it('reports only contention as retryable', () => {
    expect(new GuardedChannelMessageError('CONTENDED', 'x').retryable).toBe(true)
    for (const code of ['CONVERSATION_NOT_FOUND', 'CONVERSATION_CHANNEL_MISMATCH', 'CONVERSATION_KIND_MISMATCH'] as const) {
      expect(new GuardedChannelMessageError(code, 'x').retryable).toBe(false)
    }
  })
})

describe('guarded append policy', () => {
  it('shows a proven sender only in the conversation bound to exactly that contact and identity', () => {
    expect(decideGuardedAppendV1('private', PROVEN, BOUND_A)).toEqual({ visible: true })
    expect(decideGuardedAppendV1('private', PROVEN, { ...BOUND_A, driverId: null })).toEqual({ visible: true })
  })

  it('holds a proven sender whose conversation is bound to another person', () => {
    expect(decideGuardedAppendV1('private', PROVEN, { ...BOUND_A, contactId: 'contact-b' })).toEqual({ visible: false, reason: 'binding_mismatch' })
    expect(decideGuardedAppendV1('private', PROVEN, { ...BOUND_A, contactIdentityId: 'identity-b' })).toEqual({ visible: false, reason: 'binding_mismatch' })
    expect(decideGuardedAppendV1('private', PROVEN, { contactId: null, contactIdentityId: null, driverId: 'driver-b' })).toEqual({ visible: false, reason: 'binding_mismatch' })
    expect(decideGuardedAppendV1('private', PROVEN, { contactId: 'contact-a', contactIdentityId: null, driverId: null })).toEqual({ visible: false, reason: 'binding_mismatch' })
  })

  it('holds a proven sender whose conversation was never linked', () => {
    expect(decideGuardedAppendV1('private', PROVEN, UNBOUND)).toEqual({ visible: false, reason: 'binding_absent' })
  })

  it('shows an unproven sender only where no person is bound, and never guesses one', () => {
    expect(decideGuardedAppendV1('private', UNPROVEN, UNBOUND)).toEqual({ visible: true })
    expect(decideGuardedAppendV1('private', UNPROVEN, BOUND_A)).toEqual({ visible: false, reason: 'attribution_unproven' })
    expect(decideGuardedAppendV1('private', UNPROVEN, { ...UNBOUND, driverId: 'driver-a' })).toEqual({ visible: false, reason: 'attribution_unproven' })
    expect(decideGuardedAppendV1('private', UNPROVEN, { ...UNBOUND, contactIdentityId: 'identity-a' })).toEqual({ visible: false, reason: 'attribution_unproven' })
  })

  it('shows a group event only while the group is bound to nobody', () => {
    expect(decideGuardedAppendV1('group', { status: 'not_applicable' }, UNBOUND)).toEqual({ visible: true })
    expect(decideGuardedAppendV1('group', { status: 'not_applicable' }, { ...UNBOUND, driverId: 'driver-a' })).toEqual({ visible: false, reason: 'group_person_bound' })
  })

  it('fails closed on an attribution the parser would never pair with a private conversation', () => {
    expect(decideGuardedAppendV1('private', { status: 'not_applicable' }, UNBOUND).visible).toBe(false)
    expect(decideGuardedAppendV1('private', { status: 'not_applicable' }, BOUND_A).visible).toBe(false)
  })

  it('counts any of the three columns as a person binding', () => {
    expect(hasConversationPersonBindingV1(UNBOUND)).toBe(false)
    expect(hasConversationPersonBindingV1({ ...UNBOUND, contactId: 'c' })).toBe(true)
    expect(hasConversationPersonBindingV1({ ...UNBOUND, contactIdentityId: 'i' })).toBe(true)
    expect(hasConversationPersonBindingV1({ ...UNBOUND, driverId: 'd' })).toBe(true)
  })
})

function fakePort(overrides: Partial<GuardedChannelMessagePersistencePortV1> = {}): GuardedChannelMessagePersistencePortV1 {
  return {
    append: vi.fn(async () => ({ outcome: 'appended', messageId: 'message-1' } as const)),
    release: vi.fn(async () => ({ released: 0, remaining: 0, keyConflicts: 0, senderMismatches: 0, holdReason: null })),
    countHeld: vi.fn(async () => ({})),
    purgeHeld: vi.fn(async () => 0),
    ...overrides,
  }
}

describe('guarded append handlers', () => {
  it('parses before persisting and passes the command without its envelope', async () => {
    const port = fakePort()
    const append = createAppendGuardedChannelMessageHandlerV1(port)
    await expect(append(appendCommand({ chatId: '' }))).rejects.toThrow(GuardedChannelMessageCommandValidationError)
    expect(port.append).not.toHaveBeenCalled()

    const result = await append(appendCommand())
    const { contract: _contract, ...input } = appendCommand()
    expect(port.append).toHaveBeenCalledWith(input)
    expect(result).toEqual({
      contract: APPEND_GUARDED_CHANNEL_MESSAGE_RESULT_V1,
      outcome: 'appended',
      messageId: 'message-1',
      heldMessageId: null,
      holdReason: null,
      visible: true,
      newlyRecorded: true,
    })
  })

  it('marks only appended and held as newly recorded', async () => {
    const cases = [
      [{ outcome: 'held', heldMessageId: 'held-1', holdReason: 'binding_mismatch' }, { newlyRecorded: true, visible: false, heldMessageId: 'held-1', holdReason: 'binding_mismatch' }],
      [{ outcome: 'duplicate', messageId: null, heldMessageId: 'held-1', visible: false }, { newlyRecorded: false, visible: false, heldMessageId: 'held-1' }],
      [{ outcome: 'duplicate', messageId: 'message-1', heldMessageId: null, visible: true }, { newlyRecorded: false, visible: true, messageId: 'message-1' }],
      [{ outcome: 'key_conflict' }, { newlyRecorded: false, visible: false, messageId: null, heldMessageId: null }],
    ] as const
    for (const [settled, expected] of cases) {
      const append = createAppendGuardedChannelMessageHandlerV1(fakePort({ append: vi.fn(async () => settled as never) }))
      expect(await append(appendCommand())).toMatchObject({ outcome: settled.outcome, ...expected })
    }
  })

  it('propagates a write that wrote nothing, with its retry classification', async () => {
    const append = createAppendGuardedChannelMessageHandlerV1(fakePort({
      append: vi.fn(async () => { throw new GuardedChannelMessageError('CONTENDED', 'busy') }),
    }))
    await expect(append(appendCommand())).rejects.toMatchObject({ code: 'CONTENDED', retryable: true })
  })

  it('derives the release outcome from what the port settled, with the default limit', async () => {
    const release = { contract: RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1, chatId: 'chat-1', conversationKind: 'private', attribution: PROVEN }
    const cases = [
      [{ released: 2, remaining: 0, keyConflicts: 0, senderMismatches: 0, holdReason: null }, 'released'],
      [{ released: 1, remaining: 2, keyConflicts: 0, senderMismatches: 2, holdReason: null }, 'released'],
      [{ released: 0, remaining: 0, keyConflicts: 0, senderMismatches: 0, holdReason: null }, 'nothing_held'],
      [{ released: 0, remaining: 3, keyConflicts: 0, senderMismatches: 0, holdReason: 'binding_mismatch' }, 'still_held'],
      [{ released: 0, remaining: 1, keyConflicts: 1, senderMismatches: 0, holdReason: null }, 'still_held'],
      [{ released: 0, remaining: 1, keyConflicts: 0, senderMismatches: 1, holdReason: null }, 'still_held'],
    ] as const
    for (const [settled, outcome] of cases) {
      const port = fakePort({ release: vi.fn(async () => settled) })
      const result = await createReleaseHeldChannelMessagesHandlerV1(port)(release)
      expect(result).toEqual({ contract: RELEASE_HELD_CHANNEL_MESSAGES_RESULT_V1, outcome, ...settled })
      expect(port.release).toHaveBeenCalledWith({ chatId: 'chat-1', conversationKind: 'private', attribution: PROVEN, limit: 100 })
    }
  })

  it('runs held retention at exactly the 12-month boundary with the default limit', async () => {
    const now = Date.UTC(2026, 10, 8, 12, 0, 0)
    const port = fakePort({ purgeHeld: vi.fn(async () => 3) })
    const run = createRunHeldChannelMessageRetentionHandlerV1(port, () => now)
    expect(await run({ contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1, dryRun: true })).toEqual({
      contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_RESULT_V1, dryRun: true, selectedCount: 3,
    })
    expect(port.purgeHeld).toHaveBeenCalledWith({ before: new Date(now - 365 * 24 * 60 * 60 * 1000), limit: 200, dryRun: true })
    await run({ contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1, dryRun: false, limit: 50 })
    expect(port.purgeHeld).toHaveBeenLastCalledWith({ before: new Date(now - 365 * 24 * 60 * 60 * 1000), limit: 50, dryRun: false })
    await expect(run({ contract: RUN_HELD_CHANNEL_MESSAGE_RETENTION_COMMAND_V1 })).rejects.toThrow(GuardedChannelMessageCommandValidationError)
  })

  it('reports held counts for every reason, zero-filled, and nothing else', async () => {
    const port = fakePort({ countHeld: vi.fn(async () => ({ binding_mismatch: 2, attribution_unproven: 1 })) })
    const result = await createHeldChannelMessagesQueryHandlerV1(port)({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1 })
    expect(port.countHeld).toHaveBeenCalledWith({ chatId: null })
    expect(result).toEqual({
      contract: HELD_CHANNEL_MESSAGES_RESULT_V1,
      held: 3,
      byReason: { binding_absent: 0, binding_mismatch: 2, attribution_unproven: 1, group_person_bound: 0 },
    })
  })
})
