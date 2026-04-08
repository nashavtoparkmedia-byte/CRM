'use server'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { emitMessageReceived } from '@/lib/messageEvents'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { opsLog } from '@/lib/opsLog'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { externalId, chatId, senderId, senderName, senderPhone, text, timestamp, messageType, attachments, isOutgoing } = body

    if (!chatId) {
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 })
    }

    const externalChatId = String(chatId)

    // Find or create Chat
    let chat = await prisma.chat.findUnique({
      where: { externalChatId },
    })

    const sentAt = timestamp ? new Date(timestamp) : new Date()

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          channel:       'max',
          externalChatId,
          name:          senderName || (senderId ? `MAX:${senderId}` : `MAX:${externalChatId}`),
          lastMessageAt: sentAt,
          status:        'new',
          metadata: {
            ...(senderId    ? { senderId: String(senderId) } : {}),
            ...(senderPhone ? { phone: senderPhone }         : {}),
          },
        },
      })
    } else {
      await prisma.chat.update({
        where: { id: chat.id },
        data: {
          lastMessageAt: sentAt,
          // Обновляем имя если раньше было только MAX:ID
          ...(senderName && chat.name?.startsWith('MAX:') ? { name: senderName } : {}),
          // Обновляем senderId / phone в metadata
          ...((senderId || senderPhone) ? {
            metadata: {
              ...((chat.metadata as any) || {}),
              ...(senderId    ? { senderId: String(senderId) } : {}),
              ...(senderPhone ? { phone: senderPhone }         : {}),
            }
          } : {}),
        },
      })
    }

    // Workflow: update status/unread/requiresResponse via centralized service
    if (!isOutgoing) {
      await ConversationWorkflowService.onInboundMessage(chat.id, sentAt)
    } else {
      await ConversationWorkflowService.onOutboundMessage(chat.id, sentAt)
    }

    // Map messageType to Prisma MessageType enum
    const typeMap: Record<string, string> = {
      text:     'text',
      image:    'image',
      video:    'video',
      voice:    'voice',
      audio:    'audio',
      document: 'document',
    }
    const msgType = typeMap[messageType] || 'text'

    // For non-text messages without text, use a readable placeholder
    const contentFallbacks: Record<string, string> = {
      image: '[Фото]', video: '[Видео]', voice: '[Голосовое]',
      audio: '[Аудио]', document: '[Документ]',
    }
    const content = text || contentFallbacks[messageType] || ''

    // Create Message (skip if already seen)
    const message = await prisma.message.upsert({
      where:  { externalId: externalId || `max-${chatId}-${Date.now()}` },
      update: {},
      create: {
        chatId:    chat.id,
        direction: isOutgoing ? 'outbound' : 'inbound',
        type:      msgType as any,
        content,
        channel:   'max',
        externalId: externalId || null,
        status:    'delivered',
        sentAt:    timestamp ? new Date(timestamp) : new Date(),
        metadata:  { senderId, maxChatId: chatId, attachments: attachments || [] },
      },
    })

    // Save attachments
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (!att.url) continue
        await prisma.messageAttachment.create({
          data: {
            messageId: message.id,
            type:      att.type || 'file',
            url:       att.url,
            fileName:  att.name || null,
            fileSize:  att.size || null,
            mimeType:  null,
          },
        })
      }
    }

    console.log(`[MAX Webhook] chatId=${chatId} direction=${isOutgoing ? 'out' : 'in'} text="${(text || '').slice(0, 50)}"`)

    // Привязываем чат к водителю (по телефону/имени из MAX)
    if (!isOutgoing && !chat.driverId && (senderPhone || senderName)) {
      DriverMatchService.linkChatToDriver(chat.id, { phone: senderPhone, name: senderName }).catch(e =>
        console.error('[MAX Webhook] linkChatToDriver error:', e.message)
      )
    }

    // ── Contact Model dual write ──────────────────────────────
    if (!isOutgoing) {
      try {
        // Стабильный externalId: senderId > chatId (chatId может быть phone или max_name:*)
        const maxExternalId = senderId ? String(senderId) : externalChatId
        const maxPhone = senderPhone ? normalizePhoneE164(senderPhone) : null

        const contactResult = await ContactService.resolveContact(
          'max',
          maxExternalId,
          maxPhone,
          senderName || null,
        )
        await ContactService.ensureChatLinked(
          chat.id,
          contactResult.contact.id,
          contactResult.identity.id,
        )
      } catch (contactErr: any) {
        console.error(`[MAX Webhook] ContactService error (non-blocking): ${contactErr.message}`)
      }
    }
    // ──────────────────────────────────────────────────────────

    // Запускаем AI pipeline для входящих сообщений (не дожидаемся)
    if (!isOutgoing) {
      emitMessageReceived(message).catch(e =>
        console.error('[MAX Webhook] emitMessageReceived error:', e.message)
      )
    }

    return NextResponse.json({ success: true, chatInternalId: chat.id, messageId: message.id })
  } catch (err: any) {
    opsLog('error', 'webhook_max_error', { channel: 'max', error: err.message })
    return NextResponse.json({ error: 'Internal Server Error', details: err.message }, { status: 500 })
  }
}
