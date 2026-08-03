'use server'

import { NextResponse } from 'next/server'
import type { Message, MessageType, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { emitMessageReceived } from '@/lib/messageEvents'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { startMaxContactResolutionShadow } from '@/lib/contacts/max-contact-resolution-shadow'
import type { LegacyContactResolutionOutcome } from '@/lib/contacts/contact-resolution-shadow.types'
import { resolveMaxPhoneEvidence } from '@/lib/contacts/max-phone-evidence'
import { opsLog } from '@/lib/opsLog'
import {
  personalMaxNativeMetadata,
  REAL_PERSONAL_MAX_MESSAGE_ID,
} from '@/lib/personal-max-live-conversation'

const MAX_RUNTIME_TRACE_PREFIX = '[MAX_RUNTIME_TRACE]'
let maxRuntimeTraceSeq = 0

function maxRuntimeTraceText(value: unknown): string | null {
  if (value == null) return null
  const raw = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim()
  if (!raw) return ''
  return raw.length > 80 ? `${raw.slice(0, 80)}...[${raw.length}]` : raw
}

function maxRuntimeTrace(stage: string, fields: Record<string, unknown> = {}): void {
  try {
    const providerMessageId = fields.providerMessageId || fields.externalId
    const chatId = fields.chatId
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      eventId: `webhook:${++maxRuntimeTraceSeq}`,
      traceId: fields.traceId || (providerMessageId ? `max:${providerMessageId}` : (chatId ? `max-chat:${chatId}` : 'max-webhook')),
      stage,
    }
    for (const [key, value] of Object.entries(fields)) {
      if (/phone|token|cookie|secret|authorization|password|base64|url/i.test(key)) {
        entry[key] = '[redacted]'
      } else if (key === 'text') {
        entry.textPreview = maxRuntimeTraceText(value)
        entry.textLength = value == null ? 0 : String(value).length
      } else {
        entry[key] = value
      }
    }
    process.stdout.write(`${MAX_RUNTIME_TRACE_PREFIX} ${JSON.stringify(entry)}\n`)
  } catch {
    // Instrumentation must never affect webhook behavior.
  }
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

type DurableMaxStoredMessage = Pick<
  Message,
  'chatId' | 'metadata' | 'sentAt' | 'content' | 'direction' | 'channel'
>

type DurableMaxExpectedIdentity = {
  accountId: string
  protocolChatId: string
  uiRouteId: string
  providerUserId: string
  content: string
  sentAt: Date
  chatInternalId?: string
}

function matchesDurableMaxIdentity(
  stored: DurableMaxStoredMessage,
  expected: DurableMaxExpectedIdentity,
): boolean {
  const metadata = metadataRecord(stored.metadata)
  return Boolean(
    expected.accountId
    && expected.protocolChatId
    && expected.uiRouteId
    && expected.providerUserId
    && (!expected.chatInternalId || stored.chatId === expected.chatInternalId)
    && stored.channel === 'max'
    && stored.direction === 'inbound'
    && stored.content === expected.content
    && stored.sentAt.getTime() === expected.sentAt.getTime()
    && String(metadata.providerAccountId || '') === expected.accountId
    && String(metadata.protocolChatId || '') === expected.protocolChatId
    && String(metadata.uiRouteId || '') === expected.uiRouteId
    && String(metadata.providerUserId || '') === expected.providerUserId
  )
}

function sanitizeMaxValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  }
  if (Array.isArray(value)) return value.map(sanitizeMaxValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeMaxValue(entry)])
    )
  }
  return value
}

const MAX_CHAT_ID_ALIASES: Record<string, string> = {
  '511708938': '902454841098',
  '201482140': '902144614300',
}

type AttachmentLike = {
  name?: string | null
  fileName?: string | null
  mimeType?: string | null
  contentType?: string | null
  size?: number | string | null
  fileSize?: number | string | null
  type?: string | null
  url?: string | null
  downloadStatus?: string | null
  downloadError?: string | null
}

type MaxWebhookBody = {
  externalId?: string | number | null
  chatId?: string | number | null
  rawChatId?: string | number | null
  senderId?: string | number | null
  senderName?: string | null
  senderPhone?: string | number | null
  phone?: string | number | null
  phoneEvidence?: {
    sourceKind?: string | null
    trustedForAutomaticResolution?: boolean | null
    observedAt?: string | null
    providerIdentityId?: string | number | null
    protocolChatId?: string | number | null
    uiRouteId?: string | number | null
  } | null
  text?: string | null
  timestamp?: string | number | null
  messageType?: string | null
  attachments?: AttachmentLike[] | null
  attachmentResolution?: {
    status?: string | null
    reason?: string | null
    expectedCount?: number | null
    resolvedCount?: number | null
    failedCount?: number | null
  } | null
  isOutgoing?: boolean | null
  deleted?: boolean | null
  forwardedFrom?: unknown
  source?: string | null
  replyToExternalId?: string | number | null
  replyQuoteText?: string | null
  chatKind?: 'private' | 'group' | 'unknown' | null
  providerAccountId?: string | null
  protocolChatId?: string | number | null
  uiRouteId?: string | number | null
  providerUserId?: string | number | null
  textQuarantineReason?: string | null
}

