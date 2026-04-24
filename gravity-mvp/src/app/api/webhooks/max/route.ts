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

    // Reject empty text messages (pure protocol noise — ack / receipt
    // frames shouldn't render as empty bubbles in the UI).
    const trimmedText = typeof text === 'string' ? text.trim() : ''
    const isTextType = !messageType || messageType === 'text'
    if (isTextType && !trimmedText && (!attachments || attachments.length === 0)) {
      return NextResponse.json({ ok: true, skipped: 'empty_text' })
    }

    // Validate timestamp — same pattern as WA/TG. MAX timestamps are
    // ms since epoch (JS Date constructor input). Accept only values
    // within [2015-01-01 .. now+1h]; reject corrupted/absent.
    const MIN_TS_MS = Date.UTC(2015, 0, 1)
    const FUTURE_TOLERANCE_MS = 60 * 60 * 1000
    const nowMs = Date.now()
    let sentAt: Date
    if (timestamp) {
      const ts = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp))
      if (!Number.isFinite(ts) || ts < MIN_TS_MS || ts > nowMs + FUTURE_TOLERANCE_MS) {
        // Corrupted timestamp — skip rather than file under wrong date.
        return NextResponse.json({ ok: true, skipped: 'bad_timestamp', value: timestamp })
      }
      sentAt = new Date(ts)
    } else {
      sentAt = new Date()
    }

    const externalChatId = String(chatId)

    // Find or create Chat
    let chat = await prisma.chat.findUnique({
      where: { externalChatId },
    })

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
            connectionId: 'max_scraper',
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
              connectionId: (chat.metadata as any)?.connectionId || 'max_scraper',
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

    // Map messageType to Prisma MessageType enum.
    // Defensive: if the scraper classified as 'document' but the first
    // attachment is actually a sticker, override. MAX ships stickers
    // with _type='STICKER' which older scraper versions bucketed as
    // document — the new MessageParser branch already emits 'sticker',
    // but this guard catches any in-flight or legacy frames.
    const typeMap: Record<string, string> = {
      text:     'text',
      image:    'image',
      video:    'video',
      voice:    'voice',
      audio:    'audio',
      document: 'document',
      sticker:  'sticker',
    }
    let effectiveMessageType = messageType
    if (attachments && attachments.length > 0) {
      const firstAttType = String(attachments[0]?.type || '').toLowerCase()
      if (firstAttType === 'sticker' || firstAttType === 'smile') {
        effectiveMessageType = 'sticker'
      }
    }
    const msgType = typeMap[effectiveMessageType] || 'text'

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
        sentAt,   // validated above
        metadata:  { senderId, maxChatId: chatId, attachments: attachments || [] },
      },
    })

    // Save attachments. Dedup by url first — MAX scraper sometimes sends
    // the same sticker/image twice (preview + full, or two frames of a
    // protocol that we both flatten). Without this, the UI renders N
    // copies of the same frog.
    if (attachments && attachments.length > 0) {
      const seenUrls = new Set<string>()
      for (const att of attachments) {
        if (!att.url) continue
        if (seenUrls.has(att.url)) continue
        seenUrls.add(att.url)
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
