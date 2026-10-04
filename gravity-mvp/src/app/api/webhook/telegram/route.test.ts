import { NextRequest } from 'next/server'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsertConversation: vi.fn(),
  patchConversation: vi.fn(),
  appendCollision: vi.fn(),
  createMessage: vi.fn(),
  ensureContactLink: vi.fn(),
  linkDriver: vi.fn(),
  resolveContact: vi.fn(),
  isResolvedContact: vi.fn(),
  attachIdentity: vi.fn(),
  markIdentityConflict: vi.fn(),
  promoteDisplayName: vi.fn(),
  recordProfile: vi.fn(),
  botMessageCreate: vi.fn(),
  messageFindFirst: vi.fn(),
  driverFindUnique: vi.fn(),
  driverFindFirst: vi.fn(),
  driverUpdate: vi.fn(),
  chatFindUnique: vi.fn(),
  inboundWorkflow: vi.fn(),
  outboundWorkflow: vi.fn(),
  groupInboundWorkflow: vi.fn(),
  sendBotMessage: vi.fn(),
  changeDriverLimit: vi.fn(),
  authorizeDriverTelegram: vi.fn(),
  canonicalBotConnection: vi.fn(),
  opsLog: vi.fn(),
  recordReachability: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    botChatMessage: { create: mocks.botMessageCreate },
    message: { findFirst: mocks.messageFindFirst },
    chat: { findUnique: mocks.chatFindUnique },
    driverTelegram: {
      findUnique: mocks.driverFindUnique,
      findFirst: mocks.driverFindFirst,
      update: mocks.driverUpdate,
    },
  },
}))
vi.mock('@/app/tg-bot-actions', () => ({
  sendTelegramBotMessage: mocks.sendBotMessage,
}))
vi.mock('@/modules/fleet-operations/public/v1/yandex-fleet-operations', () => ({
  changeDriverLimit: mocks.changeDriverLimit,
}))
vi.mock('@/modules/fleet-operations/public/v1/channel-driver-match', () => ({
  channelDriverMatchV1: { linkChatToDriver: mocks.linkDriver },
}))
vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
  channelConversationWorkflowV1: {
    onInboundMessage: mocks.inboundWorkflow,
    onOutboundMessage: mocks.outboundWorkflow,
    onGroupInboundMessage: mocks.groupInboundWorkflow,
  },
}))
vi.mock('@/modules/messaging/public/v1', () => ({
  createChannelMessageV1: mocks.createMessage,
  ensureConversationContactLinkV1: mocks.ensureContactLink,
  linkMatchedDriverToConversationCapabilityV1: vi.fn(),
  patchChannelConversationV1: mocks.patchConversation,
  appendConversationIdentityCollisionV1: mocks.appendCollision,
  upsertChannelConversationV1: mocks.upsertConversation,
}))
vi.mock('@/modules/contacts/public/v1', () => ({
  attachContactIdentityV1: mocks.attachIdentity,
  isResolvedChannelContactResultV1: mocks.isResolvedContact,
  markChannelIdentityConflictV1: mocks.markIdentityConflict,
  resolveChannelContactOperationV1: mocks.resolveContact,
}))
vi.mock('@/modules/contacts/public/v2', () => ({
  resolveContactV2: mocks.promoteDisplayName,
}))
vi.mock('@/modules/telegram-channel/public/v1', () => ({
  prepareDriverTelegramConversationAuthorityV1: mocks.authorizeDriverTelegram,
  canonicalTelegramBotConnectionIdV1: mocks.canonicalBotConnection,
  recordBotUserProfileV1: mocks.recordProfile,
}))

const BOT_CONNECTION = 'driver-bot-primary'
/** The live Driver Bot API account id, as the bot process reports it. */
const BOT_ACCOUNT = '8447212640'
/** The single production MTProto personal-account transport. */
const MTPROTO_CONNECTION = '1982527911'
vi.mock('@/infrastructure/operations/operational-log', () => ({
  operationalLogV1: mocks.opsLog,
}))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
  contactReachabilityV1: { recordExactProviderReachability: mocks.recordReachability },
}))

import { POST } from './route'

const originalSecret = process.env.BOT_CRM_SECRET

