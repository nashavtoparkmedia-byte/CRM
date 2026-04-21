import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/telephonyAuth'
import { emitTelephonyEvent } from '@/lib/telephonyEventBus'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { opsLog } from '@/lib/opsLog'

// ─── Helpers ─────────────────────────────────────────────────────

function parseTimestamp(value: string): Date | null {
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d
}

function formatCallContent(
  disposition: string,
  direction: string,
  durationSec: number,
): string {
  const dur = `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`

  if (disposition === 'answered') {
    return direction === 'inbound'
      ? `Входящий звонок · ${dur}`
      : `Исходящий звонок · ${dur}`
  }
  if (disposition === 'missed') {
    return direction === 'inbound' ? 'Пропущенный звонок' : 'Нет ответа'
  }
  if (disposition === 'busy') return 'Занято'
  if (disposition === 'rejected') return 'Отклонён'
  return 'Нет ответа'
}

// ─── Rate limiter (in-memory, per-IP, best-effort) ───────────────

const registerCalls = new Map<string, number[]>()
const REGISTER_LIMIT = 10
const REGISTER_WINDOW_MS = 60 * 60 * 1000

function checkRegisterRateLimit(ip: string): boolean {
  const now = Date.now()
  const timestamps = (registerCalls.get(ip) ?? []).filter(t => now - t < REGISTER_WINDOW_MS)
  if (timestamps.length >= REGISTER_LIMIT) return false
  timestamps.push(now)
  registerCalls.set(ip, timestamps)
  return true
}

// ─── Types ───────────────────────────────────────────────────────

export interface CallEventPayload {
  eventType: 'ringing' | 'answered' | 'ended'
  direction: 'inbound' | 'outbound'
  phoneNumber: string
  callSessionId?: string
  androidCallId?: string
  timestamp: string
  duration?: number
  disposition?: string
}

interface ServiceResult {
  error?: string
  status?: number
  [key: string]: unknown
}

// ═════════════════════════════════════════════════════════════════
// TelephonyService
// ═════════════════════════════════════════════════════════════════

export class TelephonyService {

  // ─── Device Management ──────────────────────────────────────

