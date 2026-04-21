import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  telephonyDevice: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  callSession: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  telephonyCommand: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  chat: { upsert: vi.fn(), update: vi.fn() },
  message: { findUnique: vi.fn(), create: vi.fn() },
  contact: { findUnique: vi.fn(), create: vi.fn() },
  contactPhone: { findFirst: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/telephonyEventBus', () => ({ emitTelephonyEvent: vi.fn() }))
vi.mock('@/lib/ConversationWorkflowService', () => ({
  ConversationWorkflowService: { onInboundMessage: vi.fn(), onOutboundMessage: vi.fn() },
}))
vi.mock('@/lib/opsLog', () => ({ opsLog: vi.fn() }))

import { TelephonyService, CallEventPayload } from '../TelephonyService'
import { emitTelephonyEvent } from '../telephonyEventBus'

const NOW = '2026-04-08T12:00:00.000Z'
const DEVICE_ID = 'dev_1'
const DEVICE = { id: DEVICE_ID, name: 'Test Phone', phoneNumber: '+79001234567' }
const SESSION_ID = 'sess_1'

function pay(overrides: Partial<CallEventPayload> = {}): CallEventPayload {
  return { eventType: 'ringing', direction: 'inbound', phoneNumber: '+79221234567', timestamp: NOW, ...overrides }
}

beforeEach(() => { vi.clearAllMocks(); mockPrisma.telephonyDevice.findUnique.mockResolvedValue(DEVICE) })

describe('handleCallEvent validation', () => {
  it('rejects invalid phone', async () => {
    expect((await TelephonyService.handleCallEvent(DEVICE_ID, pay({ phoneNumber: 'abc' }))).error).toBe('invalid_phone_number')
  })
  it('rejects invalid timestamp', async () => {
    expect((await TelephonyService.handleCallEvent(DEVICE_ID, pay({ timestamp: 'bad' }))).error).toBe('invalid_timestamp')
  })
  it('rejects negative duration', async () => {
    expect((await TelephonyService.handleCallEvent(DEVICE_ID, pay({ eventType: 'ended', disposition: 'answered', duration: -1 }))).error).toBe('invalid_duration')
  })
  it('rejects ended without disposition', async () => {
    expect((await TelephonyService.handleCallEvent(DEVICE_ID, pay({ eventType: 'ended' }))).error).toBe('disposition_required')
  })
  it('rejects invalid direction', async () => {
    expect((await TelephonyService.handleCallEvent(DEVICE_ID, pay({ direction: 'x' as any }))).error).toBe('invalid_direction')
  })
})

describe('ringing', () => {
  it('creates new CallSession', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue(null)
    mockPrisma.callSession.findFirst.mockResolvedValue(null)
    mockPrisma.callSession.create.mockResolvedValue({ id: SESSION_ID })
    mockPrisma.contactPhone.findFirst.mockResolvedValue(null)
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, pay())
    expect(r.callSessionId).toBe(SESSION_ID)
    expect(mockPrisma.callSession.create).toHaveBeenCalledOnce()
    expect(emitTelephonyEvent).toHaveBeenCalledWith('call:ringing', expect.objectContaining({ callSessionId: SESSION_ID }))
  })

  it('idempotent for duplicate ringing', async () => {
    mockPrisma.callSession.findFirst.mockResolvedValue({ id: SESSION_ID, deviceId: DEVICE_ID, status: 'ringing', contactId: null })
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, pay({ androidCallId: 'a1' }))
    expect(r.idempotent).toBe(true)
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled()
  })

  it('resolves existing contact', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue(null)
    mockPrisma.callSession.findFirst.mockResolvedValue(null)
    mockPrisma.callSession.create.mockResolvedValue({ id: SESSION_ID })
    mockPrisma.contactPhone.findFirst.mockResolvedValue({ contact: { id: 'c1', displayName: 'Иван' } })
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, pay())
    expect(r.contactId).toBe('c1')
    expect(r.contactName).toBe('Иван')
  })
})

describe('answered', () => {
  it('404 if no session', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue(null)
    mockPrisma.callSession.findFirst.mockResolvedValue(null)
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, pay({ eventType: 'answered', callSessionId: 'x' }))
    expect(r.error).toBe('call_session_not_found')
  })

  it('idempotent if already active', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue({ id: SESSION_ID, deviceId: DEVICE_ID, status: 'active' })
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, pay({ eventType: 'answered', callSessionId: SESSION_ID }))
    expect(r.idempotent).toBe(true)
  })
})

