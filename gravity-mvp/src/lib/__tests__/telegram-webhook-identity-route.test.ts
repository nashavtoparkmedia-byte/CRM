import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  botChatMessage: { create: vi.fn() },
  chat: { upsert: vi.fn(), findUnique: vi.fn() },
  message: { findFirst: vi.fn(), create: vi.fn() },
  contact: { findUnique: vi.fn(), update: vi.fn() },
  contactIdentity: { findUnique: vi.fn(), update: vi.fn() },
  driverTelegram: { findUnique: vi.fn(), update: vi.fn() },
}))

const contactServiceMock = vi.hoisted(() => ({
  resolveContact: vi.fn(),
  ensureChatLinked: vi.fn(),
}))

const driverMatchMock = vi.hoisted(() => ({ linkChatToDriver: vi.fn() }))
const workflowMock = vi.hoisted(() => ({
  onInboundMessage: vi.fn(),
  onOutboundMessage: vi.fn(),
  onGroupInboundMessage: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/ContactService', () => ({ ContactService: contactServiceMock }))
vi.mock('@/lib/DriverMatchService', () => ({ DriverMatchService: driverMatchMock }))
vi.mock('@/lib/ConversationWorkflowService', () => ({ ConversationWorkflowService: workflowMock }))
vi.mock('@/app/tg-bot-actions', () => ({ sendTelegramBotMessage: vi.fn() }))
vi.mock('@/app/actions', () => ({ changeDriverLimit: vi.fn() }))
vi.mock('@/lib/opsLog', () => ({ opsLog: vi.fn() }))

import { POST } from '@/app/api/webhook/telegram/route'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/webhook/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

describe('Telegram webhook identity enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.botChatMessage.create.mockResolvedValue({ id: 'bot-message-1' })
    prismaMock.chat.upsert.mockResolvedValue({ id: 'chat-1', driverId: 'driver-1' })
    prismaMock.message.findFirst.mockResolvedValue(null)
    prismaMock.message.create.mockResolvedValue({ id: 'message-1' })
    prismaMock.driverTelegram.findUnique.mockResolvedValue(null)
    contactServiceMock.resolveContact.mockResolvedValue({
      contact: { id: 'contact-1' },
      identity: { id: 'identity-1' },
      isNew: true,
    })
    contactServiceMock.ensureChatLinked.mockResolvedValue(undefined)
    prismaMock.contactIdentity.findUnique.mockResolvedValue({
      displayName: '@old_name',
      metadata: { retainedAuditField: 'keep-me' },
    })
    prismaMock.contactIdentity.update.mockResolvedValue({ id: 'identity-1' })
  })

  it('uses telegramId as the stable key and records a mutable username observation', async () => {
    const response = await POST(request({
      telegramId: '100500',
      text: 'Здравствуйте',
      direction: 'INCOMING',
      username: 'new_name',
      firstName: 'Ivan',
      lastName: 'Petrov',
      timestamp: '2026-07-17T12:00:00.000Z',
    }))

    expect(response.status).toBe(200)
    expect(contactServiceMock.resolveContact).toHaveBeenCalledWith(
      'telegram',
      '100500',
      null,
      '@new_name',
    )
    expect(prismaMock.contactIdentity.update).toHaveBeenCalledWith({
      where: { id: 'identity-1' },
      data: {
        displayName: '@new_name',
        metadata: expect.objectContaining({
          telegramUserId: '100500',
          username: 'new_name',
          lastObservedUsername: 'new_name',
          retainedAuditField: 'keep-me',
          lastObservedSource: 'telegram_webhook',
        }),
      },
    })
  })
})