  static async registerDevice(
    androidId: string,
    name: string,
    phoneNumber?: string,
    simOperator?: string,
    appVersion?: string,
    ip?: string,
  ): Promise<ServiceResult> {
    if (!androidId || androidId.length > 128) return { error: 'invalid_android_id', status: 400 }
    if (!name || name.length > 256) return { error: 'invalid_name', status: 400 }

    if (ip && !checkRegisterRateLimit(ip)) return { error: 'rate_limit_exceeded', status: 429 }

    const normalizedPhone = phoneNumber ? normalizePhoneE164(phoneNumber) : null

    const existing = await prisma.telephonyDevice.findUnique({ where: { androidId: androidId.trim() } })

    const secret = crypto.randomBytes(32).toString('hex')
    const secretHash = hashToken(secret)

    if (existing && existing.isActive) {
      await prisma.telephonyDevice.update({
        where: { id: existing.id },
        data: {
          name: name.trim(),
          phoneNumber: normalizedPhone,
          simOperator: simOperator ?? existing.simOperator,
          appVersion: appVersion ?? existing.appVersion,
          deviceSecret: secretHash,
        },
      })
      opsLog('info', 'device_register', { androidId, ip, isNew: false, reactivated: false, secretRotated: true })
      return { deviceId: existing.id, secret, isNew: false }
    }

    if (existing && !existing.isActive) {
      await prisma.telephonyDevice.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          revokedAt: null,
          deviceSecret: secretHash,
          name: name.trim(),
          phoneNumber: normalizedPhone,
          simOperator: simOperator ?? null,
          appVersion: appVersion ?? null,
          status: 'offline',
        },
      })
      opsLog('info', 'device_register', { androidId, ip, isNew: false, reactivated: true })
      return { deviceId: existing.id, secret, isNew: false }
    }

    const device = await prisma.telephonyDevice.create({
      data: {
        androidId: androidId.trim(),
        name: name.trim(),
        phoneNumber: normalizedPhone,
        simOperator: simOperator ?? null,
        appVersion: appVersion ?? null,
        deviceSecret: secretHash,
      },
    })
    opsLog('info', 'device_register', { androidId, ip, isNew: true })
    return { deviceId: device.id, secret, isNew: true }
  }

  static async heartbeat(
    deviceId: string,
    telemetry: { batteryLevel?: number; signalStrength?: number },
  ) {
    await prisma.telephonyDevice.update({
      where: { id: deviceId },
      data: {
        lastHeartbeat: new Date(),
        status: 'online',
        metadata: {
          batteryLevel: telemetry.batteryLevel ?? null,
          signalStrength: telemetry.signalStrength ?? null,
        },
      },
    })

    const commands = await prisma.telephonyCommand.findMany({
      where: { deviceId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })

    if (commands.length > 0) {
      await prisma.telephonyCommand.updateMany({
        where: { id: { in: commands.map(c => c.id) } },
        data: { status: 'delivered', deliveredAt: new Date() },
      })
    }

    return {
      ok: true,
      commands: commands.map(c => ({ commandId: c.id, type: c.type, payload: c.payload })),
    }
  }

  // ─── Contact Resolution ─────────────────────────────────────

  static async resolveContactByPhone(phoneE164: string) {
    const rec = await prisma.contactPhone.findFirst({
      where: { phone: phoneE164, isActive: true },
      include: { contact: { select: { id: true, displayName: true } } },
    })
    return rec ? { contactId: rec.contact.id, contactName: rec.contact.displayName } : null
  }

  static async createContactForPhone(phoneE164: string) {
    const existing = await prisma.contactPhone.findFirst({
      where: { phone: phoneE164, isActive: true },
      include: { contact: true },
    })
    if (existing) {
      return { contactId: existing.contact.id, contactName: existing.contact.displayName }
    }

    const contact = await prisma.contact.create({
      data: {
        displayName: phoneE164,
        displayNameSource: 'channel',
        masterSource: 'chat',
        phones: {
          create: {
            phone: phoneE164,
            source: 'phone',
            isPrimary: true,
            isActive: true,
          },
        },
      },
    })
    return { contactId: contact.id, contactName: phoneE164 }
  }

  // ─── Call Events ────────────────────────────────────────────

  static async handleCallEvent(
    deviceId: string,
    payload: CallEventPayload,
  ): Promise<ServiceResult> {
    const remoteNumber = normalizePhoneE164(payload.phoneNumber)
    if (!remoteNumber) return { error: 'invalid_phone_number', status: 400 }

    const eventTime = parseTimestamp(payload.timestamp)
    if (!eventTime) return { error: 'invalid_timestamp', status: 400 }

    if (payload.direction !== 'inbound' && payload.direction !== 'outbound') {
      return { error: 'invalid_direction', status: 400 }
    }

    if (payload.eventType === 'ended') {
      if (!payload.disposition) return { error: 'disposition_required', status: 400 }
      if (payload.duration !== undefined && payload.duration < 0) {
        return { error: 'invalid_duration', status: 400 }
      }
    }

    const device = await prisma.telephonyDevice.findUnique({
      where: { id: deviceId },
      select: { id: true, name: true, phoneNumber: true },
    })
    if (!device) return { error: 'device_not_found', status: 404 }

    const direction = payload.direction
    const callerNumber = direction === 'inbound' ? remoteNumber : (device.phoneNumber ?? remoteNumber)
    const calleeNumber = direction === 'outbound' ? remoteNumber : (device.phoneNumber ?? remoteNumber)
    const duration = payload.duration ?? 0

    switch (payload.eventType) {
      case 'ringing':
        return this._handleRinging(deviceId, payload, remoteNumber, eventTime, direction, callerNumber, calleeNumber)
      case 'answered':
        return this._handleAnswered(deviceId, payload, remoteNumber, eventTime)
      case 'ended':
        return this._handleEnded(deviceId, payload, remoteNumber, eventTime, direction, callerNumber, calleeNumber, duration, device)
      default:
        return { error: 'invalid_event_type', status: 400 }
    }
  }

  private static async _handleRinging(
    deviceId: string,
    payload: CallEventPayload,
    remoteNumber: string,
    eventTime: Date,
    direction: string,
    callerNumber: string,
    calleeNumber: string,
  ): Promise<ServiceResult> {
    const existing = await this._findExistingSession(deviceId, payload, remoteNumber, ['ringing'])
    if (existing) {
      const contact = existing.contactId
        ? await prisma.contact.findUnique({ where: { id: existing.contactId }, select: { displayName: true } })
        : null
      return {
        callSessionId: existing.id,
        contactId: existing.contactId,
        contactName: contact?.displayName,
        idempotent: true,
      }
    }

    const session = await prisma.callSession.create({
      data: {
        deviceId,
        direction: direction as 'inbound' | 'outbound',
        callerNumber,
        calleeNumber,
        status: 'ringing',
        startedAt: eventTime,
        androidCallId: payload.androidCallId,
      },
    })

    const contactResult = await this.resolveContactByPhone(remoteNumber)
    if (contactResult) {
      await prisma.callSession.update({
        where: { id: session.id },
        data: { contactId: contactResult.contactId },
      })
    }

    emitTelephonyEvent('call:ringing', {
      callSessionId: session.id,
      direction,
      phoneNumber: remoteNumber,
      contactId: contactResult?.contactId,
      contactName: contactResult?.contactName,
    })

    return {
      callSessionId: session.id,
      contactId: contactResult?.contactId,
      contactName: contactResult?.contactName,
    }
  }

  private static async _handleAnswered(
    deviceId: string,
    payload: CallEventPayload,
    remoteNumber: string,
    eventTime: Date,
  ): Promise<ServiceResult> {
    const session = await this._findExistingSession(deviceId, payload, remoteNumber, ['ringing', 'active'])
    if (!session) return { error: 'call_session_not_found', status: 404 }

    if (session.status === 'active') {
      return { callSessionId: session.id, idempotent: true }
    }

    await prisma.callSession.update({
      where: { id: session.id },
      data: { status: 'active', answeredAt: eventTime },
    })

    emitTelephonyEvent('call:answered', { callSessionId: session.id })
    return { callSessionId: session.id }
  }

  private static async _handleEnded(
    deviceId: string,
    payload: CallEventPayload,
    remoteNumber: string,
    eventTime: Date,
    direction: string,
    callerNumber: string,
    calleeNumber: string,
    duration: number,
    device: { id: string; name: string; phoneNumber: string | null },
  ): Promise<ServiceResult> {
    let session = await this._findExistingSession(
      deviceId, payload, remoteNumber, ['ringing', 'active', 'completed'],
    )

    if (session && session.status === 'completed' && session.messageId) {
      return {
        callSessionId: session.id,
        chatId: session.chatId,
        messageId: session.messageId,
        contactId: session.contactId,
        idempotent: true,
      }
    }

    if (!session) {
      session = await prisma.callSession.create({
        data: {
          deviceId,
          direction: direction as 'inbound' | 'outbound',
          callerNumber,
          calleeNumber,
          status: 'completed',
          startedAt: eventTime,
          endedAt: eventTime,
          answeredAt: payload.disposition === 'answered' ? eventTime : null,
          duration,
          disposition: payload.disposition as any,
          androidCallId: payload.androidCallId,
          metadata: { recovery: true },
        },
      })
    } else {
      await prisma.callSession.update({
        where: { id: session.id },
        data: {
          status: 'completed',
          endedAt: eventTime,
          duration,
          disposition: payload.disposition as any,
        },
      })
    }

    let contactResult = await this.resolveContactByPhone(remoteNumber)
    if (!contactResult) {
      contactResult = await this.createContactForPhone(remoteNumber)
    }
    await prisma.callSession.update({
      where: { id: session.id },
      data: { contactId: contactResult.contactId },
    })

    const ecid = `phone:${contactResult.contactId}`
    const chat = await prisma.chat.upsert({
      where: { externalChatId: ecid },
      update: { lastMessageAt: eventTime },
      create: {
        channel: 'phone',
        externalChatId: ecid,
        contactId: contactResult.contactId,
        name: contactResult.contactName,
        status: 'new',
        lastMessageAt: eventTime,
      },
    })

    const cmi = `call_${session.id}`
    const existingMsg = await prisma.message.findUnique({ where: { clientMessageId: cmi } })
    let messageId: string

    if (existingMsg) {
      messageId = existingMsg.id
    } else {
      const msg = await prisma.message.create({
        data: {
          clientMessageId: cmi,
          chatId: chat.id,
          direction: direction === 'inbound' ? 'inbound' : 'outbound',
          type: 'call',
          content: formatCallContent(payload.disposition!, direction, duration),
          status: 'delivered',
          channel: 'phone',
          sentAt: eventTime,
          metadata: {
            callSessionId: session.id,
            duration,
            disposition: payload.disposition,
            callerNumber,
            calleeNumber,
            deviceId: device.id,
            deviceName: device.name,
          },
        },
      })
      messageId = msg.id
    }

    // ConversationWorkflowService handles unreadCount, requiresResponse, lastInboundAt/lastOutboundAt, status transitions.
    // We only update lastMessageAt here (for both directions) to keep Chat.lastMessageAt in sync.
    // Do NOT increment unreadCount separately — onInboundMessage already does it.
    await prisma.chat.update({
      where: { id: chat.id },
      data: { lastMessageAt: eventTime },
    })

    if (direction === 'inbound') {
      await ConversationWorkflowService.onInboundMessage(chat.id, eventTime)
    } else {
      await ConversationWorkflowService.onOutboundMessage(chat.id, eventTime)
    }

    await prisma.callSession.update({
      where: { id: session.id },
      data: { chatId: chat.id, messageId },
    })

    emitTelephonyEvent('call:ended', {
      callSessionId: session.id,
      chatId: chat.id,
      messageId,
      duration,
      disposition: payload.disposition,
      contactId: contactResult.contactId,
    })

    return {
      callSessionId: session.id,
      chatId: chat.id,
      messageId,
      contactId: contactResult.contactId,
    }
  }

  // ─── Idempotency Search ─────────────────────────────────────

  private static async _findExistingSession(
    deviceId: string,
    payload: CallEventPayload,
    remoteNumber: string,
    allowedStatuses: string[],
  ) {
    if (payload.callSessionId) {
      const s = await prisma.callSession.findUnique({ where: { id: payload.callSessionId } })
      if (s && s.deviceId === deviceId && allowedStatuses.includes(s.status)) return s
    }

    if (payload.androidCallId) {
      const s = await prisma.callSession.findFirst({
        where: { deviceId, androidCallId: payload.androidCallId, status: { in: allowedStatuses } },
      })
      if (s) return s
    }

    const fallbackStatuses = allowedStatuses.filter(s => s === 'ringing' || s === 'active')
    if (fallbackStatuses.length === 0) return null

    return prisma.callSession.findFirst({
      where: {
        deviceId,
        OR: [
          { callerNumber: remoteNumber },
          { calleeNumber: remoteNumber },
        ],
        status: { in: fallbackStatuses },
        startedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      orderBy: { startedAt: 'desc' },
    })
  }

  // ─── Commands ───────────────────────────────────────────────

  static async enqueueCommand(
    deviceId: string,
    type: string,
    payload: { phoneNumber: string; contactId?: string },
  ): Promise<ServiceResult> {
    const device = await prisma.telephonyDevice.findUnique({
      where: { id: deviceId },
      select: { isActive: true },
    })
    if (!device) return { error: 'device_not_found', status: 404 }
    if (!device.isActive) return { error: 'device_revoked', status: 400 }

    const phone = normalizePhoneE164(payload.phoneNumber)
    if (!phone) return { error: 'invalid_phone_number', status: 400 }

    const cmd = await prisma.telephonyCommand.create({
      data: {
        deviceId,
        type,
        payload: { ...payload, phoneNumber: phone },
        status: 'pending',
      },
    })

    return { commandId: cmd.id }
  }

  static async confirmCommandExecution(
    commandId: string,
    deviceId: string,
    success: boolean,
    failReason?: string,
  ): Promise<ServiceResult> {
    const command = await prisma.telephonyCommand.findUnique({ where: { id: commandId } })

    if (!command || command.deviceId !== deviceId) {
      return { error: 'not_found', status: 404 }
    }

    if (command.status === 'executed' || command.status === 'failed') {
      return { ok: true, idempotent: true }
    }

    if (command.status !== 'delivered') {
      return { error: 'invalid_state', status: 400 }
    }

    await prisma.telephonyCommand.update({
      where: { id: commandId },
      data: success
        ? { status: 'executed', executedAt: new Date() }
        : { status: 'failed', failedAt: new Date(), failReason },
    })

    return { ok: true }
  }

  // ─── Device Lifecycle ───────────────────────────────────────

  static async revokeDevice(deviceId: string) {
    await prisma.telephonyDevice.update({
      where: { id: deviceId },
      data: { isActive: false, revokedAt: new Date(), status: 'offline' },
    })

    await prisma.telephonyCommand.updateMany({
      where: { deviceId, status: 'pending' },
      data: { status: 'failed', failReason: 'device_revoked', failedAt: new Date() },
    })

    await prisma.telephonyCommand.updateMany({
      where: { deviceId, status: 'delivered' },
      data: { status: 'failed', failReason: 'device_revoked', failedAt: new Date() },
    })

    emitTelephonyEvent('device:offline', { deviceId })
    return { success: true }
  }

  static async markOfflineStaleDevices() {
    const stale = await prisma.telephonyDevice.findMany({
      where: {
        isActive: true,
        status: 'online',
        lastHeartbeat: { lt: new Date(Date.now() - 90_000) },
      },
      select: { id: true },
    })

    if (stale.length === 0) return

    await prisma.telephonyDevice.updateMany({
      where: { id: { in: stale.map(d => d.id) } },
      data: { status: 'offline' },
    })

    for (const d of stale) {
      try { emitTelephonyEvent('device:offline', { deviceId: d.id }) } catch { /* best-effort */ }
    }
  }

  // ─── Queries ────────────────────────────────────────────────

  static async listDevices() {
    return prisma.telephonyDevice.findMany({
      select: {
        id: true,
        androidId: true,
        name: true,
        phoneNumber: true,
        simOperator: true,
        status: true,
        isActive: true,
        revokedAt: true,
        lastHeartbeat: true,
        appVersion: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
  }
}
