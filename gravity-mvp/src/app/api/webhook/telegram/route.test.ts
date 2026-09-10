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
  prepareManualDriverTelegramLinkAuthorityV1: mocks.authorizeDriverTelegram,
  recordBotUserProfileV1: mocks.recordProfile,
}))
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
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
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
    mocks.authorizeDriverTelegram.mockResolvedValue({
      chatId: 'chat-1',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
  })

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.BOT_CRM_SECRET
    else process.env.BOT_CRM_SECRET = originalSecret
  })

  test('persists the exact incoming provider account and transport on a new private Chat', async () => {
    const created = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.upsertConversation).toHaveBeenCalledWith({
      contract: 'messaging.UpsertChannelConversationCommand.v1',
      externalChatId: 'telegram:42',
      channel: 'telegram',
      name: '@driver42',
      chatType: 'private',
      metadata: {
        chatKind: 'private',
        providerAccountId: 'telegram-bot-b',
        connectionId: 'telegram-connection-b',
      },
    })
    expect(mocks.resolveContact).toHaveBeenCalledWith(
      'telegram',
      '42',
      null,
      '@driver42',
      { chatKind: 'private', providerAccountId: 'telegram-bot-b' },
    )
    expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).toHaveBeenCalledWith({
      identityId: 'identity-1',
      contactId: 'contact-1',
      channel: 'telegram',
      providerAccountId: 'telegram-bot-b',
      providerTargetId: '42',
      status: 'confirmed',
    })
    expect(mocks.botMessageCreate).toHaveBeenCalledOnce()
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'telegram:telegram-bot-b:42:update%3A1001',
      metadata: expect.objectContaining({
        providerAccountId: 'telegram-bot-b',
        connectionId: 'telegram-connection-b',
        providerPeerId: '42',
        providerEventId: 'update:1001',
        providerUpdateId: '1001',
        providerMessageId: '2001',
        callbackQueryId: null,
      }),
    }))
    expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
  })

  test.each([
    ['another provider account', {
      chatKind: 'private',
      providerAccountId: 'telegram-bot-a',
      connectionId: 'telegram-connection-a',
    }, 'TELEGRAM_PROVIDER_ACCOUNT_COLLISION', 'provider_account_mismatch'],
    ['unproven provider account', {
      chatKind: 'private',
      connectionId: 'telegram-connection-b',
    }, 'TELEGRAM_PROVIDER_ACCOUNT_UNPROVEN', 'provider_account_unproven'],
    ['another transport connection', {
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-a',
    }, 'TELEGRAM_TRANSPORT_CONNECTION_COLLISION', 'transport_connection_mismatch'],
    ['unproven transport connection', {
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
    }, 'TELEGRAM_TRANSPORT_CONNECTION_UNPROVEN', 'transport_connection_unproven'],
  ])('rejects an existing private Chat with %s before downstream mutation', async (
    _label,
    metadata,
    expectedError,
    reason,
  ) => {
    const existing = chat(metadata)
    mocks.upsertConversation.mockResolvedValue({ conversation: existing })

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: expectedError })
    expect(mocks.appendCollision).toHaveBeenCalledWith({
      chatId: 'chat-1',
      evidence: expect.objectContaining({
        channel: 'telegram',
        reason,
        incomingProviderAccountId: 'telegram-bot-b',
        incomingConnectionId: 'telegram-connection-b',
        externalChatId: 'telegram:42',
      }),
    })
    expectNoPersonOrMessageMutation()
  })

  test('marks the exact linked ContactIdentity conflicted after durable Chat evidence', async () => {
    const existing = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-a',
      connectionId: 'telegram-connection-a',
    }, {
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
      reason: 'provider_account_mismatch',
      evidenceRoot: expect.stringContaining('channel-collision:telegram:telegram:42:'),
      details: expect.objectContaining({
        incomingProviderAccountId: 'telegram-bot-b',
        existingProviderAccountId: 'telegram-bot-a',
        incomingConnectionId: 'telegram-connection-b',
        existingConnectionId: 'telegram-connection-a',
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
        externalId: 'telegram:telegram-bot-b:42:update%3A1001',
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
        externalId: 'telegram:telegram-bot-b:-10042:update%3A1001',
      },
      select: { id: true },
    })
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'telegram:telegram-bot-b:-10042:update%3A1001',
      metadata: expect.objectContaining({
        providerAccountId: 'telegram-bot-b',
        providerPeerId: '-10042',
        providerEventId: 'update:1001',
      }),
    }))
    expect(mocks.groupInboundWorkflow).toHaveBeenCalledOnce()
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.botMessageCreate).not.toHaveBeenCalled()
  })

  test('does not continue when exact Contact linkage rejects the admitted Chat', async () => {
    const admitted = chat({
      chatKind: 'private',
      providerAccountId: 'telegram-bot-b',
      connectionId: 'telegram-connection-b',
    })
    mocks.upsertConversation.mockResolvedValue({ conversation: admitted })
    mocks.patchConversation.mockResolvedValue({ conversation: admitted })
    mocks.ensureContactLink.mockRejectedValue(new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH'))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'TELEGRAM_CONTACT_BINDING_BLOCKED' })
    expect(mocks.recordProfile).not.toHaveBeenCalled()
    expect(mocks.botMessageCreate).not.toHaveBeenCalled()
    expect(mocks.createMessage).not.toHaveBeenCalled()
    expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
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
})
