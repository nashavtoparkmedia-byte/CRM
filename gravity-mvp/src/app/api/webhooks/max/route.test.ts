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
  prepareIdentity: vi.fn(),
  resolvePeerIdentity: vi.fn(),
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
  prepareContactConversationIdentityV1: mocks.prepareIdentity,
  resolveInboundConversationPeerIdentityV1: mocks.resolvePeerIdentity,
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

// ---------------------------------------------------------------------------
// DOM-fallback inbound (production failure 2026-09-22 11:44:50Z).
//
// The provider push lost its message object, so the scraper recovered the text from
// the page and forwarded it without a provider senderId. Such an event may inherit the
// peer of the exact, already proven private conversation it names — only when the
// scraper attests it read that conversation's page and every independent MAX invariant
// names that same peer. The chat id and route below are C4's, from MAX_CHAT_ID_ALIASES.
// ---------------------------------------------------------------------------
const DOM_ACCOUNT = '902100000248'
const DOM_CHAT = '902454841098'
const DOM_ROUTE = '511708938'
const DOM_PEER = '902200000154'
// Production topology: one Contact holds three active MAX identities - a phone-shaped one,
// one whose externalId is the conversation key (which the Chat is linked to), and the peer
// who actually speaks. fb9fb30d assumed the linked identity was the peer and fail-closed.
const DOM_PHONE_IDENTITY = 'identity-phone'
const DOM_CHATKEY_IDENTITY = 'identity-chatkey'
const DOM_PEER_IDENTITY = 'identity-peer'
const DOM_EXTERNAL_ID = `max-dom-${DOM_CHAT}-7ef524501d31775e`

function attestedRoute(overrides: Record<string, unknown> = {}) {
  return { uiRouteId: DOM_ROUTE, source: 'static_override', extraction: 'message_element', verified: true, ...overrides }
}

function domRequest(overrides: Record<string, unknown> = {}, omit: string[] = []) {
  const body: Record<string, unknown> = {
    accountId: DOM_ACCOUNT,
    externalId: DOM_EXTERNAL_ID,
    chatId: DOM_CHAT,
    rawChatId: DOM_CHAT,
    text: 'A2-0922-K7Q3',
    timestamp: Date.now() - 1_000,
    messageType: 'text',
    attachments: [],
    isOutgoing: false,
    source: 'dom_fallback',
    chatKind: 'private',
    domRoute: attestedRoute(),
    ...overrides,
  }
  for (const key of omit) delete body[key]
  return new Request('https://crm.example/api/webhooks/max', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Max-Scraper-Webhook-Secret': WEBHOOK_SECRET },
    body: JSON.stringify(body),
  })
}

function provenPrivateChat(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  return {
    id: 'chat-c4',
    channel: 'max',
    externalChatId: DOM_CHAT,
    chatType: 'private',
    name: 'User A',
    contactId: 'contact-c4',
    contactIdentityId: DOM_CHATKEY_IDENTITY,
    driverId: null,
    metadata: {
      senderId: DOM_PEER,
      chatKind: 'private',
      providerAccountId: DOM_ACCOUNT,
      connectionId: 'max_scraper',
      rawExternalChatId: DOM_CHAT,
      contactResolution: { status: 'identity_reused', candidateCount: 1, automaticLinkPerformed: true },
      ...metadata,
    },
    ...overrides,
  }
}

function readyPeerIdentity(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    contact: { id: 'contact-c4', displayName: 'User A' },
    peerIdentity: {
      kind: 'inbound_peer_identity',
      id: DOM_PEER_IDENTITY,
      channel: 'max',
      externalId: DOM_PEER,
      providerAccountId: null,
      ...overrides,
    },
  }
}

