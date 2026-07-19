import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getRenderedMessageText } from '@/lib/max-message-render-text'

const prismaMock = vi.hoisted(() => ({
  chat: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  message: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks()
    storedMessage = {}

    prismaMock.message.findUnique.mockResolvedValue(null)
    prismaMock.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      channel: 'max',
      externalChatId: '900001',
      name: 'MAX fixture',
      metadata: {},
      driverId: 'driver-1',
    })
    prismaMock.chat.update.mockResolvedValue({ id: 'chat-1' })
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
    prismaMock.message.findMany.mockImplementation(async () => [storedMessage])

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
})