function request(overrides: Record<string, unknown> = {}, signature = 'test-bot-secret') {
  return new NextRequest('https://crm.example/api/webhook/telegram', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bot-signature': signature,
    },
    body: JSON.stringify({
      telegramId: '42',
      // Production shape: the live Bot API account id is numeric, and the
      // transport the bot reports is the canonical configured one.
      providerAccountId: BOT_ACCOUNT,
      connectionId: BOT_CONNECTION,
      providerEventId: 'update:1001',
      providerUpdateId: '1001',
      providerMessageId: '2001',
      callbackQueryId: null,
      text: 'hello',
      direction: 'INCOMING',
      username: 'driver42',
      firstName: 'Driver',
      lastName: 'Forty Two',
      timestamp: '2026-09-02T12:00:00.000Z',
      chatType: 'private',
      ...overrides,
    }),
  })
}

function chat(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat-1',
    channel: 'telegram',
    externalChatId: 'telegram:42',
    name: '@driver42',
    chatType: 'private',
    contactId: null,
    contactIdentityId: null,
    driverId: null,
    metadata,
    ...overrides,
  }
}

function expectNoPersonOrMessageMutation() {
  expect(mocks.patchConversation).not.toHaveBeenCalled()
  expect(mocks.linkDriver).not.toHaveBeenCalled()
  expect(mocks.resolveContact).not.toHaveBeenCalled()
  expect(mocks.ensureContactLink).not.toHaveBeenCalled()
  expect(mocks.attachIdentity).not.toHaveBeenCalled()
  expect(mocks.recordProfile).not.toHaveBeenCalled()
  expect(mocks.botMessageCreate).not.toHaveBeenCalled()
  expect(mocks.createMessage).not.toHaveBeenCalled()
  expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
}

