'use server'

import { NextResponse } from 'next/server'
import type { Chat, Message, MessageType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { publishPersistedMessageV1 as emitMessageReceived } from '@/modules/messaging/public/v1/persisted-message-ingress'
import { broadcastChatMessageV1 as broadcastChatMessage } from '@/modules/messaging/public/v1/message-stream'
import { channelConversationWorkflowV1 as ConversationWorkflowService } from '@/modules/messaging/public/v1/channel-conversation-workflow'
import {
  markChannelIdentityConflictV1,
  startMaxContactResolutionShadowV1,
  type LegacyContactResolutionOutcome,
} from '@/modules/contacts/public/v1'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import { contactReachabilityV1 } from '@/modules/contacts/public/v1/contact-reachability'
import { isResolvedChannelContactResultV1, resolveChannelContactOperationV1 } from '@/modules/contacts/public/v1'
import { selectUniqueExactMaxSenderCandidate } from '@/modules/max-channel/internal/max-contact-ingress-policy'
import { isAuthorizedMaxScraperWebhookV1 } from '@/modules/max-channel/internal/scraper-webhook-auth'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { CREATE_EXTERNAL_CONVERSATION_COMMAND_V1, DELETE_MESSAGE_COMMAND_V1, DELETE_MESSAGE_MEDIA_COMMAND_V1, ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1, PATCH_EXTERNAL_CONVERSATION_COMMAND_V1, REPLACE_EXTERNAL_MESSAGE_COMMAND_V1, UPSERT_EXTERNAL_MESSAGE_COMMAND_V1 } from '@/contracts/messaging/v1'
import { ATTACH_MESSAGE_MEDIA_COMMAND_V2 } from '@/contracts/messaging/v2'
import { appendConversationIdentityCollisionV1, createExternalConversationV1, deleteMessageMediaV1, deleteMessageV1, ensureConversationContactLinkV1, patchExternalConversationV1, replaceExternalMessageV1, upsertExternalMessageV1 } from '@/modules/messaging/public/v1'
import { attachMessageMediaV2 } from '@/modules/messaging/public/v2'

const MAX_RUNTIME_TRACE_PREFIX = '[MAX_RUNTIME_TRACE]'
let maxRuntimeTraceSeq = 0

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
        // Preserve correlation/size diagnostics without logging message PII.
        entry.textPreview = '[redacted]'
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

function concreteProviderAccountId(metadata: unknown): string | null {
  const value = metadataRecord(metadata).providerAccountId
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized !== '' && normalized !== 'legacy' && normalized !== 'max-default' ? normalized : null
}

function concreteIncomingProviderAccountId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized !== '' && normalized !== 'legacy' && normalized !== 'max-default' ? normalized : null
}

type MaxIdentityCollisionEvidence = {
  channel: 'max'
  reason: string
  incomingProviderAccountId: string
  existingProviderAccountId: string | null
  incomingSenderId: string | null
  existingSenderId: string | null
  incomingChatKind: 'private' | 'group' | 'unknown'
  existingChatKind: 'private' | 'group' | 'unknown'
  hasPersonOwnership: boolean
  externalChatId: string
  existingExternalChatId?: string
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
}

type MaxWebhookBody = {
  accountId?: string | number | null
  externalId?: string | number | null
  chatId?: string | number | null
  rawChatId?: string | number | null
  senderId?: string | number | null
  senderName?: string | null
  senderPhone?: string | number | null
  phone?: string | number | null
  text?: string | null
  timestamp?: string | number | null
  messageType?: string | null
  attachments?: AttachmentLike[] | null
  isOutgoing?: boolean | null
  deleted?: boolean | null
  forwardedFrom?: unknown
  source?: string | null
  replyToExternalId?: string | number | null
  chatKind?: 'private' | 'group' | 'unknown' | null
}

