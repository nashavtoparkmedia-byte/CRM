import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const WEBHOOK_SECRET = 'test-max-scraper-webhook-secret'

const mocks = vi.hoisted(() => ({
  messageFindUnique: vi.fn(),
  chatFindUnique: vi.fn(),
  chatFindMany: vi.fn(),
  patchConversation: vi.fn(),
  appendCollision: vi.fn(),
  markIdentityConflict: vi.fn(),
  createConversation: vi.fn(),
  upsertMessage: vi.fn(),
  replaceMessage: vi.fn(),
  deleteMessage: vi.fn(),
  deleteMessageMedia: vi.fn(),
  ensureContactLink: vi.fn(),
  attachMessageMedia: vi.fn(),
  shadowStart: vi.fn(),
  shadowComplete: vi.fn(),
  resolveContact: vi.fn(),
  isResolvedContact: vi.fn(),
  recordReachability: vi.fn(),
  selectSenderCandidate: vi.fn(),
  inboundWorkflow: vi.fn(),
  outboundWorkflow: vi.fn(),
  emitMessage: vi.fn(),
  broadcastMessage: vi.fn(),
  opsLog: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    message: {
      findUnique: mocks.messageFindUnique,
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    chat: {
      findUnique: mocks.chatFindUnique,
      findMany: mocks.chatFindMany,
    },
    messageAttachment: { findMany: vi.fn() },
  },
}))

vi.mock('@/modules/messaging/public/v1/persisted-message-ingress', () => ({
  publishPersistedMessageV1: mocks.emitMessage,
}))
vi.mock('@/modules/messaging/public/v1/message-stream', () => ({
  broadcastChatMessageV1: mocks.broadcastMessage,
}))
vi.mock('@/modules/messaging/public/v1/channel-conversation-workflow', () => ({
  channelConversationWorkflowV1: {
    onInboundMessage: mocks.inboundWorkflow,
    onOutboundMessage: mocks.outboundWorkflow,
  },
}))
vi.mock('@/modules/contacts/public/v1', () => ({
  startMaxContactResolutionShadowV1: mocks.shadowStart,
  markChannelIdentityConflictV1: mocks.markIdentityConflict,
  isResolvedChannelContactResultV1: mocks.isResolvedContact,
  resolveChannelContactOperationV1: mocks.resolveContact,
}))
vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
  contactReachabilityV1: {
    recordExactProviderReachability: mocks.recordReachability,
  },
}))
vi.mock('@/modules/max-channel/internal/max-contact-ingress-policy', () => ({
  selectUniqueExactMaxSenderCandidate: mocks.selectSenderCandidate,
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({
  operationalLogV1: mocks.opsLog,
}))
vi.mock('@/modules/messaging/public/v1', () => ({
  appendConversationIdentityCollisionV1: mocks.appendCollision,
  createExternalConversationV1: mocks.createConversation,
  deleteMessageMediaV1: mocks.deleteMessageMedia,
  deleteMessageV1: mocks.deleteMessage,
  ensureConversationContactLinkV1: mocks.ensureContactLink,
  patchExternalConversationV1: mocks.patchConversation,
  replaceExternalMessageV1: mocks.replaceMessage,
  upsertExternalMessageV1: mocks.upsertMessage,
}))
vi.mock('@/modules/messaging/public/v2', () => ({
  attachMessageMediaV2: mocks.attachMessageMedia,
}))

import { POST } from './route'

function request(
  overrides: Record<string, unknown> = {},
  webhookSecret: string | null = WEBHOOK_SECRET,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (webhookSecret !== null) headers['X-Max-Scraper-Webhook-Secret'] = webhookSecret
  return new Request('https://crm.example/api/webhooks/max', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      accountId: 'max-account-b',
      externalId: 'max-message-1',
      chatId: 'max-conversation-900',
      senderId: 'max-sender-42',
      senderName: 'MAX User',
      text: 'hello',
      chatKind: 'private',
      ...overrides,
    }),
  })
}

