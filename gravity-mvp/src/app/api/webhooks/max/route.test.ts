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
vi.mock('@/modules/contacts/public/v1', async () => ({
  startMaxContactResolutionShadowV1: mocks.shadowStart,
  markChannelIdentityConflictV1: mocks.markIdentityConflict,
  isResolvedChannelContactResultV1: mocks.isResolvedContact,
  resolveChannelContactOperationV1: mocks.resolveContact,
  // The real Contacts classifier decides person evidence; only the writer is mocked.
  isPersonIdentityCollisionEvidenceV1: (
    await vi.importActual<typeof import('@/modules/contacts/public/v1/contact-evidence-state')>(
      '@/modules/contacts/public/v1/contact-evidence-state',
    )
  ).isPersonIdentityCollisionEvidenceV1,
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

  test('fails a Chat owned by another concrete MAX account closed without invalidating the Contact', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'max-sender-42',
      providerAccountId: 'max-account-a',
      connectionId: 'max_scraper',
    }))

    const response = await POST(request())

    // The conversation/route guard is unchanged: MAX chat ids are not proven to
    // be account-independent, so another account may not append to this Chat.
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expect(mocks.shadowComplete).toHaveBeenCalledWith({
      status: 'no_contact',
      reason: 'provider_account_mismatch',
    })
    expectCollisionEvidence('provider_account_mismatch')
    // Same sender, different company account: no person conflict is written.
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expectNoInboundMutation()
  })

  test('does not record a person conflict when another account\'s conversation stored a different sender', async () => {
    // Even stamped private peer evidence belongs to account A's conversation. MAX
    // chat ids are not proven account-independent, so account B's event may be a
    // different dialog: route uncertainty, audited here, not a person fact.
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'other-max-sender',
      chatKind: 'private',
      providerAccountId: 'max-account-a',
      connectionId: 'max_scraper',
    }))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expectCollisionEvidence('provider_account_mismatch')
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        incomingSenderId: 'max-sender-42',
        existingSenderId: 'other-max-sender',
        existingChatKind: 'private',
      }),
    }))
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expectNoInboundMutation()
  })

  test('fails an unstamped legacy Chat closed without a person conflict when the sender is proven', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'max-sender-42',
      connectionId: 'max_scraper',
    }))

    const response = await POST(request())

    // No silent attribution of a legacy conversation to the live account.
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expectCollisionEvidence('provider_account_unproven')
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
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
    // Neither the account gap nor the missing stored sender is a fact about the
    // person: the conversation fails closed and only Messaging audits it.
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
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
    // Same account, so nothing masks it: the linked person is disabled.
    expect(mocks.markIdentityConflict).toHaveBeenCalledOnce()
    expect(mocks.markIdentityConflict).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-a',
      identityId: 'identity-a',
      channel: 'max',
      reason: 'sender_identity_mismatch',
      evidenceRoot: expect.stringMatching(/:sender_identity_mismatch$/),
    }))
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
    // Absent sender proof blocks this admission, not the person.
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expectNoInboundMutation()
  })

  test('does not record a person conflict when another account sends group traffic under a stored private chat id', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({
      senderId: 'max-sender-42',
      chatKind: 'private',
      providerAccountId: 'max-account-a',
      connectionId: 'max_scraper',
    }))

    // The account arm fires first and the hidden kind arm is still audited, but
    // another account's group under the same id is not evidence about the person.
    const response = await POST(request({ chatKind: 'group' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expectCollisionEvidence('provider_account_mismatch')
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ incomingChatKind: 'group', existingChatKind: 'private' }),
    }))
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
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
    // A global message-key collision is not evidence about the linked person.
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
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

  // ── M2-0: MAX sender evidence and the person record ─────────────────────
  // The sender arm compares the incoming sender with Chat.metadata.senderId.
  // Only a stored sender the admission chain stamped together with a concrete
  // account and a private kind is evidence about the person. The real Contacts
  // classifier runs here: only the Contacts writer itself is mocked.

  function expectNoPersonThreadEffects() {
    expectNoInboundMutation()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expect(mocks.patchConversation).not.toHaveBeenCalled()
    expect(mocks.attachMessageMedia).not.toHaveBeenCalled()
    expect(mocks.deleteMessageMedia).not.toHaveBeenCalled()
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
    expect(mocks.emitMessage).not.toHaveBeenCalled()
    expect(mocks.broadcastMessage).not.toHaveBeenCalled()
  }

  const provenPrivateChat = (senderId: string, providerAccountId = 'max-account-b') => existingChat({
    senderId,
    chatKind: 'private',
    providerAccountId,
    connectionId: 'max_scraper',
  })

  test.each([
    ['an unstamped legacy row', { connectionId: 'max_scraper' }, 'MAX_PROVIDER_ACCOUNT_UNPROVEN', 'provider_account_unproven'],
    ['a canary-label row', { providerAccountId: 'canary-operator-label', connectionId: 'max_scraper' }, 'MAX_PROVIDER_ACCOUNT_COLLISION', 'provider_account_mismatch'],
    ['a live-account row with a stored private kind', { chatKind: 'private', providerAccountId: 'max-account-b', connectionId: 'max_scraper' }, 'MAX_SENDER_IDENTITY_UNPROVEN', 'sender_identity_unproven'],
  ])('CASE 1: a linked Chat with no stored sender (%s) fails closed and is audited without a Contact conflict', async (
    _label,
    metadata,
    error,
    auditReason,
  ) => {
    mocks.chatFindUnique.mockResolvedValue(existingChat(metadata))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error })
    expectCollisionEvidence(auditReason)
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        incomingSenderId: 'max-sender-42',
        existingSenderId: null,
        hasPersonOwnership: true,
      }),
    }))
    expect(mocks.shadowComplete).toHaveBeenCalledWith({ status: 'no_contact', reason: auditReason })
    expectNoPersonThreadEffects()
  })

  test('CASE 1: an inbound event without a sender on a proven private Chat fails closed without a Contact conflict', async () => {
    mocks.chatFindUnique.mockResolvedValue(provenPrivateChat('max-sender-42'))

    const response = await POST(request({ senderId: null }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_UNPROVEN' })
    expectCollisionEvidence('sender_identity_unproven')
    expectNoPersonThreadEffects()
  })

  test.each([
    // The shared company-account sender measured on legacy production rows.
    ['an unstamped legacy row', { senderId: 'company-account-echo', connectionId: 'max_scraper' }, 'MAX_PROVIDER_ACCOUNT_UNPROVEN', 'provider_account_unproven'],
    ['a canary-label row', { senderId: 'stale-last-writer', providerAccountId: 'canary-operator-label', connectionId: 'max_scraper' }, 'MAX_PROVIDER_ACCOUNT_COLLISION', 'provider_account_mismatch'],
    // Same live account, but the stored sender was never stamped with a private kind.
    ['a live-account row without a stored private kind', { senderId: 'stale-last-writer', providerAccountId: 'max-account-b', connectionId: 'max_scraper' }, 'MAX_SENDER_IDENTITY_COLLISION', 'sender_identity_mismatch'],
    ['a live-account row stored as unknown kind', { senderId: 'stale-last-writer', chatKind: 'unknown', providerAccountId: 'max-account-b', connectionId: 'max_scraper' }, 'MAX_SENDER_IDENTITY_COLLISION', 'sender_identity_mismatch'],
  ])('CASE 2: a linked Chat whose legacy stored sender differs (%s) fails closed and is audited without a Contact conflict', async (
    _label,
    metadata,
    error,
    auditReason,
  ) => {
    mocks.chatFindUnique.mockResolvedValue(existingChat(metadata))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error })
    expectCollisionEvidence(auditReason)
    expect(mocks.appendCollision).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        incomingSenderId: 'max-sender-42',
        existingSenderId: metadata.senderId,
      }),
    }))
    expectNoPersonThreadEffects()
  })

  test.each([
    ['group traffic', { chatKind: 'group' }, 'MAX_CHAT_KIND_COLLISION', 'chat_kind_mismatch'],
    ['a legacy stored sender', { chatKind: 'private' }, null, null],
  ])('CASE 2: an outgoing echo carrying %s observes no person and writes no Contact conflict', async (
    _label,
    overrides,
    error,
    auditReason,
  ) => {
    // An echo names our own account as sender, so the route already refuses it as
    // peer evidence. A contradiction it raises is about the conversation only.
    mocks.chatFindUnique.mockResolvedValue(provenPrivateChat('peer-sender'))
    mocks.patchConversation.mockResolvedValue({ conversation: provenPrivateChat('peer-sender') })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-echo', chatId: 'chat-1' } })

    const response = await POST(request({ isOutgoing: true, senderId: 'account-user', ...overrides }))

    if (error) {
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({ error })
      expectCollisionEvidence(auditReason as string)
      expectNoPersonThreadEffects()
    } else {
      expect(response.status).toBe(200)
      expect(mocks.appendCollision).not.toHaveBeenCalled()
    }
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
  })

  test('CASE 2: a deletion on a linked legacy Chat fails closed at the account arm without a Contact conflict', async () => {
    const legacyChat = existingChat({ senderId: 'company-account-echo', connectionId: 'max_scraper' })
    mocks.chatFindUnique.mockResolvedValueOnce(legacyChat)
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-legacy',
      chatId: legacyChat.id,
      direction: 'inbound',
      metadata: { senderId: 'max-sender-42' },
      chat: legacyChat,
    })

    const response = await POST(request({ deleted: true, text: null }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' })
    expect(mocks.appendCollision).toHaveBeenLastCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        reason: 'provider_account_unproven',
        incomingSenderId: 'max-sender-42',
        existingSenderId: 'company-account-echo',
      }),
    }))
    expectNoPersonThreadEffects()
  })

  test('CASE 3: a sender that contradicts proven private peer evidence on the same account still records the person conflict', async () => {
    mocks.chatFindUnique.mockResolvedValue(provenPrivateChat('proven-peer'))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_COLLISION' })
    expectCollisionEvidence('sender_identity_mismatch')
    expect(mocks.markIdentityConflict).toHaveBeenCalledOnce()
    // The writer receives exactly the recorded values the classifier accepted.
    expect(mocks.markIdentityConflict).toHaveBeenCalledWith({
      contactId: 'contact-a',
      identityId: 'identity-a',
      channel: 'max',
      reason: 'sender_identity_mismatch',
      evidenceRoot: 'channel-collision:max:max-conversation-900:max-account-b:sender_identity_mismatch',
      details: {
        incomingProviderAccountId: 'max-account-b',
        existingProviderAccountId: 'max-account-b',
        incomingSenderId: 'max-sender-42',
        existingSenderId: 'proven-peer',
        incomingChatKind: 'private',
        existingChatKind: 'private',
      },
    })
    expectNoInboundMutation()
    expect(mocks.emitMessage).not.toHaveBeenCalled()
    expect(mocks.patchConversation).not.toHaveBeenCalled()
  })

  test('CASE 3: group traffic into a proven private conversation on the same account still records the person conflict', async () => {
    mocks.chatFindUnique.mockResolvedValue(provenPrivateChat('max-sender-42'))

    const response = await POST(request({ chatKind: 'group' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_CHAT_KIND_COLLISION' })
    expectCollisionEvidence('chat_kind_mismatch')
    expect(mocks.markIdentityConflict).toHaveBeenCalledOnce()
    expect(mocks.markIdentityConflict).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'chat_kind_mismatch',
      details: expect.objectContaining({ existingChatKind: 'private', incomingChatKind: 'group' }),
    }))
    expectNoInboundMutation()
  })

  test.each([
    ['an agreeing stored private sender', { senderId: 'max-sender-42', chatKind: 'private', providerAccountId: 'max-account-a', connectionId: 'max_scraper' }, {}],
    ['an agreeing stored unknown-kind sender', { senderId: 'max-sender-42', providerAccountId: 'max-account-a', connectionId: 'max_scraper' }, {}],
    ['a different stamped private sender', { senderId: 'proven-peer', chatKind: 'private', providerAccountId: 'max-account-a', connectionId: 'max_scraper' }, {}],
    ['stamped private kind and group traffic', { senderId: 'max-sender-42', chatKind: 'private', providerAccountId: 'max-account-a', connectionId: 'max_scraper' }, { chatKind: 'group' }],
  ])('CASE 4: an account mismatch with %s fails closed and is audited without a person conflict', async (
    _label,
    metadata,
    overrides,
  ) => {
    mocks.chatFindUnique.mockResolvedValue(existingChat(metadata))

    const response = await POST(request(overrides))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' })
    expectCollisionEvidence('provider_account_mismatch')
    expectNoPersonThreadEffects()
  })

  test.each([
    ['an unstamped legacy row', { senderId: 'max-sender-42', connectionId: 'max_scraper' }, 'MAX_PROVIDER_ACCOUNT_UNPROVEN', 'provider_account_unproven'],
    // A cold scraper chat cache stores 'unknown'; ownership alone is not a private proof.
    ['a live-account row stored as unknown kind', { senderId: 'max-sender-42', providerAccountId: 'max-account-b', connectionId: 'max_scraper' }, 'MAX_CHAT_KIND_COLLISION', 'chat_kind_mismatch'],
  ])('CASE 2: group traffic into a linked Chat whose private kind was never proven (%s) writes no Contact conflict', async (
    _label,
    metadata,
    error,
    auditReason,
  ) => {
    mocks.chatFindUnique.mockResolvedValue(existingChat(metadata))

    const response = await POST(request({ chatKind: 'group' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error })
    expectCollisionEvidence(auditReason)
    expectNoPersonThreadEffects()
  })

  test('CASE 2: a replayed message stored under a legacy conversation key writes no Contact conflict on the linked person', async () => {
    const legacyKeyChat = {
      ...existingChat({ senderId: 'max-sender-42', connectionId: 'max_scraper' }),
      externalChatId: 'legacy-ui-route-key',
    }
    mocks.chatFindUnique.mockResolvedValueOnce(null)
    mocks.messageFindUnique.mockResolvedValue({
      id: 'message-legacy-key',
      chatId: legacyKeyChat.id,
      chat: legacyKeyChat,
    })

    const response = await POST(request({ source: 'catchup' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_MESSAGE_IDENTITY_COLLISION' })
    expectCollisionEvidence('message_chat_mismatch')
    expectNoPersonThreadEffects()
  })

  test('CASE 2: a stored sender equal to the company account itself is not person evidence', async () => {
    mocks.chatFindUnique.mockResolvedValue(provenPrivateChat('max-account-b'))

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'MAX_SENDER_IDENTITY_COLLISION' })
    expectCollisionEvidence('sender_identity_mismatch')
    expectNoPersonThreadEffects()
  })

  test.each([
    ['stored senders disagree', { id: 'message-proven', direction: 'inbound', metadata: { senderId: 'other-stored-sender' } }, {}, 'MAX_SENDER_IDENTITY_COLLISION'],
    ['the delete push carries group traffic', { id: 'message-proven', direction: 'inbound', metadata: { senderId: 'max-sender-42' } }, { chatKind: 'group' }, 'MAX_CHAT_KIND_COLLISION'],
  ])('CASE 2: a deletion on a proven private Chat where %s neither deletes nor writes a Contact conflict', async (
    _label,
    storedMessage,
    overrides,
    error,
  ) => {
    const chat = provenPrivateChat('max-sender-42')
    mocks.chatFindUnique.mockResolvedValueOnce(chat)
    mocks.messageFindUnique.mockResolvedValue({ ...storedMessage, chatId: chat.id, chat })

    const response = await POST(request({ deleted: true, text: null, ...overrides }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mocks.appendCollision).toHaveBeenCalledOnce()
    expectNoPersonThreadEffects()
  })

  test.each([
    ['an unstamped legacy row with a differing sender', { senderId: 'company-account-echo', connectionId: 'max_scraper' }, 'MAX_PROVIDER_ACCOUNT_UNPROVEN'],
    ['a live-account private row without a stored sender', { chatKind: 'private', providerAccountId: 'max-account-b', connectionId: 'max_scraper' }, 'MAX_SENDER_IDENTITY_UNPROVEN'],
  ])('CASE 5: an unlinked Chat with insufficient sender evidence (%s) gains no Contact link and no person conflict', async (
    _label,
    metadata,
    error,
  ) => {
    mocks.chatFindUnique.mockResolvedValue({ ...existingChat(metadata), contactId: null, contactIdentityId: null })

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mocks.appendCollision).toHaveBeenCalledOnce()
    expectNoPersonThreadEffects()
  })

  test('CASE 5: a new private conversation whose inbound event carries no sender is not linked to any Contact', async () => {
    const created = {
      ...existingChat({ chatKind: 'private', providerAccountId: 'max-account-b', connectionId: 'max_scraper' }),
      contactId: null,
      contactIdentityId: null,
    }
    mocks.chatFindUnique.mockResolvedValue(null)
    mocks.createConversation.mockResolvedValue({ conversation: created })
    mocks.patchConversation.mockResolvedValue({ conversation: created })
    mocks.upsertMessage.mockResolvedValue({ message: { id: 'message-no-sender', chatId: created.id } })

    const response = await POST(request({ senderId: null }))

    expect(response.status).toBe(200)
    expect(mocks.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ senderId: expect.anything() }),
    }))
    expect(mocks.chatFindMany).not.toHaveBeenCalled()
    expect(mocks.resolveContact).not.toHaveBeenCalled()
    expect(mocks.ensureContactLink).not.toHaveBeenCalled()
    expect(mocks.recordReachability).not.toHaveBeenCalled()
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.markIdentityConflict).not.toHaveBeenCalled()
    expect(mocks.patchConversation).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: {
        metadata: expect.objectContaining({
          contactResolution: expect.objectContaining({
            automaticLinkPerformed: false,
            reason: 'missing_exact_sender_identity',
          }),
        }),
      },
    }))
  })

  test('CASE 6: a duplicate legacy-sender collision forwards identical audit evidence and never touches the person', async () => {
    mocks.chatFindUnique.mockResolvedValue(existingChat({ senderId: 'company-account-echo', connectionId: 'max_scraper' }))

    const first = await POST(request())
    const second = await POST(request())

    expect(first.status).toBe(409)
    expect(second.status).toBe(409)
    expect(mocks.appendCollision).toHaveBeenCalledTimes(2)
    // The Messaging audit de-duplicates on the evidence without observedAt, so an
    // identical payload collapses to one entry (conversation-identity-collision.ts).
    expect(mocks.appendCollision.mock.calls[1]).toEqual(mocks.appendCollision.mock.calls[0])
    expect(mocks.appendCollision.mock.calls[0][0].evidence).not.toHaveProperty('observedAt')
    expectNoPersonThreadEffects()
  })

  test('CASE 6: a duplicate proven contradiction reuses one Contacts evidence root, which the writer de-duplicates', async () => {
    mocks.chatFindUnique.mockResolvedValue(provenPrivateChat('proven-peer'))

    await POST(request())
    await POST(request())

    expect(mocks.markIdentityConflict).toHaveBeenCalledTimes(2)
    expect(mocks.markIdentityConflict.mock.calls[1]).toEqual(mocks.markIdentityConflict.mock.calls[0])
    expect(mocks.appendCollision.mock.calls[1]).toEqual(mocks.appendCollision.mock.calls[0])
    expectNoInboundMutation()
    expect(mocks.emitMessage).not.toHaveBeenCalled()
  })

  test('CASE 6: a duplicate accepted inbound on a proven Chat produces no second write or side effect', async () => {
    const chat = provenPrivateChat('max-sender-42')
    mocks.chatFindUnique.mockResolvedValue(chat)
    mocks.messageFindUnique.mockResolvedValue({ id: 'message-in-1', chatId: chat.id, chat })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      chatInternalId: chat.id,
      messageId: 'message-in-1',
      deduped: true,
    })
    expect(mocks.appendCollision).not.toHaveBeenCalled()
    expect(mocks.shadowComplete).toHaveBeenCalledWith({ status: 'no_contact', reason: 'existing_provider_message' })
    expectNoPersonThreadEffects()
  })
})