describe('ended', () => {
  const ep = pay({ eventType: 'ended', disposition: 'answered', duration: 30 })

  function mockEnded() {
    mockPrisma.callSession.findUnique.mockResolvedValue({ id: SESSION_ID, deviceId: DEVICE_ID, status: 'active', messageId: null, chatId: null, contactId: null })
    mockPrisma.callSession.update.mockResolvedValue({})
    mockPrisma.contactPhone.findFirst.mockResolvedValue({ contact: { id: 'c1', displayName: 'Тест' } })
    mockPrisma.chat.upsert.mockResolvedValue({ id: 'chat_1' })
    mockPrisma.message.findUnique.mockResolvedValue(null)
    mockPrisma.message.create.mockResolvedValue({ id: 'msg_1' })
  }

  it('creates Chat and Message', async () => {
    mockEnded()
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, ep)
    expect(r.chatId).toBe('chat_1')
    expect(r.messageId).toBe('msg_1')
  })

  it('idempotent if completed with messageId', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue({ id: SESSION_ID, deviceId: DEVICE_ID, status: 'completed', messageId: 'msg_1', chatId: 'chat_1', contactId: 'c1' })
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, { ...ep, callSessionId: SESSION_ID })
    expect(r.idempotent).toBe(true)
    expect(mockPrisma.message.create).not.toHaveBeenCalled()
  })

  it('recovery when no prior ringing', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue(null)
    mockPrisma.callSession.findFirst.mockResolvedValue(null)
    mockPrisma.callSession.create.mockResolvedValue({ id: 'rec_1', status: 'completed', messageId: null, chatId: null, contactId: null })
    mockPrisma.callSession.update.mockResolvedValue({})
    mockPrisma.contactPhone.findFirst.mockResolvedValue(null)
    mockPrisma.contact.create.mockResolvedValue({ id: 'nc1' })
    mockPrisma.chat.upsert.mockResolvedValue({ id: 'chr1' })
    mockPrisma.message.findUnique.mockResolvedValue(null)
    mockPrisma.message.create.mockResolvedValue({ id: 'mr1' })
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, ep)
    expect(r.callSessionId).toBe('rec_1')
    expect(mockPrisma.callSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ metadata: { recovery: true } }),
    }))
  })

  it('recovery answered sets answeredAt', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue(null)
    mockPrisma.callSession.findFirst.mockResolvedValue(null)
    mockPrisma.callSession.create.mockResolvedValue({ id: 'r2', status: 'completed', messageId: null, chatId: null, contactId: null })
    mockPrisma.callSession.update.mockResolvedValue({})
    mockPrisma.contactPhone.findFirst.mockResolvedValue(null)
    mockPrisma.contact.create.mockResolvedValue({ id: 'nc2' })
    mockPrisma.chat.upsert.mockResolvedValue({ id: 'ch2' })
    mockPrisma.message.findUnique.mockResolvedValue(null)
    mockPrisma.message.create.mockResolvedValue({ id: 'mr2' })
    await TelephonyService.handleCallEvent(DEVICE_ID, { ...ep, disposition: 'answered' })
    expect(mockPrisma.callSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ answeredAt: expect.any(Date) }),
    }))
  })

  it('existingMsg found, session.messageId null → back-ref updated', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue({ id: SESSION_ID, deviceId: DEVICE_ID, status: 'active', messageId: null, chatId: null, contactId: null })
    mockPrisma.callSession.update.mockResolvedValue({})
    mockPrisma.contactPhone.findFirst.mockResolvedValue({ contact: { id: 'c1', displayName: 'T' } })
    mockPrisma.chat.upsert.mockResolvedValue({ id: 'chat_1' })
    mockPrisma.message.findUnique.mockResolvedValue({ id: 'existing_msg' })
    const r = await TelephonyService.handleCallEvent(DEVICE_ID, ep)
    expect(r.messageId).toBe('existing_msg')
    expect(mockPrisma.message.create).not.toHaveBeenCalled()
    const backRef = mockPrisma.callSession.update.mock.calls.find((c: any) => c[0]?.data?.messageId === 'existing_msg')
    expect(backRef).toBeTruthy()
  })

  it('outbound ended updates lastMessageAt', async () => {
    mockPrisma.callSession.findUnique.mockResolvedValue({ id: SESSION_ID, deviceId: DEVICE_ID, status: 'active', messageId: null, chatId: null, contactId: null })
    mockPrisma.callSession.update.mockResolvedValue({})
    mockPrisma.contactPhone.findFirst.mockResolvedValue({ contact: { id: 'c1', displayName: 'T' } })
    mockPrisma.chat.upsert.mockResolvedValue({ id: 'chat_1' })
    mockPrisma.message.findUnique.mockResolvedValue(null)
    mockPrisma.message.create.mockResolvedValue({ id: 'mo' })
    await TelephonyService.handleCallEvent(DEVICE_ID, { ...ep, direction: 'outbound' })
    expect(mockPrisma.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
    }))
  })
})

describe('confirmCommandExecution', () => {
  it('404 for wrong device', async () => {
    mockPrisma.telephonyCommand.findUnique.mockResolvedValue({ id: 'c1', deviceId: 'other', status: 'delivered' })
    expect((await TelephonyService.confirmCommandExecution('c1', DEVICE_ID, true)).error).toBe('not_found')
  })

  it('invalid_state for pending', async () => {
    mockPrisma.telephonyCommand.findUnique.mockResolvedValue({ id: 'c1', deviceId: DEVICE_ID, status: 'pending' })
    expect((await TelephonyService.confirmCommandExecution('c1', DEVICE_ID, true)).error).toBe('invalid_state')
  })

  it('idempotent for executed', async () => {
    mockPrisma.telephonyCommand.findUnique.mockResolvedValue({ id: 'c1', deviceId: DEVICE_ID, status: 'executed' })
    const r = await TelephonyService.confirmCommandExecution('c1', DEVICE_ID, true)
    expect(r.idempotent).toBe(true)
    expect(mockPrisma.telephonyCommand.update).not.toHaveBeenCalled()
  })

  it('idempotent for failed', async () => {
    mockPrisma.telephonyCommand.findUnique.mockResolvedValue({ id: 'c1', deviceId: DEVICE_ID, status: 'failed' })
    expect((await TelephonyService.confirmCommandExecution('c1', DEVICE_ID, false)).idempotent).toBe(true)
  })
})

describe('revokeDevice', () => {
  it('sets isActive=false and cancels commands', async () => {
    mockPrisma.telephonyDevice.update.mockResolvedValue({})
    mockPrisma.telephonyCommand.updateMany.mockResolvedValue({ count: 2 })
    await TelephonyService.revokeDevice(DEVICE_ID)
    expect(mockPrisma.telephonyDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isActive: false }),
    }))
    expect(mockPrisma.telephonyCommand.updateMany).toHaveBeenCalledTimes(2)
    expect(emitTelephonyEvent).toHaveBeenCalledWith('device:offline', { deviceId: DEVICE_ID })
  })
})