function existingChat(metadata: Record<string, unknown>) {
  return {
    id: 'chat-1',
    channel: 'max',
    externalChatId: 'max-conversation-900',
    name: 'MAX User',
    contactId: 'contact-a',
    contactIdentityId: 'identity-a',
    driverId: null,
    metadata,
  }
}

function expectNoInboundMutation() {
  expect(mocks.chatFindMany).not.toHaveBeenCalled()
  expect(mocks.createConversation).not.toHaveBeenCalled()
  expect(mocks.upsertMessage).not.toHaveBeenCalled()
  expect(mocks.replaceMessage).not.toHaveBeenCalled()
  expect(mocks.ensureContactLink).not.toHaveBeenCalled()
  expect(mocks.resolveContact).not.toHaveBeenCalled()
  expect(mocks.recordReachability).not.toHaveBeenCalled()
  expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
  expect(mocks.outboundWorkflow).not.toHaveBeenCalled()
}

function expectCollisionEvidence(reason: string) {
  expect(mocks.appendCollision).toHaveBeenCalledOnce()
  expect(mocks.appendCollision).toHaveBeenCalledWith({
    chatId: 'chat-1',
    evidence: expect.objectContaining({
      channel: 'max',
      reason,
      incomingProviderAccountId: 'max-account-b',
      externalChatId: 'max-conversation-900',
    }),
  })
}

