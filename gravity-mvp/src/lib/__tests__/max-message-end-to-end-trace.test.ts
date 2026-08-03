import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getRenderedMessageText } from '@/lib/max-message-render-text'

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  chat: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  message: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    createMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  messageAttachment: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}))

const contactServiceMock = vi.hoisted(() => ({
  resolveContact: vi.fn(),
  ensureChatLinked: vi.fn(),
}))
const workflowMock = vi.hoisted(() => ({
  onInboundMessage: vi.fn(),
  onOutboundMessage: vi.fn(),
}))
const shadowCompleteMock = vi.hoisted(() => vi.fn())
const messageEventsMock = vi.hoisted(() => ({
  emitMessageReceived: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/messageEvents', () => messageEventsMock)
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: vi.fn() }))
vi.mock('@/lib/DriverMatchService', () => ({
  DriverMatchService: { linkChatToDriver: vi.fn() },
}))
vi.mock('@/lib/ContactService', () => ({ ContactService: contactServiceMock }))
vi.mock('@/lib/ConversationWorkflowService', () => ({
  ConversationWorkflowService: workflowMock,
}))
vi.mock('@/lib/contacts/max-contact-resolution-shadow', () => ({
  startMaxContactResolutionShadow: vi.fn(async () => ({
    session: { complete: shadowCompleteMock },
  })),
}))
vi.mock('@/lib/opsLog', () => ({ opsLog: vi.fn() }))
vi.mock('@/lib/whatsapp/WhatsAppService', () => ({ sendMessage: vi.fn() }))

import { POST as maxWebhookPost } from '@/app/api/webhooks/max/route'
import { GET as messagesGet } from '@/app/api/messages/route'

const require = createRequire(import.meta.url)
const { TransportInterceptor } = require('../../../../max-web-scraper/transport/TransportInterceptor')
const { MessageParser } = require('../../../../max-web-scraper/parser/MessageParser')
const { withForwardingMetadata } = require('../../../../max-web-scraper/pipeline/MessageEnvelope')

function fixture(name: string) {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), '..', 'max-web-scraper', 'forensics', 'fixtures', name),
    'utf8',
  ))
}

function webhookRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/webhooks/max', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('MAX raw payload to rendered text trace', () => {
  let storedMessage: Record<string, unknown>
  let durableStoredMessage: Record<string, unknown> | null

  beforeEach(() => {
    vi.clearAllMocks()
    storedMessage = {}
    durableStoredMessage = null

    prismaMock.message.findUnique.mockImplementation(async ({ where }) => (
      where.externalId && durableStoredMessage?.externalId === where.externalId
        ? durableStoredMessage
        : null
    ))
    prismaMock.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      channel: 'max',
      externalChatId: '900001',
      name: 'MAX fixture',
      metadata: {},
      driverId: 'driver-1',
    })
    prismaMock.chat.update.mockResolvedValue({ id: 'chat-1' })
    prismaMock.chat.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.$transaction.mockImplementation(async callback => callback(prismaMock))
    prismaMock.messageAttachment.findMany.mockResolvedValue([])
    prismaMock.messageAttachment.create.mockResolvedValue({ id: 'attachment-1' })
    prismaMock.message.upsert.mockImplementation(async ({ create }) => {
      storedMessage = {
        id: 'message-1',
        createdAt: new Date('2026-07-18T12:00:00.000Z'),
        updatedAt: new Date('2026-07-18T12:00:00.000Z'),
        attachments: [],
        ...create,
      }
      return storedMessage
    })
    prismaMock.message.createMany.mockImplementation(async ({ data }) => {
      const create = Array.isArray(data) ? data[0] : data
      if (durableStoredMessage?.externalId === create.externalId) return { count: 0 }
      const created = {
        id: 'message-1',
        createdAt: new Date(create.sentAt),
        updatedAt: new Date(create.sentAt),
        attachments: [],
        ...create,
      }
      durableStoredMessage = created
      storedMessage = created
      return { count: 1 }
    })
    prismaMock.message.findMany.mockImplementation(async () => [storedMessage])
    prismaMock.message.update.mockImplementation(async ({ where, data }) => ({
      ...storedMessage,
      id: where.id,
      ...data,
    }))

    contactServiceMock.resolveContact.mockResolvedValue({
      contact: { id: 'contact-1' },
      identity: { id: 'identity-1' },
      isNew: false,
    })
    contactServiceMock.ensureChatLinked.mockResolvedValue(undefined)
    workflowMock.onInboundMessage.mockResolvedValue(undefined)
    workflowMock.onOutboundMessage.mockResolvedValue(undefined)
    shadowCompleteMock.mockResolvedValue(undefined)
    messageEventsMock.emitMessageReceived.mockResolvedValue(undefined)
  })

  test('keeps body exact while forwarding metadata remains structured', async () => {
    const raw = fixture('forward.json')
    raw.message.time = Date.now() - 1_000

    const transportEvent = new TransportInterceptor()._normalizeMaxMsg(raw)
    const parserOutput = MessageParser.toCrmPayload(transportEvent)
    const webhookPayload = withForwardingMetadata(
      parserOutput,
      transportEvent,
      (id: string) => ({ name: `Fixture ${id}`, phone: null }),
    )

    const webhookResponse = await maxWebhookPost(webhookRequest(webhookPayload))
    expect(webhookResponse.status).toBe(200)

    const createPayload = prismaMock.message.upsert.mock.calls[0][0].create
    expect(createPayload.content).toBe('Пересланный текст без префикса')
    expect(createPayload.metadata).toMatchObject({
      forwardedFrom: {
        id: '700777',
        name: 'Fixture 700777',
        phone: null,
      },
    })
    expect(createPayload.content).not.toContain('[↩')
    expect(createPayload.content).not.toContain('forwardedFrom')

    const apiResponse = await messagesGet(new Request(
      'http://localhost/api/messages?chatId=chat-1',
    ) as never)
    const apiPayload = await apiResponse.json()
    expect(apiPayload).toHaveLength(1)
    expect(apiPayload[0].content).toBe('Пересланный текст без префикса')
    expect(apiPayload[0].metadata.forwardedFrom).toMatchObject({
      id: '700777',
      name: 'Fixture 700777',
    })

    const renderedText = getRenderedMessageText(apiPayload[0])
    expect(renderedText).toBe('Пересланный текст без префикса')
  })

  test('stores caption and attachment as separate DB/API fields', async () => {
    const raw = fixture('image-caption.json')
    raw.message.time = Date.now() - 1_000

    const transportEvent = new TransportInterceptor()._normalizeMaxMsg(raw)
    const webhookPayload = MessageParser.toCrmPayload(transportEvent)
    const webhookResponse = await maxWebhookPost(webhookRequest(webhookPayload))

    expect(webhookResponse.status).toBe(200)
    const createPayload = prismaMock.message.upsert.mock.calls[0][0].create
    expect(createPayload.content).toBe('Подпись к изображению')
    expect(createPayload.metadata.attachments).toHaveLength(1)
    expect(createPayload.content).not.toContain('attachments')
    expect(prismaMock.messageAttachment.create).toHaveBeenCalledTimes(1)
  })

  test('stores a retryable inbound image before its file is downloadable', async () => {
    const response = await maxWebhookPost(webhookRequest({
      externalId: 'd301-retryable-image',
      chatId: '900001',
      senderId: '700001',
      timestamp: Date.now() - 1_000,
      messageType: 'image',
      attachments: [],
      attachmentResolution: {
        status: 'retryable',
        reason: 'no_download_source',
        expectedCount: 1,
        resolvedCount: 0,
        failedCount: 1,
      },
      isOutgoing: false,
      source: 'transport',
    }))

    expect(response.status).toBe(200)
    const createPayload = prismaMock.message.upsert.mock.calls[0][0].create
    expect(createPayload.content).toBe('[\u0424\u043e\u0442\u043e]')
    expect(createPayload.metadata.attachmentResolution).toEqual({
      status: 'retryable',
      reason: 'no_download_source',
      expectedCount: 1,
      resolvedCount: 0,
      failedCount: 1,
    })
    expect(prismaMock.messageAttachment.create).not.toHaveBeenCalled()
  })

  test('upgrades the same retryable image when its attachment arrives', async () => {
    prismaMock.message.upsert.mockResolvedValue({
      id: 'message-retryable',
      chatId: 'chat-1',
      metadata: {
        attachmentResolution: {
          status: 'retryable',
          reason: 'no_download_source',
        },
      },
    })

    const response = await maxWebhookPost(webhookRequest({
      externalId: 'd301-retryable-image',
      chatId: '900001',
      senderId: '700001',
      timestamp: Date.now() - 1_000,
      messageType: 'image',
      attachments: [{
        type: 'image',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        url: 'data:image/jpeg;base64,ZmFrZQ==',
        downloadStatus: 'ok',
      }],
      attachmentResolution: {
        status: 'resolved',
        expectedCount: 1,
        resolvedCount: 1,
        failedCount: 0,
      },
      isOutgoing: false,
      source: 'transport',
    }))

    expect(response.status).toBe(200)
    expect(prismaMock.message.update).toHaveBeenCalledWith({
      where: { id: 'message-retryable' },
      data: {
        metadata: {
          attachmentResolution: {
            status: 'resolved',
            reason: null,
            expectedCount: 1,
            resolvedCount: 1,
            failedCount: 0,
          },
        },
      },
    })
    expect(prismaMock.messageAttachment.create).toHaveBeenCalledTimes(1)
  })

  test('rejects live MAX text without a real provider message ID', async () => {
    const response = await maxWebhookPost(webhookRequest({
      chatId: '900001',
      senderId: '700001',
      text: 'Text without provider identity',
      timestamp: new Date().toISOString(),
      messageType: 'text',
      source: 'transport',
      externalId: null,
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      skipped: 'text_without_provider_identity',
      externalId: null,
    })
    expect(prismaMock.message.upsert).not.toHaveBeenCalled()
  })

  test('repeated reconnect delivery of one provider ID creates one durable Message', async () => {
    const persisted = new Map<string, Record<string, unknown>>()
    prismaMock.message.findUnique.mockImplementation(async ({ where }) => (
      where.externalId ? persisted.get(String(where.externalId)) || null : null
    ))
    prismaMock.message.createMany.mockImplementation(async ({ data }) => {
      const create = Array.isArray(data) ? data[0] : data
      if (persisted.has(String(create.externalId))) return { count: 0 }
      const value = {
        id: `message-${persisted.size + 1}`,
        chatId: 'chat-1',
        createdAt: new Date('2026-08-03T18:13:15.210Z'),
        updatedAt: new Date('2026-08-03T18:13:15.210Z'),
        attachments: [],
        ...create,
      }
      persisted.set(String(create.externalId), value)
      return { count: 1 }
    })

    const body = {
      externalId: 'd3019fc8d4774a04bc',
      chatId: '900001',
      senderId: '700001',
      text: 'ывапро',
      timestamp: '2026-08-03T18:13:15.210Z',
      messageType: 'text',
      source: 'reconnect_snapshot',
      isOutgoing: false,
      providerAccountId: 'personal-max-main',
      protocolChatId: '900001',
      uiRouteId: '900001',
      providerUserId: '700001',
    }
    const first = await maxWebhookPost(webhookRequest(body))
    const second = await maxWebhookPost(webhookRequest(body))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      success: true,
      messageId: 'message-1',
      chatInternalId: 'chat-1',
      deduped: true,
    })
    expect(prismaMock.message.createMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.message.upsert).not.toHaveBeenCalled()
    expect(persisted.size).toBe(1)
  })

  test('concurrent reconnect requests apply unread and application side effects only for the actual insert', async () => {
    const persisted = new Map<string, Record<string, unknown>>()
    let createCalls = 0
    let releaseFirstCreate: (() => void) | null = null
    const secondCreateReached = new Promise<void>(resolve => { releaseFirstCreate = resolve })

    prismaMock.message.findUnique.mockImplementation(async ({ where }) => (
      where.externalId ? persisted.get(String(where.externalId)) || null : null
    ))
    prismaMock.message.createMany.mockImplementation(async ({ data }) => {
      const create = Array.isArray(data) ? data[0] : data
      createCalls += 1
      if (createCalls === 1) {
        await secondCreateReached
      } else {
        releaseFirstCreate?.()
      }
      if (persisted.has(String(create.externalId))) return { count: 0 }
      persisted.set(String(create.externalId), {
        id: 'message-concurrent',
        createdAt: new Date(create.sentAt),
        updatedAt: new Date(create.sentAt),
        attachments: [],
        ...create,
      })
      return { count: 1 }
    })

    const body = {
      externalId: 'd3019fc8d4774a04bc',
      chatId: '900001',
      senderId: '700001',
      text: 'ывапро',
      timestamp: '2026-08-03T18:13:15.210Z',
      messageType: 'text',
      source: 'reconnect_snapshot',
      isOutgoing: false,
      providerAccountId: 'personal-max-main',
      protocolChatId: '900001',
      uiRouteId: '900001',
      providerUserId: '700001',
    }
    const [first, second] = await Promise.all([
      maxWebhookPost(webhookRequest(body)),
      maxWebhookPost(webhookRequest(body)),
    ])
    const responses = await Promise.all([first.json(), second.json()])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(responses.every(response => response.messageId === 'message-concurrent')).toBe(true)
    expect(responses.filter(response => response.deduped === true)).toHaveLength(1)
    expect(prismaMock.message.createMany).toHaveBeenCalledTimes(2)
    expect(persisted.size).toBe(1)
    expect(workflowMock.onInboundMessage).toHaveBeenCalledTimes(1)
    expect(prismaMock.chat.updateMany).toHaveBeenCalledTimes(1)
    expect(contactServiceMock.resolveContact).toHaveBeenCalledTimes(1)
    expect(messageEventsMock.emitMessageReceived).toHaveBeenCalledTimes(1)
  })

  test('reconnect duplicate ACK fails closed when the stored route identity differs', async () => {
    const body = {
      externalId: 'd3019fc8d4774a04bc',
      chatId: '900001',
      senderId: '700001',
      text: 'ывапро',
      timestamp: '2026-08-03T18:13:15.210Z',
      messageType: 'text',
      source: 'reconnect_snapshot',
      isOutgoing: false,
      providerAccountId: 'personal-max-main',
      protocolChatId: '900001',
      uiRouteId: '900001',
      providerUserId: '700001',
    }
    prismaMock.message.findUnique.mockResolvedValue({
      id: 'message-existing',
      chatId: 'chat-other',
      metadata: {
        providerAccountId: 'personal-max-main',
        protocolChatId: '900001',
        uiRouteId: 'different-route',
        providerUserId: '700001',
      },
      sentAt: new Date(body.timestamp),
      content: body.text,
      direction: 'inbound',
      channel: 'max',
    })

    const response = await maxWebhookPost(webhookRequest(body))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'MAX_PROVIDER_IDENTITY_CONFLICT',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.message.createMany).not.toHaveBeenCalled()
    expect(prismaMock.message.upsert).not.toHaveBeenCalled()
  })

  test('reconnect Message and activity changes share one rollback boundary', async () => {
    workflowMock.onInboundMessage.mockRejectedValueOnce(new Error('workflow unavailable'))
    let transactionMessage: Record<string, unknown> | null = null
    prismaMock.message.findUnique.mockImplementation(async ({ where }) => (
      where.externalId && transactionMessage?.externalId === where.externalId
        ? transactionMessage
        : null
    ))
    prismaMock.message.createMany.mockImplementation(async ({ data }) => {
      const create = Array.isArray(data) ? data[0] : data
      transactionMessage = {
        id: 'message-rollback',
        createdAt: new Date(create.sentAt),
        updatedAt: new Date(create.sentAt),
        attachments: [],
        ...create,
      }
      return { count: 1 }
    })
    prismaMock.$transaction.mockImplementation(async callback => {
      transactionMessage = null
      try {
        return await callback(prismaMock)
      } catch (error) {
        transactionMessage = null
        throw error
      }
    })
    const body = {
      externalId: 'd3019fc8d4774a04bc',
      chatId: '900001',
      senderId: '700001',
      text: 'ывапро',
      timestamp: '2026-08-03T18:13:15.210Z',
      messageType: 'text',
      source: 'reconnect_snapshot',
      isOutgoing: false,
      providerAccountId: 'personal-max-main',
      protocolChatId: '900001',
      uiRouteId: '900001',
      providerUserId: '700001',
    }

    const failed = await maxWebhookPost(webhookRequest(body))
    expect(failed.status).toBe(500)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.message.createMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.chat.updateMany).not.toHaveBeenCalled()

    const retried = await maxWebhookPost(webhookRequest(body))
    expect(retried.status).toBe(200)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(prismaMock.message.createMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.chat.updateMany).toHaveBeenCalledTimes(1)
  })

  test('identical reconnect text with distinct provider IDs remains separate and API-visible', async () => {
    const persisted = new Map<string, Record<string, unknown>>()
    prismaMock.message.findUnique.mockImplementation(async ({ where }) => (
      where.externalId ? persisted.get(String(where.externalId)) || null : null
    ))
    prismaMock.message.createMany.mockImplementation(async ({ data }) => {
      const create = Array.isArray(data) ? data[0] : data
      if (persisted.has(String(create.externalId))) return { count: 0 }
      const value = {
        id: `message-${persisted.size + 1}`,
        chatId: 'chat-1',
        createdAt: new Date(create.sentAt),
        updatedAt: new Date(create.sentAt),
        attachments: [],
        ...create,
      }
      persisted.set(String(create.externalId), value)
      return { count: 1 }
    })
    prismaMock.message.findMany.mockImplementation(async () => Array.from(persisted.values()))

    for (const externalId of ['d3019fc8d8ab3a4130', 'd3019fc8d8ac3a4131']) {
      const response = await maxWebhookPost(webhookRequest({
        externalId,
        chatId: '900001',
        senderId: '700001',
        text: 'у',
        timestamp: '2026-08-03T18:17:50.051Z',
        messageType: 'text',
        source: 'reconnect_snapshot',
        isOutgoing: false,
        providerAccountId: 'personal-max-main',
        protocolChatId: '900001',
        uiRouteId: '900001',
        providerUserId: '700001',
      }))
      expect(response.status).toBe(200)
    }

    expect(prismaMock.message.createMany).toHaveBeenCalledTimes(2)
    expect(persisted.size).toBe(2)
    const apiResponse = await messagesGet(new Request(
      'http://localhost/api/messages?chatId=chat-1',
    ) as never)
    const apiPayload = await apiResponse.json()
    expect(apiPayload).toHaveLength(2)
    expect(apiPayload.map((message: Record<string, unknown>) => message.externalId)).toEqual([
      'd3019fc8d8ac3a4131',
      'd3019fc8d8ab3a4130',
    ])
    expect(apiPayload.map(getRenderedMessageText)).toEqual(['у', 'у'])
  })

  test('preserves normal live ordering while advancing lastMessageAt monotonically', async () => {
    const sentAt = new Date('2026-08-03T18:17:52.281Z')

    const response = await maxWebhookPost(webhookRequest({
      externalId: 'd3019fc8d8b19921ec',
      chatId: '900001',
      senderId: '700001',
      text: 'к',
      timestamp: sentAt.toISOString(),
      messageType: 'text',
      source: 'provider_store_recovery',
      isOutgoing: false,
    }))

    expect(response.status).toBe(200)
    expect(prismaMock.chat.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'chat-1',
        OR: [
          { lastMessageAt: null },
          { lastMessageAt: { lt: sentAt } },
        ],
      },
      data: { lastMessageAt: sentAt },
    })
    expect(prismaMock.chat.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(workflowMock.onInboundMessage.mock.invocationCallOrder[0])
    expect(workflowMock.onInboundMessage.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.message.upsert.mock.invocationCallOrder[0])
    expect(prismaMock.chat.update.mock.calls.every(
      ([call]) => !Object.prototype.hasOwnProperty.call(call.data, 'lastMessageAt'),
    )).toBe(true)
  })

  test('normal inbound workflow failure leaves no Message and the established retry can succeed', async () => {
    workflowMock.onInboundMessage.mockRejectedValueOnce(new Error('workflow unavailable'))
    const body = {
      externalId: 'd3019fc8d8b19921ec',
      chatId: '900001',
      senderId: '700001',
      text: 'к',
      timestamp: '2026-08-03T18:17:52.281Z',
      messageType: 'text',
      source: 'provider_store_recovery',
      isOutgoing: false,
    }

    const failed = await maxWebhookPost(webhookRequest(body))
    expect(failed.status).toBe(500)
    expect(prismaMock.message.upsert).not.toHaveBeenCalled()

    const retried = await maxWebhookPost(webhookRequest(body))
    expect(retried.status).toBe(200)
    expect(workflowMock.onInboundMessage).toHaveBeenCalledTimes(2)
    expect(prismaMock.message.upsert).toHaveBeenCalledTimes(1)
  })

  test('a delayed old event cannot decrease lastMessageAt and a newer event advances it', async () => {
    let storedLastMessageAt = new Date('2026-08-03T18:17:52.281Z')
    prismaMock.chat.updateMany.mockImplementation(async ({ where, data }) => {
      const incoming = where.OR[1].lastMessageAt.lt as Date
      if (storedLastMessageAt < incoming) storedLastMessageAt = data.lastMessageAt
      return { count: storedLastMessageAt === incoming ? 1 : 0 }
    })

    for (const event of [
      { externalId: 'd3019fc8d8a8e31d6d', text: 'ц', timestamp: '2026-08-03T18:17:50.051Z' },
      { externalId: 'd3019fc8d8b29921ed', text: 'н', timestamp: '2026-08-03T18:17:53.000Z' },
    ]) {
      const response = await maxWebhookPost(webhookRequest({
        ...event,
        chatId: '900001',
        senderId: '700001',
        messageType: 'text',
        source: 'provider_store_recovery',
        isOutgoing: false,
      }))
      expect(response.status).toBe(200)
    }

    expect(storedLastMessageAt.toISOString()).toBe('2026-08-03T18:17:53.000Z')
    expect(prismaMock.chat.updateMany).toHaveBeenCalledTimes(2)
  })

  test('history replay never promotes Chat activity timestamps', async () => {
    const response = await maxWebhookPost(webhookRequest({
      externalId: 'd3019fc8d4774a04bc',
      chatId: '900001',
      senderId: '700001',
      text: 'ывапро',
      timestamp: '2026-08-03T18:13:15.210Z',
      messageType: 'text',
      source: 'catchup',
      isOutgoing: false,
    }))

    expect(response.status).toBe(200)
    expect(prismaMock.message.upsert).toHaveBeenCalledTimes(1)
    expect(prismaMock.chat.updateMany).not.toHaveBeenCalled()
    expect(workflowMock.onInboundMessage).not.toHaveBeenCalled()
  })
})
