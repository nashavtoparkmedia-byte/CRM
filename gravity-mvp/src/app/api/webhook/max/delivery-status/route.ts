import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { opsLog } from '@/lib/opsLog'
import {
  buildMaxDeliveryMetadata,
  canApplyMaxDeliveryTransition,
  isRealMaxMessageId,
  maxDeliveryTargetStatus,
  type MaxDeliveryStatus,
} from '@/lib/max-delivery-state'

type DeliveryBody = {
  queueId?: string | null
  crmMessageId?: string | null
  clientMessageId?: string | null
  status?: MaxDeliveryStatus | null
  attempt?: number | null
  retryable?: boolean | null
  error?: string | null
  errorCode?: string | null
  externalId?: string | null
  chatId?: string | null
  uiChatId?: string | null
  quotedMsgId?: string | null
  source?: string | null
  deliveryConfirmed?: boolean | null
  updatedAt?: string | null
}

const ALLOWED = new Set<MaxDeliveryStatus>(['queued', 'sending', 'delivered', 'failed'])

export async function POST(request: NextRequest) {
  if (request.headers.get('x-max-delivery-source') !== 'max-scraper') {
    return NextResponse.json({ error: 'invalid source' }, { status: 403 })
  }

  const body = await request.json().catch(() => null) as DeliveryBody | null
  if (!body?.status || !ALLOWED.has(body.status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  }
  if (!body.crmMessageId && !body.clientMessageId) {
    return NextResponse.json({ error: 'message identity is required' }, { status: 400 })
  }
  if (body.status === 'delivered' && !isRealMaxMessageId(body.externalId)) {
    return NextResponse.json({ error: 'delivered requires real MAX message id' }, { status: 400 })
  }

  const message = await prisma.message.findFirst({
    where: {
      OR: [
        ...(body.crmMessageId ? [{ id: body.crmMessageId }] : []),
        ...(body.clientMessageId ? [{ clientMessageId: body.clientMessageId }] : []),
      ],
    },
    select: {
      id: true,
      chatId: true,
      channel: true,
      direction: true,
      status: true,
      externalId: true,
      metadata: true,
    },
  })
  if (!message) {
    return NextResponse.json({ error: 'message not found', retryable: true }, { status: 404 })
  }
  if (message.channel !== 'max' || message.direction !== 'outbound') {
    return NextResponse.json({ error: 'message is not outbound MAX' }, { status: 409 })
  }

  const nextStatus = maxDeliveryTargetStatus(body.status)
  if (!canApplyMaxDeliveryTransition(message.status, nextStatus)) {
    return NextResponse.json({
      success: true,
      ignored: 'stale_transition',
      currentStatus: message.status,
    })
  }

  if (body.externalId) {
    const owner = await prisma.message.findFirst({
      where: { externalId: body.externalId },
      select: { id: true },
    })
    if (owner && owner.id !== message.id) {
      opsLog('error', 'max_delivery_external_id_conflict', {
        messageId: message.id,
        conflictingMessageId: owner.id,
        externalId: body.externalId,
      })
      return NextResponse.json({ error: 'external id already belongs to another message' }, { status: 409 })
    }
  }

  const nextMetadata = buildMaxDeliveryMetadata(message.metadata, {
    queueId: body.queueId,
    status: body.status,
    attempt: body.attempt,
    retryable: body.retryable,
    error: body.error,
    errorCode: body.errorCode,
    externalId: body.externalId,
    chatId: body.chatId,
    uiChatId: body.uiChatId,
    quotedMsgId: body.quotedMsgId,
    source: body.source,
    updatedAt: body.updatedAt,
  })

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      status: nextStatus,
      externalId: isRealMaxMessageId(body.externalId) ? body.externalId : undefined,
      metadata: nextMetadata as Prisma.InputJsonValue,
    },
  })

  try {
    broadcastChatMessage(message.chatId, updated)
  } catch {
    // Realtime UI is best effort; DB remains the source of truth.
  }
  opsLog(body.status === 'failed' ? 'warn' : 'info', 'max_delivery_status_updated', {
    messageId: message.id,
    chatId: message.chatId,
    status: body.status,
    queueId: body.queueId || undefined,
    attempt: Number(body.attempt || 0),
    retryable: body.retryable !== false,
  })

  return NextResponse.json({
    success: true,
    messageId: message.id,
    status: nextStatus,
  })
}