function normalizeMaxChatId(chatId: unknown): string {
  const raw = String(chatId)
  return MAX_CHAT_ID_ALIASES[raw] || raw
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
  if (!isAuthorizedMaxScraperWebhookV1(request)) {
    return NextResponse.json({ error: 'MAX_SCRAPER_WEBHOOK_UNAUTHORIZED' }, { status: 401 })
  }
  try {
    const body = sanitizeMaxValue(await request.json()) as MaxWebhookBody
    const { externalId, chatId, rawChatId, senderId, senderName, senderPhone, phone, text, timestamp, messageType, attachments, isOutgoing, deleted, forwardedFrom, source, replyToExternalId, chatKind } = body
    const maxProviderAccountId = concreteIncomingProviderAccountId(body.accountId)
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

    if (!maxProviderAccountId) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, reason: 'provider_account_unproven' })
      return NextResponse.json({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' }, { status: 400 })
    }

    if (!chatId) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, reason: 'missing_chat_id' })
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 })
    }

    // Reject empty text messages (pure protocol noise — ack / receipt
    // frames shouldn't render as empty bubbles in the UI).
    const trimmedText = typeof text === 'string' ? text.trim() : ''
    const isTextType = !messageType || messageType === 'text'
    if (!deleted && isTextType && !trimmedText && (!attachments || attachments.length === 0)) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalId ? String(externalId) : null, chatId: String(chatId), reason: 'empty_text' })
      return NextResponse.json({ ok: true, skipped: 'empty_text' })
    }
    const usableAttachments = Array.isArray(attachments)
      ? attachments.filter((att): att is AttachmentLike & { url: string } => att && typeof att.url === 'string' && att.url.length > 0)
      : []
    if (!deleted && !isOutgoing && messageType === 'image' && usableAttachments.length === 0) {
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
    const isTextProviderEvent = isTextType && usableAttachments.length === 0
    const isPlaceholderTextId = !!externalIdString && (
      externalIdString.startsWith('max-dom-') ||
      externalIdString.startsWith('max-recovered-')
    )
    const isHistoryReplay = source === 'history' || source === 'catchup'
    const allowLiveDomTextRecovery = Boolean(
      isTextProviderEvent &&
      isPlaceholderTextId &&
      source === 'dom_fallback' &&
      !isHistoryReplay &&
      !isOutgoing &&
      trimmedText.length > 0
    )

    if (!deleted && isTextProviderEvent && (!externalIdString || isPlaceholderTextId) && !allowLiveDomTextRecovery) {
      maxRuntimeTrace('webhook.skipped', { providerMessageId: externalIdString, chatId: String(chatId), text, reason: 'text_without_provider_identity' })
      return NextResponse.json({
        ok: true,
        skipped: 'text_without_provider_identity',
        externalId: externalIdString,
      })
    }

    const rawExternalChatId = String(rawChatId || chatId)
    const externalChatId = normalizeMaxChatId(chatId)
    // Scraper echoes identify our own MAX account as the sender. Only inbound
    // events can contribute peer identity evidence to a conversation.
    const peerSenderIdString = isOutgoing || !senderId ? null : String(senderId)
    const normalizedPeerSenderPhone = isOutgoing || !(senderPhone || phone)
      ? null
      : normalizePhoneE164(String(senderPhone || phone))
    const effectivePeerSenderPhone = normalizedPeerSenderPhone || null
    const peerSenderName = isOutgoing ? null : senderName || null
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
    // MAX currently does not prove phone provenance in this payload, so a
    // provider phone remains untrusted for automatic planner matching.
    const maxContactResolutionShadow = await startMaxContactResolutionShadowV1({
      resolutionInput: {
        channel: 'max',
        externalUserId: peerSenderIdString,
        externalChatId,
        providerAccountId: maxProviderAccountId,
        channelDisplayName: peerSenderName,
        normalizedPhone: effectivePeerSenderPhone,
        phoneEvidence: effectivePeerSenderPhone
          ? { source: 'unknown', trustedForAutomaticResolution: false }
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
    let senderCandidateCount = 0

    const persistMaxIdentityCollision = async (
      existingChat: Chat,
      evidence: MaxIdentityCollisionEvidence,
    ) => {
      await appendConversationIdentityCollisionV1({
        chatId: existingChat.id,
        evidence,
      })
      if (existingChat.contactId && existingChat.contactIdentityId) {
        await markChannelIdentityConflictV1({
          contactId: existingChat.contactId,
          identityId: existingChat.contactIdentityId,
          channel: 'max',
          reason: evidence.reason,
          evidenceRoot: `channel-collision:max:${existingChat.externalChatId}:${evidence.incomingProviderAccountId}:${evidence.reason}`,
          details: {
            incomingProviderAccountId: evidence.incomingProviderAccountId,
            existingProviderAccountId: evidence.existingProviderAccountId,
            incomingSenderId: evidence.incomingSenderId,
            existingSenderId: evidence.existingSenderId,
            incomingChatKind: evidence.incomingChatKind,
            existingChatKind: evidence.existingChatKind,
          },
        })
      }
    }

    const rejectExistingChatCollision = async (
      existingChat: Chat,
      options: {
        requireExactExternalChatId?: boolean
        expectedChatId?: string
        incomingPeerSenderId?: string | null
        requirePeerSenderProof?: boolean
      } = {},
    ) => {
      const existingMetadata = metadataRecord(existingChat.metadata)
      const existingProviderAccountId = concreteProviderAccountId(existingMetadata)
      const providerCollisionReason = existingProviderAccountId !== null
        ? existingProviderAccountId !== maxProviderAccountId
          ? 'provider_account_mismatch'
          : null
        : 'provider_account_unproven'
      const existingSenderId = typeof existingMetadata.senderId === 'string'
        && existingMetadata.senderId.trim() !== ''
        ? existingMetadata.senderId
        : null
      const existingChatKind = existingMetadata.chatKind === 'private' || existingMetadata.chatKind === 'group'
        ? existingMetadata.chatKind
        : 'unknown'
      const hasPersonOwnership = Boolean(existingChat.contactId || existingChat.contactIdentityId)
      const hasPrivateConversationAuthority = !isOutgoing && (
        hasPersonOwnership || existingChatKind === 'private'
      )
      const hasConcreteChatKindMismatch = existingChatKind !== 'unknown'
        && maxChatKind !== 'unknown'
        && existingChatKind !== maxChatKind
      const chatKindCollisionReason = hasConcreteChatKindMismatch
        || (hasPrivateConversationAuthority && maxChatKind === 'group')
        ? 'chat_kind_mismatch'
        : null
      const incomingPeerSenderId = options.incomingPeerSenderId === undefined
        ? peerSenderIdString
        : options.incomingPeerSenderId
      const requiresPeerSenderProof = options.requirePeerSenderProof ?? (!isOutgoing && (
        hasPrivateConversationAuthority
        || (options.requireExactExternalChatId && maxChatKind === 'private')
      ))
      const senderCollisionReason = requiresPeerSenderProof && !chatKindCollisionReason
        ? existingSenderId && incomingPeerSenderId
          ? existingSenderId !== incomingPeerSenderId ? 'sender_identity_mismatch' : null
          : 'sender_identity_unproven'
        : null
      const channelCollisionReason = existingChat.channel !== 'max'
        ? 'channel_mismatch'
        : null
      const messageChatCollisionReason = options.requireExactExternalChatId
        && (
          normalizeMaxChatId(existingChat.externalChatId) !== externalChatId
          || (options.expectedChatId !== undefined && existingChat.id !== options.expectedChatId)
        )
        ? 'message_chat_mismatch'
        : null
      const collisionReason = channelCollisionReason
        ?? messageChatCollisionReason
        ?? providerCollisionReason
        ?? chatKindCollisionReason
        ?? senderCollisionReason
      if (collisionReason) {
        await persistMaxIdentityCollision(existingChat, {
          channel: 'max',
          reason: collisionReason,
          incomingProviderAccountId: maxProviderAccountId,
          existingProviderAccountId,
          incomingSenderId: incomingPeerSenderId,
          existingSenderId,
          incomingChatKind: maxChatKind,
          existingChatKind,
          hasPersonOwnership,
          externalChatId,
          existingExternalChatId: existingChat.externalChatId,
        })
        maxRuntimeTrace('webhook.skipped', {
          providerMessageId: externalIdString,
          chatId: String(chatId),
          chatInternalId: existingChat.id,
          reason: collisionReason,
        })
        opsLog('warn', 'max_chat_identity_collision', {
          channel: 'max',
          chatId: existingChat.id,
          reason: collisionReason,
        })
        await maxContactResolutionShadow.session?.complete({
          status: 'no_contact',
          reason: collisionReason,
        })
        return NextResponse.json({
          error: collisionReason === 'provider_account_mismatch'
            ? 'MAX_PROVIDER_ACCOUNT_COLLISION'
            : collisionReason === 'provider_account_unproven'
              ? 'MAX_PROVIDER_ACCOUNT_UNPROVEN'
              : collisionReason === 'sender_identity_mismatch'
                ? 'MAX_SENDER_IDENTITY_COLLISION'
                : collisionReason === 'sender_identity_unproven'
                  ? 'MAX_SENDER_IDENTITY_UNPROVEN'
                  : collisionReason === 'chat_kind_mismatch'
                    ? 'MAX_CHAT_KIND_COLLISION'
                    : collisionReason === 'channel_mismatch'
                      ? 'MAX_CHANNEL_COLLISION'
                      : 'MAX_MESSAGE_IDENTITY_COLLISION',
        }, { status: 409 })
      }
      return null
    }

    if (chat) {
      const collision = await rejectExistingChatCollision(chat, deleted
        ? { requirePeerSenderProof: false }
        : {})
      if (collision) return collision
    }

    // Message.externalId is globally unique in the current schema. Never let
    // that global key delete or suppress a message until the owning Chat has
    // passed the exact account/conversation/peer admission above.
    if (deleted) {
      if (!externalIdString) {
        return NextResponse.json({ error: 'externalId is required for deletion' }, { status: 400 })
      }
      const existingMessage = await prisma.message.findUnique({
        where: { externalId: externalIdString },
        include: { chat: true },
      })
      if (existingMessage) {
        const storedMessageMetadata = metadataRecord(existingMessage.metadata)
        const storedMessageSenderId = typeof storedMessageMetadata.senderId === 'string'
          && storedMessageMetadata.senderId.trim() !== ''
          ? storedMessageMetadata.senderId
          : null
        const collision = await rejectExistingChatCollision(existingMessage.chat, {
          requireExactExternalChatId: true,
          ...(chat ? { expectedChatId: chat.id } : {}),
          incomingPeerSenderId: existingMessage.direction === 'inbound' ? storedMessageSenderId : null,
          requirePeerSenderProof: existingMessage.direction === 'inbound',
        })
        if (collision) return collision
        await deleteMessageMediaV1({
          contract: DELETE_MESSAGE_MEDIA_COMMAND_V1,
          messageId: existingMessage.id,
        })
        await deleteMessageV1({ contract: DELETE_MESSAGE_COMMAND_V1, messageId: existingMessage.id })
        console.log(`[MAX Webhook] deleted externalId=${externalIdString}`)
        broadcastChatMessage(existingMessage.chatId, { ...existingMessage, deleted: true })
      }
      await maxContactResolutionShadow.session?.complete({
        status: 'no_contact',
        reason: 'deleted_provider_message',
      })
      return NextResponse.json({ ok: true, deleted: externalIdString })
    }

    if (isTextProviderEvent && externalIdString) {
      const existingText = await prisma.message.findUnique({
        where: { externalId: externalIdString },
        include: { chat: true },
      })
      if (existingText) {
        const collision = await rejectExistingChatCollision(existingText.chat, {
          requireExactExternalChatId: true,
          ...(chat ? { expectedChatId: chat.id } : {}),
        })
        if (collision) return collision
        maxRuntimeTrace('webhook.duplicate', {
          providerMessageId: externalIdString,
          chatId: String(chatId),
          text,
          chatInternalId: existingText.chatId,
          messageId: existingText.id,
        })
        await maxContactResolutionShadow.session?.complete({
          status: 'no_contact',
          reason: 'existing_provider_message',
        })
        return NextResponse.json({
          success: true,
          chatInternalId: existingText.chatId,
          messageId: existingText.id,
          deduped: true,
        })
      }
    }

    if (peerSenderIdString) {
      const senderCandidates = await prisma.chat.findMany({
        where: {
          channel: 'max',
          AND: [
            { metadata: { path: ['senderId'], equals: peerSenderIdString } },
            { metadata: { path: ['providerAccountId'], equals: maxProviderAccountId } },
          ],
        },
      })
      const senderSelection = selectUniqueExactMaxSenderCandidate(senderCandidates)
      senderCandidateCount = senderSelection.candidateCount

      if (!chat && maxChatKind === 'private' && senderSelection.status === 'reuse') {
        const existingBySender = senderSelection.candidate
        const collision = await rejectExistingChatCollision(existingBySender)
        if (collision) return collision
        const existingMetadata = metadataRecord(existingBySender.metadata)
        chat = (await patchExternalConversationV1({
          contract: PATCH_EXTERNAL_CONVERSATION_COMMAND_V1,
          chatId: existingBySender.id,
          patch: {
            externalChatId,
            ...(isHistoryReplay ? {} : { lastMessageAt: sentAt }),
            ...(peerSenderName && existingBySender.name?.startsWith('MAX:') ? { name: peerSenderName } : {}),
            metadata: {
              ...existingMetadata,
              previousExternalChatId: existingBySender.externalChatId,
              rawExternalChatId,
              senderId: peerSenderIdString,
              ...(effectivePeerSenderPhone ? { phone: effectivePeerSenderPhone } : {}),
              chatKind: maxChatKind,
              providerAccountId: maxProviderAccountId,
              connectionId: existingMetadata.connectionId || 'max_scraper',
            },
          },
        })).conversation as Chat
      }
    }

    if (!chat) {
      chat = (await createExternalConversationV1({
        contract: CREATE_EXTERNAL_CONVERSATION_COMMAND_V1,
          channel:       'max',
          externalChatId,
          name:          peerSenderName || (peerSenderIdString ? `MAX:${peerSenderIdString}` : `MAX:${externalChatId}`),
          lastMessageAt: sentAt,
          status:        'new',
          metadata: {
            ...(peerSenderIdString       ? { senderId: peerSenderIdString }       : {}),
            ...(effectivePeerSenderPhone ? { phone: effectivePeerSenderPhone } : {}),
            rawExternalChatId,
            chatKind: maxChatKind,
            providerAccountId: maxProviderAccountId,
            connectionId: 'max_scraper',
          },
      })).conversation as Chat
    } else {
      const existingMetadata = metadataRecord(chat.metadata)
      chat = (await patchExternalConversationV1({
        contract: PATCH_EXTERNAL_CONVERSATION_COMMAND_V1,
        chatId: chat.id,
        patch: {
          ...(isHistoryReplay ? {} : { lastMessageAt: sentAt }),
          // Обновляем имя если раньше было только MAX:ID
          ...(peerSenderName && chat.name?.startsWith('MAX:') ? { name: peerSenderName } : {}),
          // Обновляем senderId / phone в metadata
          ...((peerSenderIdString || effectivePeerSenderPhone) ? {
            metadata: {
              ...existingMetadata,
              ...(peerSenderIdString       ? { senderId: peerSenderIdString }       : {}),
              ...(effectivePeerSenderPhone ? { phone: effectivePeerSenderPhone } : {}),
              rawExternalChatId,
              chatKind: maxChatKind,
              providerAccountId: maxProviderAccountId,
              connectionId: existingMetadata.connectionId || 'max_scraper',
            }
          } : {}),
        },
      })).conversation as Chat
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
    const msgType = typeMap[effectiveMessageType || 'text'] || 'text'

    // For non-text messages without text, use a readable placeholder
    const contentFallbacks: Record<string, string> = {
      image: '[Фото]', video: '[Видео]', voice: '[Голосовое]',
      audio: '[Аудио]', document: '[Документ]',
    }
    const content = text || contentFallbacks[messageType || 'text'] || ''

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
        message = (await replaceExternalMessageV1({
          contract: REPLACE_EXTERNAL_MESSAGE_COMMAND_V1,
          messageId: nearbyDomMessage.id,
          externalId: externalIdString,
          type: msgType,
          content,
          sentAt,
          metadata: { ...metadataRecord(nearbyDomMessage.metadata), senderId, maxChatId: externalChatId, maxRawChatId: rawExternalChatId, attachments: attachments || [], ...(replyToExternalIdString ? { replyToExternalId: replyToExternalIdString } : {}), ...(forwardedFrom ? { forwardedFrom } : {}) },
        })).message as Message
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

    // Create Message (skip if already seen)
    if (!message) {
      message = (await upsertExternalMessageV1({
        contract: UPSERT_EXTERNAL_MESSAGE_COMMAND_V1,
        lookupExternalId: externalIdString || `max-${chatId}-${Date.now()}`,
        chatId: chat.id,
        direction: isOutgoing ? 'outbound' : 'inbound',
        type: msgType,
        content,
        channel: 'max',
        externalId: externalIdString,
        sentAt, // validated above
        metadata: { senderId, maxChatId: externalChatId, maxRawChatId: rawExternalChatId, attachments: attachments || [], ...(source ? { source } : {}), ...(replyToExternalIdString ? { replyToExternalId: replyToExternalIdString } : {}), ...(forwardedFrom ? { forwardedFrom } : {}) },
      })).message as Message
      if (message.chatId !== chat.id) {
        const owningChat = await prisma.chat.findUnique({ where: { id: message.chatId } })
        if (owningChat) {
          const collision = await rejectExistingChatCollision(owningChat, {
            requireExactExternalChatId: true,
            expectedChatId: chat.id,
          })
          if (collision) return collision
        }
        return NextResponse.json({ error: 'MAX_MESSAGE_IDENTITY_COLLISION' }, { status: 409 })
      }
    }

    // Apply conversation workflow only after the globally keyed message has
    // been proven to belong to this exact admitted Chat.
    if (!isOutgoing && !isHistoryReplay) {
      await ConversationWorkflowService.onInboundMessage(chat.id, sentAt)
    } else if (isOutgoing && !isHistoryReplay) {
      await ConversationWorkflowService.onOutboundMessage(chat.id, sentAt)
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
        await attachMessageMediaV2({
          contract: ATTACH_MESSAGE_MEDIA_COMMAND_V2,
          messageId: message.id,
          mediaType: att.type || 'file',
          url: att.url,
          fileName: attachmentDisplayName(att),
          fileSize: attachmentSize(att),
          mimeType: att.mimeType || null,
        })
      }
    }

    console.log(`[MAX Webhook] chatId=${chatId} direction=${isOutgoing ? 'out' : 'in'} text="${(text || '').slice(0, 50)}"`)

    // ── Contact Model dual write ──────────────────────────────
    let legacyContactResolution: LegacyContactResolutionOutcome = {
      status: 'no_contact',
      reason: 'outgoing_or_not_attempted',
    }
    let contactResolutionMetadata: Record<string, unknown> = {
      status: isOutgoing ? 'not_attempted' : 'unknown_kind_limited',
      candidateCount: 0,
      automaticLinkPerformed: false,
    }
    if (!isOutgoing) {
      try {
        if (maxChatKind === 'group') {
          contactResolutionMetadata = {
            status: 'group_skipped',
            candidateCount: 0,
            automaticLinkPerformed: false,
          }
          legacyContactResolution = { status: 'no_contact', reason: 'group_skipped' }
        } else if (senderCandidateCount > 1) {
          contactResolutionMetadata = {
            status: 'ambiguous',
            candidateCount: senderCandidateCount,
            automaticLinkPerformed: false,
            reason: 'multiple_exact_sender_chats',
          }
          legacyContactResolution = { status: 'no_contact', reason: 'ambiguous_sender_mapping' }
        } else if (!peerSenderIdString) {
          contactResolutionMetadata = {
            status: 'unknown_kind_limited',
            candidateCount: 0,
            automaticLinkPerformed: false,
            reason: 'missing_exact_sender_identity',
          }
          legacyContactResolution = { status: 'no_contact', reason: 'missing_sender_identity' }
        } else {
          // MAX payload phones remain untrusted. The conversation id is never
          // substituted for senderId and cannot become a person identity.
          const contactResult = await resolveChannelContactOperationV1(
            'max',
            peerSenderIdString,
            effectivePeerSenderPhone,
            peerSenderName,
            {
              chatKind: maxChatKind,
              providerAccountId: maxProviderAccountId,
              phoneEvidence: effectivePeerSenderPhone
                ? { source: 'unknown', trustedForAutomaticResolution: false }
                : null,
            },
          )
          if (isResolvedChannelContactResultV1(contactResult) && contactResult.identity) {
            await ensureConversationContactLinkV1({
              contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
              chatId: chat.id,
              contactId: contactResult.contact.id,
              contactIdentityId: contactResult.identity.id,
            })
            if (maxChatKind === 'private' && !isHistoryReplay) {
              await contactReachabilityV1.recordExactProviderReachability({
                identityId: contactResult.identity.id,
                contactId: contactResult.contact.id,
                channel: 'max',
                providerAccountId: maxProviderAccountId,
                providerTargetId: peerSenderIdString,
                status: 'confirmed',
              })
            }
            contactResolutionMetadata = {
              status: contactResult.status,
              candidateCount: 1,
              automaticLinkPerformed: true,
            }
            legacyContactResolution = contactResult.isNew
              ? { status: 'contact_created', contactId: contactResult.contact.id }
              : { status: 'contact_reused', contactId: contactResult.contact.id, source: 'identity' }
          } else {
            const candidateCount = contactResult.status === 'ambiguous'
              ? contactResult.candidateCount
              : contactResult.status === 'identity_phone_conflict'
                ? new Set([contactResult.identityContactId, ...contactResult.phoneContactIds]).size
                : 0
            contactResolutionMetadata = {
              status: contactResult.status,
              candidateCount,
              automaticLinkPerformed: false,
            }
            legacyContactResolution = { status: 'no_contact', reason: contactResult.status }
          }
        }
      } catch (contactErr: unknown) {
        const message = contactErr instanceof Error ? contactErr.message : String(contactErr)
        console.error(`[MAX Webhook] ContactService error (non-blocking): ${message}`)
        legacyContactResolution = {
          status: 'legacy_error',
          errorCode: contactErr instanceof Error ? contactErr.name : 'unknown_legacy_error',
        }
        contactResolutionMetadata = {
          status: 'error',
          candidateCount: 0,
          automaticLinkPerformed: false,
        }
      }
    }
    await patchExternalConversationV1({
      contract: PATCH_EXTERNAL_CONVERSATION_COMMAND_V1,
      chatId: chat.id,
      patch: {
        metadata: {
          ...metadataRecord(chat.metadata),
          contactResolution: contactResolutionMetadata,
        },
      },
    })
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
    opsLog('error', 'webhook_max_error', { channel: 'max', error: message })
    return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 })
  }
}