describe('Telegram webhook account and transport admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BOT_CRM_SECRET = 'test-bot-secret'
    mocks.appendCollision.mockResolvedValue(undefined)
    mocks.markIdentityConflict.mockResolvedValue(undefined)
    mocks.linkDriver.mockResolvedValue(false)
    mocks.driverFindUnique.mockResolvedValue(null)
    mocks.messageFindFirst.mockResolvedValue(null)
    mocks.botMessageCreate.mockResolvedValue({ id: 'legacy-message-1' })
    mocks.createMessage.mockResolvedValue({ message: { id: 'message-1' } })
    mocks.resolveContact.mockResolvedValue({
      status: 'created',
      isNew: true,
      contact: { id: 'contact-1' },
      identity: { id: 'identity-1' },
    })
    mocks.isResolvedContact.mockReturnValue(true)
    mocks.ensureContactLink.mockResolvedValue({ linked: true })
    mocks.recordReachability.mockResolvedValue({ outcome: 'updated', status: 'confirmed' })
    mocks.sendBotMessage.mockResolvedValue({ success: true, messageId: 'bot-message-1' })
    // Person/conversation proof: it names no transport.
    mocks.authorizeDriverTelegram.mockResolvedValue({
      chatId: 'chat-1',
      contactId: 'contact-1',
      contactIdentityId: 'identity-1',
      driverId: 'driver-1',
      target: '42',
    })
    mocks.canonicalBotConnection.mockReturnValue(BOT_CONNECTION)
  })

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.BOT_CRM_SECRET
    else process.env.BOT_CRM_SECRET = originalSecret
  })

  test('creates a new private Chat with transport-neutral metadata', async () => {
    const created = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })

    const response = await POST(request())

    expect(response.status).toBe(200)
    // A Chat is the shared peer identity. Bot transport provenance must not be
    // persisted at conversation level, or a Bot-first row would collide with the
    // MTProto ingress on the very same peer. chatType carries private/group.
    expect(mocks.upsertConversation).toHaveBeenCalledWith({
      contract: 'messaging.UpsertChannelConversationCommand.v1',
      externalChatId: 'telegram:42',
      channel: 'telegram',
      name: '@driver42',
      chatType: 'private',
      metadata: {},
    })
    expect(mocks.resolveContact).toHaveBeenCalledWith(
      'telegram',
      '42',
      null,
      '@driver42',
      { chatKind: 'private', providerAccountId: BOT_ACCOUNT },
    )
    expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).toHaveBeenCalledWith({
      identityId: 'identity-1',
      contactId: 'contact-1',
      channel: 'telegram',
      providerAccountId: BOT_ACCOUNT,
      providerTargetId: '42',
      status: 'confirmed',
    })
    expect(mocks.botMessageCreate).toHaveBeenCalledOnce()
    // Exact transport provenance stays on the event, which is where it belongs.
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      externalId: `telegram:${BOT_ACCOUNT}:42:update%3A1001`,
      metadata: expect.objectContaining({
        providerAccountId: BOT_ACCOUNT,
        connectionId: BOT_CONNECTION,
        providerPeerId: '42',
        providerEventId: 'update:1001',
        providerUpdateId: '1001',
        providerMessageId: '2001',
        callbackQueryId: null,
      }),
    }))
    expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
  })

  // A Chat is the shared peer/conversation identity, never exclusive transport
  // ownership, so a stored connection naming the other Telegram transport is not
  // a contradiction. This is the MTProto-first ordering of the mixed-transport
  // proof: existing MTProto Chat -> Bot ingress -> accepted, one Chat, no
  // durable conflict.
  test.each([
    ['the MTProto personal-account transport', {
      chatKind: 'private',
      providerAccountId: MTPROTO_CONNECTION,
      connectionId: MTPROTO_CONNECTION,
    }],
    ['a stored connection only', { connectionId: MTPROTO_CONNECTION }],
    ['no transport provenance at all', {}],
  ])('admits an existing private Chat carrying %s', async (_label, metadata) => {
    const existing = chat(metadata, {
      contactId: 'contact-a',
      contactIdentityId: 'identity-a',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: existing })
    mocks.patchConversation.mockResolvedValue({ conversation: existing })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expect(mocks.createMessage).toHaveBeenCalledOnce()
  })

  // Bot-first ordering of the mixed-transport proof: a new peer first seen through
  // Bot API must create a Chat that the MTProto ingress can later admit. The
  // GramJS side of this ordering is proven by
  // tg-actions.identity.test.ts > 'admits a legacy private Chat carrying no
  // transport or peer provenance', which accepts exactly the row created here.
  test('a Bot-first new Chat carries no key that could collide with MTProto', async () => {
    const created = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })

    await POST(request())

    const [[create]] = mocks.upsertConversation.mock.calls
    expect(create.metadata).not.toHaveProperty('connectionId')
    expect(create.metadata).not.toHaveProperty('providerAccountId')
    expect(create.metadata).not.toHaveProperty('chatKind')
    expect(create.chatType).toBe('private')
  })

  test('a second Bot event on that Bot-first Chat is admitted unchanged', async () => {
    const created = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })

    const first = await POST(request())
    const second = await POST(request({ providerUpdateId: '1002', providerEventId: 'update:1002' }))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  })

  test('never rewrites the stored transport of an admitted shared Chat', async () => {
    const existing = chat({ connectionId: MTPROTO_CONNECTION })
    mocks.upsertConversation.mockResolvedValue({ conversation: existing })
    mocks.patchConversation.mockResolvedValue({ conversation: existing })

    await POST(request())

    const [[patch]] = mocks.patchConversation.mock.calls
    expect(patch.patch).not.toHaveProperty('metadata')
  })

  test('records durable Chat evidence for a real collision on a linked identity', async () => {
    // The transport arm is gone, but a genuine contradiction — a private event
    // racing a concrete group Chat — still produces durable evidence.
    const existing = chat({ chatKind: 'group' }, {
      chatType: 'group',
      contactId: 'contact-a',
      contactIdentityId: 'identity-a',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: existing })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(mocks.appendCollision.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.markIdentityConflict.mock.invocationCallOrder[0])
    expect(mocks.markIdentityConflict).toHaveBeenCalledWith({
      contactId: 'contact-a',
      identityId: 'identity-a',
      channel: 'telegram',
      reason: 'chat_kind_mismatch',
      evidenceRoot: expect.stringContaining('channel-collision:telegram:telegram:42:'),
      details: expect.objectContaining({
        incomingChatKind: 'private',
        existingChatKind: 'group',
      }),
    })
    expectNoPersonOrMessageMutation()
  })

  test('rejects a private event that races with a concrete group Chat', async () => {
    const existing = chat({
      chatKind: 'group',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    }, { chatType: 'group' })
    mocks.upsertConversation.mockResolvedValue({ conversation: existing })

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'TELEGRAM_CHAT_KIND_COLLISION' })
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        reason: 'chat_kind_mismatch',
        incomingChatKind: 'private',
        existingChatKind: 'group',
      }),
    }))
    expectNoPersonOrMessageMutation()
  })

  test('rejects an unsigned message before Chat admission', async () => {
    const response = await POST(request({}, 'wrong-secret'))

    expect(response.status).toBe(401)
    expect(mocks.upsertConversation).not.toHaveBeenCalled()
    expectNoPersonOrMessageMutation()
  })

  test.each([
    ['providerAccountId', { providerAccountId: '' }],
    ['connectionId', { connectionId: '' }],
  ])('rejects a missing exact %s before Chat admission', async (_label, overrides) => {
    const response = await POST(request(overrides))

    expect(response.status).toBe(400)
    expect(mocks.upsertConversation).not.toHaveBeenCalled()
    expectNoPersonOrMessageMutation()
  })

  test.each([
    ['providerEventId', { providerEventId: null }],
    ['providerUpdateId', { providerUpdateId: null }],
    ['mismatched update identity', { providerEventId: 'update:9999' }],
    ['provider message or callback identity', { providerMessageId: null, callbackQueryId: null }],
    ['provider timestamp', { timestamp: null }],
  ])('rejects missing or inconsistent %s before Chat admission', async (_label, overrides) => {
    const response = await POST(request(overrides))

    expect(response.status).toBe(400)
    expect(mocks.upsertConversation).not.toHaveBeenCalled()
    expectNoPersonOrMessageMutation()
  })

  test('returns a stable duplicate result before person, history, workflow, or Driver mutation', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.messageFindFirst.mockResolvedValue({ id: 'existing-message' })

    const response = await POST(request({ text: '💳 Управление лимитом' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      processed: 'duplicate_provider_event',
    })
    expect(mocks.messageFindFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        externalId: `telegram:${BOT_ACCOUNT}:42:update%3A1001`,
      },
      select: { id: true },
    })
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
    expect(mocks.recordProfile).not.toHaveBeenCalled()
    expect(mocks.botMessageCreate).not.toHaveBeenCalled()
    expect(mocks.createMessage).not.toHaveBeenCalled()
    expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
    expect(mocks.authorizeDriverTelegram).not.toHaveBeenCalled()
    expect(mocks.driverUpdate).not.toHaveBeenCalled()
    expect(mocks.changeDriverLimit).not.toHaveBeenCalled()
  })

  test('persists a group event under its exact account, peer, and update identity', async () => {
    const admitted = chat({
      chatKind: 'group',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    }, {
      externalChatId: 'telegram:group:-10042',
      chatType: 'group',
      name: 'Dispatch',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })

    const response = await POST(request({
      chatType: 'supergroup',
      chatId: '-10042',
      chatTitle: 'Dispatch',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, processed: 'group_message' })
    expect(mocks.messageFindFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        externalId: `telegram:${BOT_ACCOUNT}:-10042:update%3A1001`,
      },
      select: { id: true },
    })
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      externalId: `telegram:${BOT_ACCOUNT}:-10042:update%3A1001`,
      metadata: expect.objectContaining({
        providerAccountId: BOT_ACCOUNT,
        providerPeerId: '-10042',
        providerEventId: 'update:1001',
      }),
    }))
    // The group Chat keeps only its descriptive title/kind — no transport keys.
    expect(mocks.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 'group',
      metadata: { chatTitle: 'Dispatch', chatType: 'supergroup' },
    }))
    expect(mocks.groupInboundWorkflow).toHaveBeenCalledOnce()
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.botMessageCreate).not.toHaveBeenCalled()
  })

  // ── register_bot_user ────────────────────────────────────────────────
  // The clean bot posts registration to this route with the shared signature.
  // Registration records BotUser profile evidence only; it must not depend on
  // shared Chat transport ownership.

  function registrationRequest(payload: Record<string, unknown>, signature = 'test-bot-secret') {
    return new NextRequest('https://crm.example/api/webhook/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-signature': signature },
      body: JSON.stringify({ action: 'register_bot_user', payload }),
    })
  }

  test('accepts a signed register_bot_user and records profile evidence only', async () => {
    mocks.driverFindFirst.mockResolvedValue(null)

    const response = await POST(registrationRequest({
      telegramId: '42',
      username: 'driver42',
      firstName: 'Driver',
      lastName: 'Forty Two',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      linked: false,
      status: 'PENDING_MANAGER_LINK',
    })
    expect(mocks.recordProfile).toHaveBeenCalledOnce()
    // No conversation admission, no transport ownership, no message.
    expect(mocks.upsertConversation).not.toHaveBeenCalled()
    expect(mocks.createMessage).not.toHaveBeenCalled()
  })

  test('rejects register_bot_user with a wrong signature', async () => {
    const response = await POST(registrationRequest({ telegramId: '42' }, 'wrong-secret'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mocks.recordProfile).not.toHaveBeenCalled()
  })

  // ── persist-before-enrichment ────────────────────────────────────────
  // An authenticated, de-duplicated provider event is durable once admitted.
  // Identity enrichment runs afterwards and is non-fatal: a contradictory
  // Contact, ContactIdentity or Driver must never make a delivered message
  // disappear, and must never ask the bot to resend an accepted event.

  // `vi.clearAllMocks()` clears calls but keeps implementations, so every case
  // here breaks enrichment for exactly one call and leaks nothing forward.
  test.each([
    ['Contact linkage', () => mocks.ensureContactLink.mockRejectedValueOnce(
      new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH'))],
    ['Contact resolution', () => mocks.isResolvedContact.mockReturnValueOnce(false)],
    ['reachability', () => mocks.recordReachability.mockRejectedValueOnce(
      new Error('CONTACT_REACHABILITY_BLOCKED'))],
    ['Driver linking', () => mocks.linkDriver.mockRejectedValueOnce(
      new Error('DRIVER_LINK_CONTRADICTION'))],
    ['BotUser profile', () => mocks.recordProfile.mockRejectedValueOnce(
      new Error('BOT_USER_PROFILE_BLOCKED'))],
  ])('keeps the Message when %s contradicts, and does not ask for a resend', async (
    _label,
    breakEnrichment,
  ) => {
    const admitted = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    breakEnrichment()

    const response = await POST(request())

    // Transport processing succeeded: the event was accepted and persisted.
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      processed: 'message_persisted',
      enrichment: 'blocked',
    })
    expect(mocks.createMessage).toHaveBeenCalledOnce()
    expect(mocks.botMessageCreate).toHaveBeenCalledOnce()
    expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
  })

  test('persists the Message before any person enrichment runs', async () => {
    const admitted = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })

    await POST(request())

    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resolveContact.mock.invocationCallOrder[0])
    expect(mocks.inboundWorkflow.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resolveContact.mock.invocationCallOrder[0])
  })

  test('a blocked event does not poison the next independent event', async () => {
    const admitted = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.ensureContactLink.mockRejectedValueOnce(new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH'))

    const eventA = await POST(request())
    const eventB = await POST(request({
      providerUpdateId: '1002',
      providerEventId: 'update:1002',
    }))

    expect(eventA.status).toBe(200)
    await expect(eventA.json()).resolves.toMatchObject({ enrichment: 'blocked' })
    expect(eventB.status).toBe(200)
    const bodyB = await eventB.json()
    expect(bodyB.enrichment).toBeUndefined()
    expect(mocks.createMessage).toHaveBeenCalledTimes(2)
  })

  test('a persistence failure is still a transport failure', async () => {
    const admitted = chat({})
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.createMessage.mockRejectedValue(new Error('DB_DOWN'))

    const response = await POST(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'TELEGRAM_INGRESS_PERSISTENCE_FAILED' })
    expect(mocks.resolveContact).not.toHaveBeenCalled()
  })

  test('does not confirm reachability for an outgoing bot echo', async () => {
    const created = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })

    const response = await POST(request({ direction: 'OUTGOING' }))

    expect(response.status).toBe(200)
    expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
  })

  test('does not report a successful limit-menu response when exact bot delivery fails', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.driverFindUnique.mockResolvedValue({
      id: 'driver-telegram-link',
      driverId: 'driver-1',
      phoneVerified: true,
      botState: 'IDLE',
    })
    mocks.driverUpdate.mockResolvedValue({})
    mocks.sendBotMessage.mockResolvedValue({ success: false, error: 'BOT_ACCOUNT_UNAVAILABLE' })

    const response = await POST(request({ text: '💳 Управление лимитом' }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ details: 'BOT_ACCOUNT_UNAVAILABLE' })
    expect(mocks.sendBotMessage).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Управление лимитом'),
      'driver-1',
      expect.any(Array),
    )
  })

  test('rejects a stale or conflicted mapping before entering the limit state', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.driverFindUnique.mockResolvedValue({
      id: 'driver-telegram-link',
      driverId: 'driver-1',
      phoneVerified: true,
      botState: 'IDLE',
    })
    mocks.authorizeDriverTelegram.mockRejectedValue(
      new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
    )

    const response = await POST(request({ text: '💳 Управление лимитом' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
    })
    expect(mocks.authorizeDriverTelegram).toHaveBeenCalledWith({
      driverId: 'driver-1',
      telegramId: 42n,
    })
    expect(mocks.driverUpdate).not.toHaveBeenCalled()
    expect(mocks.changeDriverLimit).not.toHaveBeenCalled()
    expect(mocks.sendBotMessage).not.toHaveBeenCalled()
  })

  test('rejects a limit mutation when current authority resolves another bot account', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.driverFindUnique.mockResolvedValue({
      id: 'driver-telegram-link',
      driverId: 'driver-1',
      phoneVerified: true,
      botState: 'IDLE',
    })
    mocks.authorizeDriverTelegram.mockResolvedValue({
      chatId: 'chat-1',
      providerAccountId: 'telegram-bot-a',
      connectionId: 'telegram-connection-b',
    })

    const response = await POST(request({ text: '💳 Управление лимитом' }))

    expect(response.status).toBe(409)
    expect(mocks.driverUpdate).not.toHaveBeenCalled()
    expect(mocks.changeDriverLimit).not.toHaveBeenCalled()
    expect(mocks.sendBotMessage).not.toHaveBeenCalled()
  })

  test('rejects a stale mapping before continuing an awaiting limit action', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.driverFindUnique.mockResolvedValue({
      id: 'driver-telegram-link',
      driverId: 'driver-1',
      phoneVerified: true,
      botState: 'AWAITING_LIMIT',
    })
    mocks.authorizeDriverTelegram.mockRejectedValue(
      new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
    )

    const response = await POST(request({ text: 'limit_20000' }))

    expect(response.status).toBe(409)
    expect(mocks.sendBotMessage).not.toHaveBeenCalled()
    expect(mocks.changeDriverLimit).not.toHaveBeenCalled()
    expect(mocks.driverUpdate).not.toHaveBeenCalled()
  })

  test('rechecks current authority immediately before the Driver and state mutations', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.driverFindUnique.mockResolvedValue({
      id: 'driver-telegram-link',
      driverId: 'driver-1',
      phoneVerified: true,
      botState: 'AWAITING_LIMIT',
    })
    mocks.changeDriverLimit.mockResolvedValue({ success: true })
    mocks.driverUpdate.mockResolvedValue({})

    const response = await POST(request({ text: 'limit_20000' }))

    expect(response.status).toBe(200)
    expect(mocks.authorizeDriverTelegram).toHaveBeenCalledTimes(3)
    expect(mocks.authorizeDriverTelegram.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.changeDriverLimit.mock.invocationCallOrder[0])
    expect(mocks.authorizeDriverTelegram.mock.invocationCallOrder[2])
      .toBeLessThan(mocks.driverUpdate.mock.invocationCallOrder[0])
    expect(mocks.changeDriverLimit).toHaveBeenCalledWith('driver-1', 20000)
    expect(mocks.driverUpdate).toHaveBeenCalledWith({
      where: { id: 'driver-telegram-link' },
      data: { botState: 'IDLE' },
    })
  })

  // Legacy compatibility must not become 'accept anything'. A row that merely
  // LACKS provenance it could never have recorded is admitted; a row that
  // CONTRADICTS the inbound event is still rejected before any mutation.
  test('admits a legacy private Chat carrying no provenance at all', async () => {
    mocks.upsertConversation.mockResolvedValue({ conversation: chat({}) })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  })

  test.each([
    ['a different conversation key', { chatKind: 'private' }, { externalChatId: 'telegram:999' }],
    ['a different channel', { chatKind: 'private' }, { channel: 'whatsapp' }],
    ['a concrete group chatType', { chatKind: 'private' }, { chatType: 'group' }],
  ])('still rejects %s before any person or message mutation', async (_label, metadata, overrides) => {
    mocks.upsertConversation.mockResolvedValue({ conversation: chat(metadata, overrides) })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expectNoPersonOrMessageMutation()
  })

})