describe('MAX webhook DOM-fallback peer binding', () => {
  let chat: ReturnType<typeof provenPrivateChat>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('MAX_SCRAPER_WEBHOOK_SECRET', WEBHOOK_SECRET)
    chat = provenPrivateChat()
    mocks.messageFindUnique.mockResolvedValue(null)
    mocks.shadowStart.mockResolvedValue({ session: { complete: mocks.shadowComplete } })
    mocks.shadowComplete.mockResolvedValue(undefined)
    mocks.emitMessage.mockResolvedValue(undefined)
    mocks.appendCollision.mockResolvedValue(undefined)
    mocks.markIdentityConflict.mockResolvedValue(undefined)
    mocks.chatFindUnique.mockImplementation(async () => chat)
    mocks.chatFindMany.mockImplementation(async () => [chat])
    mocks.resolvePeerIdentity.mockResolvedValue(readyPeerIdentity())
    mocks.selectSenderCandidate.mockReturnValue({ status: 'none', candidateCount: 0 })
    mocks.patchConversation.mockImplementation(async () => ({ conversation: chat }))
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-dom-1', chatId: 'chat-c4' } })
    mocks.resolveContact.mockResolvedValue({
      status: 'identity_reused',
      isNew: false,
      contact: { id: 'contact-c4' },
      identity: { id: 'identity-c4' },
    })
    mocks.isResolvedContact.mockReturnValue(true)
    mocks.recordReachability.mockResolvedValue({ outcome: 'updated', identityId: 'identity-c4', status: 'confirmed' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function expectNoDomMessage() {
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
    expect(mocks.replaceMessage).not.toHaveBeenCalled()
    expect(mocks.inboundWorkflow).not.toHaveBeenCalled()
    expect(mocks.emitMessage).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
  }

  async function expectUnproven(response: Response) {
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_UNPROVEN' })
    expect(mocks.appendCollision).toHaveBeenCalledOnce()
    expect(mocks.appendCollision.mock.calls[0][0].evidence).toMatchObject({
      reason: 'sender_identity_unproven',
      incomingSenderId: null,
    })
    expectNoDomMessage()
  }

  async function expectBound(response: Response) {
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, chatInternalId: 'chat-c4', messageId: 'message-dom-1' })
    expect(mocks.upsertMessage).toHaveBeenCalledOnce()
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  }

  test('accepts the exact production DOM-fallback event once on the proven private conversation', async () => {
    await expectBound(await POST(domRequest()))

    expect(mocks.resolvePeerIdentity).toHaveBeenCalledOnce()
    expect(mocks.resolvePeerIdentity).toHaveBeenCalledWith({
      contract: 'contacts.ResolveInboundConversationPeerIdentityQuery.v1',
      contactId: 'contact-c4',
      channel: 'max',
      // the peer is resolved by its own external id, NOT by the conversation's linked identity
      peerExternalId: DOM_PEER,
      linkedIdentityId: DOM_CHATKEY_IDENTITY,
    })
    // unfiltered by provider account, so an unstamped legacy claimant cannot hide
    expect(mocks.chatFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        channel: 'max',
        metadata: { path: ['senderId'], equals: DOM_PEER },
      },
    }))
    expect(mocks.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-c4',
      direction: 'inbound',
      externalId: DOM_EXTERNAL_ID,
      content: 'A2-0922-K7Q3',
      metadata: expect.objectContaining({
        senderId: DOM_PEER,
        senderIdProof: 'bound_private_conversation',
        source: 'dom_fallback',
        maxChatId: DOM_CHAT,
      }),
    }))
    // The conversation already names its person: no new resolution, link or reachability.
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
    expect(mocks.selectSenderCandidate).not.toHaveBeenCalled()
    // The Chat patch keeps only activity; payload phone/name never reach it.
    expect(mocks.patchConversation.mock.calls[0][0].patch).not.toHaveProperty('metadata')
    expect(mocks.patchConversation.mock.calls[0][0].patch).not.toHaveProperty('name')
    expect(mocks.patchConversation).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: { metadata: expect.objectContaining({ contactResolution: { status: 'bound_conversation_reused', candidateCount: 1, automaticLinkPerformed: false } }) },
    }))
    expect(mocks.shadowComplete).toHaveBeenCalledWith({ status: 'contact_reused', contactId: 'contact-c4', source: 'identity' })
    expect(mocks.inboundWorkflow).toHaveBeenCalledOnce()
  })

  test('ignores payload phone and name on an accepted DOM-fallback event', async () => {
    chat = provenPrivateChat({ name: 'MAX:902200000154' })
    await expectBound(await POST(domRequest({ phone: '+79990000000', senderPhone: '+79990000000', senderName: 'Cached Name' })))
    expect(mocks.patchConversation.mock.calls[0][0].patch).toEqual({ lastMessageAt: expect.any(Date) })
  })

  test('replays the same DOM-fallback event as a duplicate of the stored message', async () => {
    mocks.messageFindUnique.mockResolvedValue({ id: 'message-dom-1', chatId: 'chat-c4', externalId: DOM_EXTERNAL_ID, chat })

    const response = await POST(domRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, chatInternalId: 'chat-c4', messageId: 'message-dom-1', deduped: true })
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  })

  test('binds a protocol-route DOM read only to the same canonical chat id', async () => {
    chat = provenPrivateChat({ externalChatId: '902400000777' }, { rawExternalChatId: '902400000777' })
    const event = { chatId: '902400000777', rawChatId: '902400000777', externalId: 'max-dom-902400000777-7ef524501d31775e' }
    await expectBound(await POST(domRequest({ ...event, domRoute: attestedRoute({ uiRouteId: '902400000777', source: 'protocol_chat_id' }) })))
  })

  test('binds a participant-route DOM read only when the route is the proven peer', async () => {
    chat = provenPrivateChat({ externalChatId: '902400000777' }, { rawExternalChatId: '902400000777' })
    const event = { chatId: '902400000777', rawChatId: '902400000777', externalId: 'max-dom-902400000777-7ef524501d31775e' }
    await expectBound(await POST(domRequest({ ...event, domRoute: attestedRoute({ uiRouteId: DOM_PEER, source: 'dialog_participant' }) })))
  })

  test('ignores a group conversation that happens to store the same sender', async () => {
    mocks.chatFindMany.mockImplementation(async () => [chat, provenPrivateChat({ id: 'chat-group', externalChatId: '902400000555' }, { chatKind: 'group' })])
    await expectBound(await POST(domRequest()))
  })

  test.each([
    ['no attestation', { domRoute: undefined }],
    ['attestation not verified', { domRoute: attestedRoute({ verified: false }) }],
    ['verified is a string', { domRoute: attestedRoute({ verified: 'true' }) }],
    ['heuristic text row', { domRoute: attestedRoute({ extraction: 'generic_text_rows' }) }],
    ['unknown route source', { domRoute: attestedRoute({ source: 'guessed' }) }],
    ['static route that Gravity does not map to this chat', { domRoute: attestedRoute({ uiRouteId: '201482140' }) }],
    ['static route with a prototype key', { domRoute: attestedRoute({ uiRouteId: 'constructor' }) }],
    ['non-numeric route', { domRoute: attestedRoute({ uiRouteId: '51170893x' }) }],
    ['protocol route of another chat', { domRoute: attestedRoute({ uiRouteId: '902400000777', source: 'protocol_chat_id' }) }],
    ['participant route that is not the proven peer', { domRoute: attestedRoute({ uiRouteId: '902200000999', source: 'dialog_participant' }) }],
    ['attestation is an array', { domRoute: [attestedRoute()] }],
    ['attestation is a string', { domRoute: 'verified' }],
    ['attestation is null', { domRoute: null }],
  ])('rejects without a verified page binding: %s', async (_label, event) => {
    await expectUnproven(await POST(domRequest(event)))
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
  })

  test('keeps rejecting a DOM-fallback event when the provider account is absent from the payload', async () => {
    const response = await POST(domRequest({}, ['accountId']))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('keeps rejecting a DOM-fallback event on a Chat whose provider account was never proven', async () => {
    chat = provenPrivateChat({}, { providerAccountId: undefined })
    const response = await POST(domRequest())
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('rejects a DOM-fallback event carried by another provider account', async () => {
    const response = await POST(domRequest({ accountId: '902100000999' }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('rejects when the Contact identity carries a different concrete provider account', async () => {
    mocks.resolvePeerIdentity.mockResolvedValue(readyPeerIdentity({ providerAccountId: '902100000999' }))
    await expectUnproven(await POST(domRequest()))
  })

  test('rejects a DOM-fallback event that claims a group conversation', async () => {
    const response = await POST(domRequest({ chatKind: 'group' }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_CHAT_KIND_COLLISION' })
    expectNoDomMessage()
  })

  test.each([
    ['incoming kind unknown', { chatKind: 'unknown' }, {}, {}, []],
    ['incoming kind missing', {}, {}, {}, ['chatKind']],
    ['stored kind missing', {}, { chatKind: undefined }, {}, []],
    ['stored kind group on a person-owned Chat', { chatKind: 'group' }, { chatKind: 'group' }, {}, []],
    ['Chat column is not private', {}, {}, { chatType: 'group' }, []],
  ])('rejects without proof when %s', async (_label, event, storedMetadata, chatColumns, omit) => {
    chat = provenPrivateChat(chatColumns, storedMetadata)
    const response = await POST(domRequest(event, omit as string[]))
    expect(response.status).toBe(409)
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).toHaveBeenCalled()
  })

  test('rejects when a second private Chat on the same account claims the same peer', async () => {
    mocks.chatFindMany.mockImplementation(async () => [chat, provenPrivateChat({ id: 'chat-other', externalChatId: '902400000777' })])
    await expectUnproven(await POST(domRequest()))
  })

  test('accepts the exact production topology: chat linked to the chat-key identity, peer in a sibling identity', async () => {
    // Contact holds three active MAX identities: phone, chat-key (which the Chat links to)
    // and the peer. This is the shape that made fb9fb30d fail production with identity_peer.
    chat = provenPrivateChat({ contactIdentityId: DOM_CHATKEY_IDENTITY })
    mocks.resolvePeerIdentity.mockResolvedValue(readyPeerIdentity())

    const response = await POST(domRequest())

    expect(response.status).toBe(200)
    // resolved by the peer's own external id, with the linked chat-key identity passed through
    expect(mocks.resolvePeerIdentity).toHaveBeenCalledOnce()
    expect(mocks.resolvePeerIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-c4',
      peerExternalId: DOM_PEER,
      linkedIdentityId: DOM_CHATKEY_IDENTITY,
    }))
    // exactly one Message, on the existing Chat, carrying the proven peer
    expect(mocks.upsertMessage).toHaveBeenCalledOnce()
    expect(mocks.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-c4',
      metadata: expect.objectContaining({ senderId: DOM_PEER, senderIdProof: 'bound_private_conversation' }),
    }))
    // no identity created, no Chat rebinding, no conflict, no collision audit
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expect(mocks.createConversation).not.toHaveBeenCalled()
    for (const call of mocks.patchConversation.mock.calls) {
      expect(call[0]).not.toHaveProperty('contactId')
      expect(call[0]).not.toHaveProperty('contactIdentityId')
    }
  })

  test('replays the production-topology event exactly once', async () => {
    mocks.resolvePeerIdentity.mockResolvedValue(readyPeerIdentity())
    const first = await POST(domRequest())
    expect(first.status).toBe(200)

    // the stored message now exists and carries the proven peer
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-dom-1',
      chatId: 'chat-c4',
      direction: 'inbound',
      metadata: { senderId: DOM_PEER, senderIdProof: 'bound_private_conversation' },
      chat,
    })
    mocks.upsertMessage.mockClear()
    mocks.appendCollision.mockClear()
    mocks.markIdentityConflict.mockClear()

    const replay = await POST(domRequest())

    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ deduped: true, messageId: 'message-dom-1' })
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  })

  test('a replay whose peer can no longer be proven still dedupes without writing a conflict', async () => {
    // the exact regression the hoisted duplicate branch exists for: Contacts state moved
    // after the message was stored, so the proof now fails - the replay must still dedupe.
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-dom-1',
      chatId: 'chat-c4',
      direction: 'inbound',
      metadata: { senderId: DOM_PEER, senderIdProof: 'bound_private_conversation' },
      chat,
    })
    mocks.resolvePeerIdentity.mockResolvedValue({ status: 'peer_identity_conflicted' })

    const replay = await POST(domRequest())

    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ deduped: true })
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
  })

  test('a stored duplicate carrying no senderId still dedupes instead of failing closed', async () => {
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-dom-legacy',
      chatId: 'chat-c4',
      direction: 'inbound',
      metadata: {},
      chat,
    })

    const replay = await POST(domRequest())

    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ deduped: true })
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  })

  test.each([
    ['no identity of this Contact carries the stored peer', { status: 'peer_identity_not_found' }],
    ['the peer identity belongs to another Contact', { status: 'peer_identity_not_found' }],
    ['Contact is archived or missing', { status: 'contact_not_found' }],
    ['the peer identity has an open conflict', { status: 'peer_identity_conflicted' }],
    ["the Chat's linked identity is missing, inactive or foreign", { status: 'linked_identity_not_found' }],
    ['resolved Contact differs from the Chat', { ...readyPeerIdentity(), contact: { id: 'contact-other', displayName: 'X' } }],
    ['the peer identity names another peer', readyPeerIdentity({ externalId: '902200000999' })],
    ['the peer identity is not MAX', readyPeerIdentity({ channel: 'telegram' })],
    ['the peer identity is stamped for another provider account', readyPeerIdentity({ providerAccountId: '902100000999' })],
  ])('rejects when %s', async (_label, resolved) => {
    mocks.resolvePeerIdentity.mockResolvedValue(resolved)
    await expectUnproven(await POST(domRequest()))
  })

  test('fails without writing any collision or conflict when the Contacts lookup throws', async () => {
    mocks.resolvePeerIdentity.mockRejectedValue(new Error('CONTACT_OWNERSHIP_BUSY'))
    const response = await POST(domRequest())
    expect(response.status).toBe(500)
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('fails without writing any collision or conflict when the claimant lookup throws', async () => {
    mocks.chatFindMany.mockRejectedValue(new Error('connection reset'))
    const response = await POST(domRequest())
    expect(response.status).toBe(500)
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test.each([
    ['stored sender missing', {}, { senderId: undefined }],
    ['stored sender is the chat id', {}, { senderId: DOM_CHAT }],
    ['stored sender is the raw chat id', {}, { senderId: '511708938', rawExternalChatId: '511708938' }],
    ['Chat has no identity link', { contactIdentityId: null }, {}],
    ['Chat has no Contact link', { contactId: null }, {}],
  ])('rejects without proof when %s', async (_label, columns, storedMetadata) => {
    chat = provenPrivateChat(columns, storedMetadata)
    const response = await POST(domRequest())
    expect(response.status).toBe(409)
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('rejects an unresolved shortId key that only a DOM event ever named', async () => {
    const shortId = '197100100'
    chat = provenPrivateChat({ externalChatId: shortId }, { senderId: undefined, chatKind: undefined, rawExternalChatId: shortId })
    const response = await POST(domRequest({
      chatId: shortId,
      rawChatId: shortId,
      externalId: `max-dom-${shortId}-7ef524501d31775e`,
      chatKind: 'unknown',
      domRoute: attestedRoute({ uiRouteId: shortId, source: 'protocol_chat_id' }),
    }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_UNPROVEN' })
    expectNoDomMessage()
  })

  test('rejects a route-id alias even when it normalizes to the proven conversation', async () => {
    await expectUnproven(await POST(domRequest({ chatId: DOM_ROUTE, rawChatId: DOM_ROUTE, externalId: `max-dom-${DOM_ROUTE}-7ef524501d31775e` })))
  })

  test('rejects when the raw chat id differs from the canonical chat id', async () => {
    await expectUnproven(await POST(domRequest({ rawChatId: DOM_ROUTE })))
  })

  test('rejects a stale legacy Chat that carries no provider stamps', async () => {
    chat = provenPrivateChat({}, { chatKind: undefined, providerAccountId: undefined })
    const response = await POST(domRequest())
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expectNoDomMessage()
  })

  test.each([
    ['placeholder id of another chat', { externalId: 'max-dom-902400000777-7ef524501d31775e' }],
    ['provider-shaped id', { externalId: 'd301a0bdbcf79419e8' }],
    ['short hash', { externalId: `max-dom-${DOM_CHAT}-7ef5` }],
    ['uppercase hash', { externalId: `max-dom-${DOM_CHAT}-7EF524501D31775E` }],
    ['trailing suffix', { externalId: `${DOM_EXTERNAL_ID}-x` }],
    ['live DOM recovery source', { source: 'live_dom_recovery' }],
    ['history source', { source: 'history' }],
    ['no source', { source: null }],
    ['empty sender field', { senderId: '' }],
    ['attachments present', { attachments: [{ type: 'image', url: 'https://i.example/x.jpg' }], messageType: 'image' }],
  ])('rejects a forged or partial DOM-fallback marker: %s', async (_label, event) => {
    const response = await POST(domRequest(event))
    expect([200, 409]).toContain(response.status)
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
  })

  test.each([
    ['a deletion', { deleted: true }],
    ['a non-text message without attachments', { messageType: 'video' }],
    ['a text event with an attachment that has no source', { attachments: [{ type: 'image' }] }],
  ])('never binds %s', async (_label, event) => {
    await POST(domRequest(event))
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expect(mocks.upsertMessage).not.toHaveBeenCalled()
  })

  test('rejects a route-id alias in chatId even when rawChatId is canonical', async () => {
    await expectUnproven(await POST(domRequest({ chatId: DOM_ROUTE, rawChatId: DOM_CHAT })))
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
  })

  test('never treats a non-numeric route as a page route, even for a matching stored sender', async () => {
    chat = provenPrivateChat({ externalChatId: '902400000777' }, { senderId: 'peer-x', rawExternalChatId: '902400000777' })
    mocks.chatFindMany.mockImplementation(async () => [chat])
    mocks.resolvePeerIdentity.mockResolvedValue(readyPeerIdentity({ externalId: 'peer-x' }))
    const event = { chatId: '902400000777', rawChatId: '902400000777', externalId: 'max-dom-902400000777-7ef524501d31775e' }
    await expectUnproven(await POST(domRequest({ ...event, domRoute: attestedRoute({ uiRouteId: 'peer-x', source: 'dialog_participant' }) })))
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
  })

  test('never binds a Chat of another channel that shares the external id', async () => {
    chat = provenPrivateChat({ channel: 'telegram' })
    const response = await POST(domRequest())
    expect(response.status).toBe(409)
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('keeps the existing mismatch failure for a DOM event that carries another sender', async () => {
    const response = await POST(domRequest({ senderId: '902200000999' }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_COLLISION' })
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expectNoDomMessage()
  })

  test('leaves a valid provider-framed inbound unchanged', async () => {
    const response = await POST(domRequest({
      externalId: 'd301a0bdbd00000001',
      senderId: DOM_PEER,
      senderName: 'User A',
      source: undefined,
      domRoute: undefined,
    }))
    expect(response.status).toBe(200)
    expect(mocks.resolvePeerIdentity).not.toHaveBeenCalled()
    expect(mocks.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ senderIdProof: expect.anything() }),
    }))
    expect(mocks.resolveContact).toHaveBeenCalledOnce()
    expect(mocks.recordReachability).toHaveBeenCalledOnce()
  })
})