function normalizeMaxChatId(chatId: unknown): string {
  const raw = String(chatId)
  return MAX_CHAT_ID_ALIASES[raw] || raw
}

async function advanceMaxChatLastMessageAt(
  chatId: string,
  sentAt: Date,
  db: Pick<Prisma.TransactionClient, 'chat'> = prisma,
): Promise<void> {
  await db.chat.updateMany({
    where: {
      id: chatId,
      OR: [
        { lastMessageAt: null },
        { lastMessageAt: { lt: sentAt } },
      ],
    },
    data: { lastMessageAt: sentAt },
  })
}

function attachmentName(att: AttachmentLike): string {
  const value = att.name ?? att.fileName ?? ''
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function attachmentDisplayName(att: AttachmentLike): string | null {
  const value = att.name ?? att.fileName ?? ''
  return typeof value === 'string' && value.trim() ? value : null
}

function attachmentMime(att: AttachmentLike): string {
  const value = att.mimeType ?? att.contentType ?? ''
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function attachmentSize(att: AttachmentLike): number | null {
  const raw = att.size ?? att.fileSize
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

function attachmentType(att: AttachmentLike): string {
  const value = att.type ?? ''
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function sameMaxAttachment(incoming: AttachmentLike, existing: AttachmentLike): boolean {
  const incomingName = attachmentName(incoming)
  const existingName = attachmentName(existing)
  const incomingMime = attachmentMime(incoming)
  const existingMime = attachmentMime(existing)
  const incomingSize = attachmentSize(incoming)
  const existingSize = attachmentSize(existing)

  if (incomingName && existingName && incomingName === existingName) {
    return !incomingSize || !existingSize || incomingSize === existingSize
  }

  if (incomingSize && existingSize && incomingSize === existingSize) {
    if (incomingMime && existingMime && incomingMime === existingMime) return true
    return attachmentType(incoming) !== '' && attachmentType(incoming) === attachmentType(existing)
  }

  return false
}

function sameMaxAttachmentSet(incomingAttachments: AttachmentLike[], existingAttachments: AttachmentLike[]): boolean {
  if (!incomingAttachments.length || !existingAttachments.length) return false
  return incomingAttachments.every(incoming =>
    existingAttachments.some(existing => sameMaxAttachment(incoming, existing))
  )
}

export async function POST(request: Request) {
  try {
    const body = sanitizeMaxValue(await request.json()) as MaxWebhookBody
    const {
      externalId, chatId, rawChatId, senderId, senderName, senderPhone, phone,
      phoneEvidence, text, timestamp, messageType, attachments, isOutgoing,
      attachmentResolution, deleted, forwardedFrom, source, replyToExternalId, replyQuoteText, chatKind,
      providerAccountId, protocolChatId, uiRouteId, providerUserId, textQuarantineReason,
    } = body
    maxRuntimeTrace('webhook.received', {
      providerMessageId: externalId ? String(externalId) : null,
      chatId: chatId ? String(chatId) : null,
      rawChatId: rawChatId ? String(rawChatId) : null,
      text,
      messageType: messageType || 'text',
      source: source || null,
      isOutgoing: Boolean(isOutgoing),
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      deleted: Boolean(deleted),
    })

    // MAX server confirmed a message was deleted — remove from CRM DB
    if (deleted && externalId) {
      const msg = await prisma.message.findUnique({ where: { externalId: String(externalId) } })
      if (msg) {
        await prisma.messageAttachment.deleteMany({ where: { messageId: msg.id } })
        await prisma.message.delete({ where: { id: msg.id } })
        console.log(`[MAX Webhook] deleted externalId=${externalId}`)
        // Broadcast directly (skip AI pipeline — message is gone)
        broadcastChatMessage(msg.chatId, { ...msg, deleted: true })
      }
      return NextResponse.json({ ok: true, deleted: externalId })
    }

    if (!chatId) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, reason: 'missing_chat_id' })
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 })
    }
    const configuredAccountId = process.env.MAX_PERSONAL_ACCOUNT_ID || ''
    if (providerAccountId && configuredAccountId && providerAccountId !== configuredAccountId) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, reason: 'account_mismatch' })
      return NextResponse.json({ error: 'Personal MAX account mismatch' }, { status: 409 })
    }
    if (textQuarantineReason) {
      maxRuntimeTrace('webhook.skipped', {
        providerMessageId: externalId ? String(externalId) : null,
        chatId: String(chatId),
        reason: 'provider_text_quarantined',
      })
      return NextResponse.json({ ok: true, skipped: 'provider_text_quarantined' })
    }

    // Reject empty text messages (pure protocol noise — ack / receipt
    // frames shouldn't render as empty bubbles in the UI).
    const trimmedText = typeof text === 'string' ? text.trim() : ''
    const isTextType = !messageType || messageType === 'text'
    if (isTextType && !trimmedText && (!attachments || attachments.length === 0)) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, chatId: String(chatId), reason: 'empty_text' })
      return NextResponse.json({ ok: true, skipped: 'empty_text' })
    }
    const usableAttachments = Array.isArray(attachments)
      ? attachments.filter((att): att is AttachmentLike & { url: string } =>
          Boolean(att) &&
          att.downloadStatus !== 'failed' &&
          typeof att.url === 'string' &&
          att.url.length > 0
        )
      : []
    const retryableAttachment = attachmentResolution?.status === 'retryable'
    const attachmentResolutionMetadata = messageType && messageType !== 'text'
      ? {
          status: retryableAttachment ? 'retryable' : 'resolved',
          reason: retryableAttachment ? (attachmentResolution?.reason || 'download_pending') : null,
          expectedCount: Number(attachmentResolution?.expectedCount ?? attachments?.length ?? 0),
          resolvedCount: Number(attachmentResolution?.resolvedCount ?? usableAttachments.length),
          failedCount: Number(
            attachmentResolution?.failedCount ??
            (attachments?.filter(att => att.downloadStatus === 'failed').length || 0)
          ),
        }
      : null
    if (
      !isOutgoing &&
      messageType === 'image' &&
      usableAttachments.length === 0 &&
      !retryableAttachment
    ) {
      console.warn(`[MAX Webhook] skipped image without attachment chatId=${chatId} externalId=${externalId || 'n/a'}`)
      opsLog('warn', 'max_image_without_attachment_skipped', {
        channel: 'max',
        chatId: String(chatId),
        externalId: externalId ? String(externalId) : null,
        attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      })
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, chatId: String(chatId), reason: 'image_without_attachment' })
      return NextResponse.json({ ok: true, skipped: 'image_without_attachment' })
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
        maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, chatId: String(chatId), reason: 'bad_timestamp' })
        return NextResponse.json({ ok: true, skipped: 'bad_timestamp', value: timestamp })
      }
      sentAt = new Date(ts)
    } else {
      sentAt = new Date()
    }

    const externalIdString = externalId ? String(externalId) : null
    const replyToExternalIdString = replyToExternalId ? String(replyToExternalId) : null
    const replyQuoteTextString = typeof replyQuoteText === 'string' && replyQuoteText.trim()
      ? replyQuoteText.trim()
      : null
    const providerReplyMetadata = replyToExternalIdString
      ? {
          replyToExternalId: replyToExternalIdString,
          replyResolutionStatus: 'resolved',
        }
      : replyQuoteTextString
        ? {
            unresolvedReplyQuoteText: replyQuoteTextString,
            replyResolutionStatus: 'ambiguous_or_missing',
          }
        : {}
    const isTextProviderEvent = isTextType && usableAttachments.length === 0
    const isPlaceholderTextId = !!externalIdString && (
      externalIdString.startsWith('max-dom-') ||
      externalIdString.startsWith('max-recovered-')
    )
    const isHistoryReplay = source === 'history' || source === 'catchup'
    const requiresDurableRecoverySemantics = source === 'reconnect_snapshot' || source === 'raw_journal_replay'
    if (requiresDurableRecoverySemantics && (
      isOutgoing
      || !externalIdString
      || !REAL_PERSONAL_MAX_MESSAGE_ID.test(externalIdString)
      || !providerAccountId
      || !protocolChatId
      || !uiRouteId
      || !providerUserId
    )) {
      maxRuntimeTrace('webhook.skipped', {
        providerMessageId: externalIdString,
        chatId: String(chatId),
        reason: 'durable_identity_incomplete',
      })
      return NextResponse.json({
        success: false,
        error: 'Personal MAX durable recovery identity is incomplete',
        code: 'MAX_DURABLE_IDENTITY_INCOMPLETE',
      }, { status: 409 })
    }
    const durableRecoveryIdentity: DurableMaxExpectedIdentity | null = requiresDurableRecoverySemantics
      ? {
          accountId: providerAccountId || configuredAccountId || '',
          protocolChatId: normalizeMaxChatId(protocolChatId || chatId),
          uiRouteId: uiRouteId == null ? '' : String(uiRouteId),
          providerUserId: providerUserId == null
            ? (senderId == null ? '' : String(senderId))
            : String(providerUserId),
          content: String(text || ''),
          sentAt,
        }
      : null
    const allowLiveDomTextRecovery = Boolean(
      isTextProviderEvent &&
      isPlaceholderTextId &&
      source === 'dom_fallback' &&
      !isHistoryReplay &&
      !isOutgoing &&
      trimmedText.length > 0
    )

    if (isTextProviderEvent && (!externalIdString || isPlaceholderTextId) && !allowLiveDomTextRecovery) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalIdString, chatId: String(chatId), text, reason: 'text_without_provider_identity' })
      return NextResponse.json({
        ok: true,
        skipped: 'text_without_provider_identity',
        externalId: externalIdString,
      })
    }

    if (isOutgoing && externalIdString && REAL_PERSONAL_MAX_MESSAGE_ID.test(externalIdString)) {
      const exactDispatch = await prisma.maxOutboundDispatch.findFirst({
        where: {
          providerMessageId: externalIdString,
          ...(configuredAccountId ? { accountId: configuredAccountId } : {}),
        },
        select: {
          state: true,
          command: { select: { clientMessageId: true } },
        },
      })
      const clientMessageId = exactDispatch?.command.clientMessageId
      const crmOriginated = clientMessageId
        ? await prisma.message.findUnique({ where: { clientMessageId } })
        : null
      if (exactDispatch?.state === 'provider_confirmed' && crmOriginated) {
        const metadata = metadataRecord(crmOriginated.metadata)
        const delivery = metadataRecord(metadata.maxDelivery)
        const linked = await prisma.message.update({
          where: { id: crmOriginated.id },
          data: {
            externalId: externalIdString,
            status: 'delivered',
            sentAt,
            metadata: {
              ...metadata,
              origin: 'crm',
              retryable: false,
              maxDelivery: {
                ...delivery,
                status: 'provider_confirmed',
                deliveryConfirmed: true,
                maxMessageId: externalIdString,
                externalId: externalIdString,
              },
            },
          },
        })
        maxRuntimeTrace('webhook.crm_echo_linked', {
          providerMessageId: externalIdString,
          chatId: String(chatId),
          messageId: linked.id,
        })
        return NextResponse.json({
          success: true,
          chatInternalId: linked.chatId,
          messageId: linked.id,
          deduped: true,
          crmEchoLinked: true,
        })
      }
      if (exactDispatch) {
        maxRuntimeTrace('webhook.reconciliation_required', {
          providerMessageId: externalIdString,
          chatId: String(chatId),
          reason: 'crm_dispatch_without_linkable_bubble',
        })
        return NextResponse.json({
          ok: true,
          skipped: 'crm_echo_reconciliation_required',
        })
      }
    }

    if (isTextProviderEvent && externalIdString) {
      const existingText = await prisma.message.findUnique({
        where: { externalId: externalIdString },
        select: {
          id: true,
          chatId: true,
          metadata: true,
          sentAt: true,
          content: true,
          direction: true,
          channel: true,
        },
      })
      if (existingText) {
        if (durableRecoveryIdentity) {
          if (!matchesDurableMaxIdentity(existingText, durableRecoveryIdentity)) {
            maxRuntimeTrace('webhook.provider_identity_conflict', {
              providerMessageId: externalIdString,
              chatId: String(chatId),
              source,
            })
            return NextResponse.json({
              success: false,
              error: 'Personal MAX provider identity conflict',
              code: 'MAX_PROVIDER_IDENTITY_CONFLICT',
            }, { status: 409 })
          }
        }
        let resolvedReplyToExternalId = replyToExternalIdString
        const normalizedReplyQuote = replyQuoteTextString || ''
        if (!resolvedReplyToExternalId && source === 'live_dom_reply_enrichment' && normalizedReplyQuote) {
          const candidates = await prisma.message.findMany({
            where: {
              chatId: existingText.chatId,
              id: { not: existingText.id },
              content: normalizedReplyQuote,
              externalId: { startsWith: 'd301' },
              sentAt: { lte: existingText.sentAt },
            },
            select: { externalId: true },
            orderBy: { sentAt: 'desc' },
            take: 2,
          })
          if (candidates.length === 1 && candidates[0].externalId) {
            resolvedReplyToExternalId = candidates[0].externalId
          }
        }
        if (resolvedReplyToExternalId || normalizedReplyQuote) {
          await prisma.message.update({
            where: { id: existingText.id },
            data: {
              metadata: {
                ...metadataRecord(existingText.metadata),
                ...(resolvedReplyToExternalId
                  ? {
                      replyToExternalId: resolvedReplyToExternalId,
                      replyResolutionStatus: 'resolved',
                    }
                  : {
                      unresolvedReplyQuoteText: normalizedReplyQuote,
                      replyResolutionStatus: 'ambiguous_or_missing',
                    }),
              },
            },
          })
        }
        maxRuntimeTrace('webhook.duplicate', {
          providerMessageId: externalIdString,
          chatId: String(chatId),
          text,
          chatInternalId: existingText.chatId,
          messageId: existingText.id,
        })
        return NextResponse.json({
          success: true,
          chatInternalId: existingText.chatId,
          messageId: existingText.id,
          deduped: true,
          replyEnriched: Boolean(resolvedReplyToExternalId),
        })
      }
    }

    const rawExternalChatId = String(rawChatId || uiRouteId || chatId)
    const externalChatId = normalizeMaxChatId(protocolChatId || chatId)
    const senderIdString = senderId ? String(senderId) : null
    const providerUserIdString = providerUserId ? String(providerUserId) : senderIdString
    const maxPhoneEvidence = resolveMaxPhoneEvidence(senderPhone || phone, phoneEvidence, {
      externalChatId,
      senderId: providerUserIdString,
    })
    const effectiveSenderPhone = maxPhoneEvidence.normalizedPhone
    const trustedSenderPhone = maxPhoneEvidence.trustedForAutomaticResolution
      ? effectiveSenderPhone
      : null
    const maxChatKind = chatKind === 'private' || chatKind === 'group' ? chatKind : 'unknown'
    const shadowEventSource = source === 'history'
      ? 'history'
      : source === 'catchup'
        ? 'replay'
        : source
          ? 'unknown'
          : 'live'

    // Stage 3B shadow starts before the first Chat/Contact/Identity/Phone
    // mutation. Its result is diagnostic only and never feeds legacy flow.
    // Only a provider-profile phone bound to this identity, protocol chat and
    // derived UI route may participate in automatic planner matching.
    const maxContactResolutionShadow = await startMaxContactResolutionShadow({
      resolutionInput: {
        channel: 'max',
        externalUserId: providerUserIdString,
        externalChatId,
        providerAccountId: providerAccountId || configuredAccountId || null,
        channelDisplayName: senderName || null,
        normalizedPhone: effectiveSenderPhone,
        phoneEvidence: effectiveSenderPhone
          ? {
              source: maxPhoneEvidence.sourceKind,
              trustedForAutomaticResolution: maxPhoneEvidence.trustedForAutomaticResolution,
            }
          : null,
        chatKind: maxChatKind,
      },
      isOutgoing: isOutgoing ?? null,
      eventSource: shadowEventSource,
    })

    // Find or create Chat
    let chat = await prisma.chat.findUnique({
      where: { externalChatId },
    })

    if (!chat && rawExternalChatId !== externalChatId) {
      const existingByUiRoute = await prisma.chat.findUnique({
        where: { externalChatId: rawExternalChatId },
      })
      if (existingByUiRoute) {
        const metadata = metadataRecord(existingByUiRoute.metadata)
        chat = await prisma.chat.update({
          where: { id: existingByUiRoute.id },
          data: {
            externalChatId,
            metadata: {
              ...metadata,
              previousExternalChatId: rawExternalChatId,
              protocolChatId: externalChatId,
              uiRouteId: uiRouteId ? String(uiRouteId) : rawExternalChatId,
              providerAccountId: providerAccountId || configuredAccountId || null,
            },
          },
        })
      }
    }

    if (!chat && !isOutgoing && providerUserIdString) {
      const existingBySender = await prisma.chat.findFirst({
        where: {
          channel: 'max',
          metadata: { path: ['providerUserId'], equals: providerUserIdString },
        },
        orderBy: { lastMessageAt: 'desc' },
      })

      if (existingBySender) {
        const existingMetadata = metadataRecord(existingBySender.metadata)
        chat = await prisma.chat.update({
          where: { id: existingBySender.id },
          data: {
            externalChatId,
            ...(senderName && existingBySender.name?.startsWith('MAX:') ? { name: senderName } : {}),
            metadata: {
              ...existingMetadata,
              previousExternalChatId: existingBySender.externalChatId,
              rawExternalChatId,
              senderId: providerUserIdString,
              providerUserId: providerUserIdString,
              protocolChatId: externalChatId,
              uiRouteId: uiRouteId ? String(uiRouteId) : rawExternalChatId,
              providerAccountId: providerAccountId || configuredAccountId || null,
              ...(effectiveSenderPhone ? { phone: effectiveSenderPhone } : {}),
              ...(effectiveSenderPhone ? { phoneEvidence: maxPhoneEvidence } : {}),
              connectionId: existingMetadata.connectionId || 'max_scraper',
            },
          },
        })
      }
    }

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          channel:       'max',
          externalChatId,
          name:          senderName || (senderId ? `MAX:${senderId}` : `MAX:${externalChatId}`),
          lastMessageAt: sentAt,
          status:        'new',
          metadata: {
            ...(providerUserIdString ? { senderId: providerUserIdString, providerUserId: providerUserIdString } : {}),
            ...(effectiveSenderPhone ? { phone: effectiveSenderPhone } : {}),
            ...(effectiveSenderPhone ? { phoneEvidence: maxPhoneEvidence } : {}),
            rawExternalChatId,
            protocolChatId: externalChatId,
            uiRouteId: uiRouteId ? String(uiRouteId) : rawExternalChatId,
            providerAccountId: providerAccountId || configuredAccountId || null,
            connectionId: 'max_scraper',
          },
        },
      })
    } else {
      const existingMetadata = metadataRecord(chat.metadata)
      await prisma.chat.update({
        where: { id: chat.id },
        data: {
          // Обновляем имя если раньше было только MAX:ID
          ...(senderName && chat.name?.startsWith('MAX:') ? { name: senderName } : {}),
          // Обновляем senderId / phone в metadata
          ...((providerUserIdString || effectiveSenderPhone) ? {
            metadata: {
              ...existingMetadata,
              ...(providerUserIdString ? { senderId: providerUserIdString, providerUserId: providerUserIdString } : {}),
              ...(effectiveSenderPhone ? { phone: effectiveSenderPhone } : {}),
              ...(effectiveSenderPhone ? { phoneEvidence: maxPhoneEvidence } : {}),
              rawExternalChatId,
              protocolChatId: externalChatId,
              uiRouteId: uiRouteId ? String(uiRouteId) : rawExternalChatId,
              providerAccountId: providerAccountId || configuredAccountId || null,
              connectionId: existingMetadata.connectionId || 'max_scraper',
            }
          } : {}),
        },
      })
    }

    // Preserve the established normal inbound/outbound ordering: chat activity
    // is advanced before workflow and before Message upsert. Only the new
    // reconnect/replay path moves these effects into its durable transaction.
    if (!requiresDurableRecoverySemantics && !isHistoryReplay) {
      await advanceMaxChatLastMessageAt(chat.id, sentAt)
    }

    // Map messageType to Prisma MessageType enum.
    // Defensive: if the scraper classified as 'document' but the first
    // attachment is actually a sticker, override. MAX ships stickers
    // with _type='STICKER' which older scraper versions bucketed as
    // document — the new MessageParser branch already emits 'sticker',
    // but this guard catches any in-flight or legacy frames.
    const typeMap: Record<string, MessageType> = {
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
    const effectiveMessageTypeKey = typeof effectiveMessageType === 'string' ? effectiveMessageType : 'text'
    const msgType = typeMap[effectiveMessageTypeKey] || 'text'

    // For non-text messages without text, use a readable placeholder
    const contentFallbacks: Record<string, string> = {
      image: '[Фото]', video: '[Видео]', voice: '[Голосовое]',
      audio: '[Аудио]', document: '[Документ]',
    }
    const content = text || contentFallbacks[effectiveMessageTypeKey] || ''
    const isNativeMaxOutbound = Boolean(
      isOutgoing && externalIdString && REAL_PERSONAL_MAX_MESSAGE_ID.test(externalIdString),
    )
    const nativeMetadata = isNativeMaxOutbound
      ? personalMaxNativeMetadata({
          accountId: providerAccountId || configuredAccountId,
          protocolChatId: externalChatId,
          uiRouteId: uiRouteId ? String(uiRouteId) : rawExternalChatId,
          providerUserId: providerUserIdString || externalChatId,
          source: source === 'history' || source === 'catchup'
            ? 'history'
            : source === 'provider_store_recovery'
              ? 'provider_store_recovery'
              : 'live',
        })
      : null

    let message: Message | null = null
    const shouldUpgradeDomMessage =
      msgType !== 'text' &&
      externalIdString &&
      !externalIdString.startsWith('max-dom-') &&
      !externalIdString.startsWith('max-recovered-')

    if (shouldUpgradeDomMessage) {
      const nearbyDomMessage = await prisma.message.findFirst({
        where: {
          chatId: chat.id,
          channel: 'max',
          direction: isOutgoing ? 'outbound' : 'inbound',
          content,
          externalId: { startsWith: 'max-dom-' },
          sentAt: {
            gte: new Date(sentAt.getTime() - 10 * 60 * 1000),
            lte: new Date(sentAt.getTime() + 10 * 60 * 1000),
          },
        },
        orderBy: { sentAt: 'desc' },
      })
      if (nearbyDomMessage) {
        message = await prisma.message.update({
          where: { id: nearbyDomMessage.id },
          data: {
            externalId: externalIdString,
            type: msgType,
            content,
            sentAt,
            metadata: { ...metadataRecord(nearbyDomMessage.metadata), senderId, maxChatId: externalChatId, maxRawChatId: rawExternalChatId, attachments: attachments || [], ...(attachmentResolutionMetadata ? { attachmentResolution: attachmentResolutionMetadata } : {}), ...providerReplyMetadata, ...(forwardedFrom ? { forwardedFrom } : {}) },
          },
        })
        console.log(`[MAX Webhook] upgraded DOM externalId ${nearbyDomMessage.externalId} → ${externalIdString}`)
      }
    } else if (msgType === 'text' && externalIdString && !externalIdString.startsWith('max-dom-') && !externalIdString.startsWith('max-recovered-')) {
      console.log(`[MAX Webhook] skipped text DOM externalId upgrade for ${externalIdString}`)
    }

    const isDomFallbackMedia =
      !isOutgoing &&
      msgType !== 'text' &&
      externalIdString &&
      (externalIdString.startsWith('max-dom-') || externalIdString.startsWith('max-recovered-')) &&
      usableAttachments.length > 0

    if (!message && isDomFallbackMedia) {
      const nearbyMessages = await prisma.message.findMany({
        where: {
          chatId: chat.id,
          channel: 'max',
          direction: 'inbound',
          type: msgType,
          content,
          externalId: { not: externalIdString },
          sentAt: {
            gte: new Date(sentAt.getTime() - 10 * 60 * 1000),
            lte: new Date(sentAt.getTime() + 10 * 60 * 1000),
          },
        },
        include: { attachments: true },
        orderBy: { sentAt: 'desc' },
        take: 25,
      })

      const duplicate = nearbyMessages.find(candidate =>
        sameMaxAttachmentSet(usableAttachments, candidate.attachments as unknown as AttachmentLike[])
      )

      if (duplicate) {
        console.log(`[MAX Webhook] deduped DOM media externalId ${externalIdString} -> ${duplicate.id}`)
        opsLog('info', 'max_dom_media_deduped', {
          channel: 'max',
          chatId: chat.id,
          externalChatId,
          externalId: externalIdString,
          duplicateMessageId: duplicate.id,
          type: msgType,
          attachmentCount: usableAttachments.length,
        })
        await maxContactResolutionShadow.session?.complete({
          status: 'no_contact',
          reason: 'legacy_contact_resolution_not_reached',
        })
        return NextResponse.json({
          success: true,
          chatInternalId: chat.id,
          messageId: duplicate.id,
          deduped: true,
        })
      }
    }

    // Workflow ordering for normal opcode 128/180 and provider-store recovery
    // stays identical to the accepted baseline. A failure here leaves no
    // Message row, so the existing retry can still repair the activity state.
    if (!requiresDurableRecoverySemantics && !isOutgoing && !isHistoryReplay) {
      await ConversationWorkflowService.onInboundMessage(chat.id, sentAt)
    } else if (!requiresDurableRecoverySemantics && isOutgoing && !isHistoryReplay) {
      await ConversationWorkflowService.onOutboundMessage(chat.id, sentAt)
    }

    const messageCreateData: Prisma.MessageCreateManyInput = {
      chatId:    chat.id,
      direction: isOutgoing ? 'outbound' : 'inbound',
      type:      msgType,
      content,
      channel:   'max',
      externalId: externalIdString,
      status:    isNativeMaxOutbound ? 'sent' : 'delivered',
      sentAt,   // validated above
      metadata:  {
        senderId: providerUserIdString || senderId,
        maxChatId: externalChatId,
        maxRawChatId: rawExternalChatId,
        protocolChatId: externalChatId,
        uiRouteId: uiRouteId ? String(uiRouteId) : rawExternalChatId,
        providerAccountId: providerAccountId || configuredAccountId || null,
        providerUserId: providerUserIdString,
        attachments: attachments || [],
        ...(attachmentResolutionMetadata ? { attachmentResolution: attachmentResolutionMetadata } : {}),
        ...(source ? { source } : {}),
        ...(nativeMetadata || {}),
        ...providerReplyMetadata,
        ...(forwardedFrom ? { forwardedFrom } : {}),
      },
    }
    const persistMessage = (db: Pick<Prisma.TransactionClient, 'message'>) =>
      db.message.upsert({
        where:  { externalId: externalIdString || `max-${chatId}-${Date.now()}` },
        update: {},
        create: messageCreateData,
      })

    // The reconnect/replay ACK boundary is atomic: if workflow or monotonic
    // activity advancement fails, the Message insert rolls back and remains
    // safely retryable instead of becoming an early-return duplicate.
    let durableRecoveryWasDeduped = false
    if (!message && requiresDurableRecoverySemantics) {
      const durablePersistence = await prisma.$transaction(async tx => {
        const insertion = await tx.message.createMany({
          data: [messageCreateData],
          skipDuplicates: true,
        })
        if (insertion.count !== 0 && insertion.count !== 1) {
          throw Object.assign(new Error('Unexpected Personal MAX durable insert count'), {
            code: 'MAX_DURABLE_INSERT_COUNT_INVALID',
          })
        }
        const persisted = externalIdString
          ? await tx.message.findUnique({ where: { externalId: externalIdString } })
          : null
        const exactIdentity = durableRecoveryIdentity
          ? { ...durableRecoveryIdentity, chatInternalId: chat.id, content }
          : null
        if (!persisted || !exactIdentity || !matchesDurableMaxIdentity(persisted, exactIdentity)) {
          throw Object.assign(new Error('Personal MAX provider identity conflict during durable persistence'), {
            code: 'MAX_PROVIDER_IDENTITY_CONFLICT',
          })
        }
        if (insertion.count === 1) {
          await ConversationWorkflowService.onInboundMessage(chat.id, sentAt, tx)
          await advanceMaxChatLastMessageAt(chat.id, sentAt, tx)
        }
        return { message: persisted, deduped: insertion.count === 0 }
      })
      message = durablePersistence.message
      durableRecoveryWasDeduped = durablePersistence.deduped
    }

    // A concurrent request can pass the early lookup before the winning
    // transaction commits. Treat createMany(count=0) exactly like the early
    // provider-ID duplicate path: acknowledge it, but do not emit workflow,
    // contact, attachment, or application side effects a second time.
    if (message && durableRecoveryWasDeduped) {
      await maxContactResolutionShadow.session?.complete({
        status: 'no_contact',
        reason: 'legacy_contact_resolution_not_reached',
      })
      maxRuntimeTrace('webhook.duplicate', {
        providerMessageId: externalIdString,
        chatId: String(chatId),
        text,
        chatInternalId: message.chatId,
        messageId: message.id,
        raceDeduped: true,
      })
      return NextResponse.json({
        success: true,
        chatInternalId: message.chatId,
        messageId: message.id,
        deduped: true,
      })
    }

    // Create Message (skip if already seen)
    if (!message) {
      message = await persistMessage(prisma)
    }
    if (attachmentResolutionMetadata?.status === 'resolved') {
      const existingMetadata = metadataRecord(message.metadata)
      const previousResolution = metadataRecord(existingMetadata.attachmentResolution)
      if (previousResolution.status === 'retryable') {
        message = await prisma.message.update({
          where: { id: message.id },
          data: {
            metadata: { ...existingMetadata, attachmentResolution: attachmentResolutionMetadata },
          },
        })
      }
    }
    maxRuntimeTrace('webhook.stored', {
      providerMessageId: externalIdString,
      chatId: String(chatId),
      text,
      chatInternalId: chat.id,
      messageId: message.id,
      source: source || null,
      isOutgoing: Boolean(isOutgoing),
    })

    // Save attachments. Dedup by url first — MAX scraper sometimes sends
    // the same sticker/image twice (preview + full, or two frames of a
    // protocol that we both flatten). Without this, the UI renders N
    // copies of the same frog.
    if (attachments && attachments.length > 0) {
      const seenUrls = new Set<string>()
      const existingAttachments = await prisma.messageAttachment.findMany({
        where: { messageId: message.id },
        select: { url: true },
      })
      for (const existing of existingAttachments) {
        if (existing.url) seenUrls.add(existing.url)
      }
      for (const att of attachments) {
        if (!att.url) continue
        if (seenUrls.has(att.url)) continue
        seenUrls.add(att.url)
        await prisma.messageAttachment.create({
          data: {
            messageId: message.id,
            type:      att.type || 'file',
            url:       att.url,
            fileName:  attachmentDisplayName(att),
            fileSize:  attachmentSize(att),
            mimeType:  att.mimeType || null,
          },
        })
      }
    }

    console.log(`[MAX Webhook] chatId=${chatId} direction=${isOutgoing ? 'out' : 'in'} text="${(text || '').slice(0, 50)}"`)

    // Привязываем чат к водителю (по телефону/имени из MAX)
    if (!isOutgoing && !chat.driverId && trustedSenderPhone) {
      DriverMatchService.linkChatToDriver(chat.id, { phone: trustedSenderPhone }).catch(e =>
        console.error('[MAX Webhook] linkChatToDriver error:', e.message)
      )
    }

    // ── Contact Model dual write ──────────────────────────────
    let legacyContactResolution: LegacyContactResolutionOutcome = {
      status: 'no_contact',
      reason: 'outgoing_or_not_attempted',
    }
    if (!isOutgoing) {
      try {
        // Стабильный externalId: senderId > chatId (chatId может быть phone или max_name:*)
        const maxExternalId = providerUserIdString || externalChatId
        const maxPhone = effectiveSenderPhone

        const contactResult = await ContactService.resolveContact(
          'max',
          maxExternalId,
          maxPhone,
          senderName || null,
          {
            phoneEvidence: maxPhone
              ? {
                  source: maxPhoneEvidence.sourceKind,
                  trustedForAutomaticResolution: maxPhoneEvidence.trustedForAutomaticResolution,
                  observedAt: maxPhoneEvidence.observedAt,
                  providerIdentityId: maxPhoneEvidence.providerIdentityId,
                  protocolChatId: maxPhoneEvidence.protocolChatId,
                  uiRouteId: maxPhoneEvidence.uiRouteId,
                  trustResult: maxPhoneEvidence.trustResult,
                }
              : null,
          },
        )
        await ContactService.ensureChatLinked(
          chat.id,
          contactResult.contact.id,
          contactResult.identity.id,
        )
        legacyContactResolution = contactResult.isNew
          ? { status: 'contact_created', contactId: contactResult.contact.id }
          : { status: 'contact_reused', contactId: contactResult.contact.id, source: 'unknown' }
      } catch (contactErr: unknown) {
        const message = contactErr instanceof Error ? contactErr.message : String(contactErr)
        console.error(`[MAX Webhook] ContactService error (non-blocking): ${message}`)
        legacyContactResolution = {
          status: 'legacy_error',
          errorCode: contactErr instanceof Error ? contactErr.name : 'unknown_legacy_error',
        }
      }
    }
    await maxContactResolutionShadow.session?.complete(legacyContactResolution)
    // ──────────────────────────────────────────────────────────

    // Запускаем AI pipeline для входящих сообщений (не дожидаемся)
    if (!isOutgoing) {
      emitMessageReceived(message).catch(e =>
        console.error('[MAX Webhook] emitMessageReceived error:', e.message)
      )
    }

    maxRuntimeTrace('webhook.accepted', {
      providerMessageId: externalIdString,
      chatId: String(chatId),
      text,
      chatInternalId: chat.id,
      messageId: message.id,
    })
    return NextResponse.json({ success: true, chatInternalId: chat.id, messageId: message.id })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    maxRuntimeTrace('webhook.error', { error: message })
    const errorCode = err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : ''
    if (errorCode === 'MAX_PROVIDER_IDENTITY_CONFLICT') {
      return NextResponse.json({
        success: false,
        error: 'Personal MAX provider identity conflict',
        code: errorCode,
      }, { status: 409 })
    }
    opsLog('error', 'webhook_max_error', { channel: 'max', error: message })
    return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 })
  }
}