describe('MAX webhook provider-account admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('MAX_SCRAPER_WEBHOOK_SECRET', WEBHOOK_SECRET)
    mocks.messageFindUnique.mockResolvedValue(null)
    mocks.shadowStart.mockResolvedValue({
      session: { complete: mocks.shadowComplete },
    })
    mocks.shadowComplete.mockResolvedValue(undefined)
    mocks.emitMessage.mockResolvedValue(undefined)
    mocks.appendCollision.mockResolvedValue(undefined)
    mocks.markIdentityConflict.mockResolvedValue(undefined)
    mocks.isResolvedContact.mockReturnValue(false)
    mocks.recordReachability.mockResolvedValue({
      outcome: 'updated',
      identityId: 'identity-b',
      status: 'confirmed',
    })
    mocks.selectSenderCandidate.mockReturnValue({ status: 'none', candidateCount: 0 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test.each([
    ['missing header', null],
    ['wrong header', 'wrong-secret'],
  ])('rejects %s before any read or mutation', async (_label, secret) => {
    const response = await POST(request({}, secret))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SCRAPER_WEBHOOK_UNAUTHORIZED' })
    expect(mocks.shadowStart).not.toHaveBeenCalled()
    expect(mocks.chatFindUnique).not.toHaveBeenCalled()
    expect(mocks.messageFindUnique).not.toHaveBeenCalled()
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expect(mocks.patchConversation).not.toHaveBeenCalled()
    expect(mocks.deleteMessageMedia).not.toHaveBeenCalled()
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
    expect(mocks.attachMessageMedia).not.toHaveBeenCalled()
    expect(mocks.emitMessage).not.toHaveBeenCalled()
    expect(mocks.broadcastMessage).not.toHaveBeenCalled()
    expectNoInboundMutation()
  })

  test('fails closed when the webhook secret is not configured', async () => {
    vi.stubEnv('MAX_SCRAPER_WEBHOOK_SECRET', '')

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(mocks.shadowStart).not.toHaveBeenCalled()
    expect(mocks.chatFindUnique).not.toHaveBeenCalled()
    expect(mocks.patchConversation).not.toHaveBeenCalled()
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
    expectNoInboundMutation()
  })

  test.each([
    ['missing', undefined],
    ['blank', '   '],
    ['legacy', 'legacy'],
    ['default placeholder', 'max-default'],
  ])('rejects a %s incoming provider account before shadow/read/mutation', async (_label, accountId) => {
    const response = await POST(request({ accountId }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expect(mocks.shadowStart).not.toHaveBeenCalled()
    expect(mocks.chatFindUnique).not.toHaveBeenCalled()
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expectNoInboundMutation()
  })

  test('rejects a live-shaped Chat owned by another concrete MAX account before mutation', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'max-sender-42',
      providerAccountId: 'max-account-a',
      connectionId: 'max_scraper',
    }))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expect(mocks.shadowComplete).toHaveBeenCalledWith({
      status: 'no_contact',
      reason: 'provider_account_mismatch',
    })
    expectCollisionEvidence('provider_account_mismatch')
    expect(mocks.appendCollision.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.markIdentityConflict.mock.invocationCallOrder[0])
    expect(mocks.markIdentityConflict).toHaveBeenCalledWith({
      contactId: 'contact-a',
      identityId: 'identity-a',
      channel: 'max',
      reason: 'provider_account_mismatch',
      evidenceRoot: expect.stringContaining('channel-collision:max:'),
      details: expect.objectContaining({
        incomingProviderAccountId: 'max-account-b',
        existingProviderAccountId: 'max-account-a',
      }),
    })
    expectNoInboundMutation()
  })

  test('forwards repeated collision evidence to the atomic bounded Messaging audit', async () => {
    const duplicateEvidence = {
      channel: 'max',
      reason: 'provider_account_mismatch',
      incomingProviderAccountId: 'max-account-b',
      existingProviderAccountId: 'max-account-a',
      incomingSenderId: 'max-sender-42',
      existingSenderId: 'max-sender-42',
      incomingChatKind: 'private',
      existingChatKind: 'unknown',
      hasPersonOwnership: true,
      externalChatId: 'max-conversation-900',
      observedAt: '2026-01-01T00:00:00.000Z',
    }
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'max-sender-42',
      providerAccountId: 'max-account-a',
      connectionId: 'max_scraper',
      channelIdentityCollisionAudit: [
        ...Array.from({ length: 22 }, (_, index) => ({
          channel: 'max',
          reason: `prior-collision-${index}`,
          observedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        })),
        duplicateEvidence,
      ],
    }))

    const response = await POST(request())

    expect(response.status).toBe(409)
    expectCollisionEvidence('provider_account_mismatch')
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        existingProviderAccountId: 'max-account-a',
        existingExternalChatId: 'max-conversation-900',
      }),
    }))
    expectNoInboundMutation()
  })

  test.each([
    ['missing', {}],
    ['legacy', { providerAccountId: 'legacy' }],
  ])('does not auto-claim an identity-linked Chat with %s account evidence', async (
    _label,
    metadata,
  ) => {
    mocks.chatFindUnique.mockResolvedValue(existingChat(metadata))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expect(mocks.shadowComplete).toHaveBeenCalledWith({
      status: 'no_contact',
      reason: 'provider_account_unproven',
    })
    expectCollisionEvidence('provider_account_unproven')
    expectNoInboundMutation()
  })

  test('does not claim an unlinked legacy Chat whose provider account is absent', async () => {
    mocks.chatFindUnique.mockResolvedValue({
      ...existingChat({ legacyMarker: true }),
      contactId: null,
      contactIdentityId: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expect(mocks.shadowComplete).toHaveBeenCalledWith({
      status: 'no_contact',
      reason: 'provider_account_unproven',
    })
    expectCollisionEvidence('provider_account_unproven')
    expectNoInboundMutation()
  })

  test('rejects a private Chat whose stored sender belongs to another identity', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'other-max-sender',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    }))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_COLLISION' })
    expect(mocks.shadowComplete).toHaveBeenCalledWith({
      status: 'no_contact',
      reason: 'sender_identity_mismatch',
    })
    expectCollisionEvidence('sender_identity_mismatch')
    expectNoInboundMutation()
  })

  test('rejects an identity-linked private Chat whose sender alias is missing', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    }))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_UNPROVEN' })
    expect(mocks.shadowComplete).toHaveBeenCalledWith({
      status: 'no_contact',
      reason: 'sender_identity_unproven',
    })
    expectCollisionEvidence('sender_identity_unproven')
    expectNoInboundMutation()
  })

  test('does not claim an unlinked private Chat whose stored sender proof is missing', async () => {
    mocks.chatFindUnique.mockResolvedValue({
      ...existingChat({
        chatKind: 'private',
        providerAccountId: 'max-account-b',
        connectionId: 'max_scraper',
      }),
      contactId: null,
      contactIdentityId: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_UNPROVEN' })
    expectCollisionEvidence('sender_identity_unproven')
    expectNoInboundMutation()
  })

  test.each([
    ['stored private kind', {
      chat: {
        ...existingChat({
          senderId: 'max-sender-42',
          chatKind: 'private',
          providerAccountId: 'max-account-b',
          connectionId: 'max_scraper',
        }),
        contactId: null,
        contactIdentityId: null,
      },
      expectedStoredKind: 'private',
      expectedOwnership: false,
    }],
    ['existing Contact ownership', {
      chat: {
        ...existingChat({
          senderId: 'max-sender-42',
          chatKind: 'group',
          providerAccountId: 'max-account-b',
          connectionId: 'max_scraper',
        }),
        contactIdentityId: null,
      },
      expectedStoredKind: 'group',
      expectedOwnership: true,
    }],
  ])('rejects an incoming group event that contradicts %s', async (
    _label,
    { chat, expectedStoredKind, expectedOwnership },
  ) => {
    mocks.chatFindUnique.mockResolvedValue(chat)

    const response = await POST(request({ chatKind: 'group' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_CHAT_KIND_COLLISION' })
    expectCollisionEvidence('chat_kind_mismatch')
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        incomingChatKind: 'group',
        existingChatKind: expectedStoredKind,
        hasPersonOwnership: expectedOwnership,
      }),
    }))
    expectNoInboundMutation()
  })

  test('rejects an incoming private event that attempts to reuse a concrete group Chat', async () => {
    mocks.chatFindUnique.mockResolvedValue({
      ...existingChat({
        chatKind: 'group',
        providerAccountId: 'max-account-b',
        connectionId: 'max_scraper',
      }),
      contactId: null,
      contactIdentityId: null,
    })

    const response = await POST(request({ chatKind: 'private' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_CHAT_KIND_COLLISION' })
    expectCollisionEvidence('chat_kind_mismatch')
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        incomingChatKind: 'private',
        existingChatKind: 'group',
      }),
    }))
    expectNoInboundMutation()
  })

  test('does not delete a globally keyed message owned by another MAX account', async () => {
    const owningChat = existingChat({
      senderId: 'max-sender-42',
      chatKind: 'private',
      providerAccountId: 'max-account-a',
      connectionId: 'max_scraper',
    })
    mocks.chatFindUnique.mockResolvedValueOnce(null)
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-account-a',
      chatId: owningChat.id,
      direction: 'inbound',
      metadata: { senderId: 'max-sender-42' },
      chat: owningChat,
    })

    const response = await POST(request({ deleted: true, text: null }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expectCollisionEvidence('provider_account_mismatch')
    expect(mocks.deleteMessageMedia).not.toHaveBeenCalled()
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
    expect(mocks.broadcastMessage).not.toHaveBeenCalled()
  })

  test('deletes only after the stored Message sender and exact Chat account are proven', async () => {
    const owningChat = existingChat({
      senderId: 'max-sender-42',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    })
    const storedMessage = {
      id: 'message-account-b',
      chatId: owningChat.id,
      direction: 'inbound',
      metadata: { senderId: 'max-sender-42' },
      chat: owningChat,
    }
    mocks.chatFindUnique.mockResolvedValueOnce(owningChat)
    mocks.messageFindUnique.mockResolvedValue(storedMessage)

    const response = await POST(request({
      deleted: true,
      text: null,
      senderId: null,
    }))

    expect(response.status).toBe(200)
    expect(mocks.deleteMessageMedia).toHaveBeenCalledWith({
      contract: 'messaging.DeleteMessageMediaCommand.v1',
      messageId: storedMessage.id,
    })
    expect(mocks.deleteMessage).toHaveBeenCalledWith({
      contract: 'messaging.DeleteMessageCommand.v1',
      messageId: storedMessage.id,
    })
    expect(mocks.broadcastMessage).toHaveBeenCalledWith(
      owningChat.id,
      expect.objectContaining({ id: storedMessage.id, deleted: true }),
    )
    expect(mocks.patchConversation).not.toHaveBeenCalled()
  })

  test('does not dedupe a provider message id against another account-scoped Chat', async () => {
    const owningChat = {
      ...existingChat({
        senderId: 'max-sender-42',
        chatKind: 'private',
        providerAccountId: 'max-account-a',
        connectionId: 'max_scraper',
      }),
      externalChatId: 'max-conversation-other',
    }
    mocks.chatFindUnique.mockResolvedValueOnce(null)
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-account-a',
      chatId: owningChat.id,
      chat: owningChat,
    })

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_MESSAGE_IDENTITY_COLLISION' })
    expectCollisionEvidence('message_chat_mismatch')
    expect(mocks.createConversation).not.toHaveBeenCalled()
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
    expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
  })

  test('rejects an upsert race that resolves the global message id to another Chat', async () => {
    const admittedChat = existingChat({
      senderId: 'peer-sender',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    })
    const owningChat = {
      ...existingChat({
        senderId: 'other-peer',
        chatKind: 'private',
        providerAccountId: 'max-account-a',
        connectionId: 'max_scraper',
      }),
      id: 'chat-owner',
      externalChatId: 'max-conversation-other',
    }
    mocks.chatFindUnique
      .mockResolvedValueOnce(admittedChat)
      .mockResolvedValueOnce(owningChat)
    mocks.patchConversation.mockResolvedValue({ conversation: admittedChat })
    mocks.upsertMessage.mockResolvedValue({
      message: { id: 'message-account-a', chatId: owningChat.id },
    })

    const response = await POST(request({
      isOutgoing: true,
      senderId: 'account-user',
      senderName: 'CRM Operator',
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_MESSAGE_IDENTITY_COLLISION' })
    expect(mocks.appendCollision).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: 'chat-owner',
      evidence: expect.objectContaining({
        reason: 'message_chat_mismatch',
        incomingProviderAccountId: 'max-account-b',
        existingProviderAccountId: 'max-account-a',
      }),
    }))
    expect(mocks.outboundWorkflow).not.toHaveBeenCalled()
  })

  test('confirms exact reachability once after an accepted private inbound Contact link', async () => {
    const chat = existingChat({
      senderId: 'max-sender-42',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    })
    mocks.chatFindUnique.mockResolvedValue(chat)
    mocks.chatFindMany.mockResolvedValue([])
    mocks.patchConversation.mockResolvedValue({ conversation: chat })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-in-1', chatId: chat.id } })
    mocks.resolveContact.mockResolvedValue({
      status: 'identity_reused',
      isNew: false,
      contact: { id: 'contact-b' },
      identity: { id: 'identity-b' },
    })
    mocks.isResolvedContact.mockReturnValue(true)

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).toHaveBeenCalledWith({
      identityId: 'identity-b',
      contactId: 'contact-b',
      channel: 'max',
      providerAccountId: 'max-account-b',
      providerTargetId: 'max-sender-42',
      status: 'confirmed',
    })
    expect(mocks.ensureContactLink.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.recordReachability.mock.invocationCallOrder[0])
  })

  test('does not confirm reachability for history even after exact private linkage', async () => {
    const chat = existingChat({
      senderId: 'max-sender-42',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    })
    mocks.chatFindUnique.mockResolvedValue(chat)
    mocks.chatFindMany.mockResolvedValue([])
    mocks.patchConversation.mockResolvedValue({ conversation: chat })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-history-1', chatId: chat.id } })
    mocks.resolveContact.mockResolvedValue({
      status: 'identity_reused',
      isNew: false,
      contact: { id: 'contact-b' },
      identity: { id: 'identity-b' },
    })
    mocks.isResolvedContact.mockReturnValue(true)

    const response = await POST(request({ source: 'history' }))

    expect(response.status).toBe(200)
    expect(mocks.ensureContactLink).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
  })

  test('does not confirm reachability for an ambiguous exact-sender lookup', async () => {
    const chat = existingChat({
      senderId: 'max-sender-42',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    })
    mocks.chatFindUnique.mockResolvedValue(chat)
    mocks.chatFindMany.mockResolvedValue([chat, { ...chat, id: 'chat-2' }])
    mocks.selectSenderCandidate.mockReturnValue({ status: 'ambiguous', candidateCount: 2 })
    mocks.patchConversation.mockResolvedValue({ conversation: chat })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-in-2', chatId: chat.id } })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
  })

  test('does not confirm reachability for an accepted group message', async () => {
    const chat = {
      ...existingChat({
        senderId: 'max-sender-42',
        chatKind: 'group',
        providerAccountId: 'max-account-b',
        connectionId: 'max_scraper',
      }),
      contactId: null,
      contactIdentityId: null,
    }
    mocks.chatFindUnique.mockResolvedValue(null)
    mocks.chatFindMany.mockResolvedValue([])
    mocks.createConversation.mockResolvedValue({ conversation: chat })
    mocks.patchConversation.mockResolvedValue({ conversation: chat })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-group-1', chatId: chat.id } })

    const response = await POST(request({ chatKind: 'group' }))

    expect(response.status).toBe(200)
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
  })

  test('preserves an existing peer identity when an outgoing echo names the account user', async () => {
    const chat = existingChat({
      senderId: 'peer-sender',
      phone: '+79990001122',
      chatKind: 'private',
      providerAccountId: 'max-account-b',
      connectionId: 'max_scraper',
    })
    mocks.chatFindUnique.mockResolvedValue(chat)
    mocks.patchConversation.mockResolvedValue({ conversation: chat })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-out-1', chatId: 'chat-1' } })

    const response = await POST(request({
      isOutgoing: true,
      senderId: 'account-user',
      senderName: 'CRM Operator',
      senderPhone: '+70000000000',
    }))

    expect(response.status).toBe(200)
    expect(mocks.chatFindMany).not.toHaveBeenCalled()
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
    expect(mocks.shadowStart).toHaveBeenCalledWith(expect.objectContaining({
      resolutionInput: expect.objectContaining({
        externalUserId: null,
        channelDisplayName: null,
        normalizedPhone: null,
        phoneEvidence: null,
      }),
      isOutgoing: true,
    }))
    const firstPatch = mocks.patchConversation.mock.calls[0][0].patch
    expect(firstPatch.name).toBeUndefined()
    expect(firstPatch.metadata).toBeUndefined()
    expect(JSON.stringify(mocks.patchConversation.mock.calls)).not.toContain('account-user')
    expect(JSON.stringify(mocks.patchConversation.mock.calls)).not.toContain('CRM Operator')
    expect(JSON.stringify(mocks.patchConversation.mock.calls)).not.toContain('+70000000000')
    expect(mocks.outboundWorkflow).toHaveBeenCalledOnce()
  })

  test('creates an outgoing-only Chat without seeding account-user data as peer identity', async () => {
    const created = {
      ...existingChat({
        chatKind: 'private',
        providerAccountId: 'max-account-b',
        connectionId: 'max_scraper',
      }),
      contactId: null,
      contactIdentityId: null,
      name: 'MAX:max-conversation-900',
    }
    mocks.chatFindUnique.mockResolvedValue(null)
    mocks.createConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-out-2', chatId: 'chat-1' } })

    const response = await POST(request({
      isOutgoing: true,
      senderId: 'account-user',
      senderName: 'CRM Operator',
      senderPhone: '+70000000000',
    }))

    expect(response.status).toBe(200)
    expect(mocks.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'MAX:max-conversation-900',
      metadata: {
        rawExternalChatId: 'max-conversation-900',
        chatKind: 'private',
        providerAccountId: 'max-account-b',
        connectionId: 'max_scraper',
      },
    }))
    expect(JSON.stringify(mocks.createConversation.mock.calls)).not.toContain('account-user')
    expect(JSON.stringify(mocks.createConversation.mock.calls)).not.toContain('CRM Operator')
    expect(JSON.stringify(mocks.createConversation.mock.calls)).not.toContain('+70000000000')
    expect(mocks.chatFindMany).not.toHaveBeenCalled()
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
  })
})
