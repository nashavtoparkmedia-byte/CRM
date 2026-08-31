'use strict'

require('dotenv').config()

const express  = require('express')
const fs       = require('fs')
const path     = require('path')
const cors     = require('cors')
const http     = require('http')
const https    = require('https')
const crypto   = require('crypto')
const { chromium } = require('playwright')

const { SessionController }        = require('./session/SessionController')
const {
  TransportInterceptor,
  OP,
  evaluatePhoneResolutionUiSend,
} = require('./transport/TransportInterceptor')
const { MessageParser }            = require('./parser/MessageParser')
const { MediaPipeline }            = require('./media/MediaPipeline')
const { MessageSync }              = require('./sync/MessageSync')
const { InitialHistorySync }       = require('./sync/InitialHistorySync')
const { NameSync }                 = require('./sync/NameSync')
const { ContactStore }             = require('./contacts/ContactStore')
const { cleanupStaleMaxSession }   = require('./lib/MaxCleanup')
const QRCode                       = require('qrcode')

// ─── Конфиг ──────────────────────────────────────────────────────────────────

const PORT            = process.env.PORT            || 3005
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/webhooks/max'
const MAX_URL         = 'https://web.max.ru/'
const USER_DATA_DIR        = path.join(__dirname, 'user_data')
const PHONE_CHATID_CACHE   = path.join(USER_DATA_DIR, 'phone_chatid_cache.json')
const KNOWN_CHATS_PATH     = path.join(USER_DATA_DIR, 'known_chats.json')
const LEGACY_KNOWN_CHATS_PATH = path.join(__dirname, 'known_chats.json')
const LIVE_DOM_WINDOW_CONTEXT_SLACK = 2
const UI_CHAT_ID_OVERRIDES = {
  // MAX exposes different IDs for websocket history and the web.max.ru route.
  // Remezov Alexander: protocol 902144614300, browser URL /201482140.
  '902144614300': '201482140',
  // +79126787532: protocol dialog id differs from browser profile/dialog route.
  '902454841098': '511708938',
  // Live inbound fallback observed in prod: protocol dialog id differs from browser route.
  '901943199056': '66896',
}

function protocolChatIdForUiRoute(routeId) {
  const value = String(routeId || '')
  for (const [protocolId, uiRouteId] of Object.entries(UI_CHAT_ID_OVERRIDES)) {
    if (String(uiRouteId) === value) return protocolId
  }
  return value
}

function normalizeMaxChatId(chatId) {
  return protocolChatIdForUiRoute(chatId)
}

function dialogParticipantUiRouteId(chatId) {
  const chatIdStr = String(chatId || '')
  if (!chatIdStr || typeof chatCache === 'undefined' || !chatCache?.get) return null

  const chat = chatCache.get(chatIdStr)
  if (!chat || typeof chat !== 'object') return null
  if (chat.type && String(chat.type).toUpperCase() !== 'DIALOG') return null

  const participants = chat.participants && typeof chat.participants === 'object'
    ? Object.keys(chat.participants)
    : []
  if (!participants.length) return null

  const myId = String(transport?._myUserId || '')
  if (myId && !participants.includes(myId)) return null

  const otherParticipants = participants
    .filter(id => id && String(id) !== myId)
    .filter(id => /^\d{5,15}$/.test(String(id)))

  if (otherParticipants.length !== 1) return null
  const routeId = String(otherParticipants[0])
  return routeId && routeId !== chatIdStr ? routeId : null
}

function resolveUiRouteIdForChat(chatId) {
  const chatIdStr = String(chatId || '')
  const staticRouteId = UI_CHAT_ID_OVERRIDES[chatIdStr]
  if (staticRouteId) return { uiRouteId: String(staticRouteId), source: 'static_override' }

  const participantRouteId = dialogParticipantUiRouteId(chatIdStr)
  if (participantRouteId) return { uiRouteId: participantRouteId, source: 'dialog_participant' }

  return { uiRouteId: chatIdStr, source: 'protocol_chat_id' }
}

const MAX_DELIVERY_STATUSES = new Set([
  'queued',
  'upload_started',
  'uploaded',
  'send_requested',
  'max_echo_received',
  'delivered',
  'failed',
])

function redactForStructuredLog(value, depth = 0) {
  if (depth > 5) return '[truncated]'
  if (value == null) return value
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`
  if (typeof value === 'string') {
    if (value.length > 300) return `${value.slice(0, 120)}...[${value.length}]`
    if (/^data:.*;base64,/i.test(value)) return '[data-url-redacted]'
    if (/^[A-Za-z0-9+/=_-]{400,}$/.test(value)) return '[base64-or-token-redacted]'
    return value
  }
  if (Array.isArray(value)) return value.map(item => redactForStructuredLog(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (/token|cookie|secret|authorization|base64|password/i.test(key)) {
        out[key] = '[redacted]'
      } else if (/url/i.test(key) && typeof item === 'string') {
        out[key] = String(item).slice(0, 120)
      } else {
        out[key] = redactForStructuredLog(item, depth + 1)
      }
    }
    return out
  }
  return value
}

function maxDeliveryLog(event) {
  const status = MAX_DELIVERY_STATUSES.has(event?.status) ? event.status : (event?.error ? 'failed' : 'send_requested')
  const payload = redactForStructuredLog({
    ts: new Date().toISOString(),
    ...event,
    status,
  })
  console.log('[MAX_DELIVERY]', JSON.stringify(payload))
}

function isRealMaxMessageId(id) {
  return /^d301/i.test(String(id || ''))
}

function stableTextCid(seed) {
  if (!seed) return -Date.now()
  const digest = crypto.createHash('sha1').update(String(seed)).digest()
  const value = digest.readUInt32BE(0) & 0x7fffffff
  return -Math.max(1, value)
}

function normalizeMediaSendResult(result) {
  if (result && typeof result === 'object' && !Buffer.isBuffer(result)) {
    const externalId = result.externalId || result.maxMessageId || null
    const source = String(result.source || '')
    const deliveryConfirmed = Boolean(
      source !== 'op180' &&
      source !== 'op180_compact' &&
      result.deliveryConfirmed &&
      isRealMaxMessageId(externalId)
    )
    return {
      ...result,
      externalId,
      maxMessageId: result.maxMessageId || externalId,
      deliveryConfirmed,
      deliveryStatus: deliveryConfirmed ? 'delivered' : (result.deliveryStatus || result.status || 'send_requested'),
    }
  }
  const externalId = result ? String(result) : null
  const deliveryConfirmed = isRealMaxMessageId(externalId)
  return {
    externalId,
    maxMessageId: externalId,
    deliveryConfirmed,
    deliveryStatus: deliveryConfirmed ? 'delivered' : 'send_requested',
  }
}

function uiTextDeliveredResult(source = 'ui_text_no_provider_id', clientMessageId = null) {
  return {
    externalId: null,
    maxMessageId: null,
    deliveryConfirmed: true,
    deliveryStatus: 'delivered',
    source,
    deliveryProof: {
      kind: 'ui_send_action',
      clientMessageId: clientMessageId ? String(clientMessageId) : null,
      actionConfirmed: true,
    },
  }
}

function readKnownChatIds() {
  let known = []
  try { known = JSON.parse(fs.readFileSync(KNOWN_CHATS_PATH, 'utf8')) } catch {}
  if (!Array.isArray(known)) known = []

  let legacy = []
  try { legacy = JSON.parse(fs.readFileSync(LEGACY_KNOWN_CHATS_PATH, 'utf8')) } catch {}
  if (Array.isArray(legacy) && legacy.length > 0) {
    known = [...new Set([...known.map(String), ...legacy.map(String)])]
    try {
      fs.mkdirSync(USER_DATA_DIR, { recursive: true })
      fs.writeFileSync(KNOWN_CHATS_PATH, JSON.stringify(known))
      fs.unlinkSync(LEGACY_KNOWN_CHATS_PATH)
    } catch {}
  }

  return known.map(String)
}

function rememberKnownChatId(chatId) {
  const normalized = chatId != null ? String(chatId) : ''
  if (!normalized || normalized === '0') return
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true })
    const known = readKnownChatIds()
    if (!known.includes(normalized)) {
      known.push(normalized)
      fs.writeFileSync(KNOWN_CHATS_PATH, JSON.stringify(known))
    }
  } catch {}
}

function normalizeTextSendResult(result) {
  if (result && typeof result === 'object' && !Buffer.isBuffer(result)) {
    const externalId = typeof result.externalId === 'string'
      ? result.externalId
      : (typeof result.maxMessageId === 'string' ? result.maxMessageId : null)
    const maxMessageId = typeof result.maxMessageId === 'string' ? result.maxMessageId : externalId
    const hasExplicitError = Object.prototype.hasOwnProperty.call(result, 'error')
      && result.error !== null
      && result.error !== undefined
      && result.error !== ''
    const explicitError = typeof result.error === 'string' && result.error.trim()
      ? result.error.trim()
      : null
    const hasExplicitFailure = result.success === false || result.failed === true || result.failure === true
    if (hasExplicitFailure || hasExplicitError) {
      return {
        ...result,
        success: false,
        error: explicitError || 'MAX text delivery failed',
        externalId,
        maxMessageId,
        deliveryConfirmed: false,
        deliveryStatus: 'failed',
      }
    }
    const deliveryStatus = result.deliveryStatus || result.status || (result.deliveryConfirmed === true ? 'delivered' : 'send_requested')
    return {
      ...result,
      externalId,
      maxMessageId,
      deliveryConfirmed: result.deliveryConfirmed === true && deliveryStatus === 'delivered',
      deliveryStatus,
    }
  }
  const externalId = result ? String(result) : null
  const deliveryConfirmed = isRealMaxMessageId(externalId)
  return {
    externalId,
    maxMessageId: externalId,
    deliveryConfirmed,
    deliveryStatus: deliveryConfirmed ? 'delivered' : 'send_requested',
  }
}

function isConfirmedMediaSendResult(result) {
  return Boolean(result?.deliveryConfirmed && isRealMaxMessageId(result.maxMessageId || result.externalId))
}

function isProtocolMaxChatId(chatId) {
  return /^\d{12,}$/.test(String(chatId || ''))
}

// 'none' | 'from_connection_time' | 'available_history'
let HISTORY_IMPORT_MODE = process.env.HISTORY_IMPORT_MODE || 'from_connection_time'
let qrUpdatedAt         = null   // timestamp последней генерации QR
const SESSION_START_MS  = Date.now()  // для подавления ложного QR при перезапуске

// ─── Persistent phone → chatId cache (survives container restarts) ───────────
// Stored in the Docker volume (user_data) so chatIds discovered via UI-send
// are remembered across restarts. Key = E.164 digits, value = 12-digit chatId.

function loadPhoneChatIdCache() {
  if (!contactStore) return
  try {
    if (!fs.existsSync(PHONE_CHATID_CACHE)) return
    const data = JSON.parse(fs.readFileSync(PHONE_CHATID_CACHE, 'utf8'))
    let n = 0
    for (const [phone, chatId] of Object.entries(data)) {
      contactStore._map.set(String(chatId), { name: null, firstName: null, lastName: null, phone: String(phone) })
      n++
    }
    if (n) console.log(`[PhoneCache] Loaded ${n} entries from volume`)
  } catch (e) {
    console.warn('[PhoneCache] Load failed:', e.message)
  }
}

function normalizePhoneForCrmPayload(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length === 10) return `+7${digits}`
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`
  return digits || null
}

function savePhoneChatId(phone, chatId) {
  try {
    let data = {}
    if (fs.existsSync(PHONE_CHATID_CACHE)) {
      data = JSON.parse(fs.readFileSync(PHONE_CHATID_CACHE, 'utf8'))
    }
    const key = String(phone).replace(/\D/g, '')
    const chatIdStr = String(chatId)
    data[key] = chatIdStr
    fs.mkdirSync(USER_DATA_DIR, { recursive: true })
    fs.writeFileSync(PHONE_CHATID_CACHE, JSON.stringify(data, null, 2))
    if (contactStore && key) {
      contactStore._map.set(chatIdStr, { name: null, firstName: null, lastName: null, phone: key })
    }
    console.log(`[PhoneCache] Saved ${key} → ${chatIdStr}`)
  } catch (e) {
    console.warn('[PhoneCache] Save failed:', e.message)
  }
}

function cachedPhoneForChatId(...chatIds) {
  for (const chatId of chatIds) {
    if (chatId == null) continue
    const phone = contactStore?.getPhone?.(String(chatId))
    if (phone) return phone
  }
  return null
}

// ─── Счётчик статистики импорта ──────────────────────────────────────────────

let importSession = null  // { jobId, crmApiUrl, startedAt, messagesImported, chatsSet, minMessageDate, maxMessageDate }

function startImportSession(jobId, crmApiUrl) {
  importSession = { jobId, crmApiUrl, startedAt: Date.now(), messagesImported: 0, chatsSet: new Set(), minMessageDate: null, maxMessageDate: null }
}

function trackImportedMessage(chatId, sentAt) {
  if (!importSession) return
  importSession.messagesImported++
  if (chatId) importSession.chatsSet.add(String(chatId))
  if (sentAt) {
    const ts = new Date(sentAt).getTime()
    if (!isNaN(ts)) {
      if (importSession.minMessageDate === null || ts < importSession.minMessageDate) importSession.minMessageDate = ts
      if (importSession.maxMessageDate === null || ts > importSession.maxMessageDate) importSession.maxMessageDate = ts
    }
  }
}

async function finishImportSession(status = 'completed', resultType = 'partial') {
  if (!importSession) return
  const { jobId, crmApiUrl, startedAt, messagesImported, chatsSet, minMessageDate, maxMessageDate } = importSession
  importSession = null

  if (!jobId) return

  // База для job-колбэка — origin рабочего CRM_WEBHOOK_URL (по нему скрапер
  // уже успешно льёт сообщения, значит адрес достижим). crmApiUrl, который
  // передаёт gravity, ненадёжен: внутри docker gravity не знает свой внешний
  // URL и шлёт localhost:3002 → в сети контейнера это сам скрапер
  // (ECONNREFUSED) → job навсегда висел в queued, а в UI крутился спиннер.
  const crmBase = (CRM_WEBHOOK_URL || '').replace(/\/api\/.*$/, '')
    || crmApiUrl
    || 'http://127.0.0.1:3002'

  const body = JSON.stringify({
    status,
    resultType,
    messagesImported,
    chatsScanned:    chatsSet.size,
    contactsFound:   contactStore ? contactStore._map.size : 0,
    startedAt:       new Date(startedAt).toISOString(),
    finishedAt:      new Date().toISOString(),
    coveredPeriodFrom: minMessageDate ? new Date(minMessageDate).toISOString() : new Date(startedAt).toISOString(),
    coveredPeriodTo:   maxMessageDate ? new Date(maxMessageDate).toISOString() : new Date().toISOString(),
  })

  try {
    const url = new URL(`${crmBase}/api/import-jobs/${jobId}`)
    const mod = url.protocol === 'https:' ? https : http
    await new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'PATCH',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); res.on('end', resolve) })
      req.on('error', reject)
      req.write(body); req.end()
    })
    console.log(`[Import] Job ${jobId} завершён: ${messagesImported} сообщений, ${chatsSet.size} чатов`)
  } catch (e) {
    console.error('[Import] Не удалось обновить job:', e.message)
  }
}

// ─── Дедупликация собственных реакций (opcode 135 echo) ─────────────────────
// Когда мы отправляем реакцию из CRM, MAX сервер пушит opcode 135 обратно.
// Без фильтра это создаёт дублирующее обновление в CRM (реакция уже сохранена через broadcastChatMessage).
const recentOwnReactionIds = new Set()

// ─── Маппинг ID → emoji (из opcode 28) ────────────────────────────────────────
// MAX хранит реакции как { reactionType:'EMOJI', id: <integer> } где id — это
// animoji-ID. Этот маппинг позволяет преобразовать integer ID обратно в emoji-символ.
const reactionEmojiById = new Map()
const reactionIdByEmoji = new Map([
  ['👍', 1],
  ['👍🏻', 1],
  ['👍🏼', 1],
  ['👍🏽', 1],
  ['👍🏾', 1],
  ['👍🏿', 1],
  ['⚡', 117],
  ['⚡️', 117],
])
reactionEmojiById.set(1, '👍')
reactionEmojiById.set(117, '⚡️')

function normalizeReactionEmoji(raw) {
  if (!raw) return ''
  // Если это объект { id, reactionType } — извлекаем id
  if (typeof raw === 'object') raw = raw.id || raw.emoji || ''
  // Если id — число (или строка числа) → ищем emoji символ в карте
  const asNum = Number(raw)
  if (!isNaN(asNum) && reactionEmojiById.has(asNum)) {
    return reactionEmojiById.get(asNum)
  }
  // Иначе уже emoji символ — вернуть как есть
  return String(raw)
}

function extractMaxId(value) {
  if (!value) return null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    if (value.hex) return String(value.hex)
    if (value.id) return extractMaxId(value.id)
    if (value.messageId) return extractMaxId(value.messageId)
  }
  return null
}

function extractReactionCountersFromMap(messagesReactions) {
  const countersByMessage = new Map()
  const entries = Array.isArray(messagesReactions?.__complexEntries)
    ? messagesReactions.__complexEntries
    : []

  for (const entry of entries) {
    const externalMsgId = extractMaxId(entry?.key)
    if (!externalMsgId) continue

    const value = entry?.value || {}
    const counters = []
    const source = Array.isArray(value.counters)
      ? value.counters
      : Array.isArray(value.reactions)
        ? value.reactions
        : Array.isArray(value)
          ? value
          : []

    for (const item of source) {
      const reaction = normalizeReactionEmoji(item?.reaction || item?.id || item?.emoji || item)
      const count = Number(item?.count ?? item?.value ?? 1)
      if (reaction && count > 0) counters.push({ reaction, count })
    }

    if (counters.length > 0) countersByMessage.set(externalMsgId, counters)
  }

  return countersByMessage
}

function hexFromMaxReactionBlob(value) {
  if (value == null) return ''
  const raw = String(value)
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return raw.toLowerCase()
  return Buffer.from(raw, 'utf8').toString('hex').toLowerCase()
}

function maxMessageSuffix(messageId) {
  const hex = String(messageId || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
  if (hex.length < 12) return ''
  return hex.slice(-12)
}

function compactReactionSnapshotMatches(messagesReactions, messageId) {
  if (!messagesReactions || !messageId) return false
  const suffix = maxMessageSuffix(messageId)
  if (!suffix) return false
  const countersMarker = Buffer.from('counters').toString('hex')
  for (const value of Object.values(messagesReactions)) {
    if (typeof value !== 'string') continue
    const hex = hexFromMaxReactionBlob(value)
    if (hex.includes(countersMarker) && hex.includes(suffix)) return true
  }
  return false
}

function waitForReactionConfirmation(transport, { chatId, messageId, emoji, remove = false, timeoutMs = 15_000 } = {}) {
  if (!transport?._rawHandlers || !messageId) return Promise.resolve(null)
  const expectedMessageId = String(messageId)
  const expectedChatId = chatId != null ? String(chatId) : null
  const expectedEmoji = emoji ? normalizeReactionEmoji(emoji) : ''

  return new Promise(resolve => {
    let done = false
    const cleanup = () => {
      const index = transport._rawHandlers.indexOf(handler)
      if (index >= 0) transport._rawHandlers.splice(index, 1)
    }
    const finish = confirmation => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      resolve(confirmation)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const matches = externalMsgId => String(externalMsgId || '') === expectedMessageId

    const handler = data => {
      try {
        if (![135, 155, 180].includes(data?.opcode)) return
        const payload = data.payload || {}

        if (data.opcode === 180 && payload.messagesReactions) {
          const byMessage = extractReactionCountersFromMap(payload.messagesReactions)
          if (byMessage.has(expectedMessageId)) {
            finish({
              reactionConfirmed: true,
              deliveryStatus: 'delivered',
              source: 'op180',
              counters: byMessage.get(expectedMessageId),
            })
            return
          }
          if (compactReactionSnapshotMatches(payload.messagesReactions, expectedMessageId)) {
            finish({
              reactionConfirmed: true,
              deliveryStatus: 'delivered',
              source: 'op180_compact',
              counters: expectedEmoji ? [{ reaction: expectedEmoji, count: remove ? 0 : 1 }] : undefined,
            })
            return
          }
        }

        if (data.opcode === 155 && matches(payload.messageId || payload.id)) {
          const counters = normalizeReactionCounters(payload.reactionInfo || payload)
          if (counters.length > 0 || remove) {
            finish({
              reactionConfirmed: true,
              deliveryStatus: 'delivered',
              source: 'op155',
              counters,
            })
            return
          }
        }

        if (data.opcode === 135 && payload.chat) {
          const chatMatches = !expectedChatId || !payload.chat.id || String(payload.chat.id) === expectedChatId
          if (chatMatches && matches(payload.chat.lastReactedMessageId)) {
            const reaction = normalizeReactionEmoji(payload.chat.lastReaction || expectedEmoji)
            finish({
              reactionConfirmed: true,
              deliveryStatus: 'delivered',
              source: 'op135',
              reaction,
              counters: reaction ? [{ reaction, count: remove ? 0 : 1 }] : undefined,
            })
          }
        }
      } catch (e) {
        console.warn(`[sendReaction] confirmation parse failed: ${e.message}`)
      }
    }
    transport._rawHandlers.push(handler)
  })
}

function normalizeReactionCounters(source) {
  const raw = Array.isArray(source?.counters)
    ? source.counters
    : Array.isArray(source?.reactions)
      ? source.reactions
      : Array.isArray(source)
        ? source
        : []

  const counters = []
  for (const item of raw) {
    const reaction = normalizeReactionEmoji(item?.reaction || item?.id || item?.emoji || item)
    const count = Number(item?.count ?? item?.value ?? 1)
    if (reaction && count > 0) counters.push({ reaction, count })
  }
  return counters
}

function extractReactionEventsDeep(value, out = [], seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return out

  if (Array.isArray(value)) {
    for (const item of value) extractReactionEventsDeep(item, out, seen, depth + 1)
    return out
  }

  if (typeof value !== 'object') return out

  if (value.lastReactedMessageId && value.lastReaction) {
    const externalMsgId = extractMaxId(value.lastReactedMessageId)
    const emoji = normalizeReactionEmoji(value.lastReaction)
    const key = `single:${externalMsgId}:${emoji}:${!!value.isRemove}`
    if (externalMsgId && emoji && !seen.has(key)) {
      seen.add(key)
      out.push({ externalMsgId, emoji, isRemove: false })
    }
  }

  const messageId = extractMaxId(value.messageId || value.id)
  const counters = normalizeReactionCounters(value.reactionInfo || value.messagesReactions || value.counters || value.reactions ? value : null)
  if (messageId && counters.length > 0) {
    const key = `counters:${messageId}:${JSON.stringify(counters)}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ externalMsgId: messageId, counters })
    }
  }

  if (Array.isArray(value.__complexEntries)) {
    for (const entry of value.__complexEntries) {
      const externalMsgId = extractMaxId(entry?.key)
      const counters = normalizeReactionCounters(entry?.value)
      if (externalMsgId && counters.length > 0) {
        const key = `counters:${externalMsgId}:${JSON.stringify(counters)}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ externalMsgId, counters })
        }
      }
      extractReactionEventsDeep(entry?.key, out, seen, depth + 1)
      extractReactionEventsDeep(entry?.value, out, seen, depth + 1)
    }
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === '__complexEntries') continue
    extractReactionEventsDeep(item, out, seen, depth + 1)
  }

  return out
}

// ─── Очередь отправки ────────────────────────────────────────────────────────

function appendDebugJson(filename, payload) {
  try {
    fs.appendFileSync(path.join('/tmp', filename), JSON.stringify({
      ts: new Date().toISOString(),
      payload,
    }) + '\n')
  } catch {}
}

function previewDataToBuffer(value) {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (Array.isArray(value)) return Buffer.from(value)
  if (typeof value === 'object' && Array.isArray(value.data)) return Buffer.from(value.data)
  if (typeof value === 'string') {
    const dataUrl = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/i)
    if (dataUrl) {
      return dataUrl[2] ? Buffer.from(dataUrl[3], 'base64') : Buffer.from(decodeURIComponent(dataUrl[3]), 'utf8')
    }
    if (/^[A-Za-z0-9+/=_-]+$/.test(value) && value.length > 32) {
      try { return Buffer.from(value, 'base64') } catch {}
    }
  }
  return null
}

function imageMimeFromBuffer(buffer, fallback = null) {
  if (!buffer || buffer.length < 12) return fallback && /^image\//i.test(fallback) ? fallback : null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png'
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return fallback && /^image\//i.test(fallback) ? fallback : null
}

function imageExtensionFromMime(mime) {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  return 'img'
}

function previewAttachmentFromData(att, msg) {
  const buffer = previewDataToBuffer(att?.previewData)
  const mimeType = imageMimeFromBuffer(buffer, att?.mimeType)
  if (!buffer || !mimeType) return null
  const idPart = String(msg?.id || att?.photoId || Date.now()).replace(/[^\w.-]+/g, '').slice(0, 48) || 'unknown'
  const ext = imageExtensionFromMime(mimeType)
  return {
    ...att,
    type: att?.type || 'photo',
    url: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    name: att?.name || `max-photo-preview-${idPart}.${ext}`,
    size: buffer.length,
    previewOnly: true,
    downloadStatus: 'preview_only',
  }
}

const sendQueue = []
let   isSending = false

async function enqueueSend(fn) {
  return new Promise((resolve, reject) => {
    sendQueue.push({ fn, resolve, reject })
    if (!isSending) processSendQueue()
  })
}

async function processSendQueue() {
  isSending = true
  while (sendQueue.length > 0) {
    const { fn, resolve, reject } = sendQueue.shift()
    try   { resolve(await fn()) }
    catch (e) { reject(e) }
  }
  isSending = false
}

// ─── CRM webhook forward ─────────────────────────────────────────────────────

async function forwardToWebhook(payload) {
  const normalizedPayload = {
    ...payload,
    chatId: payload.chatId != null ? normalizeMaxChatId(payload.chatId) : payload.chatId,
    rawChatId: payload.rawChatId || payload.chatId,
  }
  trackImportedMessage(normalizedPayload.chatId, normalizedPayload.timestamp)
  const url  = new URL(CRM_WEBHOOK_URL)
  const body = JSON.stringify(normalizedPayload)
  const mod  = url.protocol === 'https:' ? https : http

  const options = {
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
    path:     url.pathname + url.search,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(options, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end',  () => {
        let json = null
        try { json = data ? JSON.parse(data) : null } catch {}
        const skipped = json && typeof json === 'object' && json.skipped ? String(json.skipped) : null
        resolve({ status: res.statusCode, data, json, skipped })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── Обработка входящего сообщения ───────────────────────────────────────────

async function handleIncoming(msg, mediaPipeline, messageSync, transport) {
  const rawChatId = msg.chatId
  if (msg.chatId != null) msg = { ...msg, chatId: normalizeMaxChatId(msg.chatId), rawChatId }

  // Server push: message was deleted in MAX — propagate to CRM
  if (msg.status === 'REMOVED') {
    if (!msg.id) return
    try {
      await forwardToWebhook({ deleted: true, externalId: String(msg.id), chatId: msg.chatId })
      console.log(`[App] REMOVED push → CRM delete: externalId=${msg.id} chatId=${msg.chatId}`)
    } catch (e) {
      console.error('[App] REMOVED webhook error:', e.message)
    }
    return
  }

  if (messageSync.isDuplicate(msg)) return
  messageSync.markSeen(msg)

  if (!msg.isOutgoing && !transport?._myUserId && msg.status) {
    const status = String(msg.status).toUpperCase()
    if (['SENT', 'DELIVERED', 'READ'].includes(status)) {
      console.warn(`[handleIncoming] Marking probable own MAX echo as outgoing: msgId=${msg.id || 'n/a'} status=${status}`)
      msg = { ...msg, isOutgoing: true }
    }
  }

  // Исходящее echo от сообщения, которое /send-message сейчас перехватывает
  // для получения реального conversation ID. Пропускаем здесь — CRM сам
  // обновит externalChatId когда /send-message вернёт ответ.
  if (msg.isOutgoing && msg.id && capturedEchoIds.has(String(msg.id))) {
    console.log(`[handleIncoming] Echo msgId=${msg.id} suppressed — captured by /send-message`)
    messageSync.markSeen(msg)
    return
  }

  let payload = MessageParser.toCrmPayload(msg)
  if (msg.rawChatId && String(msg.rawChatId) !== String(msg.chatId)) {
    payload = { ...payload, rawChatId: msg.rawChatId }
  }
  if (!msg.isOutgoing && !(msg.attachments && msg.attachments.length) && String(payload.text || '').trim()) {
    rememberRecentDirectInboundText(payload.chatId, payload.text, payload.externalId, payload.timestamp)
  }

  // Добавляем имя и телефон контакта из ContactStore.
  // В MAX opcode 128: chatId — это ID БЕСЕДЫ (не userId отправителя!),
  // senderId/from — userId реального отправителя.
  // Для входящих: ищем телефон по senderId. Если нет в store — запрашиваем op:32.
  // Для исходящих echo: senderId=наш userId → getPhone вернёт null, это нормально.
  const senderName = contactStore.getName(payload.senderId)
  let contactPhone = contactStore.getPhone(String(payload.senderId))

  if (!contactPhone && !msg.isOutgoing && payload.senderId && transport) {
    const freshPhone = await getContactPhone(payload.senderId)
    if (freshPhone) {
      console.log(`[handleIncoming] op:32 resolved: sender=${payload.senderId} → phone=${freshPhone}`)
      contactPhone = freshPhone
    }
  }

  if (senderName)   payload = { ...payload, senderName, driverName: senderName }
  if (contactPhone) payload = { ...payload, senderPhone: contactPhone, phone: contactPhone }

  // Переслано: текстовый префикс в content + структурированные метаданные
  if (msg.forwardedFromId) {
    const fwdName  = contactStore.getName(msg.forwardedFromId) || msg.forwardedFromId
    const fwdPhone = contactStore.getPhone(msg.forwardedFromId) || null
    const prefix   = `[↩ ${msg.forwardedFromId}:${fwdName}]`
    payload = {
      ...payload,
      text:          payload.text ? `${prefix}\n${payload.text}` : prefix,
      forwardedFrom: { id: msg.forwardedFromId, name: fwdName, phone: fwdPhone },
    }
  }

  // Скачиваем вложения
  if (msg.attachments && msg.attachments.length > 0) {
    if (!msg.isOutgoing && !isRealMaxMessageId(payload.externalId)) {
      appendDebugJson('max_media_dropped_no_real_message_id.jsonl', {
        chatId: payload.chatId,
        externalId: payload.externalId || null,
        messageType: payload.messageType,
        attachmentCount: msg.attachments.length,
        attachmentTypes: msg.attachments.map(att => att?.type || att?._type || 'unknown').slice(0, 5),
      })
      console.warn(`[media_no_real_message_id] dropped inbound media chatId=${payload.chatId} externalId=${payload.externalId || 'none'} attachments=${msg.attachments.length}`)
      return
    }
    const downloaded = []
    for (const att of msg.attachments) {
      let attUrl = att.url
      if (!attUrl && att.name && ['audio', 'voice', 'file', 'document'].includes(String(att.type || '').toLowerCase())) {
        const uiRouteId = UI_CHAT_ID_OVERRIDES[String(rawChatId)] || UI_CHAT_ID_OVERRIDES[String(msg.chatId)] || String(rawChatId || msg.chatId)
        const domFile = await downloadDomFileAttachment(uiRouteId, att.name, att.mimeType, att.type)
        if (domFile?.url) {
          downloaded.push({
            ...att,
            ...domFile,
            duration: att.duration || domFile.duration || null,
            downloadStatus: 'ok',
          })
          continue
        }
      }
      // VIDEO/FILE не несут прямой ссылки — только videoId/fileId+token.
      // Резолвим через opcode 83/88 перед скачиванием (см. resolveAttachmentUrl).
      if (!attUrl && transport) {
        try {
          attUrl = await resolveAttachmentUrl(transport, att, msg.chatId, msg.id)
        } catch (e) {
          console.error('[App] resolveAttachmentUrl error:', e.message)
        }
      }
      if (!attUrl && ['photo', 'image'].includes(String(att.type || '').toLowerCase()) && att.previewData) {
        const previewAttachment = previewAttachmentFromData(att, msg)
        if (previewAttachment?.url) {
          console.warn(`[media_preview_fallback] chatId=${msg.chatId} messageId=${msg.id || 'n/a'} photoId=${att.photoId || 'n/a'} mime=${previewAttachment.mimeType}`)
          downloaded.push(previewAttachment)
          continue
        }
      }
      if (!attUrl) {
        appendDebugJson('max_media_no_download_source.jsonl', {
          chatId: msg.chatId,
          messageId: msg.id,
          type: att.type || null,
          mimeType: att.mimeType || null,
          name: att.name || null,
          size: att.size || null,
          duration: att.duration || null,
          hasVideoId: Boolean(att.videoId),
          hasFileId: Boolean(att.fileId),
          hasPhotoId: Boolean(att.photoId),
          hasToken: Boolean(att.token),
          hasThumbnail: Boolean(att.thumbnail),
          hasPreviewData: Boolean(att.previewData),
        })
        console.warn(`[media_no_download_source] chatId=${msg.chatId} messageId=${msg.id || 'n/a'} type=${att.type || 'unknown'} hasPhotoId=${Boolean(att.photoId)} hasPreviewData=${Boolean(att.previewData)}`)
        continue
      }
      try {
        const file = await mediaPipeline.downloadAttachment(attUrl, att.mimeType)
        // Convert to data URL so CRM stores the file permanently.
        // Resolved CDN URLs (opcode 83/88) expire within minutes — if we
        // store the raw CDN URL, /api/attachments/{id} will get 403 later.
        const fileBuffer = fs.readFileSync(file.localPath)
        const downloadedMime = file.mimeType || att.mimeType || 'application/octet-stream'
        const dataUrl = `data:${downloadedMime};base64,${fileBuffer.toString('base64')}`
        downloaded.push({
          ...att,
          url:       dataUrl,
          mimeType:  downloadedMime,
          localPath: file.localPath,
          size:      file.size,
          duration:  att.duration || null,
          downloadStatus: 'ok',  // PR-Ч
        })
      } catch (e) {
        console.error('[App] Ошибка скачивания вложения:', e.message)
        // PR-Ч: сохраняем оригинальный URL чтобы UI/admin мог сделать manual retry.
        // downloadStatus='failed' + downloadError для диагностики.
        downloaded.push({
          ...att,
          url: attUrl,
          downloadStatus: 'failed',
          downloadError:  e.message,
        })
      }
    }
    if (downloaded.length === 0) {
      appendDebugJson('max_media_dropped_no_attachment.jsonl', {
        chatId: msg.chatId,
        messageId: msg.id,
        messageType: payload.messageType,
        text: payload.text ? '[present]' : '',
        attachmentCount: msg.attachments.length,
      })
      if (!String(payload.text || '').trim() && ['image', 'photo'].includes(String(payload.messageType || '').toLowerCase())) {
        console.warn(`[media_no_download_source] dropped empty image message chatId=${msg.chatId} messageId=${msg.id || 'n/a'}`)
        return
      }
      if (String(payload.text || '').trim()) {
        payload = { ...payload, messageType: 'text', attachments: [] }
      }
    }
    payload = { ...payload, attachments: downloaded }
  }

  try {
    const result = await forwardToWebhook(payload)
    if (result.status >= 200 && result.status < 300) {
      if (result.skipped) {
        console.warn(`[App] CRM webhook skipped_by_crm_webhook=${result.skipped} chatId=${payload.chatId} externalId=${payload.externalId || 'none'} text="${(payload.text || '').slice(0, 50)}"`)
      } else {
        console.log(`[App] → CRM: chatId=${payload.chatId} text="${(payload.text || '').slice(0, 50)}"`)
      }
    } else {
      console.error(`[App] CRM webhook вернул ${result.status} для chatId=${payload.chatId} — сообщение потеряно! body:`, result.data?.slice(0, 200))
    }
  } catch (e) {
    console.error('[App] Webhook forward failed (network):', e.message, '— chatId:', payload.chatId)
  }

  // Сохраняем timestamp последней активности для catch-up при рестарте
  try {
    fs.writeFileSync(
      path.join(__dirname, 'last_activity.json'),
      JSON.stringify({ ts: Date.now() })
    )
  } catch {}

  // Запоминаем chatId для catch-up при рестарте
  rememberKnownChatId(payload.chatId)
}

// ─── Отправка текста через WS opcode 64 ──────────────────────────────────────

async function sendText(transport, chatId, text, replyToMessageId, uiChatId, clientMessageId) {
  const cid = stableTextCid(clientMessageId)
  const message = { text, cid, elements: [], attaches: [] }
  if (replyToMessageId) message.link = { type: 'REPLY', messageId: String(replyToMessageId) }

  const directUiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || null
  if (directUiRouteId && !replyToMessageId) {
    const directText = text
    const ackPromise = waitForUiSendAck(transport, 15_000)
    const uiSent = await sendTextViaUi(directUiRouteId, directText, chatId).catch(uiErr => {
      console.warn(`[sendText] Direct UI send failed: ${uiErr.message}`)
      return false
    })
    if (uiSent) {
      const ackId = await ackPromise
      if (ackId && isRealMaxMessageId(ackId)) {
        console.log(`[sendText] Direct UI sent chatId=${chatId} route=${directUiRouteId} msgId=${ackId}`)
        return ackId
      }
      console.log(`[sendText] Direct UI sent chatId=${chatId} route=${directUiRouteId} without provider id`)
      return uiTextDeliveredResult('direct_ui_no_provider_id', clientMessageId)
    }
  }

  const sendProtocolText = async (timeoutMs) => {
    const wsChatId = chatId
    if (replyToMessageId && directUiRouteId) {
      console.log(`[sendText] reply via WS protocol chatId=${chatId} uiRoute=${directUiRouteId}`)
    }
    const resp = await transport.sendFrame(OP.SEND_MESSAGE, { chatId: wsChatId, message, notify: true }, { waitResponse: true, timeoutMs })
    // MAX responds with the created message; extract its server-assigned ID
    const maxMsgId = resp?.message?.id ? String(resp.message.id) : null
    if (maxMsgId) console.log(`[Send] MAX assigned msgId=${maxMsgId} for chatId=${chatId}`)
    return maxMsgId
  }

  try {
    return await sendProtocolText(30_000)
  } catch (e) {
    // Re-throw MAX protocol errors (not.found, etc.) — these are real failures, not timeouts
    if (e.maxError) throw e
    const isWsFail = e.message && e.message.startsWith('WS send failed')
    if (isWsFail) {
      console.error(`[sendText] WS send FAILED (window.__maxWs not ready): ${e.message}`)
    } else {
      console.warn(`[sendText] No ack from MAX (timeout) — treating delivery as failed`)
    }
    if (!e.maxError) {
      if (replyToMessageId) {
        const isOpcode64Timeout = /Timeout: opcode 64/i.test(String(e.message || ''))
        if (isOpcode64Timeout && typeof transport?.waitForStableWs === 'function') {
          console.warn('[sendText] reply send timed out; waiting for stable WS and retrying once with same cid')
          const stable = await transport.waitForStableWs(800, 8_000).catch(() => false)
          if (stable) {
            try {
              return await sendProtocolText(15_000)
            } catch (retryErr) {
              console.warn(`[sendText] reply quick retry failed: ${retryErr.message}`)
            }
          }
        }
        console.warn('[sendText] reply send failed without MAX confirmation; not downgrading to plain UI text')
        throw e
      }
      const uiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || chatId
      const ackPromise = waitForUiSendAck(transport, 15_000)
      const uiSent = await sendTextViaUi(uiRouteId, text, chatId).catch(uiErr => {
        console.warn(`[sendText] UI fallback failed: ${uiErr.message}`)
        return false
      })
      if (uiSent) {
        const ackId = await ackPromise
        if (ackId && isRealMaxMessageId(ackId)) {
          console.log(`[sendText] UI fallback sent chatId=${chatId} msgId=${ackId}`)
          return ackId
        }
        console.log(`[sendText] UI fallback sent chatId=${chatId} without provider id`)
        return uiTextDeliveredResult('ui_fallback_no_provider_id', clientMessageId)
      }
    }
    throw e
  }
}

async function fillEditableText(locator, value) {
  const text = String(value || '')
  await locator.click({ timeout: 1_000 })
  await locator.fill(text, { timeout: 1_500 }).catch(async () => {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+A`).catch(() => {})
    await page.keyboard.press('Backspace').catch(() => {})
    await page.keyboard.insertText(text).catch(async () => {
      await locator.evaluate((el, nextValue) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.value = nextValue
        } else {
          el.textContent = nextValue
        }
        const inputEvent = typeof InputEvent === 'function'
          ? new InputEvent('input', { inputType: 'insertText', data: nextValue, bubbles: true })
          : new Event('input', { bubbles: true })
        el.dispatchEvent(inputEvent)
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, text)
    })
  })
  await page.waitForTimeout(150)
  return locator.evaluate(el =>
    (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
      ? el.value
      : (el.textContent || '')
  ).catch(() => '')
}

async function sendTextViaUi(chatId, text, protocolChatId = null) {
  if (!page || !isReady) return false

  uiSendInProgress = true
  try {
    const targetUrl = `https://web.max.ru/${chatId}`
    if (transport) transport._activeUiChatId = protocolChatId ? String(protocolChatId) : protocolChatIdForUiRoute(chatId)
    console.log(`[sendTextUi] opening ${targetUrl}`)
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1800)

    const composeSelectors = [
      'div[contenteditable][role="textbox"]',
      'div[contenteditable="true"]:not([role="search"])',
      'div[contenteditable]',
      'textarea',
    ]

    let composeEl = null
    for (const sel of composeSelectors) {
      const candidates = page.locator(sel)
      const count = await candidates.count().catch(() => 0)
      for (let i = count - 1; i >= 0; i--) {
        const el = candidates.nth(i)
        if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
          composeEl = el
          console.log(`[sendTextUi] compose input: ${sel} #${i}`)
          break
        }
      }
      if (composeEl) break
    }

    if (!composeEl) {
      await page.screenshot({ path: '/tmp/max_send_ui_no_compose.png', fullPage: false }).catch(() => {})
      return false
    }

    const beforeText = await fillEditableText(composeEl, text)
    console.log(`[sendTextUi] filled text: "${String(beforeText || '').slice(0, 60)}"`)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)

    let afterText = await composeEl.textContent().catch(() => '')
    if (String(afterText || '').trim()) {
      const sendSelectors = [
        'button[aria-label*="Send message" i]',
        'button[title*="Send" i]',
        'button:has-text("Send")',
        'button[aria-label*="Отправ" i]',
        'button[title*="Отправ" i]',
      ]
      for (const sel of sendSelectors) {
        const btn = page.locator(sel).first()
        if (await btn.isVisible({ timeout: 350 }).catch(() => false)) {
          await btn.click()
          console.log(`[sendTextUi] clicked send button: ${sel}`)
          break
        }
      }
      await page.waitForTimeout(700)
      afterText = await composeEl.textContent().catch(() => '')
    }

    const sent = !String(afterText || '').trim()
    if (!sent) {
      await page.screenshot({ path: '/tmp/max_send_ui_not_sent.png', fullPage: false }).catch(() => {})
    }
    return sent
  } finally {
    uiSendInProgress = false
  }
}
function waitForUiSendAck(transport, timeoutMs = 60_000) {
  if (!transport?._rawHandlers) return Promise.resolve(null)
  return new Promise(resolve => {
    let done = false
    let bestId = null
    let fallbackTimer = null
    const cleanup = () => {
      const index = transport._rawHandlers.indexOf(handler)
      if (index >= 0) transport._rawHandlers.splice(index, 1)
    }
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      cleanup()
      resolve(value)
    }
    const idsRelated = (a, b) => {
      const aa = String(a || '').replace(/[^a-fA-F0-9]/g, '')
      const bb = String(b || '').replace(/[^a-fA-F0-9]/g, '')
      if (!aa || !bb) return false
      return aa.includes(bb.slice(-10)) || bb.includes(aa.slice(-10))
    }
    const considerId = (id, immediate = false) => {
      if (!id) return
      const idStr = String(id)
      const related = bestId ? idsRelated(bestId, idStr) : true
      const preferProtocolMsgId = related && /^d301/i.test(idStr) && !/^d301/i.test(String(bestId || ''))
      if (!bestId || (related && (preferProtocolMsgId || idStr.length > String(bestId).length))) {
        bestId = idStr
      }
      if (immediate && bestId) finish(bestId)
      if (!fallbackTimer) {
        fallbackTimer = setTimeout(() => finish(bestId), Math.min(timeoutMs, 2500))
      }
    }
    const collectIds = (value, out = [], depth = 0) => {
      if (value == null || depth > 7) return out
      const direct = extractMaxId(value)
      if (direct) out.push(direct)
      if (Array.isArray(value)) {
        for (const item of value) collectIds(item, out, depth + 1)
      } else if (typeof value === 'object') {
        if (Array.isArray(value.__complexEntries)) {
          for (const entry of value.__complexEntries) {
            collectIds(entry?.key, out, depth + 1)
            collectIds(entry?.value, out, depth + 1)
          }
        }
        for (const [key, item] of Object.entries(value)) {
          if (key === '__complexEntries') continue
          collectIds(item, out, depth + 1)
        }
      }
      return out
    }
    const handler = data => {
      if (data?.opcode === OP.SEND_MESSAGE && data?.cmd === 2) {
        const maxMsgId = extractMaxId(data.payload?.message?.id || data.payload?.id || data.payload)
        considerId(maxMsgId)
        return
      }
      if (![53, 71, 128, 180].includes(data?.opcode)) return
      for (const id of collectIds(data.payload)) {
        if (!bestId || idsRelated(bestId, id)) considerId(id, String(id).length > String(bestId || '').length)
      }
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    transport._rawHandlers.push(handler)
  })
}

async function fillMaxMediaCaption(caption) {
  const text = String(caption || '').trim()
  if (!text) return { ok: true, skipped: 'empty_caption' }
  if (!page) return { ok: false, error: 'page_not_ready' }

  const editableInput = 'input:not([type="file"]):not([type="search"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'
  const selectors = [
    '[role="dialog"] textarea',
    `[role="dialog"] ${editableInput}`,
    '[role="dialog"] div[contenteditable="true"]',
    '[role="dialog"] div[contenteditable]',
    '[aria-modal="true"] textarea',
    `[aria-modal="true"] ${editableInput}`,
    '[aria-modal="true"] div[contenteditable="true"]',
    '[aria-modal="true"] div[contenteditable]',
    'textarea[placeholder*="Caption" i]',
    'textarea[placeholder*="\u041f\u043e\u0434\u043f\u0438\u0441" i]',
    `${editableInput}[placeholder*="Caption" i]`,
    `${editableInput}[placeholder*="\u041f\u043e\u0434\u043f\u0438\u0441" i]`,
    `${editableInput}[placeholder*="Message" i]`,
    `${editableInput}[placeholder*="\u0421\u043e\u043e\u0431\u0449" i]`,
    `${editableInput}[aria-label*="Caption" i]`,
    `${editableInput}[aria-label*="\u041f\u043e\u0434\u043f\u0438\u0441" i]`,
    `${editableInput}[aria-label*="Message" i]`,
    `${editableInput}[aria-label*="\u0421\u043e\u043e\u0431\u0449" i]`,
    `${editableInput}[data-placeholder*="Caption" i]`,
    `${editableInput}[data-placeholder*="\u041f\u043e\u0434\u043f\u0438\u0441" i]`,
    `${editableInput}[data-placeholder*="Message" i]`,
    `${editableInput}[data-placeholder*="\u0421\u043e\u043e\u0431\u0449" i]`,
    'div[contenteditable="true"][aria-label*="Caption" i]',
    'div[contenteditable="true"][aria-label*="\u041f\u043e\u0434\u043f\u0438\u0441" i]',
    'div[contenteditable="true"][aria-label*="Message" i]',
    'div[contenteditable="true"][aria-label*="\u0421\u043e\u043e\u0431\u0449" i]',
    'div[contenteditable="true"][data-placeholder*="Caption" i]',
    'div[contenteditable="true"][data-placeholder*="\u041f\u043e\u0434\u043f\u0438\u0441" i]',
    'div[contenteditable="true"][data-placeholder*="Message" i]',
    'div[contenteditable="true"][data-placeholder*="\u0421\u043e\u043e\u0431\u0449" i]',
    'textarea',
    editableInput,
    'div[contenteditable][role="textbox"]',
    'div[contenteditable="true"]:not([role="search"])',
    'div[contenteditable]:not([role="search"])',
  ]

  for (const sel of selectors) {
    const matches = await page.locator(sel).count().catch(() => 0)
    for (let index = matches - 1; index >= 0; index--) {
      const locator = page.locator(sel).nth(index)
      if (!await locator.isVisible({ timeout: 700 }).catch(() => false)) continue
      const candidate = await locator.evaluate(el => {
        const tag = el.tagName.toUpperCase()
        const attr = (name) => el.getAttribute(name) || ''
        const type = String(attr('type') || '').toLowerCase()
        const role = String(attr('role') || '').toLowerCase()
        const placeholder = attr('placeholder')
        const ariaLabel = attr('aria-label')
        const dataPlaceholder = attr('data-placeholder')
        const name = attr('name')
        const id = attr('id')
        const className = typeof el.className === 'string' ? el.className : ''
        const container = el.closest('[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="preview"], [class*="attach"], [class*="media"], [class*="upload"], [class*="composer"], [class*="compose"]')
        const haystack = `${type} ${role} ${placeholder} ${ariaLabel} ${dataPlaceholder} ${name} ${id} ${className}`.toLowerCase()
        const blockedHints = ['search', '\u043f\u043e\u0438\u0441\u043a', 'find', '\u043d\u0430\u0439\u0442\u0438', 'contact', '\u043a\u043e\u043d\u0442\u0430\u043a\u0442', 'phone', '\u0442\u0435\u043b\u0435\u0444\u043e\u043d', 'name', '\u0438\u043c\u044f', '\u043a\u043e\u043c\u0443']
        if (tag === 'INPUT' && ['file', 'search', 'hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type)) {
          return { ok: false, reason: `blocked_input_type:${type || 'empty'}`, tag, type, placeholder, role }
        }
        const blockedHint = blockedHints.find(hint => haystack.includes(hint))
        if (blockedHint) return { ok: false, reason: `blocked_hint:${blockedHint}`, tag, type, placeholder, role }
        const positiveHints = ['caption', '\u041f\u043e\u0434\u043f\u0438\u0441', 'message', '\u0421\u043e\u043e\u0431\u0449']
        const hasPositiveHint = positiveHints.some(hint => haystack.includes(hint))
        const hasMediaContainer = Boolean(container)
        if (tag === 'INPUT' && !hasPositiveHint && !hasMediaContainer) {
          return { ok: false, reason: 'generic_input_without_media_context', tag, type, placeholder, role }
        }
        return { ok: true, tag, type, placeholder, role, hasPositiveHint, hasMediaContainer }
      }).catch(e => ({ ok: false, reason: `candidate_eval_failed:${e.message}` }))
      if (!candidate.ok) {
        console.log(`[sendMediaUi] caption candidate rejected selector=${sel} reason=${candidate.reason || 'unknown'} tag=${candidate.tag || ''} placeholder=${candidate.placeholder || ''}`)
        continue
      }
      try {
        const actual = await fillEditableText(locator, text)
        if (String(actual || '').includes(text)) {
          console.log(`[sendMediaUi] caption filled via selector: ${sel}`)
          return { ok: true, selector: sel }
        }
      } catch (e) {
        console.warn(`[sendMediaUi] caption selector failed ${sel}: ${e.message}`)
      }
    }
  }

  console.warn('[sendMediaUi] caption was not filled before send')
  return { ok: false, error: 'caption_input_not_found_or_not_updated' }
}

function collectMessageCandidates(value, out = [], contextChatId = null, seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return out
  if (typeof value !== 'object') return out
  if (seen.has(value)) return out
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) collectMessageCandidates(item, out, contextChatId, seen, depth + 1)
    return out
  }

  const chatId = value.chatId != null ? String(value.chatId) : contextChatId
  if (value.message && typeof value.message === 'object') {
    out.push({ chatId, message: value.message })
    collectMessageCandidates(value.message, out, chatId, seen, depth + 1)
  }
  if (Array.isArray(value.messages)) {
    for (const message of value.messages) {
      if (message && typeof message === 'object') out.push({ chatId, message })
      collectMessageCandidates(message, out, chatId, seen, depth + 1)
    }
  }
  if (value.id && (value.sender || value.text != null || value.attaches || value.link || value.status || looksLikeDomRecoverableMediaPayload(value))) {
    out.push({ chatId, message: value })
  }
  if (Array.isArray(value.__complexEntries)) {
    for (const entry of value.__complexEntries) {
      collectMessageCandidates(entry?.key, out, chatId, seen, depth + 1)
      collectMessageCandidates(entry?.value, out, chatId, seen, depth + 1)
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === '__complexEntries' || key === 'message' || key === 'messages') continue
    collectMessageCandidates(item, out, chatId, seen, depth + 1)
  }
  return out
}

function messageHasMediaPayload(message) {
  if (!message || typeof message !== 'object') return false
  if (Array.isArray(message.attaches) && message.attaches.length > 0) return true
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return true
  if (message.media || message.photo || message.file || message.video || message.document) return true
  if (message.photoId || message.fileId || message.videoId || message.photoToken) return true
  if (message.previewData || message.thumbnail) return true
  if (looksLikeDomRecoverableMediaPayload(message)) return true
  return false
}

function waitForUiMediaEcho(transport, options = {}) {
  const protocolChatId = options.protocolChatId ? String(options.protocolChatId) : null
  const webRouteId = options.webRouteId ? String(options.webRouteId) : null
  const uploadId = options.uploadId || null
  if (!transport?._rawHandlers) {
    maxDeliveryLog({
      operation: 'media_echo_timeout',
      status: 'send_requested',
      conversationId: protocolChatId,
      protocolChatId,
      webRouteId,
      uploadId,
      error: 'raw_handlers_unavailable',
    })
    return Promise.resolve(null)
  }
  const caption = String(options.caption || '').trim()
  const timeoutMs = options.timeoutMs || 45_000
  return new Promise(resolve => {
    let done = false
    const cleanup = () => {
      const index = transport._rawHandlers.indexOf(handler)
      if (index >= 0) transport._rawHandlers.splice(index, 1)
    }
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      resolve(value)
    }
    const handler = data => {
      if (![64, 49, 53, 71, 128, 180].includes(data?.opcode)) return
      if (data.opcode === 180 && Array.isArray(data.payload?.messagesReactions?.__complexEntries)) {
        for (const entry of data.payload.messagesReactions.__complexEntries) {
          const msgId = extractMaxId(entry?.key)
          if (!isRealMaxMessageId(msgId)) continue
          maxDeliveryLog({
            operation: 'media_echo_candidate_ignored_op180',
            status: 'send_requested',
            conversationId: protocolChatId,
            protocolChatId,
            webRouteId,
            uploadId,
            maxMessageId: msgId,
            externalId: msgId,
            error: 'op180_messages_reactions_is_not_media_delivery_confirmation',
          })
        }
        return
      }
      const candidates = collectMessageCandidates(data.payload)
      for (const candidate of candidates) {
        const message = candidate.message || {}
        const msgId = extractMaxId(message.id || message.messageId)
        if (!isRealMaxMessageId(msgId)) continue
        const chatMatches = !protocolChatId || !candidate.chatId || String(candidate.chatId) === protocolChatId
        if (!chatMatches) continue
        const sender = String(message.sender || message.from || '')
        const isOwn = data.opcode === OP.SEND_MESSAGE || (transport._myUserId ? sender === String(transport._myUserId) : true)
        if (!isOwn) continue
        const hasMedia = messageHasMediaPayload(message)
        const textMatches = caption && String(message.text || '').includes(caption.slice(0, 80))
        if (!hasMedia) continue
        maxDeliveryLog({
          operation: 'media_echo_confirmed',
          status: 'max_echo_received',
          conversationId: protocolChatId,
          protocolChatId,
          webRouteId,
          uploadId,
          maxMessageId: msgId,
          externalId: msgId,
          source: `op${data.opcode}`,
          textMatched: Boolean(textMatches),
        })
        finish({
          maxMessageId: msgId,
          externalId: msgId,
          deliveryConfirmed: true,
          deliveryStatus: 'delivered',
          status: 'delivered',
          source: `op${data.opcode}`,
        })
        return
      }
    }
    const timer = setTimeout(() => {
      maxDeliveryLog({
        operation: 'media_echo_timeout',
        status: 'send_requested',
        conversationId: protocolChatId,
        protocolChatId,
        webRouteId,
        uploadId,
        error: `no_media_echo_after_${timeoutMs}ms`,
      })
      finish(null)
    }, timeoutMs)
    transport._rawHandlers.push(handler)
  })
}

async function sendMediaViaUi(chatId, fileBuffer, filename, mimeType, caption, transportForAck = null) {
  if (!page || !isReady) return false

  const uiRouteId = UI_CHAT_ID_OVERRIDES[String(chatId)] || String(chatId)
  const targetUrl = `https://web.max.ru/${uiRouteId}`
  if (transportForAck) transportForAck._activeUiChatId = protocolChatIdForUiRoute(chatId)
  const safeName = String(filename || 'upload.bin').replace(/[^\w.\-]+/g, '_').slice(-120) || 'upload.bin'
  const tmpPath = path.join('/tmp', `max_upload_${Date.now()}_${safeName}`)

  fs.writeFileSync(tmpPath, fileBuffer)
  maxDeliveryLog({
    operation: 'upload',
    status: 'upload_started',
    conversationId: protocolChatIdForUiRoute(chatId),
    protocolChatId: protocolChatIdForUiRoute(chatId),
    webRouteId: uiRouteId,
    uploadId: safeName,
  })
  console.log(`[sendMediaUi] opening ${targetUrl} file=${safeName} mime=${mimeType}`)
  try {
    if (!page.url().includes(`/${uiRouteId}`)) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(1200)
    } else {
      await page.waitForTimeout(300)
    }

    let fileSelected = false
    let uiUploadResponsePromise = null
    const armUiUploadResponseWatch = () => {
      if (uiUploadResponsePromise || !mimeType.startsWith('image/')) return
      uiUploadResponsePromise = page.waitForResponse(response => {
        const req = response.request()
        return req.method() === 'POST' && response.url().includes('/uploadImage')
      }, { timeout: 30_000 }).catch(e => ({ __uploadWaitError: e.message }))
    }
    const menuTextCandidates = (mimeType.startsWith('image/') || mimeType.startsWith('video/'))
      ? ['Photo or video', 'Photo', 'Video']
      : ['File']
    try {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 8_000 })
      const attachButtonCandidates = [
        page.getByLabel('Upload file').last(),
        page.locator('button[aria-label*="Upload file" i]').last(),
        page.locator('button[title*="Upload" i]').last(),
        page.getByLabel('Загрузить файл').last(),
        page.locator('button[aria-label*="Attach" i]').last(),
        page.locator('button[title*="Attach" i]').last(),
      ]
      let attachClicked = false
      for (const attachButton of attachButtonCandidates) {
        if (await attachButton.isVisible({ timeout: 600 }).catch(() => false)) {
          await attachButton.click()
          attachClicked = true
          break
        }
      }
      if (attachClicked) {
        await page.waitForTimeout(300)
        let menuClicked = false
        for (const text of menuTextCandidates) {
          const item = page.getByText(text, { exact: true }).last()
          if (await item.isVisible({ timeout: 350 }).catch(() => false)) {
            await item.click()
            menuClicked = true
            break
          }
        }
        if (!menuClicked) {
          for (const text of menuTextCandidates) {
            const item = page.locator(`[role="menuitem"]:has-text("${text}"), button:has-text("${text}")`).last()
            if (await item.isVisible({ timeout: 350 }).catch(() => false)) {
              await item.click()
              menuClicked = true
              break
            }
          }
        }
        const chooser = await chooserPromise
        armUiUploadResponseWatch()
        await chooser.setFiles(tmpPath)
        fileSelected = true
        console.log(`[sendMediaUi] file selected via MAX menu: ${menuClicked ? menuTextCandidates.join('/') : 'direct chooser'}`)
      }
    } catch (e) {
      console.warn(`[sendMediaUi] MAX menu file chooser failed: ${e.message}`)
    }

    let input = page.locator('input[type="file"]').last()
    if (!fileSelected) {
      const attachSelectors = [
        'button[aria-label*="Upload file" i]',
        'button[title*="Upload" i]',
        'button[aria-label*="Attach" i]',
        'button[title*="Attach" i]',
        'button[aria-label*="Прикреп" i]',
        'button[title*="Прикреп" i]',
        'button:has(svg)',
      ]
      for (const sel of attachSelectors) {
        const btn = page.locator(sel).first()
        if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
          await btn.click().catch(() => {})
          await page.waitForTimeout(500)
          input = page.locator('input[type="file"]').last()
          if (await input.count().catch(() => 0)) break
        }
      }
    }

    if (!fileSelected && !await input.count().catch(() => 0)) {
      console.warn('[sendMediaUi] file input not found')
      return false
    }

    if (!fileSelected) {
      armUiUploadResponseWatch()
      await input.setInputFiles(tmpPath)
      fileSelected = true
      console.log('[sendMediaUi] file selected via raw input fallback')
    }
    await page.screenshot({ path: '/tmp/max_send_media_after_select.png', fullPage: false }).catch(() => {})
    if (uiUploadResponsePromise) {
      const uploadResponse = await uiUploadResponsePromise
      if (uploadResponse?.__uploadWaitError) {
        maxDeliveryLog({
          operation: 'upload',
          status: 'failed',
          conversationId: protocolChatIdForUiRoute(chatId),
          protocolChatId: protocolChatIdForUiRoute(chatId),
          webRouteId: uiRouteId,
          uploadId: safeName,
          error: `ui_upload_response_timeout:${uploadResponse.__uploadWaitError}`,
        })
        return false
      }
      const uploadStatus = uploadResponse.status()
      console.log(`[sendMediaUi] upload response status=${uploadStatus} url=${uploadResponse.url().slice(0, 80)}`)
      if (uploadStatus >= 400) {
        maxDeliveryLog({
          operation: 'upload',
          status: 'failed',
          conversationId: protocolChatIdForUiRoute(chatId),
          protocolChatId: protocolChatIdForUiRoute(chatId),
          webRouteId: uiRouteId,
          uploadId: safeName,
          error: `ui_upload_http_${uploadStatus}`,
        })
        return false
      }
    }
    const uploadSettleMs = mimeType.startsWith('video/')
      ? 12_000
      : (mimeType.startsWith('image/')
        ? 1_500
        : (mimeType.startsWith('audio/') || fileBuffer.length > 2 * 1024 * 1024)
        ? 8_000
        : 5_000)
    await page.waitForTimeout(uploadSettleMs)
    maxDeliveryLog({
      operation: 'upload',
      status: 'uploaded',
      conversationId: protocolChatIdForUiRoute(chatId),
      protocolChatId: protocolChatIdForUiRoute(chatId),
      webRouteId: uiRouteId,
      uploadId: safeName,
    })

    if (caption) {
      const captionResult = await fillMaxMediaCaption(caption)
      if (!captionResult.ok) {
        maxDeliveryLog({
          operation: 'send',
          status: 'failed',
          conversationId: protocolChatIdForUiRoute(chatId),
          protocolChatId: protocolChatIdForUiRoute(chatId),
          webRouteId: uiRouteId,
          uploadId: safeName,
          error: captionResult.error || 'caption_not_filled',
        })
        await page.screenshot({ path: '/tmp/max_send_media_caption_failed.png', fullPage: false }).catch(() => {})
        return false
      }
    }

    const sendSelectors = [
      'button[aria-label*="Send message" i]',
      'button[title*="Send" i]',
      'button:has-text("Send")',
      'button[aria-label*="Отправ" i]',
      'button[title*="Отправ" i]',
    ]
    let echoPromise = waitForUiMediaEcho(transportForAck, {
      protocolChatId: protocolChatIdForUiRoute(chatId),
      webRouteId: uiRouteId,
      uploadId: safeName,
      caption,
      timeoutMs: 1_500,
    })
    let clicked = false
    for (const sel of sendSelectors) {
      const btn = page.locator(sel).last()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click()
        clicked = true
        console.log(`[sendMediaUi] clicked send button: ${sel}`)
        break
      }
    }
    if (!clicked) await page.keyboard.press('Enter').catch(() => {})
    maxDeliveryLog({
      operation: 'send',
      status: 'send_requested',
      conversationId: protocolChatIdForUiRoute(chatId),
      protocolChatId: protocolChatIdForUiRoute(chatId),
      webRouteId: uiRouteId,
      uploadId: safeName,
    })
    let echo = await echoPromise
    if (!echo) {
      console.warn('[sendMediaUi] no quick MAX echo after upload/send click; returning send_requested without retry')
    }
    await page.waitForTimeout(600)
    if (echo?.maxMessageId) {
      maxDeliveryLog({
        operation: 'echo',
        status: 'max_echo_received',
        conversationId: protocolChatIdForUiRoute(chatId),
        protocolChatId: protocolChatIdForUiRoute(chatId),
        webRouteId: uiRouteId,
        uploadId: safeName,
        maxMessageId: echo.maxMessageId,
        externalId: echo.externalId,
      })
      console.log(`[sendMediaUi] MAX echo msgId=${echo.maxMessageId}`)
      return echo
    }
    console.warn('[sendMediaUi] no MAX echo after upload/send click')
    await page.screenshot({ path: '/tmp/max_send_media_no_ack.png', fullPage: false }).catch(() => {})
    return {
      externalId: null,
      maxMessageId: null,
      deliveryConfirmed: false,
      deliveryStatus: 'send_requested',
      status: 'send_requested',
      source: 'ui_no_echo',
      uploadId: safeName,
    }
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

const domFallbackSeen = new Set()
const domRecoveredTextCounts = new Map()
let domFallbackRunning = false
let domFallbackScheduledAt = 0
let uiSendInProgress = false
const automaticDomRecoveryTimers = new Map()
const recentCrmOutboundTexts = []
const RECENT_CRM_OUTBOUND_TTL_MS = 10 * 60 * 1000
const recentDirectInboundTexts = new Map()
const RECENT_DIRECT_TEXT_TTL_MS = 2 * 60 * 1000

function comparableDomText(text) {
  return cleanDomMessageText(text).replace(/\s+/g, ' ').trim()
}

function relatedDomRouteIds(...values) {
  const ids = new Set()
  for (const value of values) {
    const digits = String(value || '').replace(/\D/g, '')
    if (!digits) continue
    ids.add(digits)
    if (digits.length >= 12) {
      try { ids.add(String(Number(BigInt(digits) & 0xffffffffn))) } catch {}
    }
  }
  return ids
}

function rememberCrmOutboundText(text, ...chatIds) {
  const comparableText = comparableDomText(text)
  if (!comparableText) return null
  const now = Date.now()
  while (recentCrmOutboundTexts.length && now - recentCrmOutboundTexts[0].ts > RECENT_CRM_OUTBOUND_TTL_MS) {
    recentCrmOutboundTexts.shift()
  }
  const entry = { text: comparableText, chatIds: relatedDomRouteIds(...chatIds), ts: now }
  recentCrmOutboundTexts.push(entry)
  if (recentCrmOutboundTexts.length > 200) recentCrmOutboundTexts.splice(0, recentCrmOutboundTexts.length - 200)
  return entry
}

function extendCrmOutboundTextGuard(entry, ...chatIds) {
  if (!entry) return
  for (const id of relatedDomRouteIds(...chatIds)) entry.chatIds.add(id)
}

function matchesRecentCrmOutboundText(chatId, uiRouteId, text) {
  const comparableText = comparableDomText(text)
  if (!comparableText) return false
  const now = Date.now()
  const candidateIds = relatedDomRouteIds(chatId, uiRouteId)
  return recentCrmOutboundTexts.some(entry => {
    if (now - entry.ts > RECENT_CRM_OUTBOUND_TTL_MS || entry.text !== comparableText) return false
    return [...candidateIds].some(id => entry.chatIds.has(id))
  })
}

function directInboundTextKey(chatId, text) {
  const cleaned = cleanDomMessageText(text)
  if (!cleaned || isDomNoiseText(cleaned)) return null
  const hash = crypto.createHash('sha1').update(`${chatId}:${cleaned}`).digest('hex').slice(0, 16)
  return { key: `${chatId}:${hash}`, cleaned }
}

function pruneRecentDirectInboundTexts(now = Date.now()) {
  for (const [key, value] of recentDirectInboundTexts.entries()) {
    const hits = Array.isArray(value?.hits)
      ? value.hits.filter(hit => hit?.ts && now - hit.ts <= RECENT_DIRECT_TEXT_TTL_MS)
      : (value?.ts && now - value.ts <= RECENT_DIRECT_TEXT_TTL_MS ? [value] : [])
    if (!hits.length) {
      recentDirectInboundTexts.delete(key)
      continue
    }
    const latest = hits[hits.length - 1]
    recentDirectInboundTexts.set(key, { ...latest, hits })
  }
}

function pruneDomRecoveredTextCounts(now = Date.now()) {
  for (const [key, value] of domRecoveredTextCounts.entries()) {
    if (!value?.ts || now - value.ts > RECENT_DIRECT_TEXT_TTL_MS) domRecoveredTextCounts.delete(key)
  }
}

function timestampMsFromValue(value) {
  if (!value) return null
  const ms = typeof value === 'number'
    ? (value < 1e12 ? value * 1000 : value)
    : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function rememberRecentDirectInboundText(chatId, text, externalId = null, timestamp = null) {
  const keyed = directInboundTextKey(chatId, text)
  if (!keyed) return
  const now = Date.now()
  pruneRecentDirectInboundTexts(now)
  const hit = {
    ts: now,
    sentAtMs: timestampMsFromValue(timestamp) || now,
    text: keyed.cleaned,
    externalId: externalId ? String(externalId) : null,
  }
  const existing = recentDirectInboundTexts.get(keyed.key)
  const hits = Array.isArray(existing?.hits)
    ? existing.hits.slice()
    : (existing?.ts ? [existing] : [])
  hits.push(hit)
  recentDirectInboundTexts.set(keyed.key, { ...hit, hits: hits.slice(-25) })
}

function findRecentDirectInboundText(chatId, text, ttlMs = RECENT_DIRECT_TEXT_TTL_MS) {
  const keyed = directInboundTextKey(chatId, text)
  if (!keyed) return null
  pruneRecentDirectInboundTexts()
  const hit = recentDirectInboundTexts.get(keyed.key)
  if (!hit || Date.now() - hit.ts > ttlMs) return null
  return hit
}

function recentDirectInboundTextHits(chatId, text, ttlMs = RECENT_DIRECT_TEXT_TTL_MS) {
  const keyed = directInboundTextKey(chatId, text)
  if (!keyed) return []
  pruneRecentDirectInboundTexts()
  const value = recentDirectInboundTexts.get(keyed.key)
  const hits = Array.isArray(value?.hits) ? value.hits : (value ? [value] : [])
  const now = Date.now()
  return hits
    .filter(hit => hit?.ts && now - hit.ts <= ttlMs)
    .sort((a, b) => (timestampMsFromValue(a.sentAtMs) || a.ts || 0) - (timestampMsFromValue(b.sentAtMs) || b.ts || 0))
}

function assignDirectHitsToDomCandidates(chatId, candidates) {
  const buckets = new Map()
  for (const candidate of candidates) {
    const keyed = directInboundTextKey(chatId, candidate.text)
    if (!keyed) {
      candidate._directHit = null
      candidate._allowDomDuplicateRecovery = true
      continue
    }
    if (!buckets.has(keyed.key)) {
      buckets.set(keyed.key, recentDirectInboundTextHits(chatId, candidate.text))
    }
    candidate._directHit = buckets.get(keyed.key).shift() || null
    candidate._allowDomDuplicateRecovery = true
  }
}

function domRecoveredTextKey(chatId, text) {
  return directInboundTextKey(chatId, text)?.key || null
}

function getDomRecoveredTextCount(chatId, text) {
  const key = domRecoveredTextKey(chatId, text)
  if (!key) return 0
  pruneDomRecoveredTextCounts()
  return domRecoveredTextCounts.get(key)?.count || 0
}

function rememberDomRecoveredText(chatId, text) {
  const key = domRecoveredTextKey(chatId, text)
  if (!key) return
  const now = Date.now()
  pruneDomRecoveredTextCounts(now)
  const current = domRecoveredTextCounts.get(key)?.count || 0
  domRecoveredTextCounts.set(key, { count: current + 1, ts: now })
}

function directHitTimestampMs(hit) {
  return timestampMsFromValue(hit?.sentAtMs) || timestampMsFromValue(hit?.ts)
}

function parsePlainIntegerText(text) {
  const value = String(text || '').trim()
  if (!/^\d{1,6}$/.test(value)) return null
  const num = Number(value)
  return Number.isSafeInteger(num) ? num : null
}

function displayMinuteDistance(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity
  const diff = Math.abs(a - b)
  return Math.min(diff, 1440 - diff)
}

function hasNearbyDirectNumericDomCandidate(candidates, index) {
  const currentNumber = parsePlainIntegerText(candidates[index]?.text)
  if (currentNumber == null) return false
  return candidates.some((candidate, candidateIndex) => {
    if (candidateIndex === index || !candidate?._directHit) return false
    const directNumber = parsePlainIntegerText(candidate.text)
    return directNumber != null && Math.abs(directNumber - currentNumber) <= 2
  })
}

function shouldKeepDomTextRecoveryCandidate(chatId, candidate, candidates, index) {
  if (candidate?._directHit) return true
  if (candidate?._liveDomSeriesCandidate) return true
  if (candidate?._liveDomContextBeforeDirect) return true
  if (!candidate?.text || candidate.attachments?.length) return true
  if (recentDirectInboundTextHits(chatId, candidate.text).length > 0) return true
  return hasNearbyDirectNumericDomCandidate(candidates, index)
}

function recentLiveDomWindowDetails(chatId, candidateCount) {
  const recentOp128Count = transport?.recentOp128CountForChat?.(chatId, 30_000) || 0
  const size = recentOp128Count
    ? Math.min(candidateCount, Math.max(1, recentOp128Count + LIVE_DOM_WINDOW_CONTEXT_SLACK))
    : candidateCount
  return { recentOp128Count, size }
}

function recentLiveDomWindowSize(chatId, candidateCount) {
  return recentLiveDomWindowDetails(chatId, candidateCount).size
}

function limitRecoverableToRecentLiveDomWindow(chatId, recoverable) {
  const size = recentLiveDomWindowSize(chatId, recoverable.length)
  return recoverable.slice(-size)
}

function shouldKeepNumericDomRecoveryCandidate(candidate, candidates) {
  if (candidate?._directHit) return true
  if (candidate?._liveDomSeriesCandidate) return true
  const currentNumber = parsePlainIntegerText(candidate?.text)
  if (currentNumber == null) return true
  const directNumbers = candidates
    .filter(item => item?._directHit)
    .map(item => parsePlainIntegerText(item.text))
    .filter(num => num != null)
  if (!directNumbers.length) return true
  return currentNumber <= Math.max(...directNumbers)
}

function applyDomTextRecoveryLimits(chatId, candidates) {
  const groups = new Map()
  for (const candidate of candidates) {
    if (!candidate?.text || candidate.attachments?.length) continue
    const key = domRecoveredTextKey(chatId, candidate.text)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, { text: candidate.text, items: [], directCount: 0 })
    const group = groups.get(key)
    group.items.push(candidate)
    if (candidate._directHit) group.directCount += 1
  }

  for (const group of groups.values()) {
    const alreadyRecovered = getDomRecoveredTextCount(chatId, group.text)
    let remaining = Math.max(0, group.items.length - group.directCount - alreadyRecovered)
    for (const candidate of group.items) {
      if (candidate._directHit) continue
      if (candidate._domRecoveryExternalId && domFallbackSeen.has(candidate._domRecoveryExternalId)) continue
      if (remaining > 0) {
        remaining -= 1
      } else {
        candidate._skipDomTextAlreadyRecovered = true
      }
    }
  }
}

function assignDomRecoveryExternalIds(chatId, candidates) {
  const gapCounts = new Map()
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (candidate._directHit) continue
    if (candidate._domRecoveryExternalId) continue

    let prevExternalId = 'start'
    for (let p = i - 1; p >= 0; p--) {
      if (candidates[p]._directHit?.externalId) {
        prevExternalId = candidates[p]._directHit.externalId
        break
      }
    }

    let nextExternalId = 'end'
    for (let n = i + 1; n < candidates.length; n++) {
      if (candidates[n]._directHit?.externalId) {
        nextExternalId = candidates[n]._directHit.externalId
        break
      }
    }

    const text = cleanDomMessageText(candidate.text || '')
    const gapKey = `${text}:${prevExternalId}:${nextExternalId}`
    const ordinal = (gapCounts.get(gapKey) || 0) + 1
    gapCounts.set(gapKey, ordinal)
    candidate._domRecoveryExternalId = stableDomMessageId(chatId, `duplicate-dom:${gapKey}:${ordinal}`)
  }
}

function domRecoveryDirectAnchorKey(candidates, index) {
  let prevExternalId = 'start'
  for (let p = index - 1; p >= 0; p--) {
    if (candidates[p]?._directHit?.externalId) {
      prevExternalId = candidates[p]._directHit.externalId
      break
    }
  }

  let nextExternalId = 'end'
  for (let n = index + 1; n < candidates.length; n++) {
    if (candidates[n]?._directHit?.externalId) {
      nextExternalId = candidates[n]._directHit.externalId
      break
    }
  }

  return `${prevExternalId}:${nextExternalId}`
}

function domRecoveryLiveSeriesKey(chatId) {
  return transport?.recentOp128SeriesKeyForChat?.(chatId, 15_000) || null
}

function assignDomTextRecoveryBudgets(chatId, candidates) {
  const dayKey = new Date().toISOString().slice(0, 10)
  const ordinalByMinuteText = new Map()
  const liveSeriesKey = domRecoveryLiveSeriesKey(chatId)
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!candidate?.text || candidate.attachments?.length || candidate._directHit) continue
    const directAnchorKey = domRecoveryDirectAnchorKey(candidates, i)
    const anchorKey = directAnchorKey !== 'start:end' ? directAnchorKey : (liveSeriesKey || directAnchorKey)
    if (Number.isFinite(candidate.displayMinute)) {
      const text = cleanDomMessageText(candidate.text || '')
      const key = `${dayKey}:${candidate.displayMinute}:${text}:${anchorKey}`
      const ordinal = (ordinalByMinuteText.get(key) || 0) + 1
      ordinalByMinuteText.set(key, ordinal)
      candidate._domRecoveryExternalId = stableDomMessageId(chatId, `dom-text-minute:${key}:${ordinal}`)
      continue
    }
    candidate._domRecoveryExternalId = stableDomMessageId(chatId, `dom-text-anchored:${anchorKey}:${candidate.text || ''}`)
  }
}

function liveDomContextBeforeDirectBudget(chatId, recoverable, firstDirectIndex) {
  if (firstDirectIndex <= 0) return 0
  const recentOp128Count = transport?.recentOp128CountForChat?.(chatId, 15_000) || 0
  const directHitCount = recoverable.filter(candidate => candidate?._directHit).length
  return Math.min(firstDirectIndex, Math.max(0, recentOp128Count - directHitCount), 5)
}

function markLiveDomContextBeforeFirstDirect(recoverable, keepFrom, firstDirectIndex) {
  if (keepFrom >= firstDirectIndex) return
  for (let i = keepFrom; i < firstDirectIndex; i++) {
    if (recoverable[i]?.text && !recoverable[i].attachments?.length && !recoverable[i]._directHit) {
      recoverable[i]._liveDomContextBeforeDirect = true
    }
  }
}

function estimateDomRecoveryTimestampMs(candidates, index) {
  const now = Date.now()
  const anchors = candidates.map(candidate => {
    const hit = candidate._directHit || findRecentDirectInboundText(candidate.chatId || candidate._chatId, candidate.text)
    return directHitTimestampMs(hit)
  })

  let prevIndex = -1
  let prevMs = null
  for (let i = index - 1; i >= 0; i--) {
    if (anchors[i]) {
      prevIndex = i
      prevMs = anchors[i]
      break
    }
  }

  let nextIndex = -1
  let nextMs = null
  for (let i = index + 1; i < candidates.length; i++) {
    if (anchors[i]) {
      nextIndex = i
      nextMs = anchors[i]
      break
    }
  }

  if (prevMs && nextMs && nextMs > prevMs) {
    const ratio = (index - prevIndex) / (nextIndex - prevIndex)
    return Math.round(prevMs + (nextMs - prevMs) * ratio)
  }
  if (prevMs) return prevMs + (index - prevIndex) * 1000
  if (nextMs) return nextMs - (nextIndex - index) * 1000
  return now - (candidates.length - index) * 1000
}

function stableDomMessageId(chatId, text) {
  const hash = crypto.createHash('sha1').update(`${chatId}:${text}`).digest('hex').slice(0, 16)
  return `max-dom-${chatId}-${hash}`
}

function roundedDomNumber(value, step = 4) {
  return Number.isFinite(value) ? Math.round(value / step) * step : 0
}

function stableDomTextMessageId(chatId, text, candidate = {}) {
  const x = roundedDomNumber(candidate.x)
  const y = roundedDomNumber(candidate.y)
  const bottom = roundedDomNumber(candidate.bottom)
  const width = roundedDomNumber(candidate.width)
  const height = roundedDomNumber(candidate.height)
  return stableDomMessageId(chatId, `dom-text:${text || ''}:${x}:${y}:${bottom}:${width}:${height}`)
}

function stableDomMediaMessageId(chatId, text, attachments = []) {
  const sig = attachments
    .map(att => [att.type, att.name, att.size, att.duration, att.sourceKind, att.url ? String(att.url).slice(0, 120) : ''].join(':'))
    .join('|')
  return stableDomMessageId(chatId, `${text || ''}:${sig}`)
}

function stableDomMediaTimeKey(candidate = {}) {
  const day = Math.floor(Date.now() / 86_400_000)
  if (Number.isFinite(candidate.displayMinute)) return `${day}:${candidate.displayMinute}`
  if (candidate.displayTime) return `${day}:${candidate.displayTime}`
  return ''
}

function latestRecentOp128ChatId() {
  if (!transport?._recentOp128ChatIds) return transport?._activeUiChatId || null
  const entries = Array.from(transport._recentOp128ChatIds.entries())
    .sort((a, b) => b[1] - a[1])
  return entries[0]?.[0] || transport?._activeUiChatId || null
}

function resolveEmptyOp71DomRecoveryChatId(decodedChatId, maxAgeMs = 15_000) {
  const decoded = decodedChatId != null ? String(decodedChatId) : null
  if (!transport?._recentOp128ChatIds) {
    return decoded ? { chatId: decoded, reason: 'decoded_no_recent_map' } : null
  }

  const now = Date.now()
  if (decoded) {
    const decodedSeenAt = transport._recentOp128ChatIds.get(decoded) || 0
    if (decodedSeenAt && now - decodedSeenAt < maxAgeMs) {
      return { chatId: decoded, reason: 'decoded_recent_op128' }
    }
  }

  const recent = Array.from(transport._recentOp128ChatIds.entries())
    .filter(([, seenAt]) => seenAt && now - seenAt < maxAgeMs)
    .sort((a, b) => b[1] - a[1])

  if (recent.length === 1) {
    return { chatId: recent[0][0], reason: decoded ? 'single_recent_op128_after_mismatched_op71_chat' : 'single_recent_op128' }
  }
  return null
}

function looksLikeDomRecoverableMediaPayload(value, depth = 0) {
  if (value == null || depth > 6) return false
  if (Array.isArray(value)) return value.some(item => looksLikeDomRecoverableMediaPayload(item, depth + 1))
  if (typeof value !== 'object') return false

  if (value.previewData || value.thumbnail || value.videoId || value.photoId || value.fileId) return true
  if (value[476] || value['476'] || value[110] || value['110']) return true
  const previewType = String(value.preview?._type || value._type || value.type || '').toUpperCase()
  if (['PHOTO', 'IMAGE', 'VIDEO', 'MUSIC', 'FILE'].includes(previewType)) return true

  return Object.values(value).some(item => looksLikeDomRecoverableMediaPayload(item, depth + 1))
}

function scheduleDomFallbackForRecentMedia(reason, delayMs = 2200) {
  if (!isReady || !page) return
  const now = Date.now()
  if (now - domFallbackScheduledAt < 1000) return
  domFallbackScheduledAt = now
  setTimeout(() => {
    if (uiSendInProgress) return
    const chatId = latestRecentOp128ChatId()
    if (!chatId) return
    const runner = reason === 'loose_op128_media'
      ? forwardRecentDomMessages(String(chatId), reason)
      : forwardLatestDomMessage(String(chatId), reason)
    runner
      .then(result => console.log(`[domFallback] result ${JSON.stringify(result).slice(0, 500)}`))
      .catch(e => console.error('[domFallback] failed:', e.message))
  }, delayMs)
}

function scheduleAutomaticDomMirrorRecovery(chatId, reason = 'missing_protocol_anchor', attempt = 0) {
  if (!isReady || !page || !chatId) return
  const chatIdStr = String(chatId)
  const existingTimer = automaticDomRecoveryTimers.get(chatIdStr)
  if (existingTimer) clearTimeout(existingTimer)

  const timer = setTimeout(async () => {
    automaticDomRecoveryTimers.delete(chatIdStr)
    if (uiSendInProgress || domFallbackRunning) {
      if (attempt < 6) scheduleAutomaticDomMirrorRecovery(chatIdStr, reason, attempt + 1)
      return
    }

    try {
      const result = await forwardRecentDomMessages(chatIdStr, reason, {
        includeOutgoing: true,
        freshOnly: true,
        enrichPeer: true,
      })
      console.log(`[domMirror] ${reason} chatId=${chatIdStr} result=${JSON.stringify(result).slice(0, 600)}`)
    } catch (e) {
      console.error(`[domMirror] ${reason} failed chatId=${chatIdStr}: ${e.message}`)
      if (attempt < 3) scheduleAutomaticDomMirrorRecovery(chatIdStr, reason, attempt + 1)
    }
  }, attempt > 0 ? 1800 : 1200)

  automaticDomRecoveryTimers.set(chatIdStr, timer)
}

function cleanDomMessageText(text) {
  return String(text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^\d{1,2}:\d{2}$/.test(s))
    .filter(s => !/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(s))
    .filter(s => !/^(Сегодня|Yesterday|Вчера|Сообщение|Message)$/i.test(s))
    .join('\n')
    .trim()
}

function isDomNoiseText(text) {
  const value = String(text || '').trim()
  if (!value) return true
  if (/^\d{1,2}:\d{2}(\s?(AM|PM))?$/i.test(value)) return true
  if (/^(Today|Yesterday|Message|Сообщение|Сегодня|Вчера)$/i.test(value)) return true
  return false
}

function domReplyQuoteLeafText(text) {
  const lines = cleanDomMessageText(text).split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length >= 3 ? lines[lines.length - 1] : null
}

function looksLikeDomReplyQuoteText(chatId, candidate) {
  if (!candidate?.text || candidate.attachments?.length) return false
  if (candidate.hasReplyQuote) return true
  const leafText = domReplyQuoteLeafText(candidate.text)
  return !!leafText && recentDirectInboundTextHits(chatId, leafText).length > 0
}

function decodeBase64Payload(base64) {
  const raw = String(base64 || '')
  return Buffer.from(raw.includes(',') ? raw.split(',').pop() : raw, 'base64')
}

function safeUploadFilename(filename, fallback = 'upload.bin') {
  const raw = String(filename || fallback)
  const ext = path.extname(raw).replace(/[^\x20-\x7E]/g, '').slice(0, 16)
  const base = path.basename(raw, path.extname(raw))
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return `${base || 'upload'}${ext || path.extname(fallback) || '.bin'}`
}

function inferMimeType(name, type, fallback = null) {
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (type === 'image') return 'image/jpeg'
  if (type === 'video') return 'video/mp4'
  if (type === 'audio' || type === 'voice') return 'audio/ogg'
  return fallback || 'application/octet-stream'
}

function inferAttachmentTypeFromName(name, fallback = 'document') {
  const lower = String(name || '').toLowerCase()
  if (/\.(jpe?g|png|webp|gif)$/i.test(lower)) return 'image'
  if (/\.(mp4|mov)$/i.test(lower)) return 'video'
  if (/\.(ogg|opus|mp3|m4a|aac|wav)$/i.test(lower)) return 'audio'
  return fallback
}

function dataUrlFromFile(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath)
  return {
    url: `data:${mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`,
    size: buffer.length,
  }
}

function cleanDomMediaCaption(text, attachments = []) {
  const fileNames = new Set(attachments.map(att => String(att.name || '').trim()).filter(Boolean))
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !fileNames.has(line))
    .filter(line => !/^(JPE?G|PNG|WEBP|GIF|MP4|MOV|OGG|OPUS|MP3|PDF)$/i.test(line))
    .filter(line => !/^Скачать\b|^Download\b/i.test(line))
    .filter(line => !/^(Скачать|Download)\s*[•.]?\s*[\d.,]+\s*(KB|MB|КБ|МБ)$/i.test(line))
    .filter(line => !/^[\d.,]+\s*(KB|MB|КБ|МБ)$/i.test(line))
    .join('\n')
    .trim()
}

async function materializeUrlAttachment(att) {
  if (!att?.url || !mediaPipeline) return null
  try {
    const file = await mediaPipeline.downloadAttachment(att.url, att.mimeType)
    const mimeType = file.mimeType || att.mimeType || inferMimeType(att.name, att.type)
    const data = dataUrlFromFile(file.localPath, mimeType)
    return {
      ...att,
      url: data.url,
      mimeType,
      size: file.size || data.size || att.size || null,
      localPath: file.localPath,
      downloadStatus: 'ok',
    }
  } catch (e) {
    console.warn(`[domFallback] media URL download failed type=${att.type || 'unknown'} name=${att.name || ''}: ${e.message}`)
    return null
  }
}

async function downloadDomFileAttachment(uiRouteId, fileName, mimeType = null, type = null) {
  if (!page || !isReady || !fileName) return null
  const targetUrl = `https://web.max.ru/${uiRouteId}`
  if (!page.url().includes(`/${uiRouteId}`)) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1200)
  }

  const downloadButtons = page.locator('button[aria-label*="Скачать"], button[aria-label*="Download"], button')
    .filter({ hasText: String(fileName) })
  const count = await downloadButtons.count().catch(() => 0)
  if (count <= 0) return null

  const button = downloadButtons.nth(count - 1)
  if (!await button.isVisible({ timeout: 1500 }).catch(() => false)) return null

  try {
    await button.scrollIntoViewIfNeeded().catch(() => {})
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
    await button.click({ timeout: 5000 })
    const download = await downloadPromise
    const tempPath = await download.path()
    const suggestedName = download.suggestedFilename() || fileName
    const attType = type || inferAttachmentTypeFromName(suggestedName, 'document')
    const resolvedMime = mimeType || inferMimeType(suggestedName, attType)
    const data = dataUrlFromFile(tempPath, resolvedMime)
    console.log(`[domFallback] downloaded file-card name=${suggestedName} size=${data.size}`)
    return {
      type: attType,
      url: data.url,
      name: suggestedName,
      size: data.size,
      mimeType: resolvedMime,
      downloadStatus: 'ok',
      source: 'dom_download',
    }
  } catch (e) {
    console.warn(`[domFallback] file-card download failed name=${fileName}: ${e.message}`)
    return null
  }
}

async function materializeDomFallbackAttachments(uiRouteId, attachments = []) {
  const out = []
  for (const att of attachments) {
    let materialized = null
    if (att.downloadable && att.name) {
      materialized = await downloadDomFileAttachment(uiRouteId, att.name, att.mimeType, att.type)
    } else if (att.url) {
      materialized = await materializeUrlAttachment(att)
    }
    if (materialized?.url) out.push({ ...att, ...materialized })
  }
  return out
}

async function scrapeRecentDomMessages(uiRouteId) {
  if (!page || !isReady) return []

  const targetUrl = `https://web.max.ru/${uiRouteId}`
  if (!page.url().includes(`/${uiRouteId}`)) {
    console.log(`[domFallback] opening ${targetUrl}`)
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1800)
  } else {
    await page.waitForTimeout(700)
  }

  await page.evaluate(() => {
    try { window.scrollTo(0, document.body.scrollHeight) } catch {}
    for (const el of [...document.querySelectorAll('div, section, main')]) {
      try {
        if (el.scrollHeight > el.clientHeight + 80) el.scrollTop = el.scrollHeight
      } catch {}
    }
  }).catch(() => {})
  await page.waitForTimeout(500)

  const candidates = await page.evaluate(() => {
    const viewportW = window.innerWidth || 1280
    const viewportH = window.innerHeight || 720
    const rows = [...document.querySelectorAll('[role="listitem"], .item, [class*="messageWrapper"]')]
    const candidates = []

    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 2 && rect.height > 2 &&
        rect.bottom > 80 && rect.top < viewportH - 55 &&
        rect.left > viewportW * 0.30 &&
        rect.right > viewportW * 0.28 &&
        style.display !== 'none' && style.visibility !== 'hidden'
    }

    const cleanText = (text) => String(text || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !/^\d{1,2}:\d{2}$/.test(s))
      .filter(s => !/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(s))
      .filter(s => !/^(Сегодня|Today|Yesterday|Вчера|Сообщение|Message)$/i.test(s))
      .join('\n')
      .trim()

    const displayTime = (text) => {
      const matches = [...String(text || '').matchAll(/\b(\d{1,2}):(\d{2})(?:\s?(AM|PM))?\b/gi)]
      const match = matches[matches.length - 1]
      if (!match) return { label: null, minute: null }
      let hour = Number(match[1])
      const minute = Number(match[2])
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return { label: match[0], minute: null }
      const ampm = match[3] ? match[3].toUpperCase() : ''
      if (ampm === 'PM' && hour < 12) hour += 12
      if (ampm === 'AM' && hour === 12) hour = 0
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { label: match[0], minute: null }
      return { label: match[0], minute: hour * 60 + minute }
    }

    const nameFromUrl = (url, fallback) => {
      try {
        const parsed = new URL(url)
        const id = parsed.searchParams.get('id') || parsed.searchParams.get('r') || ''
        return id ? `${fallback}-${id.slice(0, 12)}` : fallback
      } catch {
        return fallback
      }
    }

    const seenRows = new Set()
    for (const row of rows) {
      if (!visible(row)) continue
      const message = row.matches('[class*="messageWrapper"]') ? row : (row.querySelector('[class*="messageWrapper"]') || row)
      if (seenRows.has(message)) continue
      seenRows.add(message)

      const rect = message.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const rawText = message.innerText || row.innerText || ''
      const text = cleanText(rawText)
      const timeInfo = displayTime(rawText)
      const attachments = []

      for (const img of [...message.querySelectorAll('img')]) {
        const r = img.getBoundingClientRect()
        const src = img.currentSrc || img.src || img.getAttribute('src') || ''
        if (!src || r.width < 60 || r.height < 60) continue
        const name = `${nameFromUrl(src, 'max-image')}.jpg`
        attachments.push({ type: 'image', url: src, name, mimeType: 'image/jpeg', sourceKind: 'dom_img' })
      }

      for (const video of [...message.querySelectorAll('video')]) {
        const r = video.getBoundingClientRect()
        const url = video.currentSrc || video.src || video.getAttribute('src') || ''
        if (!url || r.width < 60 || r.height < 60) continue
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null
        const name = `${nameFromUrl(video.poster || url, 'max-video')}.mp4`
        attachments.push({ type: 'video', url, name, mimeType: 'video/mp4', duration, sourceKind: 'dom_video' })
      }

      for (const button of [...message.querySelectorAll('button[aria-label*="Скачать"], button[aria-label*="Download"]')]) {
        const buttonText = (button.innerText || button.textContent || '').trim()
        const match = buttonText.match(/[^\n\r]+\.(ogg|opus|mp3|m4a|aac|wav|mp4|mov|jpe?g|png|webp|gif|pdf|zip)\b/i)
        if (!match) continue
        const name = match[0].trim()
        const lower = name.toLowerCase()
        const type = /\.(ogg|opus|mp3|m4a|aac|wav)$/i.test(lower)
          ? 'audio'
          : (/\.(mp4|mov)$/i.test(lower)
            ? 'video'
            : (/\.(jpe?g|png|webp|gif)$/i.test(lower) ? 'image' : 'document'))
        const mimeType = /\.(ogg|opus)$/i.test(lower) ? 'audio/ogg'
          : (/\.(mp4)$/i.test(lower) ? 'video/mp4'
            : (/\.(jpe?g)$/i.test(lower) ? 'image/jpeg' : null))
        attachments.push({ type, name, mimeType, downloadable: true, sourceKind: 'dom_download' })
      }

      const quoteSelectors = [
        'use[href*="icon_quote"]',
        'use[xlink\\:href*="icon_quote"]',
        '[class*="quote"]',
        '[class*="Quote"]',
        '[class*="quoted"]',
        '[class*="Quoted"]',
      ]
      const hasReplyQuote = quoteSelectors.some(selector => {
        try { return !!message.querySelector(selector) } catch { return false }
      }) || /icon_quote|quoted|quote/i.test(String(message.innerHTML || '').slice(0, 5000))

      candidates.push({
        text,
        attachments,
        x: rect.left,
        y: rect.top,
        bottom: rowRect.bottom,
        width: rect.width,
        height: rect.height,
        viewportW,
        displayTime: timeInfo.label,
        displayMinute: timeInfo.minute,
        hasReplyQuote,
        isOutgoing: /messageWrapper--isOut|message--isOut/.test(`${message.className || ''} ${message.querySelector('[class*="message--isOut"]')?.className || ''}`),
      })
    }

    if (candidates.length > 0) {
      return candidates
        .filter(r => r.text || r.attachments.length > 0)
        .sort((a, b) => (a.bottom - b.bottom) || (a.x - b.x))
        .slice(-12)
    }

    const elements = [...document.querySelectorAll('div, span, p')]
    const textRows = []

    for (const el of elements) {
      const text = (el.innerText || el.textContent || '').trim()
      if (!text || text.length > 500 || (text.length < 2 && !/^\d$/.test(text))) continue
      if (el.closest('[contenteditable="true"], input, textarea, button, nav, header')) continue

      const rect = el.getBoundingClientRect()
      if (rect.width < 20 || rect.height < 12) continue
      if (rect.bottom < 80 || rect.top > viewportH - 55) continue
      if (rect.left < viewportW * 0.30) continue
      if (rect.right < viewportW * 0.28) continue

      const childText = [...el.children].map(c => (c.innerText || c.textContent || '').trim()).filter(Boolean).join('\n').trim()
      if (childText === text && el.children.length > 0) continue

      const timeInfo = displayTime(text)
      textRows.push({ text, attachments: [], x: rect.left, y: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, viewportW, displayTime: timeInfo.label, displayMinute: timeInfo.minute, isOutgoing: false })
    }

    const seen = new Set()
    return textRows
      .filter(r => {
        const key = `${r.text}|${Math.round(r.y)}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => (a.bottom - b.bottom) || (a.x - b.x))
      .slice(-12)
  })

  return candidates
    .map(candidate => {
      const cleaned = cleanDomMessageText(candidate.text)
      const attachments = Array.isArray(candidate.attachments) ? candidate.attachments : []
      return { ...candidate, text: cleaned, attachments }
    })
    .filter(candidate => candidate.text || candidate.attachments.length > 0)
}

async function scrapeLatestDomMessage(uiRouteId) {
  const candidates = await scrapeRecentDomMessages(uiRouteId)
  return candidates[candidates.length - 1] || null
}

async function scrapeDomPeerIdentity(uiRouteId, { forcePhone = false } = {}) {
  if (!page || !isReady) return {}
  const targetUrl = `https://web.max.ru/${uiRouteId}`
  if (!page.url().includes(`/${uiRouteId}`)) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1200)
  }

  const header = await page.evaluate(() => {
    const viewportW = window.innerWidth || 1280
    const blocked = /^(MAX|Чаты|Chats|Инфо|Info|В сети|Online|Был\(-а\)|Last seen|Сегодня|Today)$/i
    return [...document.querySelectorAll('h1, h2, h3, button, [role="button"], a, div, span')]
      .map(el => {
        const text = (el.innerText || el.textContent || '').trim()
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          fontSize: Number.parseFloat(style.fontSize) || 0,
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        }
      })
      .filter(item =>
        item.text && !item.text.includes('\n') && item.text.length >= 2 && item.text.length <= 80 &&
        item.left > viewportW * 0.25 && item.top >= 0 && item.top < 105 &&
        item.width > 20 && item.width < 520 && item.height > 10 && item.height < 90 &&
        !blocked.test(item.text) && !/^\d{1,2}:\d{2}$/.test(item.text) &&
        !/^(был|last seen|online|в сети|недавно|мин|час)/i.test(item.text)
      )
      .sort((a, b) => ((b.fontWeight + b.fontSize * 10) - (a.fontWeight + a.fontSize * 10)) || a.top - b.top)[0] || null
  }).catch(() => null)

  if (!header?.text) return {}
  const identity = { senderName: header.text }
  if (!forcePhone) return identity

  let opened = false
  try {
    await page.mouse.click(header.x, header.y)
    opened = true
    await page.waitForTimeout(900)
    const profile = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('div, span, p, label')]
        .filter(el => {
          if (el.offsetParent === null) return false
          const text = (el.innerText || el.textContent || '').trim()
          return /^(Номер телефона|Phone number)$/i.test(text)
        })
      if (!labels.length) return null

      const phonePattern = /(?:\+?7|8)(?:[\s().-]*\d){10}/
      for (const label of labels) {
        let current = label.parentElement
        for (let depth = 0; current && depth < 6; depth++, current = current.parentElement) {
          const text = (current.innerText || current.textContent || '').trim()
          const match = text.match(phonePattern)
          if (match) return { phone: match[0] }
        }
      }
      return null
    }).catch(() => null)
    if (profile?.phone) identity.phone = normalizePhoneForCrmPayload(profile.phone)
  } finally {
    if (opened || !page.url().includes(`/${uiRouteId}`)) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(900)
    }
  }

  return identity
}

function stableDomCandidateMessageId(chatId, text, attachments = [], candidate = {}) {
  if (!attachments.length) return candidate._domRecoveryExternalId || stableDomTextMessageId(chatId, text || '', candidate)
  const timeKey = stableDomMediaTimeKey(candidate)
  if (timeKey) return stableDomMediaMessageId(chatId, `${text || ''}:time=${timeKey}`, attachments)
  const y = Number.isFinite(candidate.bottom) ? Math.round(candidate.bottom) : 0
  const x = Number.isFinite(candidate.x) ? Math.round(candidate.x) : 0
  return stableDomMediaMessageId(chatId, `${text || ''}:pos=${x}:${y}`, attachments)
}

function stableDomMirrorMessageId(chatId, text, attachments = [], candidate = {}) {
  const day = Math.floor(Date.now() / 86_400_000)
  const minute = Number.isFinite(candidate.displayMinute) ? candidate.displayMinute : candidate.displayTime || 'unknown'
  const attachmentSignature = attachments
    .map(att => `${att.type || ''}:${att.name || ''}:${att.size || ''}`)
    .join('|')
  const signature = `${chatId}:${day}:${minute}:${comparableDomText(text)}:${attachmentSignature}`
  const hash = crypto.createHash('sha1').update(signature).digest('hex').slice(0, 16)
  return `max-mirror-${chatId}-${hash}`
}

async function forwardDomCandidate(chatId, uiRouteId, latest, reason = 'manual', options = {}) {
  if (!latest?.text && !latest?.attachments?.length) return { skipped: 'no_content' }
  if (latest.text && !latest.attachments?.length && isDomNoiseText(latest.text)) return { skipped: 'noise_text', text: latest.text }
  if (!latest.attachments?.length && reason === 'loose_op128_media') {
    return { skipped: 'text_only_auto_fallback', text: latest.text }
  }
  const isOutgoingCandidate = Boolean(latest.isOutgoing || (latest.viewportW && latest.x > latest.viewportW * 0.55))
  if (isOutgoingCandidate && !options.includeOutgoing) {
    return { skipped: 'outgoing_side', text: latest.text, x: latest.x, viewportW: latest.viewportW }
  }
  if (isOutgoingCandidate && matchesRecentCrmOutboundText(chatId, uiRouteId, latest.text)) {
    return { skipped: 'crm_outbound_already_recorded', text: latest.text }
  }
  if (isOutgoingCandidate && latest.attachments?.length && !options.includeOutgoingMedia) {
    return { skipped: 'outgoing_media_mirror_deferred', text: latest.text }
  }
  if (reason === 'empty_op71_after_op128' && looksLikeDomReplyQuoteText(chatId, latest)) {
    return { skipped: 'dom_reply_quote_text', text: latest.text }
  }
  if (latest._skipDomTextAlreadyRecovered) {
    return { skipped: 'dom_text_already_recovered', text: latest.text }
  }
  if (reason === 'empty_op71_after_op128' && latest.text && !latest.attachments?.length) {
    const directHit = latest._directHit || (!latest._allowDomDuplicateRecovery ? findRecentDirectInboundText(chatId, latest.text) : null)
    if (directHit) {
      return {
        skipped: 'recent_direct_text_seen',
        text: latest.text,
        externalId: directHit.externalId,
      }
    }
  }

  const attachments = await materializeDomFallbackAttachments(uiRouteId, latest.attachments || [])
  const text = attachments.length > 0 ? cleanDomMediaCaption(latest.text, attachments) : latest.text
  if (!text && !attachments.length) return { skipped: 'no_download_source', rawAttachments: latest.attachments?.length || 0 }

  const pendingProviderId = reason === 'empty_op71_after_op128' && !isOutgoingCandidate && text && attachments.length === 0
    ? transport?.peekPendingLiveTextIdForDomRecovery?.(chatId, { maxAgeMs: 15_000 })
    : null
  const externalId = isOutgoingCandidate
    ? stableDomMirrorMessageId(chatId, text, attachments, latest)
    : (pendingProviderId || stableDomCandidateMessageId(chatId, text, attachments, latest))
  if (domFallbackSeen.has(externalId)) return { skipped: 'seen', text: latest.text }
  domFallbackSeen.add(externalId)

  const messageType = attachments[0]?.type || 'text'
  const cachedPhone = cachedPhoneForChatId(chatId, uiRouteId)
  const crmPhone = normalizePhoneForCrmPayload(options.phone || cachedPhone)
  const crmSenderName = options.senderName || options.name || null
  console.log(`[domFallback] ${reason} chatId=${chatId} text="${String(text || '').slice(0, 80)}" attachments=${attachments.length}`)
  rememberKnownChatId(chatId)
  if (crmPhone) savePhoneChatId(crmPhone, chatId)
  const result = await forwardToWebhook({
    externalId,
    chatId: String(chatId),
    text,
    timestamp: options.timestamp || Date.now(),
    messageType,
    attachments,
    isOutgoing: isOutgoingCandidate,
    source: isOutgoingCandidate ? 'max_web_mirror' : (pendingProviderId ? 'live_dom_recovery' : 'dom_fallback'),
    ...(crmPhone ? { phone: crmPhone, senderPhone: crmPhone } : {}),
    ...(crmSenderName ? { senderName: crmSenderName } : {}),
  })
  if (pendingProviderId && result.status >= 200 && result.status < 300 && !result.skipped) {
    transport?.confirmPendingLiveTextIdForDomRecovery?.(chatId, pendingProviderId)
  }
  if (!isOutgoingCandidate && reason === 'empty_op71_after_op128' && text && !attachments.length && latest._allowDomDuplicateRecovery && !latest._directHit) {
    rememberDomRecoveredText(chatId, text)
  }
  if (result.status >= 200 && result.status < 300 && result.skipped) {
    return {
      skipped: 'crm_webhook_skipped',
      webhookSkipped: result.skipped,
      externalId,
      text,
      messageType,
    }
  }
  return {
    success: true,
    externalId,
    text,
    messageType,
    attachments: attachments.map(a => ({ type: a.type, name: a.name, size: a.size, mimeType: a.mimeType })),
    webhook: result,
  }
}

async function forwardLatestDomMessage(chatId, reason = 'manual', options = {}) {
  if (uiSendInProgress) return { skipped: 'ui_send_in_progress' }
  if (domFallbackRunning) return { skipped: 'busy' }
  domFallbackRunning = true
  try {
    const route = resolveUiRouteIdForChat(chatId)
    const uiRouteId = route.uiRouteId
    if (route.source !== 'protocol_chat_id') {
      console.log(`[domFallback] resolved UI route chatId=${chatId} route=${uiRouteId} source=${route.source}`)
    }
    if (transport) transport._activeUiChatId = String(chatId)
    const latest = await scrapeLatestDomMessage(uiRouteId)
    return await forwardDomCandidate(chatId, uiRouteId, latest, reason, options)
  } finally {
    domFallbackRunning = false
  }
}

async function forwardRecentDomMessages(chatId, reason = 'manual') {
  const options = arguments[2] || {}
  if (uiSendInProgress) return { skipped: 'ui_send_in_progress' }
  if (domFallbackRunning) return { skipped: 'busy' }
  domFallbackRunning = true
  try {
    const route = resolveUiRouteIdForChat(chatId)
    const uiRouteId = route.uiRouteId
    if (route.source !== 'protocol_chat_id') {
      console.log(`[domFallback] resolved UI route chatId=${chatId} route=${uiRouteId} source=${route.source}`)
    }
    if (transport) transport._activeUiChatId = String(chatId)
    let effectiveOptions = { ...options }
    if (options.enrichPeer) {
      const cachedPhone = cachedPhoneForChatId(chatId, uiRouteId)
      const peerIdentity = await scrapeDomPeerIdentity(uiRouteId, {
        forcePhone: Boolean(options.forcePeerIdentity || !cachedPhone),
      }).catch(e => {
        console.warn(`[domIdentity] failed chatId=${chatId}: ${e.message}`)
        return {}
      })
      effectiveOptions = { ...peerIdentity, ...effectiveOptions }
      if (peerIdentity.phone) {
        savePhoneChatId(peerIdentity.phone, chatId)
        console.log(`[domIdentity] chatId=${chatId} phone=${peerIdentity.phone} name=${peerIdentity.senderName || 'unknown'}`)
      }
    }
    const candidates = await scrapeRecentDomMessages(uiRouteId)
    let recoverable = (reason === 'empty_op71_after_op128'
      ? candidates
        .filter(candidate => candidate.text && !candidate.attachments?.length)
      : candidates)
      .map(candidate => ({ ...candidate, _chatId: String(chatId) }))
    const preSkipped = {}
    if (options.freshOnly) {
      const latestDisplayMinute = [...recoverable]
        .reverse()
        .find(candidate => Number.isFinite(candidate.displayMinute))?.displayMinute
      const beforeFreshFilter = recoverable.length
      recoverable = Number.isFinite(latestDisplayMinute)
        ? recoverable.filter(candidate =>
          Number.isFinite(candidate.displayMinute) &&
          displayMinuteDistance(candidate.displayMinute, latestDisplayMinute) <= 2
        )
        : recoverable.slice(-1)
      preSkipped.dom_stale_event_filtered = beforeFreshFilter - recoverable.length
    }
    if (reason === 'empty_op71_after_op128') {
      const beforeLiveWindowFilter = recoverable.length
      const liveWindowDetails = recentLiveDomWindowDetails(chatId, recoverable.length)
      recoverable = recoverable.slice(-liveWindowDetails.size)
      preSkipped.dom_live_window_filtered = beforeLiveWindowFilter - recoverable.length
      assignDirectHitsToDomCandidates(chatId, recoverable)
      const directDisplayMinutes = recoverable
        .filter(candidate => candidate._directHit && Number.isFinite(candidate.displayMinute))
        .map(candidate => candidate.displayMinute)
      if (!directDisplayMinutes.length) {
        return {
          success: false,
          count: 0,
          scanned: candidates.length,
          attempted: 0,
          skipped: { no_recent_direct_time_anchor: recoverable.length },
        }
      }
      const beforeTimeFilter = recoverable.length
      recoverable = recoverable.filter(candidate =>
        Number.isFinite(candidate.displayMinute) &&
        directDisplayMinutes.some(minute => displayMinuteDistance(candidate.displayMinute, minute) <= 1)
      )
      preSkipped.dom_time_window_filtered = beforeTimeFilter - recoverable.length
      if (liveWindowDetails.recentOp128Count > 0) {
        for (const candidate of recoverable) {
          if (candidate?.text && !candidate.attachments?.length && !candidate._directHit) {
            candidate._liveDomSeriesCandidate = true
          }
        }
      }
      const firstDirectIndex = recoverable.findIndex(candidate => candidate._directHit)
      if (firstDirectIndex > 0) {
        let keepFrom = firstDirectIndex
        const hasFreshLiveWindow = liveWindowDetails.recentOp128Count > 0
        let currentNumber = parsePlainIntegerText(recoverable[firstDirectIndex].text)
        if (currentNumber != null && !hasFreshLiveWindow) {
          for (let i = firstDirectIndex - 1; i >= 0; i--) {
            const previousNumber = parsePlainIntegerText(recoverable[i].text)
            if (previousNumber == null) break
            const step = currentNumber - previousNumber
            if (step < 0 || step > 1) break
            keepFrom = i
            currentNumber = previousNumber
          }
        } else {
          const liveContextBudget = liveDomContextBeforeDirectBudget(chatId, recoverable, firstDirectIndex)
          if (liveContextBudget > 0) keepFrom = firstDirectIndex - liveContextBudget
        }
        markLiveDomContextBeforeFirstDirect(recoverable, keepFrom, firstDirectIndex)
        preSkipped.dom_context_before_first_direct = keepFrom
        recoverable = recoverable.slice(keepFrom)
      }
      const beforeAnchorFilter = recoverable.length
      recoverable = recoverable.filter((candidate, index, list) =>
        shouldKeepDomTextRecoveryCandidate(chatId, candidate, list, index)
      )
      preSkipped.dom_unanchored_text_filtered = beforeAnchorFilter - recoverable.length
      const beforeNumericFutureFilter = recoverable.length
      recoverable = recoverable.filter((candidate, index, list) =>
        shouldKeepNumericDomRecoveryCandidate(candidate, list, index)
      )
      preSkipped.dom_numeric_future_filtered = beforeNumericFutureFilter - recoverable.length
      for (let i = 0; i < recoverable.length; i++) {
        if (!recoverable[i]._directHit) {
          recoverable[i]._recoveryTimestamp = new Date(estimateDomRecoveryTimestampMs(recoverable, i)).toISOString()
        }
      }
      assignDomTextRecoveryBudgets(chatId, recoverable)
      assignDomRecoveryExternalIds(chatId, recoverable)
      applyDomTextRecoveryLimits(chatId, recoverable)
    }
    const results = []
    const skipped = { ...preSkipped }
    for (const candidate of recoverable) {
      const result = await forwardDomCandidate(chatId, uiRouteId, candidate, reason, {
        timestamp: candidate._recoveryTimestamp,
        ...effectiveOptions,
      })
      if (result?.success) results.push(result)
      else if (result?.skipped) skipped[result.skipped] = (skipped[result.skipped] || 0) + 1
    }
    return {
      success: results.length > 0,
      count: results.length,
      scanned: candidates.length,
      attempted: recoverable.length,
      skipped,
      results: results.slice(-6),
    }
  } finally {
    domFallbackRunning = false
  }
}

// ─── Contact sync: refresh contact list from MAX ─────────────────────────────
let _lastContactSync = 0  // timestamp последнего успешного sync
let _dialogBusy      = false  // защита от параллельных вызовов resolveViaPhoneLookupDialog

async function syncContacts(timeoutMs = 8000) {
  if (!transport || !isReady) return false

  const fresh = await new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      const idx = transport._rawHandlers.indexOf(handler)
      if (idx > -1) transport._rawHandlers.splice(idx, 1)
      done = true; resolve(false)
    }, timeoutMs)

    function handler(data) {
      if (data.opcode === 32 && data.payload?.contacts) {
        clearTimeout(timer)
        const idx = transport._rawHandlers.indexOf(handler)
        if (idx > -1) transport._rawHandlers.splice(idx, 1)
        contactStore.ingest(data.payload)
        if (!done) { done = true; resolve(true) }
      }
    }
    transport._rawHandlers.push(handler)

    // Try to trigger a contacts refresh by sending opcode 32 as a request
    // MAX server should respond with cmd:1 payload.contacts OR push a fresh opcode 32
    transport.sendFrame(32, {}, { waitResponse: false })
      .catch(e => console.warn('[syncContacts] sendFrame(32) failed:', e.message))
  })

  if (fresh) {
    _lastContactSync = Date.now()
    console.log(`[syncContacts] Refreshed: ${contactStore._map.size} contacts`)
    loadPhoneChatIdCache()
  } else {
    console.warn('[syncContacts] Timeout — opcode 32 not returned by MAX')
  }
  return fresh
}

// ─── Точечный запрос телефона конкретного контакта через op:32 ───────────────
// Отправляет op:32 {contactIds:[userId]}, ждёт ответа до timeoutMs.
// Обновляет contactStore при успехе. Возвращает phone-string или null.
async function getContactPhone(senderId, timeoutMs = 4000) {
  const existing = contactStore.getPhone(String(senderId))
  if (existing) return existing

  if (!transport || !isReady) return null
  const userIdNum = Number(senderId)
  if (isNaN(userIdNum)) return null

  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { done = true; resolve(null) }, timeoutMs)

    function handler(data) {
      if (data.opcode === 32 && data.payload?.contacts) {
        const found = (data.payload.contacts || []).find(c => String(c.id) === String(senderId))
        if (found) {
          clearTimeout(timer)
          const idx = transport._rawHandlers.indexOf(handler)
          if (idx > -1) transport._rawHandlers.splice(idx, 1)
          contactStore.ingest(data.payload)
          if (!done) { done = true; resolve(found.phone ? String(found.phone) : null) }
        }
      }
    }
    transport._rawHandlers.push(handler)

    transport.sendFrame(OP.CONTACTS, { contactIds: [userIdNum] }, { waitResponse: false })
      .catch(e => {
        clearTimeout(timer)
        const idx = transport._rawHandlers.indexOf(handler)
        if (idx > -1) transport._rawHandlers.splice(idx, 1)
        if (!done) { done = true; resolve(null) }
        console.warn('[getContactPhone] op:32 failed:', e.message)
      })
  })
}

// ─── "Найти по номеру" dialog ─────────────────────────────────────────────────
// MAX Contacts → "+" button → "Найти по номеру" dialog.
// This is the correct server-side phone lookup that works even for private profiles.
// Returns convId (from URL after navigation) or userId (from WS search frames).
async function resolveViaPhoneLookupDialog(digits, messageToSend = null) {
  if (!page || !transport || !isReady) return null
  // Защита от параллельных вызовов: два одновременных диалога вешают браузер
  if (_dialogBusy) {
    console.log('[ResolvePhone] Dialog already running, skipping')
    return null
  }
  _dialogBusy = true

  const local10 = digits.slice(-10)
  console.log(`[ResolvePhone] "Найти по номеру" dialog: ${local10}`)

  const capturedFrames = []
  const rawHandler = (data) => {
    if (data.opcode !== 132 && data.opcode !== 1 && data.opcode !== 5) {
      capturedFrames.push({ opcode: data.opcode, cmd: data.cmd, payload: data.payload })
    }
  }
  transport._rawHandlers.push(rawHandler)

  // SPA-навигация назад: кликаем таб «Чаты» — не перезагружает страницу, не рвёт WS
  const returnHome = async () => {
    try {
      const chatsEl = page.locator('[aria-label="Chats"], button:has-text("Chats"), button:has-text("Чаты"), button:has-text("Диалоги")').first()
      if (await chatsEl.isVisible({ timeout: 800 }).catch(() => false)) {
        await chatsEl.click()
        return
      }
      // Fallback: pushState (не перезагружает, не рвёт WS)
      await page.evaluate(() => { try { window.history.pushState({}, '', '/') } catch {} })
      await page.waitForTimeout(300)
    } catch {}
  }
  const cleanup = () => {
    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)
    _dialogBusy = false
  }

  // Helper: find a phone-type input on the page (not a text search)
  const findPhoneInput = async () => {
    for (const sel of [
      'input[inputmode="decimal"]',   // MAX Search by number dialog input (mode=decimal, empty placeholder)
      'input[inputmode="numeric"]',
      'input[inputmode="tel"]',
      'input[type="tel"]',
      'input[placeholder*="123"]', 'input[placeholder*="456"]',
      'input[placeholder*="номер"]', 'input[placeholder*="Номер"]',
      'input[placeholder*="phone"]', 'input[placeholder*="Phone"]',
    ]) {
      if (await page.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) {
        return page.locator(sel).first()
      }
    }
    return null
  }

  try {
    // 1. Click "Contacts" tab — SPA-навигация, не перезагружает страницу, WS остаётся жить
    const contactsTab = page.locator('button:has-text("Contacts"), button:has-text("Контакты"), a[href="/contacts"]').first()
    if (await contactsTab.isVisible({ timeout: 1500 }).catch(() => false)) {
      await contactsTab.click()
      console.log('[ResolvePhone] Clicked Contacts tab')
      await page.waitForTimeout(1000)
    } else {
      // Нет таба — SPA-pushState (тоже не перезагружает)
      console.log('[ResolvePhone] Contacts tab not found, trying SPA pushState')
      await page.evaluate(() => {
        try { window.history.pushState({}, '', '/contacts') } catch {}
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
      })
      await page.waitForTimeout(1500)
    }

    // 3. Dump all visible buttons to find the "+" for "Найти по номеру"
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null)
        .map(b => ({
          text: b.innerText?.trim().slice(0, 30),
          title: b.getAttribute('title'),
          label: b.getAttribute('aria-label'),
          cls: b.className?.slice(0, 80),
        }))
    )
    console.log('[ResolvePhone] Contacts section buttons:', JSON.stringify(btns))

    // Screenshot for visual debugging — saved to /tmp/max_contacts_state.png
    await page.screenshot({ path: '/tmp/max_contacts_state.png', fullPage: false }).catch(() => {})
    console.log('[ResolvePhone] Screenshot saved: /tmp/max_contacts_state.png')

    // 4. "Start chatting" (aria-label) IS the blue "+" button (x=422, y=18 in viewport).
    //    Click it and inspect the resulting dialog for phone-number mode.
    let plusClicked = false

    const startChattingEl = page.locator('[aria-label="Start chatting"]').first()
    if (await startChattingEl.isVisible({ timeout: 1000 }).catch(() => false)) {
      await startChattingEl.click()
      console.log('[ResolvePhone] Clicked "Start chatting" (blue + button)')
      await page.waitForTimeout(1000)

      // Dump ALL interactive elements in the dialog to find phone-mode switcher
      const dialogDump = await page.evaluate(() => {
        return [...document.querySelectorAll('button, input, a, [role="button"], [role="tab"]')]
          .filter(el => {
            const s = getComputedStyle(el)
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.1
          })
          .map(el => ({
            tag: el.tagName, text: el.innerText?.trim().slice(0, 50),
            label: el.getAttribute('aria-label'), role: el.getAttribute('role'),
            type: el.getAttribute('type'), ph: el.getAttribute('placeholder'),
            cls: (el.className || '').toString().slice(0, 80),
          }))
      })
      console.log('[ResolvePhone] Dialog after StartChatting:', JSON.stringify(dialogDump))
      await page.screenshot({ path: '/tmp/max_start_chatting_dialog.png' }).catch(() => {})

      // Check if phone input already visible
      const directInput = await findPhoneInput()
      if (directInput) {
        plusClicked = true
        console.log('[ResolvePhone] Phone input directly visible after Start chatting!')
      } else {
        // "Start chatting" opens a dropdown menu. Click "Search by number" in it.
        const searchByNumberSels = [
          'button:has-text("Search by number")',
          'button[aria-label="Search by number"]',
          '[role="menuitem"]:has-text("Search by number")',
          'button:has-text("Найти по номеру")',
          'button:has-text("Поиск по номеру")',
          '[role="menuitem"]:has-text("номеру")',
        ]
        let clickedMenuItem = false
        for (const sel of searchByNumberSels) {
          if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
            await page.locator(sel).first().click()
            console.log(`[ResolvePhone] Clicked menu item: ${sel}`)
            await page.waitForTimeout(1000)
            clickedMenuItem = true
            break
          }
        }

        if (clickedMenuItem) {
          // Phone dialog is open — confirm by looking for "Find in MAX" button
          const findInMaxSels = [
            'button:has-text("Find in MAX")',
            'button[aria-label="Find in MAX"]',
            'button:has-text("Найти в МАХ")',
            'button:has-text("Найти в MAX")',
            'button[aria-label="Найти в МАХ"]',
          ]
          let dialogConfirmed = false
          for (const sel of findInMaxSels) {
            if (await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) {
              dialogConfirmed = true
              console.log(`[ResolvePhone] Phone lookup dialog confirmed (${sel})`)
              break
            }
          }

          if (dialogConfirmed) {
            // Find the actual phone input — try broader selectors
            // The input might be next to the country flag button
            const findDialogPhoneInput = async () => {
              // Try our standard selectors first
              const std = await findPhoneInput()
              if (std) return std
              // The dialog input might be ANY visible input (the other one is "Search" in contacts)
              // Since the phone dialog opens as an overlay, try to find input not in contacts list
              const allInputs = await page.evaluate(() =>
                [...document.querySelectorAll('input')]
                  .filter(i => i.type !== 'hidden')
                  .map(i => ({ ph: i.placeholder, type: i.type, mode: i.inputMode, cls: i.className?.slice(0, 60), vis: i.offsetParent !== null }))
              )
              console.log('[ResolvePhone] All inputs in phone dialog:', JSON.stringify(allInputs))
              // Return any input that's visible and not the "Search" contacts input
              for (const i of allInputs) {
                if (i.vis && i.ph !== 'Search') {
                  const loc = page.locator(`input[placeholder="${i.ph || ''}"]`).first()
                  if (await loc.isVisible({ timeout: 200 }).catch(() => false)) return loc
                }
              }
              // Last resort: try clicking the country button area and typing into it
              const countryBtn = page.locator('button[class*="country"]').first()
              if (await countryBtn.isVisible({ timeout: 200 }).catch(() => false)) {
                await countryBtn.click()
                await page.waitForTimeout(300)
                const afterClick = await findPhoneInput()
                if (afterClick) return afterClick
                await page.keyboard.press('Escape').catch(() => {}) // close country picker
                await page.waitForTimeout(200)
              }
              return null
            }

            const phoneDialogInput = await findDialogPhoneInput()
            if (phoneDialogInput) {
              plusClicked = true
              console.log('[ResolvePhone] Phone input found in dialog!')
            } else {
              // Still can't find the input — but we know the dialog is open
              // Try typing directly (keyboard.type goes to focused element)
              console.log('[ResolvePhone] Dialog open but phone input not found by selector — will try keyboard.type')
              plusClicked = true  // proceed to the typing/submit stage
            }
          } else {
            console.log('[ResolvePhone] "Search by number" clicked but dialog not confirmed')
          }
        } else {
          // Menu didn't have expected item — close it
          await page.keyboard.press('Escape').catch(() => {})
          await page.waitForTimeout(400)
          console.log('[ResolvePhone] "Search by number" not found in menu')
        }
      }
    }

    if (!plusClicked) {
      // Broaden search: look for ALL clickable elements (not just <button>)
      // The "+" for "Найти по номеру" might be a <div>/<span> with role="button"
      // or a <button> with position:fixed (offsetParent=null filters it out)
      const allClickable = await page.evaluate(() => {
        const candidates = []
        const els = document.querySelectorAll(
          'button, [role="button"], [tabindex="0"], a, [class*="add"], [class*="plus"], [class*="create"], [class*="fab"]'
        )
        for (const el of els) {
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          if (parseFloat(style.opacity) < 0.1) continue
          const text = el.innerText?.trim().slice(0, 30) || ''
          const label = el.getAttribute('aria-label') || ''
          const cls = (el.className || '').toString().slice(0, 80)
          const tag = el.tagName
          const hasSvg = !!el.querySelector('svg')
          candidates.push({ tag, text, label, cls, hasSvg })
        }
        return candidates
      })
      console.log('[ResolvePhone] All clickable elements:', JSON.stringify(allClickable))

      const SKIP_LABELS = ['Start chatting', 'Еще', 'Contact actions', 'Изменить ширину']
      const SKIP_TEXT = ['All', 'Новые', 'Каналы', 'Contacts', 'Calls', 'Settings', 'Search']

      // Priority 1: elements with "addition"/"add"/"plus" in class — the "+" button
      // may be styled via CSS pseudo-element (no SVG, no text) — e.g. DIV.addition.svelte-pu1tym
      // Exclude layer/container elements (layer-additional, layer-content, etc.)
      const addCandidates = allClickable.filter(c =>
        !c.text &&
        !SKIP_LABELS.includes(c.label) &&
        !c.cls.includes('layer') &&
        (c.cls.match(/\baddition\b/) || c.cls.includes('add-') || c.cls.includes('-add'))
      )
      // Priority 2: SVG-containing elements
      const svgCandidates = allClickable.filter(c =>
        c.hasSvg &&
        !c.text &&
        !SKIP_LABELS.includes(c.label) &&
        !SKIP_TEXT.includes(c.text) &&
        !addCandidates.includes(c)
      )
      const candidates = [...addCandidates, ...svgCandidates]
      console.log('[ResolvePhone] Filtered candidates (add-first):', JSON.stringify(candidates))

      for (const candidate of candidates) {
        const escaped = (s) => s?.replace(/"/g, '\\"').replace(/'/g, "\\'")
        let sel = null
        if (candidate.label && !SKIP_LABELS.includes(candidate.label)) {
          sel = `[aria-label="${escaped(candidate.label)}"]`
        } else {
          // Match by Svelte class hash
          const svelteCls = candidate.cls?.match(/svelte-\w+/)?.[0]
          if (svelteCls) sel = `${candidate.tag}.${svelteCls}:not([aria-label="Start chatting"])`
        }
        if (!sel) continue

        const el = page.locator(sel).first()
        if (!await el.isVisible({ timeout: 200 }).catch(() => false)) continue

        await el.click({ timeout: 2000 }).catch(() => {})
        console.log(`[ResolvePhone] Tried: ${candidate.tag} label="${candidate.label}" cls="${candidate.cls?.slice(0,40)}"`)
        await page.waitForTimeout(700)

        const phoneInput = await findPhoneInput()
        if (phoneInput) {
          plusClicked = true
          console.log('[ResolvePhone] Found phone input after click!')
          break
        }
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(400)
      }
    }

    if (!plusClicked) {
      // The "+" button is visually visible in screenshots but NOT captured by querySelectorAll.
      // Get bounding rects for known elements and use mouse.click at their position,
      // then also try coordinate-based click at known header location.
      const rects = await page.evaluate(() => {
        const res = {}
        for (const sel of ['.addition', '[class*="addition"]', '.button--active', '[aria-label="Start chatting"]']) {
          const el = document.querySelector(sel)
          if (!el) continue
          const r = el.getBoundingClientRect()
          const inner = el.innerHTML?.slice(0, 80) || ''
          res[sel] = { x: r.x, y: r.y, w: r.width, h: r.height, inner }
        }
        return res
      })
      console.log('[ResolvePhone] Element rects:', JSON.stringify(rects))

      // Try mouse.click at center of .addition bounding rect
      const addRect = rects['.addition'] || rects['[class*="addition"]']
      if (addRect && addRect.w > 0 && addRect.h > 0) {
        const cx = addRect.x + addRect.w / 2
        const cy = addRect.y + addRect.h / 2
        console.log(`[ResolvePhone] mouse.click at .addition center (${cx}, ${cy})`)
        await page.mouse.click(cx, cy)
        await page.waitForTimeout(700)
        if (await findPhoneInput()) { plusClicked = true; console.log('[ResolvePhone] Phone input found via .addition mouse.click!') }
        else await page.keyboard.press('Escape').catch(() => {})
      }
    }

    if (!plusClicked) {
      // Coordinate scan: screenshot showed "+" at right side of contacts panel header.
      // Active-button position helps us compute where the right-side "+" is.
      // Try a few y-positions at x ≈ right edge of contacts panel
      const activeBtn = await page.evaluate(() => {
        const el = document.querySelector('.button--active')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })
      if (activeBtn) {
        // The contacts panel right edge is approximately at startX + panelWidth
        // From screenshots, panel is ~300px wide; "+" is at ~panel_right - 10px
        const panelRight = activeBtn.x + activeBtn.w + 240  // rough estimate
        const headerCy   = activeBtn.y + activeBtn.h / 2
        // Scan a few x positions near the right edge of the contacts panel header
        for (const xOffset of [220, 240, 255, 270]) {
          const cx = activeBtn.x + activeBtn.w + xOffset
          const cy = headerCy
          console.log(`[ResolvePhone] Coordinate scan click at (${cx}, ${cy})`)
          await page.mouse.click(cx, cy)
          await page.waitForTimeout(600)
          if (await findPhoneInput()) { plusClicked = true; console.log(`[ResolvePhone] Phone input found at coordinate (${cx}, ${cy})!`); break }
          await page.keyboard.press('Escape').catch(() => {})
          await page.waitForTimeout(300)
        }
      }
    }

    if (!plusClicked) {
      // Last resort: click the blue "+" button by looking for primary-styled button
      // MAX uses "button--primary" class for blue accent buttons (different from neutral-primary)
      const primaryBtns = [
        'button[class*="--primary"]:not([class*="neutral"])',
        '[class*="roundButton"]',
        '[class*="round-button"]',
        '[class*="floatButton"]',
        '[class*="float-button"]',
      ]
      for (const sel of primaryBtns) {
        if (await page.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) {
          await page.locator(sel).first().click()
          console.log(`[ResolvePhone] Primary button click: ${sel}`)
          await page.waitForTimeout(700)
          if (await findPhoneInput()) { plusClicked = true; break }
          await page.keyboard.press('Escape').catch(() => {})
          await page.waitForTimeout(300)
        }
      }
    }

    if (!plusClicked) {
      // Iterate over ALL SVG-only buttons (no text), skip known non-candidates
      const svgBtns = btns.filter(b =>
        !b.text &&                         // no visible text
        b.label !== 'Start chatting' &&    // tried above already
        b.label !== 'Еще' &&
        b.label !== 'Contact actions' &&
        b.label !== 'Изменить ширину'
      )
      console.log('[ResolvePhone] Remaining SVG candidates:', JSON.stringify(svgBtns))

      for (const candidate of svgBtns) {
        // Build a selector to click this specific button
        const escaped = (s) => s?.replace(/"/g, '\\"')
        const sel = candidate.label
          ? `button[aria-label="${escaped(candidate.label)}"]`
          : candidate.title
            ? `button[title="${escaped(candidate.title)}"]`
            : null

        let clicked = false
        if (sel) {
          if (await page.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) {
            await page.locator(sel).first().click()
            clicked = true
          }
        } else {
          // No aria-label or title — click by class substring match
          const clsFrag = candidate.cls?.match(/svelte-\w+/)?.[0]
          if (clsFrag) {
            clicked = await page.evaluate((frag) => {
              const btns = [...document.querySelectorAll(`button.${frag}`)].filter(b => b.offsetParent !== null && !b.innerText?.trim())
              if (btns[0]) { btns[0].click(); return true }
              return false
            }, clsFrag)
          }
        }

        if (!clicked) continue
        console.log(`[ResolvePhone] Tried button: label="${candidate.label}" cls="${candidate.cls?.slice(0,40)}"`)
        await page.waitForTimeout(700)

        // Check if a PHONE input appeared (not a text search input)
        const phoneInput = await findPhoneInput()
        if (phoneInput) {
          plusClicked = true
          console.log('[ResolvePhone] Phone input found after button click!')
          break
        }

        // Wrong button — close any opened overlay with Escape and try next
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(400)
      }
    } else {
      await page.waitForTimeout(700)
    }

    await page.screenshot({ path: '/tmp/max_phone_dialog_open.png' }).catch(() => {})

    // 3. Find phone input — try standard selectors + broader fallback
    let dialogInput = await findPhoneInput()

    if (!dialogInput) {
      // Check if "Find in MAX" / "Найти в МАХ" is visible — means dialog IS open but input is non-standard
      const findInMaxVisible = await page.locator(
        'button:has-text("Find in MAX"), button:has-text("Найти в МАХ"), button:has-text("Найти в MAX"), button[aria-label="Find in MAX"]'
      ).first().isVisible({ timeout: 600 }).catch(() => false)

      if (findInMaxVisible) {
        console.log('[ResolvePhone] Dialog open (Find in MAX visible). Trying broader input search...')
        // Find ANY input that is not "Search" (the contacts panel search bar)
        const anyInput = await page.evaluate(() => {
          const inputs = [...document.querySelectorAll('input')]
            .filter(i => i.type !== 'hidden' && i.placeholder !== 'Search' && i.getAttribute('placeholder') !== 'Поиск')
          if (!inputs.length) return null
          const i = inputs[0]
          return { ph: i.placeholder, type: i.type, mode: i.inputMode, cls: i.className?.slice(0, 60) }
        })
        console.log('[ResolvePhone] Non-search input in dialog:', JSON.stringify(anyInput))

        if (anyInput !== null) {
          const sel = anyInput.ph
            ? `input[placeholder="${anyInput.ph}"]`
            : anyInput.cls ? `input.${anyInput.cls.split(' ')[0]}` : 'input'
          dialogInput = page.locator(sel).first()
        }

        if (!dialogInput) {
          // No input at all — the phone "input" might be a contenteditable or custom element
          // Try clicking the country button (🇷🇺) to focus the numeric field
          const countryEl = page.locator('button[class*="country"], [class*="country"][role="button"]').first()
          if (await countryEl.isVisible({ timeout: 300 }).catch(() => false)) {
            const box = await countryEl.boundingBox()
            if (box) {
              // Click right-adjacent to country button where the phone digits go
              await page.mouse.click(box.x + box.width + 20, box.y + box.height / 2)
              console.log('[ResolvePhone] Clicked right of country button to focus phone field')
              await page.waitForTimeout(300)
              dialogInput = await findPhoneInput()
            }
          }
        }
      } else {
        const inputs = await page.evaluate(() =>
          [...document.querySelectorAll('input')]
            .filter(i => i.type !== 'hidden' && i.offsetParent !== null)
            .map(i => ({ ph: i.placeholder, type: i.type, mode: i.inputMode, cls: i.className?.slice(0, 60) }))
        )
        console.log('[ResolvePhone] No phone dialog found. Visible inputs:', JSON.stringify(inputs))
        cleanup(); await returnHome(); return null
      }
    }

    // 4. Type local 10 digits into the dialog input (or use keyboard if input not found)
    if (dialogInput) {
      console.log('[ResolvePhone] Phone input confirmed — filling...')
      await dialogInput.click({ timeout: 2000 }).catch(() => {})
      await dialogInput.fill('').catch(() => {})
    } else {
      console.log('[ResolvePhone] No input found — typing directly (focussed element fallback)')
    }
    await page.keyboard.type(local10, { delay: 50 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: '/tmp/max_phone_dialog_typed.png' }).catch(() => {})

    // 5. Click "Find in MAX" / "Найти в МАХ" button
    const searchBtnSel = [
      'button:has-text("Find in MAX")',
      'button[aria-label="Find in MAX"]',
      'button:has-text("Найти в МАХ")',
      'button:has-text("Найти в MAX")',
      'button:has-text("Найти")',
      'button[type="submit"]',
    ]
    let searchBtn = null
    for (const sel of searchBtnSel) {
      if (await page.locator(sel).last().isVisible({ timeout: 500 }).catch(() => false)) {
        searchBtn = page.locator(sel).last()
        console.log(`[ResolvePhone] Search button found: ${sel}`)
        break
      }
    }

    if (!searchBtn) {
      console.log('[ResolvePhone] "Найти в МАХ" button not found')
      cleanup(); await returnHome(); return null
    }

    const urlBefore = page.url()
    await searchBtn.click()
    console.log('[ResolvePhone] Clicked "Найти в МАХ"')
    await page.waitForTimeout(3500)

    // 6a. URL changed → extract convId
    const urlAfter = page.url()
    if (urlAfter !== urlBefore) {
      const convId = urlAfter.match(/web\.max\.ru\/(\d{5,15})(?:[/?#]|$)/)?.[1]
      if (convId) {
        // MAX 12-digit IDs (902XXXXXXXXX) = existing conversation → return immediately.
        // Short IDs (< 12 digits) = user profile page (no prior conversation) →
        // need to click "Написать" to open/create the conversation and get a real convId.
        if (convId.length >= 12) {
          console.log(`[ResolvePhone] URL-resolved (existing conv): ${digits} → convId ${convId}`)
          await returnHome()
          cleanup(); return convId
        }
        console.log(`[ResolvePhone] URL-resolved to user profile (${convId}) — waiting for profile buttons...`)
        await page.waitForTimeout(2500)
        const profileBtns = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(b => ({
            text: b.textContent?.trim().slice(0, 50),
            label: b.getAttribute('aria-label')?.slice(0, 40),
          }))
        ).catch(() => [])
        console.log('[ResolvePhone] Profile page buttons:', JSON.stringify(profileBtns))

        if (!messageToSend) {
          console.log(`[ResolvePhone] returning profile route for UI media: ${convId}`)
          await returnHome()
          cleanup(); return convId
        }

        // User profile page: no prior conversation → must send first message via UI
        // to discover the real 12-digit chatId (WS op:71/op:128 echo contains it).
        if (messageToSend) {
          const composeSelectors = [
            'div[contenteditable][role="textbox"]',
            'div[contenteditable="true"]:not([role="search"])',
            'div[contenteditable]',
          ]
          let composeEl = null
          for (const sel of composeSelectors) {
            const el = page.locator(sel).last()
            if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
              composeEl = el
              console.log(`[ResolvePhone] Found compose input: ${sel}`)
              break
            }
          }
          if (composeEl) {
            // Dismiss "Add to contacts" banner if present (it may overlay compose area)
            const bannerDismiss = page.locator('button[aria-label*="Hide" i][aria-label*="contacts" i]').first()
            if (await bannerDismiss.isVisible({ timeout: 500 }).catch(() => false)) {
              await bannerDismiss.click()
              await page.waitForTimeout(200)
            }
            await composeEl.click()
            await page.waitForTimeout(200)
            // Use keyboard.type() instead of fill() to trigger MAX's key-event listeners
            await page.keyboard.type(messageToSend, { delay: 20 })
            await page.waitForTimeout(400)
            const composeTextBeforeSubmit = await composeEl.textContent().catch(() => '')
            console.log(`[ResolvePhone] Compose text after typing: "${(composeTextBeforeSubmit || '').slice(0, 50)}"`)
            const sendFrameStartIndex = capturedFrames.length
            // Try pressing Enter first (most messaging apps send on Enter)
            await page.keyboard.press('Enter')
            console.log(`[ResolvePhone] Pressed Enter to send`)
            await page.waitForTimeout(1000)
            const sendBtn = page.locator('button[aria-label*="Send message" i]').first()
            const sendBtnVisible = await sendBtn.isVisible({ timeout: 500 }).catch(() => false)
            if (sendBtnVisible) {
              // If compose area still has text (Enter didn't send), click the send button
              const afterEnterText = await composeEl.textContent().catch(() => '')
              if ((afterEnterText || '').trim()) {
                await sendBtn.click()
                console.log(`[ResolvePhone] Clicked Send message button (Enter didn't send)`)
              } else {
                console.log(`[ResolvePhone] Enter sent the message (compose area empty)`)
              }
            }
            await page.waitForTimeout(300)
            const composeTextAfterSubmit = await composeEl.textContent().catch(() => '')
            const postSendFrames = capturedFrames.slice(sendFrameStartIndex)
            const phoneUiOutcome = evaluatePhoneResolutionUiSend({
              beforeText: composeTextBeforeSubmit,
              afterText: composeTextAfterSubmit,
              expectedText: messageToSend,
              postActionFrames: postSendFrames,
            })
            console.log(`[ResolvePhone] UI submit observation: ${phoneUiOutcome.submitObserved ? 'exact_text_cleared' : 'unconfirmed'}; delivery=send_requested`)
            console.log(`[ResolvePhone] Post-action frames:`,
              postSendFrames.map(f => `op:${f.opcode} cmd:${f.cmd}`).join(' | '))
            await returnHome(); cleanup()
            return phoneUiOutcome
          } else {
            console.log(`[ResolvePhone] No compose input found on profile page`)
          }
        }
        // Fall through to 6b write-button logic below
      }
    }

    // 6b. "Написать" / "Начать чат" button appeared — click and capture URL
    const writeBtnSels = [
      'button:has-text("Написать")',
      'button:has-text("Начать чат")',
      'button:has-text("Start chatting")',
      'button:has-text("Start chat")',
      'button:has-text("Написать сообщение")',
      'button:has-text("Message")',
      'button[aria-label*="Написать"]',
      'button[aria-label*="message" i]',
    ]
    for (const sel of writeBtnSels) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
        console.log(`[ResolvePhone] Found write button "${sel}" — clicking`)
        await btn.click()
        await page.waitForTimeout(3000)
        const urlFinal = page.url()
        const convId = urlFinal.match(/web\.max\.ru\/(\d{5,15})(?:[/?#]|$)/)?.[1]
        if (convId && convId.length >= 12) {
          console.log(`[ResolvePhone] URL after "Написать": ${digits} → convId ${convId}`)
          await returnHome()
          cleanup(); return convId
        }
        // Also check WS op:48 for new chat
        for (const f of capturedFrames) {
          if (f.opcode !== 48) continue
          for (const c of (f.payload?.chats || [])) {
            const cid = String(c.chatId || c.id || '')
            if (cid && /^\d{6,15}$/.test(cid) && !chatCache.has(cid)) {
              console.log(`[ResolvePhone] New chat from op:48 after write: ${digits} → ${cid}`)
              await returnHome()
              cleanup(); return cid
            }
          }
        }
        break
      }
    }

    // 6c. Check WS frames: op:72 (chat created) + op:46 (phone lookup) + op:60/68 (search results)
    console.log(`[ResolvePhone] WS frames: ${capturedFrames.map(f => `op:${f.opcode} cmd:${f.cmd}`).join(',')}`)
    // Log late-arriving ops for diagnosis
    const lateOps = capturedFrames.filter(f => [72, 177, 180].includes(f.opcode))
    if (lateOps.length) console.log(`[ResolvePhone] Late ops:`, lateOps.map(f => `op:${f.opcode} cmd:${f.cmd} payload:${JSON.stringify(f.payload).slice(0, 300)}`).join(' | '))

    // op:72 = conversation created/updated — arrives after first-ever message to a new contact
    for (const f of capturedFrames) {
      if (f.opcode !== 72 || !f.payload) continue
      const p = f.payload
      const directId = String(p.chatId || p.id || p.conversationId || p.chat_id || '')
      if (directId && /^\d{10,15}$/.test(directId)) {
        console.log(`[ResolvePhone] 6c op:72 chatId: ${directId}`)
        await returnHome(); cleanup()
        return directId
      }
      const arr = Array.isArray(p) ? p : (Array.isArray(p.chats) ? p.chats : (Array.isArray(p.conversations) ? p.conversations : []))
      for (const c of arr) {
        const cId = String((c && typeof c === 'object') ? (c.chatId || c.id || c.conversationId || '') : c || '')
        if (cId && /^\d{10,15}$/.test(cId)) {
          console.log(`[ResolvePhone] 6c op:72 array chatId: ${cId}`)
          await returnHome(); cleanup()
          return cId
        }
      }
      // Scan all numeric values in payload for a 10-15 digit ID
      const scan72 = (obj, depth = 0) => {
        if (depth > 4 || !obj || typeof obj !== 'object') return null
        for (const v of Object.values(obj)) {
          if (typeof v === 'number' || typeof v === 'string') {
            const s = String(v)
            if (/^\d{10,15}$/.test(s)) return s
          } else if (typeof v === 'object') {
            const found = scan72(v, depth + 1)
            if (found) return found
          }
        }
        return null
      }
      const scanned72 = scan72(p)
      if (scanned72) {
        console.log(`[ResolvePhone] 6c op:72 scanned chatId: ${scanned72}`)
        await returnHome(); cleanup()
        return scanned72
      }
    }

    for (const f of capturedFrames) {
      if (f.opcode === 46 && f.cmd === 1) {
        // op:46 cmd:1 — phone lookup success
        // Payload may contain userId, id, or a conversation object
        const p = f.payload || {}
        const userId = p.userId || p.id || p.user?.id || p.user?.userId
        if (userId && /^\d{5,15}$/.test(String(userId))) {
          console.log(`[ResolvePhone] op:46 phone lookup result: ${digits} → ${userId}`)
          await returnHome()
          cleanup(); return String(userId)
        }
        const convId = p.convId || p.chatId || p.conversationId
        if (convId && /^\d{5,15}$/.test(String(convId))) {
          console.log(`[ResolvePhone] op:46 convId: ${digits} → ${convId}`)
          await returnHome()
          cleanup(); return String(convId)
        }
        // Log the full payload for unknown structures
        console.log(`[ResolvePhone] op:46 cmd:1 payload:`, JSON.stringify(p).slice(0, 300))
      }
      if (f.opcode !== 60 && f.opcode !== 68) continue
      const results = Array.isArray(f.payload?.result) ? f.payload.result : []
      for (const r of results) {
        const id = r.id || r.userId || r.user_id
        if (id && /^\d{5,12}$/.test(String(id))) {
          console.log(`[ResolvePhone] op:${f.opcode} search result: ${digits} → ${id}`)
          await returnHome()
          cleanup(); return String(id)
        }
      }
    }

    console.log(`[ResolvePhone] "Найти по номеру" — no result for ${local10}`)
    cleanup(); await returnHome(); return null

  } catch (e) {
    cleanup()
    console.warn('[ResolvePhone] Phone lookup dialog error:', e.message)
    await returnHome()
    return null
  }
}

// ─── Puppeteer UI search in MAX web ──────────────────────────────────────────
// Legacy: tries Ctrl+N compose dialog. Kept as extra fallback.
async function resolveViaUiSearch(digits) {
  if (!page) return null

  const phone7 = digits.startsWith('7') ? digits : '7' + digits.slice(-10)
  console.log(`[ResolvePhone] UI search: ${phone7}...`)

  // Capture ALL WS frames during search — the search request + results
  const capturedFrames = []
  const rawHandler = (data) => {
    if (data.opcode !== 132) {
      capturedFrames.push({ opcode: data.opcode, cmd: data.cmd, seq: data.seq, payload: data.payload })
    }
  }
  transport._rawHandlers.push(rawHandler)

  // Capture HTTP API responses during search
  const capturedHttp = []
  const httpHandler = async (response) => {
    const url = response.url()
    // Skip static assets
    if (/\.(png|jpg|svg|css|js|ico|woff|woff2)(\?|$)/.test(url)) return
    if (url.includes('/_app/') || url.includes('/immutable/')) return
    try {
      const text = await response.text().catch(() => '')
      if (text && text.length < 5000) {
        capturedHttp.push({ url, status: response.status(), body: text.slice(0, 500) })
      }
    } catch {}
  }
  page.on('response', httpHandler)

  const cleanup = () => {
    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)
    page.off('response', httpHandler)
  }

  try {
    // Save debug screenshot before interaction
    await page.screenshot({ path: '/tmp/max_resolve_before.png', fullPage: false }).catch(() => {})

    // ── Step 1: Open "new message" compose dialog ────────────────────────
    // Strategy A: Playwright keyboard shortcut (actually fired, not synthetic)
    await page.keyboard.press('Control+n').catch(() => {})
    await page.waitForTimeout(600)

    // Strategy B: click compose button (try multiple selectors)
    const composeCandidates = [
      'button[title*="Написать"]',
      'button[title*="написать"]',
      'button[aria-label*="Написать"]',
      'button[aria-label*="написать"]',
      '[data-testid*="compose"]',
      '[class*="compose"]',
      '[class*="newChat"]',
      '[class*="new-chat"]',
      '[class*="newMessage"]',
    ]
    let composeBtnClicked = false
    for (const sel of composeCandidates) {
      try {
        const el = page.locator(sel).first()
        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
          await el.click()
          composeBtnClicked = true
          console.log(`[ResolvePhone] Compose button clicked: ${sel}`)
          await page.waitForTimeout(800)
          break
        }
      } catch {}
    }

    if (!composeBtnClicked) {
      // Strategy C: look for any button with pencil SVG or similar icon — dump all button titles for debug
      const btnInfo = await page.evaluate(() =>
        [...document.querySelectorAll('button')].slice(0, 30).map(b => ({
          title: b.getAttribute('title'),
          label: b.getAttribute('aria-label'),
          class: b.className.slice(0, 60),
        }))
      )
      console.log('[ResolvePhone] Available buttons:', JSON.stringify(btnInfo))
    }

    // ── Step 2: Find and fill the search/recipient input ─────────────────
    await page.screenshot({ path: '/tmp/max_resolve_compose.png', fullPage: false }).catch(() => {})

    const inputCandidates = [
      'input[placeholder="Search"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="Поис"]',
      'input[placeholder*="поис"]',
      'input[placeholder*="Кому"]',
      'input[placeholder*="кому"]',
      'input[placeholder*="Найти"]',
      'input[placeholder*="найти"]',
      'input[placeholder*="имя"]',
      'input[placeholder*="Имя"]',
    ]
    let searchInputSel = null
    for (const sel of inputCandidates) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) {
          searchInputSel = sel
          break
        }
      } catch {}
    }

    if (!searchInputSel) {
      // Fallback: any visible input
      const allInputs = await page.evaluate(() =>
        [...document.querySelectorAll('input')]
          .filter(i => i.type !== 'hidden' && i.offsetParent !== null)
          .map(i => ({ ph: i.placeholder, cls: i.className.slice(0, 60) }))
      )
      console.log('[ResolvePhone] Visible inputs:', JSON.stringify(allInputs))
      cleanup()
      return null
    }

    console.log(`[ResolvePhone] Search input found: ${searchInputSel}`)
    await page.locator(searchInputSel).first().click()
    await page.locator(searchInputSel).first().fill('')  // clear existing content first
    await page.keyboard.type(phone7, { delay: 50 })  // Playwright native type — triggers React events
    await page.waitForTimeout(3000)  // wait for search results

    // ── Step 3: Extract userId from DOM results ───────────────────────────
    await page.screenshot({ path: '/tmp/max_resolve_results.png', fullPage: false }).catch(() => {})

    const userId = await page.evaluate(() => {
      // Look for numeric IDs in data attributes or hrefs
      const candidates = [
        ...document.querySelectorAll('[data-id], [data-user-id], [data-contact-id]'),
        ...document.querySelectorAll('a[href*="/u/"]'),
        ...document.querySelectorAll('[class*="result"] [data-id]'),
        ...document.querySelectorAll('[class*="contact"] [data-id]'),
      ]
      for (const el of candidates) {
        const id = el.getAttribute('data-id') || el.getAttribute('data-user-id') ||
                   el.getAttribute('data-contact-id') ||
                   (el.href || '').match(/\/u\/(\d+)/)?.[1] ||
                   (el.href || '').match(/\/(\d{6,10})(?:\/|$)/)?.[1]
        if (id && /^\d{6,10}$/.test(String(id))) return String(id)
      }
      return null
    })

    if (userId) {
      console.log(`[ResolvePhone] DOM resolved: ${digits} → ${userId}`)
      await page.keyboard.press('Escape').catch(() => {})
      cleanup()
      return userId
    }

    // ── Step 3b: Click "Start chatting" and capture navigation URL ────────
    // When MAX found the contact, this button appears. After click, URL changes to /chat/CONVID
    // or MAX fires a WS frame. Either way we can extract the participant userId from the frame.
    const startBtn = page.locator('button:has-text("Start chatting"), button:has-text("Начать чат")').first()
    const startBtnVisible = await startBtn.isVisible({ timeout: 500 }).catch(() => false)
    if (startBtnVisible) {
      console.log('[ResolvePhone] "Start chatting" visible — clicking to capture convId')
      // Listen for WS op:48 or op:128 that will have the conversation participants
      let resolvedFromEcho = null
      const echoHandler = (data) => {
        if (resolvedFromEcho) return
        if (data.opcode === 48 && data.payload?.chats?.[0]) {
          const chat = data.payload.chats[0]
          // participants list — find the non-fleet userId
          const parts = chat.members || chat.participants || []
          const other = parts.find(p => String(p) !== String(transport._myUserId))
          if (other) resolvedFromEcho = String(other)
        }
        if (data.opcode === 128) {
          const rp = Array.isArray(data.payload)
            ? data.payload.find(x => x && typeof x === 'object' && !Array.isArray(x) && x.message)
            : data.payload
          if (rp?.message) {
            const sender = String(rp.message.sender || '')
            if (sender && sender !== String(transport._myUserId)) resolvedFromEcho = sender
          }
        }
      }
      transport._rawHandlers.push(echoHandler)

      await startBtn.click()
      await page.waitForTimeout(2000)

      const echoIdx = transport._rawHandlers.indexOf(echoHandler)
      if (echoIdx > -1) transport._rawHandlers.splice(echoIdx, 1)

      // Try URL: /chat/CONVID — load chat page, find other participant via WS
      const currentUrl = page.url()
      console.log('[ResolvePhone] URL after start chatting:', currentUrl)

      if (resolvedFromEcho) {
        console.log(`[ResolvePhone] Echo resolved: ${digits} → ${resolvedFromEcho}`)
        await page.keyboard.press('Escape').catch(() => {})
        cleanup()
        return resolvedFromEcho
      }
    }

    // ── Step 4: Check WS frames captured during search ───────────────────
    await page.waitForTimeout(500)
    await page.keyboard.press('Escape').catch(() => {})
    cleanup()

    console.log(`[ResolvePhone] Captured ${capturedFrames.length} WS frames:`,
      capturedFrames.map(f => `op:${f.opcode} cmd:${f.cmd}`).join(', '))

    // Log ALL frames for debug
    for (const frame of capturedFrames) {
      if (frame.opcode !== 132 && frame.opcode !== 1 && frame.opcode !== 5) {
        console.log(`[ResolvePhone] WS frame detail: op:${frame.opcode} cmd:${frame.cmd}`,
          JSON.stringify(frame.payload || {}).slice(0, 400))
      }
    }

    // Priority 1: op:60 and op:68 are MAX search result opcodes
    // result[] items have {id, name, ...} for matching users
    for (const frame of capturedFrames) {
      if (frame.opcode !== 60 && frame.opcode !== 68) continue
      const p = frame.payload || {}
      const results = Array.isArray(p.result) ? p.result : []
      for (const r of results) {
        const id = r.id || r.userId || r.user_id || r.contactId
        if (id && /^\d{5,12}$/.test(String(id))) {
          console.log(`[ResolvePhone] Search op:${frame.opcode} resolved: ${digits} → ${id}`)
          return String(id)
        }
      }
    }

    // Priority 2: op:32 contacts — only accept if phone field matches
    const tail10 = digits.replace(/\D/g, '').slice(-10)
    for (const frame of capturedFrames) {
      if (frame.opcode !== 32) continue
      const contacts = frame.payload?.contacts || []
      for (const c of contacts) {
        if (c.phone && String(c.phone).replace(/\D/g, '').slice(-10) === tail10) {
          console.log(`[ResolvePhone] op:32 phone match: ${digits} → ${c.id}`)
          return String(c.id)
        }
      }
    }

    // Log any HTTP API calls captured during the search (for diagnostics)
    if (capturedHttp.length > 0) {
      console.log(`[ResolvePhone] HTTP responses (${capturedHttp.length}):`,
        capturedHttp.map(h => `${h.status} ${h.url} → ${h.body.slice(0, 100)}`).join('\n'))
    }
  } catch (e) {
    cleanup()
    console.warn('[ResolvePhone] UI search failed:', e.message)
  }

  return null
}

// ─── chatCache participant lookup ─────────────────────────────────────────────
// Find a known conversation by the OTHER participant's userId
function findConvByParticipant(userId) {
  const myId = String(transport?._myUserId || '')
  const userIdStr = String(userId)
  for (const [chatIdStr, chat] of chatCache.entries()) {
    const parts = chat.participants ? Object.keys(chat.participants) : []
    if (parts.includes(userIdStr) && (parts.includes(myId) || parts.length === 1)) {
      return chatIdStr
    }
  }
  return null
}

// ─── Contacts page phone search ───────────────────────────────────────────────
// MAX's /contacts page may find users by phone when global search fails.
// Navigates to the contacts section, searches, extracts userId from op:32 WS frame.
async function resolveViaContactsPage(digits) {
  if (!page || !transport || !isReady) return null
  const phone7 = digits.startsWith('7') ? digits : '7' + digits.slice(-10)
  console.log(`[ResolvePhone] Contacts page search: ${phone7}...`)

  const capturedFrames = []
  const rawHandler = (data) => {
    if (data.opcode !== 132 && data.opcode !== 1 && data.opcode !== 5) {
      capturedFrames.push({ opcode: data.opcode, payload: data.payload })
    }
  }
  transport._rawHandlers.push(rawHandler)

  try {
    // Navigate to contacts section
    await page.goto('https://web.max.ru/contacts', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(1500)

    // Find search input on contacts page
    const inputSel = await (async () => {
      for (const sel of ['input[placeholder="Search"]', 'input[placeholder*="Search"]', 'input[placeholder*="Поис"]', 'input[placeholder*="Найти"]', 'input[type="search"]']) {
        if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) return sel
      }
      return null
    })()

    if (!inputSel) {
      const allInputs = await page.evaluate(() =>
        [...document.querySelectorAll('input')]
          .filter(i => i.type !== 'hidden' && i.offsetParent !== null)
          .map(i => ({ ph: i.placeholder, cls: i.className.slice(0, 50) }))
      )
      console.log('[ResolvePhone] Contacts page inputs:', JSON.stringify(allInputs))
    } else {
      await page.locator(inputSel).first().click()
      await page.locator(inputSel).first().fill('')
      await page.keyboard.type(phone7, { delay: 50 })
      await page.waitForTimeout(2500)

      await page.screenshot({ path: '/tmp/max_contacts_search.png', fullPage: false }).catch(() => {})

      // Extract userId from DOM
      const userId = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-id],[data-user-id],a[href*="/u/"]')) {
          const id = el.getAttribute('data-id') || el.getAttribute('data-user-id') ||
                     (el.href || '').match(/\/u\/(\d+)/)?.[1]
          if (id && /^\d{5,12}$/.test(String(id))) return String(id)
        }
        return null
      })
      if (userId) {
        console.log(`[ResolvePhone] Contacts DOM resolved: ${digits} → ${userId}`)
        await page.goto('https://web.max.ru', { timeout: 5000 }).catch(() => {})
        const idx = transport._rawHandlers.indexOf(rawHandler)
        if (idx > -1) transport._rawHandlers.splice(idx, 1)
        return userId
      }

      // Check op:60/68 search frames
      for (const frame of capturedFrames) {
        if (frame.opcode !== 60 && frame.opcode !== 68) continue
        const results = Array.isArray(frame.payload?.result) ? frame.payload.result : []
        for (const r of results) {
          const id = r.id || r.userId || r.user_id
          if (id && /^\d{5,12}$/.test(String(id))) {
            console.log(`[ResolvePhone] Contacts op:${frame.opcode} resolved: ${digits} → ${id}`)
            await page.goto('https://web.max.ru', { timeout: 5000 }).catch(() => {})
            const idx = transport._rawHandlers.indexOf(rawHandler)
            if (idx > -1) transport._rawHandlers.splice(idx, 1)
            return String(id)
          }
        }
      }

      console.log(`[ResolvePhone] Contacts page: no result for ${phone7}. Frames:`,
        capturedFrames.map(f => `op:${f.opcode}`).join(','))
    }
  } catch (e) {
    console.warn('[ResolvePhone] Contacts page search failed:', e.message)
  }

  const idx = transport._rawHandlers.indexOf(rawHandler)
  if (idx > -1) transport._rawHandlers.splice(idx, 1)
  await page.goto('https://web.max.ru', { timeout: 5000 }).catch(() => {})
  return null
}

// ─── Live phone → MAX userId resolution ──────────────────────────────────────
// Used when contactStore doesn't have the contact (e.g. brand-new outbound)
async function resolvePhoneLive(digits, messageToSend = null) {
  // 1. Check chatCache — chats where name/title contains the phone number
  const tail10 = digits.slice(-10)
  for (const [chatIdStr, chatData] of chatCache.entries()) {
    const title = String(chatData.name || chatData.title || chatData.subject || '')
    const titleDigits = title.replace(/\D/g, '')
    if (titleDigits.length >= 10 && titleDigits.slice(-10) === tail10) {
      console.log(`[ResolvePhone] chatCache hit: ${digits} → chatId ${chatIdStr}`)
      savePhoneChatId(digits, chatIdStr)
      return chatIdStr
    }
  }

  // 2. Refresh contactStore if stale (> 5 min since last sync), then retry
  const staleMs = Date.now() - _lastContactSync
  if (staleMs > 5 * 60 * 1000) {
    console.log(`[ResolvePhone] contactStore stale (${Math.round(staleMs / 60000)}min), syncing...`)
    const synced = await syncContacts(8000)
    if (synced) {
      const fromStore = contactStore.findByPhone(digits)
      if (fromStore) {
        console.log(`[ResolvePhone] Found after sync: ${digits} → ${fromStore}`)
        savePhoneChatId(digits, fromStore)
        return fromStore
      }
    }
  }

  // 3. chatCache participant scan — if any DIALOG participant has phone=target in contactStore
  //    return the convId directly (avoids needing userId at all)
  for (const [chatIdStr, chatData] of chatCache.entries()) {
    if (chatData.type !== 'DIALOG') continue
    const parts = chatData.participants ? Object.keys(chatData.participants) : []
    for (const pId of parts) {
      const pPhone = contactStore.getPhone(pId)
      if (!pPhone) continue
      if (pPhone.replace(/\D/g, '').slice(-10) === tail10) {
        console.log(`[ResolvePhone] chatCache participant match: ${digits} → convId ${chatIdStr} (userId ${pId})`)
        savePhoneChatId(digits, chatIdStr)
        return chatIdStr  // return convId — looksLikePhone=false so will be sent directly
      }
    }
  }

  // 4. "Найти по номеру" dialog — MAX Contacts → + → phone lookup
  //    Works even for private profiles since MAX server knows the phone→userId mapping.
  const dialogId = await resolveViaPhoneLookupDialog(digits, messageToSend)
  if (dialogId) {
    const resolvedDialogChatId = typeof dialogId === 'string'
      ? dialogId
      : (dialogId.chatId ? String(dialogId.chatId) : null)
    if (resolvedDialogChatId) savePhoneChatId(digits, resolvedDialogChatId)
    return dialogId
  }

  return null
}

// ─── Отправка медиа ───────────────────────────────────────────────────────────

/**
 * Upload image via FormData (opcode 80 → iu.oneme.ru/uploadImage).
 * Returns the upload response JSON: {photos: {"<photoId>": {token: "..."}}}
 */
async function uploadImageToMax(transport, fileBuffer, filename, mimeType) {
  const uploadResp = await transport.sendFrame(OP.GET_UPLOAD_IMAGE_URL, { count: 1 }, { waitResponse: true })
  if (!uploadResp?.url) throw new Error('Не получен URL для загрузки изображения')
  const uploadName = safeUploadFilename(filename, 'image.jpg')

  return new Promise((resolve, reject) => {
    const boundary = '----MaxBoundary' + Date.now()
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${uploadName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'ascii'
    )
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([header, fileBuffer, footer])
    const urlObj = new URL(uploadResp.url)
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        console.log(`[uploadImage] status=${res.statusCode} response=${data.slice(0, 200)}`)
        if (res.statusCode >= 400) return reject(new Error(`Upload HTTP ${res.statusCode}: ${data}`))
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Upload file/video/audio as raw binary stream.
 * Used by opcode 82 (video) and opcode 87 (file/audio).
 * The upload response is intentionally ignored — token comes from the WS opcode response.
 */
async function uploadRawBinary(url, fileBuffer, filename, mimeType) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const uploadName = safeUploadFilename(filename)
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':        mimeType,
        'Content-Disposition': `attachment; filename="${uploadName}"`,
        'Content-Range':       `0-${fileBuffer.length - 1}/${fileBuffer.length}`,
        'Content-Length':      fileBuffer.length,
      },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        console.log(`[uploadBinary] status=${res.statusCode} response=${data.slice(0, 200)}`)
        if (res.statusCode >= 400) return reject(new Error(`Upload HTTP ${res.statusCode}: ${data}`))
        resolve()
      })
    })
    req.on('error', reject)
    req.write(fileBuffer)
    req.end()
  })
}

/**
 * Send a photo message: opcode 80 → FormData upload → opcode 64.
 */
async function sendImage(transport, page, chatId, fileBuffer, filename, mimeType, caption) {
  maxDeliveryLog({
    operation: 'upload',
    status: 'upload_started',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
  })
  const uploadData = await uploadImageToMax(transport, fileBuffer, filename, mimeType)
  const photoToken = uploadData?.photoToken
    || uploadData?.token
    || (uploadData?.photos && Object.values(uploadData.photos)[0]?.token)
  if (!photoToken) throw new Error(`photoToken не найден в ответе: ${JSON.stringify(uploadData)}`)
  maxDeliveryLog({
    operation: 'upload',
    status: 'uploaded',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    uploadResponse: { hasPhotoToken: Boolean(photoToken), keys: Object.keys(uploadData || {}) },
  })

  const cid = -Date.now()
  maxDeliveryLog({
    operation: 'send',
    status: 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
  })
  const resp = await transport.sendFrame(OP.SEND_MESSAGE, {
    chatId,
    message: { cid, text: caption || '', attaches: [{ _type: 'PHOTO', photoToken }] },
    notify: true,
  }, { waitResponse: true })
  const maxMessageId = resp?.message?.id ? String(resp.message.id) : null
  maxDeliveryLog({
    operation: 'echo',
    status: isRealMaxMessageId(maxMessageId) ? 'max_echo_received' : 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxMessageId,
    externalId: maxMessageId,
  })
  return maxMessageId
}

/**
 * Send SEND_MESSAGE with attachment, retrying if server says "attachment.not.ready".
 * MAX processes uploads asynchronously — the file may not be ready immediately after upload.
 */
async function sendMessageWithRetry(transport, chatId, messagePayload, maxRetries = 6, initialDelay = 2000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = initialDelay + (attempt - 1) * 1500  // 2s, 3.5s, 5s, 6.5s, 8s, 9.5s
      console.log(`[sendMsgRetry] attempt ${attempt}/${maxRetries}, wait ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
    } else {
      // Always wait a bit after upload before first attempt — MAX needs time to process
      await new Promise(r => setTimeout(r, initialDelay))
    }
    try {
      const cid = -Date.now()
      const resp = await transport.sendFrame(OP.SEND_MESSAGE, {
        chatId,
        message: { ...messagePayload, cid },
        notify: true,
      }, { waitResponse: true })
      return resp?.message?.id ? String(resp.message.id) : null
    } catch (e) {
      if (e.maxError === 'attachment.not.ready' && attempt < maxRetries) {
        console.log(`[sendMsgRetry] attachment.not.ready — will retry`)
        continue
      }
      throw e
    }
  }
}

/**
 * Send video: opcode 82 → raw binary upload → opcode 64 (with retry).
 * Response from opcode 82: {info: [{videoId, url, token}]}
 */
async function sendVideo(transport, chatId, fileBuffer, filename, mimeType, caption) {
  maxDeliveryLog({
    operation: 'upload',
    status: 'upload_started',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
  })
  const urlResp = await transport.sendFrame(OP.GET_UPLOAD_VIDEO_URL, { count: 1 }, { waitResponse: true })
  const info = urlResp?.info?.[0]
  if (!info?.url || info?.videoId == null) {
    throw new Error(`Не получен URL для загрузки видео. Ответ: ${JSON.stringify(urlResp)}`)
  }
  console.log(`[sendVideo] videoId=${info.videoId} url=${info.url.slice(0, 80)}`)
  await uploadRawBinary(info.url, fileBuffer, filename, mimeType)
  maxDeliveryLog({
    operation: 'upload',
    status: 'uploaded',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxVideoId: info.videoId,
  })
  maxDeliveryLog({
    operation: 'send',
    status: 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxVideoId: info.videoId,
  })

  const maxMessageId = await sendMessageWithRetry(transport, chatId, {
    text:    caption || '',
    attaches: [{ _type: 'VIDEO', videoId: info.videoId, token: info.token || undefined, duration: null }],
  })
  maxDeliveryLog({
    operation: 'echo',
    status: isRealMaxMessageId(maxMessageId) ? 'max_echo_received' : 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxMessageId,
    externalId: maxMessageId,
  })
  return maxMessageId
}

/**
 * Send file/audio/PDF/OGG: opcode 87 → raw binary upload → opcode 64 (with retry).
 * Response from opcode 87: {info: [{fileId, url}]}  (no token — fileId is enough)
 */
async function sendFile(transport, chatId, fileBuffer, filename, mimeType, caption) {
  maxDeliveryLog({
    operation: 'upload',
    status: 'upload_started',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
  })
  const urlResp = await transport.sendFrame(OP.GET_UPLOAD_FILE_URL, { count: 1 }, { waitResponse: true })
  const info = urlResp?.info?.[0]
  if (!info?.url || info?.fileId == null) {
    throw new Error(`Не получен URL для загрузки файла. Ответ: ${JSON.stringify(urlResp)}`)
  }
  console.log(`[sendFile] fileId=${info.fileId} url=${info.url.slice(0, 80)}`)
  await uploadRawBinary(info.url, fileBuffer, filename, mimeType)
  maxDeliveryLog({
    operation: 'upload',
    status: 'uploaded',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxFileId: info.fileId,
  })
  maxDeliveryLog({
    operation: 'send',
    status: 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxFileId: info.fileId,
  })

  const maxMessageId = await sendMessageWithRetry(transport, chatId, {
    text:    caption || '',
    attaches: [{ _type: 'FILE', fileId: info.fileId, name: filename, size: fileBuffer.length }],
  })
  maxDeliveryLog({
    operation: 'echo',
    status: isRealMaxMessageId(maxMessageId) ? 'max_echo_received' : 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    uploadId: filename,
    maxMessageId,
    externalId: maxMessageId,
  })
  return maxMessageId
}

// ─── Реакции: opcode 178 (поставить) / 179 (снять) ───────────────────────────

async function sendReaction(transport, chatId, messageId, emoji) {
  const reactionId = reactionIdByEmoji.get(String(emoji)) || emoji
  try {
    const confirmationPromise = waitForReactionConfirmation(transport, {
      chatId,
      messageId,
      emoji,
      timeoutMs: 15_000,
    })
    await transport.sendBinaryReaction(chatId, messageId, reactionId, false, true)
    console.log(`[sendReaction] binary sent chatId=${chatId} msgId=${String(messageId).slice(0, 16)} reaction=${reactionId}`)
    maxDeliveryLog({
      operation: 'reaction',
      status: 'send_requested',
      conversationId: String(chatId),
      protocolChatId: String(chatId),
      maxMessageId: String(messageId),
      externalId: String(messageId),
    })
    const confirmation = await confirmationPromise
    if (confirmation?.reactionConfirmed) {
      console.log(`[sendReaction] confirmed via ${confirmation.source} chatId=${chatId} msgId=${String(messageId).slice(0, 16)}`)
      maxDeliveryLog({
        operation: 'reaction',
        status: 'max_echo_received',
        conversationId: String(chatId),
        protocolChatId: String(chatId),
        maxMessageId: String(messageId),
        externalId: String(messageId),
        source: confirmation.source,
        counters: confirmation.counters,
      })
      return { frameSent: true, reactionConfirmed: true, deliveryStatus: 'delivered', source: confirmation.source, counters: confirmation.counters }
    }
    console.warn(`[sendReaction] unsigned binary not confirmed, trying signed message id chatId=${chatId} msgId=${String(messageId).slice(0, 16)}`)
    const signedConfirmationPromise = waitForReactionConfirmation(transport, {
      chatId,
      messageId,
      emoji,
      timeoutMs: 15_000,
    })
    await transport.sendBinaryReaction(chatId, messageId, reactionId, false, false)
    maxDeliveryLog({
      operation: 'reaction',
      status: 'send_requested',
      conversationId: String(chatId),
      protocolChatId: String(chatId),
      maxMessageId: String(messageId),
      externalId: String(messageId),
      source: 'binary_frame_signed',
    })
    const signedConfirmation = await signedConfirmationPromise
    if (signedConfirmation?.reactionConfirmed) {
      console.log(`[sendReaction] confirmed via ${signedConfirmation.source} chatId=${chatId} msgId=${String(messageId).slice(0, 16)} signed=true`)
      maxDeliveryLog({
        operation: 'reaction',
        status: 'max_echo_received',
        conversationId: String(chatId),
        protocolChatId: String(chatId),
        maxMessageId: String(messageId),
        externalId: String(messageId),
        source: signedConfirmation.source,
        counters: signedConfirmation.counters,
      })
      return { frameSent: true, reactionConfirmed: true, deliveryStatus: 'delivered', source: signedConfirmation.source, counters: signedConfirmation.counters }
    }
    const noConfirmation = new Error('Binary reaction frame was not confirmed by MAX')
    noConfirmation.noConfirmation = true
    throw noConfirmation
  } catch (binaryErr) {
    console.warn(`[sendReaction] ${binaryErr.noConfirmation ? 'binary not confirmed' : 'binary failed'}, trying JSON fallback: ${binaryErr.message}`)
  }
  const basePayload = {
    chatId,
    messageId: String(messageId),
    reaction: { reactionType: 'EMOJI', id: reactionId },
  }
  const payloads = [basePayload, { ...basePayload, postId: null }]
  let lastErr = null
  let resp = null
  for (const payload of payloads) {
    try {
      const confirmationPromise = waitForReactionConfirmation(transport, {
        chatId,
        messageId,
        emoji,
        timeoutMs: 15_000,
      })
      resp = await transport.sendFrame(OP.SEND_REACTION, payload, { waitResponse: true, timeoutMs: 15_000 })
      const confirmation = await confirmationPromise
      if (confirmation?.reactionConfirmed) {
        console.log(`[sendReaction] confirmed via ${confirmation.source} chatId=${chatId} msgId=${String(messageId).slice(0, 16)}`)
        maxDeliveryLog({
          operation: 'reaction',
          status: 'max_echo_received',
          conversationId: String(chatId),
          protocolChatId: String(chatId),
          maxMessageId: String(messageId),
          externalId: String(messageId),
          source: confirmation.source,
          counters: confirmation.counters,
        })
        return { frameSent: true, reactionConfirmed: true, responseReceived: Boolean(resp), deliveryStatus: 'delivered', source: confirmation.source, counters: confirmation.counters }
      }
      break
    } catch (e) {
      lastErr = e
      console.warn(`[sendReaction] variant failed chatId=${chatId} msgId=${String(messageId).slice(0, 16)}: ${e.message}`)
    }
  }
  if (!resp && lastErr) throw lastErr
  console.log(`[sendReaction] frame response chatId=${chatId} msgId=${String(messageId).slice(0, 16)} reaction=${reactionId} resp=${JSON.stringify(resp).slice(0, 160)}`)
  maxDeliveryLog({
    operation: 'reaction',
    status: 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    maxMessageId: String(messageId),
    externalId: String(messageId),
  })
  return { frameSent: true, reactionConfirmed: false, responseReceived: Boolean(resp), deliveryStatus: 'send_requested', source: 'json_response' }
}

async function removeReaction(transport, chatId, messageId) {
  try {
    const confirmationPromise = waitForReactionConfirmation(transport, {
      chatId,
      messageId,
      remove: true,
      timeoutMs: 15_000,
    })
    await transport.sendBinaryReaction(chatId, messageId, null, true, true)
    console.log(`[removeReaction] binary sent chatId=${chatId} msgId=${String(messageId).slice(0, 16)}`)
    maxDeliveryLog({
      operation: 'reaction',
      status: 'send_requested',
      conversationId: String(chatId),
      protocolChatId: String(chatId),
      maxMessageId: String(messageId),
      externalId: String(messageId),
    })
    const confirmation = await confirmationPromise
    if (confirmation?.reactionConfirmed) {
      console.log(`[removeReaction] confirmed via ${confirmation.source} chatId=${chatId} msgId=${String(messageId).slice(0, 16)}`)
      maxDeliveryLog({
        operation: 'reaction',
        status: 'max_echo_received',
        conversationId: String(chatId),
        protocolChatId: String(chatId),
        maxMessageId: String(messageId),
        externalId: String(messageId),
        source: confirmation.source,
        counters: confirmation.counters,
      })
      return { frameSent: true, reactionConfirmed: true, deliveryStatus: 'delivered', source: confirmation.source, counters: confirmation.counters }
    }
    const noConfirmation = new Error('Binary remove-reaction frame was not confirmed by MAX')
    noConfirmation.noConfirmation = true
    throw noConfirmation
  } catch (binaryErr) {
    console.warn(`[removeReaction] ${binaryErr.noConfirmation ? 'binary not confirmed' : 'binary failed'}, trying JSON fallback: ${binaryErr.message}`)
  }
  const basePayload = {
    chatId,
    messageId: String(messageId),
  }
  const payloads = [basePayload, { ...basePayload, postId: null }]
  let lastErr = null
  let resp = null
  for (const payload of payloads) {
    try {
      resp = await transport.sendFrame(OP.REMOVE_REACTION, payload, { waitResponse: true, timeoutMs: 15_000 })
      break
    } catch (e) {
      lastErr = e
      console.warn(`[removeReaction] variant failed chatId=${chatId} msgId=${String(messageId).slice(0, 16)}: ${e.message}`)
    }
  }
  if (!resp && lastErr) throw lastErr
  console.log(`[removeReaction] frame response chatId=${chatId} msgId=${String(messageId).slice(0, 16)} resp=${JSON.stringify(resp).slice(0, 160)}`)
  maxDeliveryLog({
    operation: 'reaction',
    status: 'send_requested',
    conversationId: String(chatId),
    protocolChatId: String(chatId),
    maxMessageId: String(messageId),
    externalId: String(messageId),
  })
  return { frameSent: true, reactionConfirmed: false, responseReceived: Boolean(resp), deliveryStatus: 'send_requested', source: 'json_response' }
}

// ─── Резолв видео/файла: opcode 83 / 88 ──────────────────────────────────────
// VIDEO и FILE-вложения приходят без прямой ссылки — только videoId/fileId +
// opaque token. Реальный URL нужно запросить отдельным фреймом. Формат ответа
// сервера не зафиксирован живым тестом — берём первую http(s)-строку из
// ответа рекурсивным поиском и логируем сырой payload для проверки.

function findFirstUrl(obj, depth = 0) {
  if (depth > 5 || obj == null) return null
  if (typeof obj === 'string' && /^https?:\/\//.test(obj)) return obj
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findFirstUrl(v, depth + 1); if (r) return r }
    return null
  }
  if (typeof obj === 'object') {
    for (const k in obj) { const r = findFirstUrl(obj[k], depth + 1); if (r) return r }
  }
  return null
}

// Opcode 83 (RESOLVE_VIDEO) returns {EXTERNAL, MP4_480, MP4_720, ...}.
// findFirstUrl picks EXTERNAL (alphabetically first), which is an ok.ru
// page — not a streamable video. Prefer direct MP4 CDN URLs instead.
function findBestVideoUrl(obj) {
  if (!obj || typeof obj !== 'object') return findFirstUrl(obj)
  for (const key of ['MP4_720', 'MP4_480', 'MP4_360', 'MP4_240', 'HLS', 'url']) {
    if (obj[key] && /^https?:\/\//.test(obj[key])) return obj[key]
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'EXTERNAL') continue
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  return obj.EXTERNAL || null
}

async function resolveAttachmentUrl(transport, att, chatId, messageId) {
  const type = (att.type || '').toLowerCase()
  let opcode, payload
  if ((type === 'photo' || type === 'image') && att.photoId) {
    const directUrl = findFirstUrl(att)
    if (directUrl) return directUrl
    appendDebugJson('max_photo_resolve_no_route.jsonl', {
      chatId,
      messageId,
      type,
      hasPhotoId: Boolean(att.photoId),
      hasPreviewData: Boolean(att.previewData),
    })
    console.warn(`[ResolveAttachment] photo has photoId but no baseUrl/url route available chatId=${chatId} msgId=${messageId || 'n/a'}`)
    return null
  }
  if (type === 'video' && att.videoId) {
    opcode = OP.RESOLVE_VIDEO
    payload = { videoId: att.videoId, ...(att.token ? { token: att.token } : {}), chatId, messageId: String(messageId) }
  } else if ((type === 'file' || type === 'document' || type === 'audio' || type === 'voice') && (att.fileId || att.token)) {
    opcode = OP.RESOLVE_FILE
    payload = { fileId: att.fileId || att.token, ...(att.token ? { token: att.token } : {}), chatId, messageId: String(messageId) }
  } else {
    return null
  }
  const resp = await transport.sendFrame(opcode, payload, { waitResponse: true })
  console.log(`[ResolveAttachment] opcode=${opcode} payload=${JSON.stringify(redactForStructuredLog(payload))} response=${JSON.stringify(redactForStructuredLog(resp)).slice(0, 800)}`)
  return opcode === OP.RESOLVE_VIDEO ? findBestVideoUrl(resp) : findFirstUrl(resp)
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false

async function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[App] Получен ${signal} — graceful shutdown...`)

  // Ждём завершения текущей очереди отправки (max 10s)
  const deadline = Date.now() + 10_000
  while (isSending && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (isSending) console.warn('[App] Очередь отправки не завершена — принудительный выход')

  // Close Playwright context so Chromium child processes don't linger
  // and hold user_data file locks after we exit. Cap at 5s.
  if (context) {
    try {
      await Promise.race([
        context.close(),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ])
      console.log('[App] Playwright context closed')
    } catch (err) {
      console.warn('[App] context.close() failed:', err.message)
    }
  }

  console.log('[App] Завершение процесса')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// Last-resort handler: if something unhandled blows up inside the
// event loop (browser crash, WS hook throw), at least give Chromium
// a chance to close before we die — otherwise zombie Chrome keeps
// holding user_data locks and the next restart is broken.
process.on('uncaughtException', async (err) => {
  console.error('[App] UNCAUGHT:', err && err.stack ? err.stack : err)
  if (context) {
    try {
      await Promise.race([
        context.close(),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ])
    } catch { /* best effort */ }
  }
  process.exit(1)
})

// Unhandled rejections are usually benign (late fetch, disconnected
// WS event). Log but don't exit — killing the whole scraper over a
// stale promise would cause more harm than the rejection itself.
process.on('unhandledRejection', (reason) => {
  console.warn('[App] UNHANDLED REJECTION:', reason && reason.stack ? reason.stack : reason)
})

// ─── Инициализация ───────────────────────────────────────────────────────────

const session      = new SessionController()
const transport    = new TransportInterceptor()
const sync         = new MessageSync()
const contactStore = new ContactStore()

const chatCache = new Map()  // chatId → chat object (собирается из opcode 48 при старте)

// messageIds исходящих сообщений, чьё echo мы перехватываем в /send-message.
// handleIncoming пропустит эти echo чтобы не создать дубль-чат до того как
// CRM обновит externalChatId на реальный conversation ID.
const capturedEchoIds = new Set()

let page               = null
let context            = null   // Playwright persistent context — keep at module scope so shutdown/uncaught handlers can close it cleanly
let mediaPipeline      = null
let _fetchIncomingTimer = null  // debounce timer for op:128 → GET_HISTORY
let initialSync   = null
let nameSync      = null  // PR-П: NameSync — раз в час подтягивает имена placeholder-чатов из MAX UI
let isReady       = false
let readySinceAt  = 0

function markReady(reason) {
  if (isReady) return
  isReady = true
  readySinceAt = Date.now()
  session.isLoggedIn = true
  console.log(`[App] Ready via ${reason}`)
}

// Exponential backoff для WS reconnect
let _reconnectCount    = 0
let _lastReconnectAt   = 0
let _reconnectDelay    = 0

async function init() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })

  // Startup cleanup: zombie Chrome + stale profile locks from a previous
  // unclean exit. Without this, launchPersistentContext below hits
  // "The browser is already running for <userDataDir>".
  try {
    await cleanupStaleMaxSession()
  } catch (err) {
    console.warn('[App] cleanupStaleMaxSession failed:', err.message)
  }

  // Clear Cookies on every startup — stale Cookies cause auth-loop
  // (MAX sees known browser but expired session → no QR, no auth frames).
  // LocalStorage token (in leveldb) is unaffected and provides the real auth.
  const cookiesPath = path.join(USER_DATA_DIR, 'Default', 'Cookies')
  const cookiesJournalPath = path.join(USER_DATA_DIR, 'Default', 'Cookies-journal')
  try {
    if (fs.existsSync(cookiesPath)) { fs.unlinkSync(cookiesPath); console.log('[App] Cleared stale Cookies') }
    if (fs.existsSync(cookiesJournalPath)) { fs.unlinkSync(cookiesJournalPath); console.log('[App] Cleared stale Cookies-journal') }
  } catch (e) {
    console.warn('[App] Cookie cleanup failed:', e.message)
  }

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  })

  page = context.pages()[0] || await context.newPage()

  // 1. Инжектируем WS-хук ДО навигации
  await transport.injectHooks(page)

  // 2. Подключаем CDP ДО навигации — чтобы webSocketFrameReceived поймал первый WS
  await transport.attachCdp(page, context)

  // 3. Навигируем
  console.log('[App] Открываем web.max.ru...')
  await page.goto(MAX_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  // 4. Создаём зависимые объекты
  mediaPipeline = new MediaPipeline(page)
  initialSync   = new InitialHistorySync(transport, sync, forwardToWebhook, mediaPipeline, chatCache, contactStore)

  // Перехватываем raw-фреймы (каждый блок изолирован — ошибка в одном не ломает другие)
  transport.onRawFrame(async data => {
    if (!isReady && [OP.CONTACTS, OP.GET_CHATS, 53, 35].includes(data.opcode)) {
      markReady(`live-op:${data.opcode}`)
    }

    // opcode 32 — контакты
    if (data.opcode === OP.CONTACTS && data.payload?.contacts) {
      try { contactStore.ingest(data.payload) }
      catch (e) { console.error('[App] onRawFrame CONTACTS error:', e.message) }
    }
    // opcode 48 — список чатов (браузер получает автоматически при старте)
    if (data.opcode === OP.GET_CHATS && data.payload?.chats) {
      try {
        let added = 0
        for (const chat of data.payload.chats) {
          if (chat == null || typeof chat !== 'object') continue
          const id = chat.id ?? chat.chatId
          if (id && id !== 0) { chatCache.set(String(id), chat); added++ }
        }
        if (added > 0) console.log(`[ChatCache] +${added} чатов, всего: ${chatCache.size}`)
      } catch (e) { console.error('[App] onRawFrame GET_CHATS error:', e.message) }
    }
    if (data.opcode === 71) {
      try {
        const decodedChatId = data.payload?.chatId != null ? String(data.payload.chatId) : null
        const messages = Array.isArray(data.payload?.messages) ? data.payload.messages : []
        const recoveryTarget = messages.length === 0 ? resolveEmptyOp71DomRecoveryChatId(decodedChatId) : null
        if (recoveryTarget) {
          const chatIdStr = String(recoveryTarget.chatId)
          const now = Date.now()
          if (now - domFallbackScheduledAt < 1800) {
            console.warn(`[domFallback] empty op71 after op128 for chatId=${chatIdStr}; decodedChatId=${decodedChatId || 'none'} reason=${recoveryTarget.reason}; guarded text recovery throttled`)
            return
          }
          domFallbackScheduledAt = now
          console.warn(`[domFallback] empty op71 after op128 for chatId=${chatIdStr}; decodedChatId=${decodedChatId || 'none'} reason=${recoveryTarget.reason}; scheduling guarded text DOM recovery`)
          setTimeout(() => {
            if (uiSendInProgress) return
            forwardRecentDomMessages(chatIdStr, 'empty_op71_after_op128')
              .then(result => console.log(`[domFallback] guarded result ${JSON.stringify(result).slice(0, 400)}`))
              .catch(e => console.error('[domFallback] failed:', e.message))
          }, 1200)
        }
      } catch (e) { console.error('[App] onRawFrame op71 DOM fallback error:', e.message) }
    }
    // opcode 53 — server push chat update; добавляем chatId в chatCache для op:128 GET_HISTORY
    if (data.opcode === 53) {
      try {
        const chats = data.payload?.chats ?? (Array.isArray(data.payload) ? data.payload : null)
        if (Array.isArray(chats)) {
          let added = 0
          for (const chat of chats) {
            if (chat == null || typeof chat !== 'object') continue
            const id = chat.id ?? chat.chatId
            if (id && id !== 0 && !chatCache.has(String(id))) { chatCache.set(String(id), chat); added++ }
          }
          if (added > 0) console.log(`[ChatCache] op:53 +${added} чатов, всего: ${chatCache.size}`)
        }
      } catch (e) { console.error('[App] onRawFrame op53 chatCache error:', e.message) }
    }
    // opcode 28 — animoji/реакции маппинг: id → emoji символ
    if (data.opcode === 28 && data.payload?.animojis) {
      try {
        for (const a of data.payload.animojis) {
          if (a == null || typeof a !== 'object') continue
          if (a.id && a.emoji) reactionEmojiById.set(Number(a.id), a.emoji)
        }
        console.log(`[App] reactionEmojiById: ${reactionEmojiById.size} записей`)
      } catch (e) { console.error('[App] opcode28 animoji error:', e.message) }
    }
    // opcode 288 — QR link от MAX сервера
    if (data.opcode === 288 && data.payload?.qrLink) {
      try {
        const qrLink    = data.payload.qrLink
        const sinceStart = Date.now() - SESSION_START_MS
        // Первые 20 сек MAX нормально присылает QR как probe (до подтверждения сессии).
        // Подавляем только в этот короткий window. Если к 20с auth не прошёл — сессия
        // истекла и QR нужно показать пользователю для повторного входа.
        if (sinceStart < 20_000 && !isReady) {
          console.log(`[QR] op:288 подавлён (${Math.round(sinceStart / 1000)}s с запуска, сессия ещё не готова)`)
        } else {
          const qrPath = path.join(__dirname, 'last_qr.png')
          await QRCode.toFile(qrPath, qrLink, {
            width:  400,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' },
          })
          qrUpdatedAt = Date.now()
          console.log('[QR] Сгенерирован из qrLink:', qrLink)
        }
      } catch (e) { console.error('[QR] Ошибка генерации:', e.message) }
    }
    // Opcode 155 — сервер пушит полный snapshot реакций на конкретное сообщение
    // Это основной механизм: counters = [{count, reaction}]
    if (data.opcode === 155 && data.payload?.messageId) {
      const p            = data.payload
      const externalMsgId = String(p.messageId)
      // Нормализуем reaction в каждом counter: может быть integer ID → emoji символ
      const rawCounters   = p.counters || []
      const counters      = rawCounters.map(c => ({ ...c, reaction: normalizeReactionEmoji(c.reaction) }))
      const reactionUrl   = CRM_WEBHOOK_URL.replace(/\/api\/webhooks?\/max\/?.*$/, '/api/webhook/max/reaction')
      console.log(`[App] opcode155 reaction snapshot: msgId=${externalMsgId} counters=${JSON.stringify(counters)}`)
      maxDeliveryLog({
        operation: 'reaction',
        status: 'max_echo_received',
        maxMessageId: externalMsgId,
        externalId: externalMsgId,
        protocolChatId: p.chatId ? String(p.chatId) : undefined,
        counters,
        opcode: 155,
      })
      fetch(reactionUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ externalMsgId, counters }),
      }).catch(e => console.error('[App] opcode155 reaction sync error:', e.message))
    }
    // Opcode 135 — chat update push; содержит lastReaction + lastReactedMessageId
    // В реальности opcode 155 не приходит при реакции другого пользователя — только 135.
    // Пропускаем если реакция пришла в ответ на нашу собственную отправку (seq >= 500).
    if (data.opcode === 180 && data.payload?.messagesReactions) {
      try {
        const byMessage = extractReactionCountersFromMap(data.payload.messagesReactions)
        if (byMessage.size > 0) {
          const reactionUrl = CRM_WEBHOOK_URL.replace(/\/api\/webhooks?\/max\/?.*$/, '/api/webhook/max/reaction')
          for (const [externalMsgId, counters] of byMessage.entries()) {
            console.log(`[App] opcode180 reaction snapshot: msgId=${externalMsgId} counters=${JSON.stringify(counters)}`)
            maxDeliveryLog({
              operation: 'reaction',
              status: 'max_echo_received',
              maxMessageId: externalMsgId,
              externalId: externalMsgId,
              counters,
              opcode: 180,
            })
            fetch(reactionUrl, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ externalMsgId, counters }),
            }).catch(e => console.error('[App] opcode180 reaction sync error:', e.message))
          }
        } else {
          appendDebugJson('max_reactions_unparsed.jsonl', data.payload)
        }
      } catch (e) {
        console.error('[App] opcode180 reaction parse error:', e.message)
      }
    }
    if (data.opcode === 135 && data.payload?.chat?.lastReactedMessageId && data.payload?.chat?.lastReaction) {
      const externalMsgId = String(data.payload.chat.lastReactedMessageId)
      const emoji          = normalizeReactionEmoji(data.payload.chat.lastReaction)
      if (!recentOwnReactionIds.has(externalMsgId)) {
        const reactionUrl = CRM_WEBHOOK_URL.replace(/\/api\/webhooks?\/max\/?.*$/, '/api/webhook/max/reaction')
        console.log(`[App] opcode135 reaction: msgId=${externalMsgId} raw=${JSON.stringify(data.payload.chat.lastReaction)} emoji=${emoji}`)
        maxDeliveryLog({
          operation: 'reaction',
          status: 'max_echo_received',
          maxMessageId: externalMsgId,
          externalId: externalMsgId,
          protocolChatId: data.payload.chat.id ? String(data.payload.chat.id) : undefined,
          reaction: emoji,
          opcode: 135,
        })
        fetch(reactionUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ externalMsgId, emoji, isRemove: false }),
        }).catch(e => console.error('[App] opcode135 reaction sync error:', e.message))
      } else {
        console.log(`[App] opcode135 skip own-reaction echo: msgId=${externalMsgId}`)
      }
    }
    // op:128 — входящее сообщение.
    // Если payload содержит данные — TransportInterceptor уже обработал через transport.onMessage.
    // ВАЖНО: отправлять op:71 через JSON нельзя — MAX закрывает WS (то же поведение что op:49).
    // op:71 обрабатывается пассивно когда браузер сам открывает чат и запрашивает историю.
    if ([53, 135, 155, 180].includes(data.opcode) && data.payload) {
      try {
        const events = extractReactionEventsDeep(data.payload)
        if (events.length > 0) {
          const reactionUrl = CRM_WEBHOOK_URL.replace(/\/api\/webhooks?\/max\/?.*$/, '/api/webhook/max/reaction')
          const sentKeys = new Set()
          for (const event of events) {
            const externalMsgId = String(event.externalMsgId || '')
            if (!externalMsgId || recentOwnReactionIds.has(externalMsgId)) continue
            const key = `${externalMsgId}:${event.emoji || ''}:${JSON.stringify(event.counters || null)}:${!!event.isRemove}`
            if (sentKeys.has(key)) continue
            sentKeys.add(key)
            console.log(`[App] opcode${data.opcode} reaction deep: msgId=${externalMsgId} event=${JSON.stringify(event).slice(0, 200)}`)
            fetch(reactionUrl, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(event),
            }).catch(e => console.error(`[App] opcode${data.opcode} reaction deep sync error:`, e.message))
          }
        } else if (data.opcode === 135 || data.opcode === 180) {
          appendDebugJson('max_reactions_unparsed.jsonl', data.payload)
        }
      } catch (e) {
        console.error(`[App] opcode${data.opcode} reaction deep parse error:`, e.message)
      }
    }
    if (data.opcode === OP.INCOMING_MSG) {
      if (!isReady) return
      const payloadIsEmpty = !data.payload || (Array.isArray(data.payload) && data.payload.length === 0)
      if (!payloadIsEmpty && looksLikeDomRecoverableMediaPayload(data.payload)) {
        scheduleDomFallbackForRecentMedia('loose_op128_media')
      }
      if (payloadIsEmpty) {
        console.log('[op128] Пустой payload — пропускаем (op:71 через JSON убивает WS, используем только пассивный перехват)')
      }
      setTimeout(() => {
        const chatId = latestRecentOp128ChatId()
        if (!chatId) return
        const anchorHex = transport?._op71AnchorForLiveNotification?.(String(chatId)) || null
        const hasPendingLive = (transport?._pendingLiveMessageIds?.get(String(chatId)) || []).length > 0
        if (!anchorHex && !hasPendingLive) {
          scheduleAutomaticDomMirrorRecovery(String(chatId), 'missing_protocol_anchor')
        }
      }, 700)
    }

    // Логируем остальные неизвестные push-опкоды
    const KNOWN_OPCODES = new Set([6, 19, 32, 48, 49, 53, 64, 65, 75, 80, 82, 83, 87, 88, 128, 130, 132, 135, 155, 178, 179, 180, 288])
    if (!KNOWN_OPCODES.has(data.opcode) && data.cmd === 0) {
      const ps = JSON.stringify(data.payload || {}).slice(0, 400)
      console.log(`[App] NEW opcode=${data.opcode} cmd=${data.cmd}: ${ps}`)
    }
  })

  transport.onMessage(msg => {
    handleIncoming(msg, mediaPipeline, sync, transport).catch(e =>
      console.error('[App] handleIncoming error:', e.message)
    )
  })

  // Синхронизация реакций, поставленных пользователем через MAX веб-интерфейс (фоллбэк)
  // Опкод 135 (сервер push) надёжнее, но на случай если он не пришёл — перехватываем
  // исходящий WS фрейм. Пропускаем наши собственные фреймы (seq >= 500).
  transport.onSentReaction(async data => {
    if (data.seq >= 500) return  // наш собственный фрейм — CRM уже сохранил
    const p        = data.payload || {}
    const chatId   = p.chatId
    const msgId    = p.messageId
    // MAX веб шлёт reaction как объект {reactionType,id} где id может быть integer или emoji-символ
    const reaction = p.reaction
    const emoji    = normalizeReactionEmoji(reaction)
    const isRemove = data.opcode === OP.REMOVE_REACTION || !emoji
    if (!msgId) return
    const reactionUrl = CRM_WEBHOOK_URL.replace(/\/api\/webhooks?\/max\/?.*$/, '/api/webhook/max/reaction')
    try {
      const res = await fetch(reactionUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ externalMsgId: String(msgId), emoji, isRemove }),
      })
      if (!res.ok) console.warn(`[App] sentReaction sync HTTP ${res.status}`)
      else console.log(`[App] sentReaction sync: msgId=${msgId} emoji=${emoji} remove=${isRemove}`)
    } catch (e) {
      console.error('[App] sentReaction sync error:', e.message)
    }
  })

  // 5. Авторизация
  session.attach(page, context, transport)

  // Auto-recovery: когда WS-сессия протухла (sendText таймауты накапливаются).
  // Не реагируем на разовые has_profile=false (это нормальный WS keepalive).
  // Перезагружаем страницу только при УСТОЙЧИВОМ сбое: ≥3 consecutive fails + >90s с момента старта.
  let _authFailReloadAt = 0
  let _authFailStreak   = 0
  let _wsReadyAt        = 0  // когда впервые получили WS auth OK
  transport._rawHandlers.push((data) => {
    if (data.opcode !== 19) return
    const hasProfile = !!(data.payload?.profile?.contact?.id)
    if (hasProfile) { _authFailStreak = 0; return }  // успешный auth сбрасывает счётчик
    if (transport?._wsConnected) return
    if (!isReady || _dialogBusy) return
    const now = Date.now()
    if (_wsReadyAt === 0 || now - _wsReadyAt < 90_000) return  // grace period 90s
    _authFailStreak++
    if (_authFailStreak < 3) return  // ждём 3 consecutive fails
    if (now - _authFailReloadAt < 120_000) return  // не чаще раза в 2 мин
    _authFailReloadAt = now
    console.warn(`[App] WS auth lost (${_authFailStreak} consecutive has_profile=false) — reloading page...`)
    _authFailStreak = 0
    isReady = false
    setTimeout(async () => {
      try {
        await page.goto(MAX_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        console.log('[App] Page reloaded after auth loss — waiting for re-auth...')
      } catch (e) {
        console.error('[App] Auth-loss reload failed:', e.message)
        isReady = true  // вернуть чтобы не завис навсегда
      }
    }, 2000)
  })

  // WS-авторизация (opcode 19) — первичный и надёжный триггер
  transport.onWsAuth(async (userId) => {
    if (isReady) {
      // Exponential backoff: если reconnect'ы идут слишком часто — притормаживаем
      const now = Date.now()
      if (now - _lastReconnectAt < 60_000) {
        _reconnectDelay = Math.min(_reconnectDelay ? _reconnectDelay * 2 : 1000, 30_000)
      } else {
        _reconnectDelay = 0
        _reconnectCount = 0
      }
      _reconnectCount++
      _lastReconnectAt = now

      if (_reconnectDelay > 0) {
        console.log(`[App] WS reconnect #${_reconnectCount}, backoff ${_reconnectDelay}ms...`)
        await new Promise(r => setTimeout(r, _reconnectDelay))
      }

      if (HISTORY_IMPORT_MODE === 'none') {
        console.log('[App] WS reconnected, userId:', userId, '— catch-up skipped (history mode: none)')
        return
      }

      console.log('[App] WS reconnected, userId:', userId, '— catch-up...')
      const result = await initialSync.runIfNeeded('from_connection_time')
      console.log('[App] Reconnect catch-up:', result)
      return
    }

    console.log('[App] WS auth OK, userId:', userId)
    markReady(`ws-auth:${userId}`)
    if (_wsReadyAt === 0) { _wsReadyAt = Date.now(); loadPhoneChatIdCache() }
    session.isLoggedIn = true  // сразу, до sync — чтобы _waitForQrLogin вышел немедленно

    const syncResult = await initialSync.runIfNeeded(HISTORY_IMPORT_MODE)
    console.log('[App] Initial sync:', syncResult)

    // PR-П: периодический name-sync для outbound-only placeholder-чатов.
    // Запускается раз в час: спрашивает CRM список Без-Имени MAX-чатов,
    // навигирует каждый в page, читает header, шлёт обратно. Использует
    // ту же page что и live ingest — на время sync ingest на этой странице
    // приостанавливается (TransportInterceptor продолжает работать через CDP).
    if (!nameSync) {
        const crmBase = (CRM_WEBHOOK_URL || '').replace(/\/api\/.*$/, '') || 'http://127.0.0.1:3002'
        nameSync = new NameSync({ page, crmBaseUrl: crmBase })
        nameSync.start()
    }

    // Записываем время ПОСЛЕ catch-up — следующий рестарт будет подтягивать с этого момента
    try {
      fs.writeFileSync(
        path.join(__dirname, 'last_activity.json'),
        JSON.stringify({ ts: Date.now() })
      )
    } catch {}
  })

  session.onLogout(() => {
    isReady = false
    if (nameSync) { nameSync.stop(); nameSync = null }
    console.log('[App] Сессия завершена')
  })

  // Ждём авторизацию: если WS auth не пришёл — покажем QR
  await session.checkAndWaitForLogin()
}

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Резолвинг телефона в MAX chatId
// GET /resolve-phone?phone=79222155750
app.get('/resolve-phone', (req, res) => {
  const { phone } = req.query
  if (!phone) return res.status(400).json({ error: 'phone query param required' })
  const userId = contactStore ? contactStore.findByPhone(String(phone)) : null
  if (userId) {
    res.json({ chatId: userId, phone: String(phone) })
  } else {
    res.status(404).json({ error: 'Contact not found', phone: String(phone) })
  }
})

// Live reachability pre-check for CRM. This is a dry-run phone -> MAX chat
// resolver: it may open/search MAX Web, but it must never send a message.
app.post('/check-reachability', async (req, res) => {
  const { phone } = req.body || {}
  const digits = String(phone || '').replace(/\D/g, '')

  if (digits.length < 10 || digits.length > 11) {
    return res.status(400).json({
      status: 'unreachable',
      reachable: false,
      confirmed: false,
      retryable: false,
      error: 'Invalid phone number',
    })
  }

  if (!isReady) {
    return res.status(503).json({
      status: 'checking',
      reachable: null,
      confirmed: false,
      retryable: true,
      error: 'MAX scraper is not ready',
    })
  }

  try {
    const fromStore = contactStore ? contactStore.findByPhone(digits) : null
    if (fromStore) {
      return res.json({
        status: 'confirmed',
        reachable: true,
        confirmed: true,
        retryable: false,
        chatId: String(fromStore),
        source: 'contactStore',
      })
    }

    const liveResult = await Promise.race([
      resolvePhoneLive(digits),
      new Promise((_, reject) => setTimeout(() => reject(new Error('max_reachability_timeout')), 30_000)),
    ])
    const liveId = liveResult && typeof liveResult === 'object'
      ? liveResult.chatId
      : (typeof liveResult === 'string' ? liveResult : null)

    if (liveId) {
      if (contactStore) contactStore._map.set(liveId, { name: null, firstName: null, lastName: null, phone: digits })
      savePhoneChatId(digits, liveId)
      return res.json({
        status: 'confirmed',
        reachable: true,
        confirmed: true,
        retryable: false,
        chatId: String(liveId),
        source: 'live_lookup',
      })
    }

    return res.status(404).json({
      status: 'unreachable',
      reachable: false,
      confirmed: false,
      retryable: false,
      error: 'MAX account not found',
    })
  } catch (e) {
    return res.status(503).json({
      status: 'checking',
      reachable: null,
      confirmed: false,
      retryable: true,
      error: e.message,
    })
  }
})

// Debug: показывает состояние contactStore + живой resolve для диагностики
// GET /debug/resolve?phone=79126787532
app.get('/debug/resolve', async (req, res) => {
  const { phone } = req.query
  if (!phone) return res.status(400).json({ error: 'phone required' })
  const digits = String(phone).replace(/\D/g, '')

  const inStore  = contactStore ? contactStore.findByPhone(digits) : null
  const storeSize = contactStore ? contactStore._map.size : 0

  // Попытаться разрезолвить вживую (до 10 сек)
  let liveResult = null
  if (!inStore && isReady) {
    try {
      liveResult = await resolvePhoneLive(digits)
    } catch (e) {
      liveResult = `error: ${e.message}`
    }
  }

  // Скриншоты (если сохранились после последнего resolveViaUiSearch)
  const fs = require('fs')
  const screenshots = ['/tmp/max_resolve_before.png', '/tmp/max_resolve_compose.png', '/tmp/max_resolve_results.png']
    .map(f => ({ file: f, exists: fs.existsSync(f), size: fs.existsSync(f) ? fs.statSync(f).size : 0 }))

  res.json({
    phone: digits,
    contactStoreSize: storeSize,
    foundInStore: inStore,
    liveResult,
    isReady,
    screenshots,
    myUserId: transport._myUserId,
  })
})

// Debug: все контакты в store с телефонами
// GET /debug/contacts
app.get('/debug/contacts', (req, res) => {
  const withPhone = []
  if (contactStore) {
    for (const [userId, c] of contactStore._map.entries()) {
      if (c.phone) withPhone.push({ userId, phone: c.phone, name: c.name || c.firstName || null })
    }
  }
  res.json({ total: contactStore?._map.size || 0, withPhone })
})

// GET /debug/chats — chatCache: all known conversations with participants
app.get('/debug/chats', (req, res) => {
  const myId = String(transport?._myUserId || '')
  const chats = []
  for (const [chatId, chat] of chatCache.entries()) {
    const participants = chat.participants ? Object.keys(chat.participants) : []
    const other = participants.filter(p => p !== myId)
    chats.push({
      chatId,
      type: chat.type || null,
      participants: other,
      title: chat.title || chat.name || null,
    })
  }
  res.json({ total: chats.length, myUserId: myId, chats: chats.slice(0, 200) })
})

// Отправить текст
// Body: { chatId: number|string, message: string, phone?: string }
// chatId может быть MAX internal ID или телефон — если телефон, автоматически резолвим
// POST /debug/op71
// Body: { chatId: string|number, anchorHex?: string }
// Internal diagnostic: force a binary history request for one MAX chat.
app.post('/debug/op71', async (req, res) => {
  try {
    const { chatId, anchorHex } = req.body || {}
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    if (!transport) return res.status(503).json({ error: 'Transport is not ready' })

    await transport.forceHistoryCatchup(String(chatId), anchorHex || null)
    res.json({ success: true, chatId: String(chatId), anchorHex: anchorHex || null })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /debug/dom-fallback
// Body: { chatId: string|number, recent?: boolean }
app.post('/debug/dom-fallback', async (req, res) => {
  try {
    const { chatId, recent, phone, senderName, name } = req.body || {}
    const { mirrorOutgoing, enrichPeer, forcePeerIdentity } = req.body || {}
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    if (phone) savePhoneChatId(phone, chatId)
    const options = {
      ...(phone ? { phone } : {}),
      ...((senderName || name) ? { senderName: senderName || name } : {}),
      ...(mirrorOutgoing ? { includeOutgoing: true } : {}),
      ...(enrichPeer ? { enrichPeer: true } : {}),
      ...(forcePeerIdentity ? { forcePeerIdentity: true, enrichPeer: true } : {}),
    }
    const result = recent
      ? await forwardRecentDomMessages(String(chatId), 'manual_debug', options)
      : await forwardLatestDomMessage(String(chatId), 'manual_debug', options)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/debug/dom-identity', async (req, res) => {
  try {
    const { chatId } = req.body || {}
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    const route = resolveUiRouteIdForChat(String(chatId))
    const identity = await scrapeDomPeerIdentity(route.uiRouteId, { forcePhone: true })
    if (identity.phone) savePhoneChatId(identity.phone, String(chatId))
    res.json({ chatId: String(chatId), uiRouteId: route.uiRouteId, ...identity })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/send-message', async (req, res) => {
  let { chatId, message, phone, quotedMsgId, uiChatId, clientMessageId } = req.body
  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }
  if (!chatId && !phone) {
    return res.status(400).json({ error: 'chatId or phone is required' })
  }
  // Normalize: если передан phone без chatId — используем его как chatId (будет резолвится как телефон)
  if (!chatId && phone) chatId = phone
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  const crmOutboundDomGuard = rememberCrmOutboundText(message, chatId, uiChatId, phone)

  // Detect if chatId looks like a phone number (10-11 digits).
  // MAX internal IDs are now 12 digits (9021XXXXXXXX), so anything 12+ is a MAX ID.
  // Russian phones: 10 digits (without country code) or 11 digits (with country code 7).
  const chatIdStr = String(chatId || '')
  const digits = chatIdStr.replace(/\D/g, '')
  const looksLikePhone = digits.length >= 10 && digits.length <= 11

  if (looksLikePhone) {
    // Must resolve phone → MAX internal userId before sending
    const fromStore = contactStore ? contactStore.findByPhone(digits) : null
    if (fromStore) {
      console.log(`[Send] contactStore: ${digits} → chatId ${fromStore}`)
      chatId = fromStore
      extendCrmOutboundTextGuard(crmOutboundDomGuard, chatId)
    } else {
      const liveResult = await resolvePhoneLive(digits, message)
      // A UI send attempt is terminal for this HTTP operation: never issue a
      // second protocol send. Only the send-specific UI result may mark it delivered.
      const uiSendAttempted = Boolean(liveResult && typeof liveResult === 'object' && liveResult.uiSendAttempted === true)
      const uiDeliveryConfirmed = Boolean(uiSendAttempted && liveResult.deliveryConfirmed === true)
      const liveId = typeof liveResult === 'string'
        ? liveResult
        : (liveResult?.chatId ? String(liveResult.chatId) : null)
      if (uiSendAttempted) {
        if (liveId) {
          console.log(`[Send] UI-resolved: ${digits} → chatId ${liveId}`)
          extendCrmOutboundTextGuard(crmOutboundDomGuard, liveId)
          if (contactStore) contactStore._map.set(liveId, { name: null, firstName: null, lastName: null, phone: digits })
          savePhoneChatId(digits, liveId)
        }
        return res.json({
          success: true,
          chatId: liveId,
          externalId: null,
          deliveryConfirmed: uiDeliveryConfirmed,
          deliveryStatus: uiDeliveryConfirmed ? 'delivered' : 'send_requested',
          source: uiDeliveryConfirmed ? 'ui_resolve_send' : 'ui_resolve_send_unconfirmed',
          deliveryProof: uiDeliveryConfirmed ? {
            kind: 'ui_send_action',
            clientMessageId: clientMessageId ? String(clientMessageId) : null,
            actionConfirmed: true,
          } : undefined,
        })
      }
      if (liveId) {
        console.log(`[Send] live-resolved: ${digits} → chatId ${liveId}`)
        chatId = liveId
        extendCrmOutboundTextGuard(crmOutboundDomGuard, liveId)
        // Cache for subsequent sends in this session
        if (contactStore) contactStore._map.set(liveId, { name: null, firstName: null, lastName: null, phone: digits })
        // Dialog used returnHome() (SPA nav) — WS stays alive. waitForStableWs resolves
        // immediately if _wsConnected is already true. Acts as a safety net if WS dropped.
        if (!transport._wsConnected) {
          console.log('[Send] WS not connected after dialog, waiting for stable WS...')
          const wsReady = await transport.waitForStableWs(400, 18_000)
          console.log(`[Send] WS stable: ${wsReady}`)
        }
      } else {
        console.warn(`[Send] Phone ${digits} not found — contactStore has ${contactStore?._map.size || 0} contacts`)
        return res.status(404).json({
          error: `Контакт не найден в MAX. Дождитесь первого входящего сообщения от контакта, или добавьте номер ${digits} в адресную книгу MAX.`,
          phone: digits,
        })
      }
    }
  }

  // Also try phone field when chatId was null initially
  if (!chatId && phone && contactStore) {
    const resolved = contactStore.findByPhone(String(phone))
    if (resolved) {
      console.log(`[Send] phone field resolved: ${phone} → chatId ${resolved}`)
      chatId = resolved
    }
  }

  if (!chatId) {
    return res.status(400).json({ error: 'chatId required' })
  }
  extendCrmOutboundTextGuard(crmOutboundDomGuard, chatId, uiChatId)

  // Для первой отправки по номеру телефона ждём эхо от MAX чтобы узнать
  // реальный conversation ID (chatId в opcode 128 ≠ userId контакта).
  // Перехватываем echo через rawHandler ДО отправки — echo может прийти
  // раньше ack op:64. Подавляем echo в handleIncoming через capturedEchoIds
  // чтобы не создать дубль-чат до того как CRM обновит externalChatId.
  let echoConvId = null
  let echoRawHandler = null
  let echoResolve = null

  if (looksLikePhone) {
    const echoPromise = new Promise((resolve) => {
      echoResolve = resolve
      echoRawHandler = function (data) {
        if (data.opcode !== 128) return
        const ep = Array.isArray(data.payload)
          ? data.payload.find(x => x && typeof x === 'object' && !Array.isArray(x) && x.message)
          : data.payload
        if (ep?.message?.id && ep.chatId) {
          const sender = String(ep.message.sender || '')
          if (sender === transport._myUserId) {
            const idx = transport._rawHandlers.indexOf(echoRawHandler)
            if (idx > -1) transport._rawHandlers.splice(idx, 1)
            echoRawHandler = null
            resolve(String(ep.chatId))
          }
        }
      }
      transport._rawHandlers.push(echoRawHandler)
    })

    try {
      const sendResult = normalizeTextSendResult(await enqueueSend(() => sendText(transport, Number(chatId), message, quotedMsgId, uiChatId, clientMessageId)))
      if (sendResult.success === false || sendResult.error) {
        throw new Error(sendResult.error || 'MAX text delivery failed')
      }
      const maxMsgId = sendResult.externalId || sendResult.maxMessageId || null

      if (maxMsgId) {
        capturedEchoIds.add(String(maxMsgId))
        // Ждём echo до 3 секунд
        echoConvId = await Promise.race([
          echoPromise,
          new Promise(r => setTimeout(() => r(null), 3000)),
        ])
        capturedEchoIds.delete(String(maxMsgId))
      }
      // Убираем rawHandler если ещё висит (timeout)
      if (echoRawHandler) {
        const idx = transport._rawHandlers.indexOf(echoRawHandler)
        if (idx > -1) transport._rawHandlers.splice(idx, 1)
      }

      const returnChatId = echoConvId || String(chatId)
      extendCrmOutboundTextGuard(crmOutboundDomGuard, returnChatId)
      if (echoConvId && echoConvId !== String(chatId)) {
        console.log(`[Send] Conversation ID from echo: ${chatId} → ${echoConvId}`)
      }
      rememberKnownChatId(returnChatId)
      if (uiChatId) rememberKnownChatId(uiChatId)
      res.json({ success: true, chatId: returnChatId, externalId: sendResult.externalId || null, deliveryConfirmed: sendResult.deliveryConfirmed, deliveryStatus: sendResult.deliveryStatus, source: sendResult.source, deliveryProof: sendResult.deliveryProof })
    } catch (e) {
      if (echoRawHandler) {
        const idx = transport._rawHandlers.indexOf(echoRawHandler)
        if (idx > -1) transport._rawHandlers.splice(idx, 1)
      }
      const isMaxErr = e.maxError
      console.error(`[Send] sendText failed: ${e.message}`)
      res.status(isMaxErr ? 422 : 500).json({ error: e.message, maxError: e.maxError || null })
    }
    return
  }

  try {
    const sendResult = normalizeTextSendResult(await enqueueSend(() => sendText(transport, Number(chatId), message, quotedMsgId, uiChatId, clientMessageId)))
    if (sendResult.success === false || sendResult.error) {
      throw new Error(sendResult.error || 'MAX text delivery failed')
    }
    res.json({ success: true, chatId: String(chatId), externalId: sendResult.externalId || null, maxMessageId: sendResult.maxMessageId || null, deliveryConfirmed: sendResult.deliveryConfirmed, deliveryStatus: sendResult.deliveryStatus, source: sendResult.source, deliveryProof: sendResult.deliveryProof })
  } catch (e) {
    const isMaxErr = e.maxError
    console.error(`[Send] sendText failed: ${e.message}`)
    res.status(isMaxErr ? 422 : 500).json({ error: e.message, maxError: e.maxError || null })
  }
})

// Поставить/снять emoji-реакцию на сообщение
// Body: { chatId: number|string, messageId: string, emoji?: string, remove?: boolean }
app.post('/send-reaction', async (req, res) => {
  const { chatId, messageId, emoji, remove } = req.body
  if (!chatId || !messageId) {
    return res.status(400).json({ error: 'chatId and messageId are required' })
  }
  if (!remove && !emoji) {
    return res.status(400).json({ error: 'emoji is required unless remove=true' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  if (/^max-(dom|recovered)-/.test(String(messageId)) || /-recovered$/.test(String(messageId))) {
    return res.status(409).json({
      error: 'Message has no real MAX id yet; wait for history sync and retry',
      code: 'MAX_REAL_MESSAGE_ID_REQUIRED',
    })
  }
  try {
    let result
    if (remove) {
      result = await removeReaction(transport, Number(chatId), messageId)
    } else {
      // Помечаем как нашу собственную реакцию чтобы opcode 135 echo не дублировал обновление
      result = await sendReaction(transport, Number(chatId), messageId, emoji)
    }
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Удалить сообщение в MAX
// Body: { chatId: number|string, messageId: string }
// Opcode 128 outgoing: {chatId, messageId} (singular) — server confirms via REMOVED push (opcode 128 cmd:0)
app.post('/delete-message', async (req, res) => {
  const { chatId, messageId } = req.body
  if (!chatId || !messageId) {
    return res.status(400).json({ error: 'chatId and messageId required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready' })
  }
  try {
    // Opcode 66 = DELETE_MESSAGE. Confirmed from web.max.ru bundle:
    // yield*r(66,{...revertId(chatId), messageIds:[id,...], forMe:!forAll})
    // forMe:false = delete for everyone, forMe:true = delete only for sender
    const result = await transport.sendFrame(OP.DELETE_MESSAGE, {
      chatId:     Number(chatId),
      messageIds: [String(messageId)],
      forMe:      false,
    }, { waitResponse: true })
    console.log(`[delete-message] op66 OK chatId=${chatId} msgId=${messageId}`, JSON.stringify(result).slice(0, 100))
    res.json({ success: true })
  } catch (e) {
    console.error(`[delete-message] FAILED chatId=${chatId} msgId=${messageId}: ${e.message}`)
    res.status(500).json({ error: e.message })
  }
})

// Отправить изображение
// Body: { chatId: number, base64: string, filename: string, mimeType: string, caption?: string }
app.post('/send-image', async (req, res) => {
  const { chatId, base64, filename, mimeType, caption, uiChatId, phone } = req.body
  if (!chatId || !base64 || !filename || !mimeType) {
    return res.status(400).json({ error: 'chatId, base64, filename, mimeType are required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  try {
    const fileBuffer = decodeBase64Payload(base64)
    const externalId = await enqueueSend(async () => {
      if (phone || uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)]) {
        try {
          let uiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || null
          if (!uiRouteId && phone) {
            uiRouteId = await resolvePhoneLive(String(phone).replace(/\D/g, ''))
            if (uiRouteId) console.log(`[send-image] phone resolved for UI-first media: ${phone} -> ${uiRouteId}`)
          }
          if (uiRouteId) {
            const uiSent = await sendMediaViaUi(uiRouteId, fileBuffer, filename, mimeType, caption, transport)
            if (isConfirmedMediaSendResult(uiSent)) return uiSent
            if (uiSent) {
              console.warn(`[send-image] UI-first returned ${uiSent.deliveryStatus || uiSent.status || 'unconfirmed'}; returning without native retry`)
              return uiSent
            }
          }
        } catch (uiFirstErr) {
          console.warn(`[send-image] UI-first failed, trying native: ${uiFirstErr.message}`)
        }
      }
      try {
        return await sendImage(transport, page, Number(chatId), fileBuffer, filename, mimeType, caption)
      } catch (nativeErr) {
        console.warn(`[send-image] native send failed, trying UI fallback: ${nativeErr.message}`)
        let uiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || null
        if (!uiRouteId && phone) {
          uiRouteId = await resolvePhoneLive(String(phone).replace(/\D/g, ''))
          if (uiRouteId) console.log(`[send-image] phone resolved for UI fallback: ${phone} -> ${uiRouteId}`)
        }
        uiRouteId = uiRouteId || Number(chatId)
        const uiSent = await sendMediaViaUi(uiRouteId, fileBuffer, filename, mimeType, caption, transport)
        if (uiSent) return uiSent
        throw nativeErr
      }
    })
    const delivery = normalizeMediaSendResult(externalId)
    res.json({ success: true, ...delivery })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Универсальный endpoint для отправки любого медиа
// mediaType: 'image' | 'video' | 'document' | 'audio' | 'voice'
app.post('/send-media', async (req, res) => {
  const { chatId, base64, filename, mimeType, caption, mediaType, uiChatId, phone } = req.body
  if (!chatId || !base64 || !filename || !mimeType || !mediaType) {
    return res.status(400).json({ error: 'chatId, base64, filename, mimeType, mediaType are required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  try {
    const fileBuffer = decodeBase64Payload(base64)
    const cid = Number(chatId)

    const externalId = await enqueueSend(async () => {
      const hasCaption = String(caption || '').trim().length > 0
      const shouldPreferUiMedia = (mediaType === 'image' || mimeType.startsWith('image/')) && (hasCaption || phone || uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)])
      if (shouldPreferUiMedia) {
        try {
          let uiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || null
          if (!uiRouteId && phone) {
            uiRouteId = await resolvePhoneLive(String(phone).replace(/\D/g, ''))
            if (uiRouteId) console.log(`[send-media] phone resolved for UI-first media: ${phone} -> ${uiRouteId}`)
          }
          if (!uiRouteId && hasCaption) uiRouteId = cid
          if (uiRouteId) {
            const uiSent = await sendMediaViaUi(uiRouteId, fileBuffer, filename, mimeType, caption, transport)
            if (isConfirmedMediaSendResult(uiSent)) return uiSent
            if (uiSent) {
              console.warn(`[send-media] UI-first returned ${uiSent.deliveryStatus || uiSent.status || 'unconfirmed'}; returning without native retry`)
              return uiSent
            }
            if (hasCaption) throw new Error('caption_ui_media_send_failed')
          }
        } catch (uiFirstErr) {
          if (hasCaption) throw uiFirstErr
          console.warn(`[send-media] UI-first failed, trying native: ${uiFirstErr.message}`)
        }
      }
      if (hasCaption && (mediaType === 'image' || mimeType.startsWith('image/'))) {
        throw new Error('caption_ui_media_send_unavailable')
      }
      try {
        if (mediaType === 'image' || mimeType.startsWith('image/')) {
        return await sendImage(transport, page, cid, fileBuffer, filename, mimeType, caption)
      } else if (mediaType === 'video' || mimeType.startsWith('video/')) {
        return await sendVideo(transport, cid, fileBuffer, filename, mimeType, caption)
      } else {
        // document, audio, voice, OGG, PDF — all go via opcode 87
        return await sendFile(transport, cid, fileBuffer, filename, mimeType, caption)
      }
      } catch (nativeErr) {
        console.warn(`[send-media] native send failed, trying UI fallback: ${nativeErr.message}`)
        let uiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || null
        if (!uiRouteId && phone) {
          uiRouteId = await resolvePhoneLive(String(phone).replace(/\D/g, ''))
          if (uiRouteId) console.log(`[send-media] phone resolved for UI fallback: ${phone} -> ${uiRouteId}`)
        }
        uiRouteId = uiRouteId || cid
        const uiSent = await sendMediaViaUi(uiRouteId, fileBuffer, filename, mimeType, caption, transport)
        if (uiSent) return uiSent
        throw nativeErr
      }
    })

    const delivery = normalizeMediaSendResult(externalId)
    res.json({ success: true, ...delivery })
  } catch (e) {
    console.error('[send-media] Error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Debug: list contacts
app.get('/contacts', (req, res) => {
  if (!contactStore) return res.json({ contacts: [], total: 0 })
  const list = []
  for (const [userId, c] of contactStore._map.entries()) {
    list.push({ userId, ...c })
  }
  res.json({ contacts: list, total: list.length })
})

app.get('/health', (req, res) => {
  res.json({ status: isReady ? 'ready' : 'initializing', isReady, queueLength: sendQueue.length })
})

app.get('/status', (req, res) => {
  const qrExists = fs.existsSync(path.join(__dirname, 'last_qr.png'))
  res.json({
    isReady,
    isLoggedIn:        isReady,
    qrGenerated:       qrExists,
    historyImportMode: HISTORY_IMPORT_MODE,
    qrUpdatedAt:       qrUpdatedAt || null,
    readySinceAt:      readySinceAt || null,
    transport: {
      wsConnected:   !!transport?._wsConnected,
      authenticated: !!transport?.isAuthenticated?.(),
      myUserId:      transport?._myUserId || null,
    },
  })
})

app.get('/qr', (req, res) => {
  const qrPath = path.join(__dirname, 'last_qr.png')
  res.sendFile(qrPath, { dotfiles: 'allow' }, err => { if (err) res.status(404).json({ error: 'QR not found' }) })
})

app.post('/reload-page', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Page not ready' })
  try {
    console.log('[Reload] Принудительная перезагрузка страницы MAX...')
    isReady = false
    await page.goto('https://web.max.ru', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    console.log('[Reload] Страница перезагружена, ждём WS auth...')
    res.json({ ok: true })
  } catch (e) {
    console.error('[Reload] Ошибка:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/set-history-mode', (req, res) => {
  const { mode } = req.body
  const valid = ['none', 'from_connection_time', 'available_history']
  if (!valid.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode. Use: ${valid.join(', ')}` })
  }
  HISTORY_IMPORT_MODE = mode
  console.log('[App] History import mode:', mode)
  res.json({ success: true, mode })
})

// Получить список всех чатов из JS-состояния MAX web app
app.get('/chats-from-page', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Page not ready' })
  try {
    const chats = await page.evaluate(() => {
      // Пробуем найти чаты в Redux/MobX store или window.__*
      const stores = Object.keys(window).filter(k =>
        k.startsWith('__') || (window[k] && typeof window[k] === 'object' && window[k]?.chats)
      )
      for (const key of stores) {
        const obj = window[key]
        if (obj && Array.isArray(obj.chats)) return obj.chats
        if (obj && obj.chats && typeof obj.chats === 'object') {
          const vals = Object.values(obj.chats)
          if (vals.length > 0) return vals
        }
      }
      // Попробуем через React fiber (если используется React)
      const root = document.getElementById('root') || document.getElementById('app')
      if (root && root._reactInternals) {
        // Искать в fiber tree — сложно, пропускаем
      }
      return []
    })
    res.json({ count: chats.length, chats: chats.slice(0, 5) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/restart', async (req, res) => {
  try {
    InitialHistorySync.resetDoneFlag()
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/reset-sync', (req, res) => {
  InitialHistorySync.resetDoneFlag()
  res.json({ success: true })
})

// Текущий прогресс импорта (для live-счётчиков в CRM)
app.get('/import-progress', (req, res) => {
  if (!importSession) {
    return res.json({ active: false })
  }
  res.json({
    active:            true,
    jobId:             importSession.jobId,
    messagesImported:  importSession.messagesImported,
    chatsScanned:      importSession.chatsSet.size,
    contactsFound:     contactStore ? contactStore._map.size : 0,
    elapsed:           Math.round((Date.now() - importSession.startedAt) / 1000),
  })
})

// Запустить импорт истории с отчётом о результатах
// Body: { jobId, crmApiUrl, mode, daysBack? }
app.post('/import-history', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'Scraper not ready yet' })
  }

  const { jobId, crmApiUrl, mode = 'available_history', daysBack } = req.body

  if (!jobId || !crmApiUrl) {
    return res.status(400).json({ error: 'jobId and crmApiUrl are required' })
  }

  // Если режим last_n_days — выставляем last_activity.json на N дней назад
  if (mode === 'last_n_days' && daysBack > 0) {
    const sinceTs = Date.now() - daysBack * 24 * 60 * 60 * 1000
    try {
      fs.writeFileSync(
        path.join(__dirname, 'last_activity.json'),
        JSON.stringify({ ts: sinceTs })
      )
    } catch {}
    // Reset dedup + done flag so re-import actually processes messages
    InitialHistorySync.resetDoneFlag()
    sync.clear()
  } else if (mode === 'available_history') {
    // Сбрасываем last_activity чтобы захватить максимально доступную историю
    try { fs.unlinkSync(path.join(__dirname, 'last_activity.json')) } catch {}
    InitialHistorySync.resetDoneFlag()
    sync.clear()  // сбрасываем dedup чтобы не пропустить сообщения при реимпорте
  } else if (mode === 'from_connection_time') {
    // Только catch-up — сбрасываем флаг но не last_activity
    InitialHistorySync.resetDoneFlag()
  }

  // Отвечаем сразу, импорт идёт в фоне
  res.json({ success: true, jobId, mode })

  // Запускаем импорт в фоне
  ;(async () => {
    startImportSession(jobId, crmApiUrl)
    try {
      if (mode === 'last_n_days') {
        const sinceTs = Date.now() - (daysBack || 7) * 24 * 60 * 60 * 1000
        await initialSync.runIfNeeded('last_n_days', { sinceTs })
      } else {
        await initialSync.runIfNeeded(mode)
      }
      await finishImportSession('completed', mode === 'available_history' ? 'full' : 'partial')
    } catch (e) {
      console.error('[Import] Ошибка:', e.message)
      await finishImportSession('failed', 'failed')
    }
  })()
})

// ─── Синхронизация контактов ──────────────────────────────────────────────────
// POST /sync-contacts — принудительно запрашивает свежий список контактов от MAX
app.post('/sync-contacts', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Not ready' })
  const oldSize = contactStore._map.size
  const ok = await syncContacts(10000)
  res.json({ success: ok, oldSize, newSize: contactStore._map.size, reason: ok ? 'opcode32_received' : 'timeout' })
})

// ─── Диагностика: Puppeteer UI search в MAX web ───────────────────────────────
// GET /probe-ui-search?phone=79126787532 — открывает compose в MAX web,
// вводит телефон, логирует все WS-фреймы и DOM-результаты.
app.get('/probe-ui-search', async (req, res) => {
  const phone = (req.query.phone || '79126787532').replace(/\D/g, '')
  if (!transport || !page || !isReady) return res.status(503).json({ error: 'Not ready' })

  const capturedIn = []
  const rawHandler = (data) => {
    if (data.opcode !== 132) {
      capturedIn.push({ opcode: data.opcode, cmd: data.cmd, seq: data.seq, payload: JSON.stringify(data.payload || {}).slice(0, 500) })
    }
  }
  transport._rawHandlers.push(rawHandler)

  try {
    const phone7 = phone.startsWith('7') ? phone : '7' + phone.slice(-10)

    const uiResult = await page.evaluate(async (ph) => {
      const log = []

      // Step 1: Click "Start chatting" button (compose dialog — different from global search)
      const btns = [...document.querySelectorAll('button')]
      const startChatBtn = btns.find(b => b.getAttribute('aria-label') === 'Start chatting')
      if (startChatBtn) {
        startChatBtn.click()
        log.push({ step: 'clicked_start_chatting', found: true })
      } else {
        // Fallback: click any compose-like button
        for (const btn of btns) {
          const label = (btn.getAttribute('title') || btn.getAttribute('aria-label') || '').toLowerCase()
          if (label.includes('написать') || label.includes('создать') || label.includes('compose') ||
              label.includes('new') || label.includes('start')) {
            btn.click()
            log.push({ step: 'clicked_fallback_compose', label })
            break
          }
        }
      }
      await new Promise(r => setTimeout(r, 1200))

      // Step 2: Inspect all DOM after compose dialog opens
      const allEls = [...document.querySelectorAll('input, [contenteditable], textarea')]
        .filter(el => el.offsetParent !== null)
      log.push({ step: 'compose_dialog_inputs', count: allEls.length,
        details: allEls.map(el => ({
          tag: el.tagName, ph: el.placeholder, type: el.type,
          ce: el.contentEditable, className: el.className?.slice(0, 80)
        }))
      })

      // Also capture visible modal/overlay structure
      const modals = [...document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="popup"], [class*="compose"], [class*="new-chat"], [class*="overlay"]')]
        .filter(el => el.offsetParent !== null)
      log.push({ step: 'compose_dialog_modals', count: modals.length,
        items: modals.slice(0, 5).map(el => ({ className: el.className?.slice(0, 100), role: el.getAttribute('role') }))
      })

      // Step 3: Find and fill the contact search input
      const contactSearch = allEls.find(el => {
        const ph = (el.placeholder || '').toLowerCase()
        return ph.includes('поис') || ph.includes('кому') || ph.includes('найти') ||
               ph.includes('search') || ph.includes('contact') || ph.includes('name') || ph.includes('to')
      }) || allEls[0]

      if (contactSearch) {
        contactSearch.focus()
        contactSearch.value = ''
        for (const char of ph) {
          contactSearch.value += char
          contactSearch.dispatchEvent(new Event('input', { bubbles: true }))
          contactSearch.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }))
          await new Promise(r => setTimeout(r, 50))
        }
        log.push({ step: 'typed_in_compose', phone: ph, placeholder: contactSearch.placeholder, tag: contactSearch.tagName })
        await new Promise(r => setTimeout(r, 2500))

        // Capture results in the compose dialog
        const results = [...document.querySelectorAll('[class*="result"], [class*="contact"], [class*="user"], [class*="item"], [class*="row"], [class*="cell"]')]
          .filter(el => el.offsetParent !== null && el.children.length < 8)
          .map(el => ({
            tag: el.tagName,
            text: el.textContent?.trim().slice(0, 80),
            dataId: el.dataset?.id || el.dataset?.userId || el.dataset?.chatId,
            className: el.className?.slice(0, 80)
          }))
          .filter(el => el.text && el.text.length > 0)
        log.push({ step: 'compose_results', count: results.length, items: results.slice(0, 10) })
      } else {
        log.push({ step: 'no_compose_input_found' })
      }

      // Close
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 300))
      return log
    }, phone7)

    await new Promise(r => setTimeout(r, 2000))

    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)

    res.json({ phone: phone7, uiInteraction: uiResult, capturedWsFrames: capturedIn })
  } catch (e) {
    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)
    res.status(500).json({ error: e.message })
  }
})

// ─── Диагностика: сканирование JS-бандла MAX web ─────────────────────────────
// GET /scan-max-bundle — скачивает JS из браузерной сессии (с куками) и
// ищет опкоды, связанные с поиском контактов по телефону.
app.get('/scan-max-bundle', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Page not ready' })

  try {
    const findings = await page.evaluate(async () => {
      // MAX web uses chunk-based bundles (not SvelteKit _app/immutable)
      const scripts = [...document.querySelectorAll('script[src]')]
        .map(s => s.src)
        .filter(u => u.length > 10 && (u.includes('.js') || !u.includes('.')))
        .slice(0, 15)

      // Also log all script URLs for inspection
      const allScripts = [...document.querySelectorAll('script[src]')].map(s => s.src)

      const out = [{ type: 'script_urls', matches: allScripts }]
      for (const url of scripts) {
        let src = ''
        try { src = await fetch(url, { credentials: 'include' }).then(r => r.text()) } catch { continue }
        if (!src || src.length < 200) continue
        const fname = url.split('/').pop().slice(0, 60)

        // Opcode maps: objects with 5+ numeric values
        const opMaps = (src.match(/\{(?:\s*\w+\s*:\s*\d{1,3}\s*,?\s*){5,}\}/g) || []).slice(0, 3).map(m => m.slice(0, 400))
        if (opMaps.length) out.push({ file: fname, type: 'opcode_map', matches: opMaps })

        // Phone-related code
        const ph = (src.match(/[a-z_$]{0,20}phone[a-z_$]{0,20}[^\n;]{0,120}/gi) || []).slice(0, 6).map(m => m.slice(0, 200))
        if (ph.length) out.push({ file: fname, type: 'phone_code', matches: ph })

        // Opcode usage patterns
        const ops = (src.match(/(?:opcode|op)\s*(?:===|:)\s*(\d{1,3})[^\n;]{0,80}/gi) || []).slice(0, 10).map(m => m.slice(0, 200))
        if (ops.length) out.push({ file: fname, type: 'opcode_use', matches: ops })

        // Search-related terms
        const search = (src.match(/(?:search|findUser|byPhone|lookup|resolve)[^;\n]{0,120}/gi) || []).slice(0, 5).map(m => m.slice(0, 200))
        if (search.length) out.push({ file: fname, type: 'search_code', matches: search })
      }
      return out
    })

    res.json(findings)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Диагностика: вкладка Contacts в MAX web ─────────────────────────────────
// GET /probe-contacts-tab?phone=79126787532 — кликает вкладку Contacts,
// вводит телефон в поиск контактов, захватывает все WS-фреймы.
app.get('/probe-contacts-tab', async (req, res) => {
  const phone = (req.query.phone || '79126787532').replace(/\D/g, '')
  if (!transport || !page || !isReady) return res.status(503).json({ error: 'Not ready' })

  const capturedIn = []
  const rawHandler = (data) => {
    if (data.opcode !== 132) {
      capturedIn.push({ opcode: data.opcode, cmd: data.cmd, seq: data.seq,
        payload: JSON.stringify(data.payload || {}).slice(0, 600) })
    }
  }
  transport._rawHandlers.push(rawHandler)

  try {
    const phone7 = phone.startsWith('7') ? phone : '7' + phone.slice(-10)

    const uiResult = await page.evaluate(async (ph) => {
      const log = []

      // Click "Contacts" tab button
      const btns = [...document.querySelectorAll('button')]
      const contactsBtn = btns.find(b => b.textContent?.trim() === 'Contacts' || b.textContent?.trim() === 'Контакты')
      if (contactsBtn) {
        contactsBtn.click()
        log.push({ step: 'clicked_contacts_tab', text: contactsBtn.textContent?.trim() })
      } else {
        log.push({ step: 'no_contacts_tab', tried: btns.map(b => b.textContent?.trim().slice(0, 20)).filter(Boolean) })
      }
      await new Promise(r => setTimeout(r, 1500))

      // Capture page structure after tab click
      const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null)
      log.push({ step: 'inputs_after_contacts_click', count: inputs.length,
        details: inputs.map(i => ({ ph: i.placeholder, type: i.type, className: i.className?.slice(0, 60) }))
      })

      // Find contact list items visible on screen
      const listItems = [...document.querySelectorAll('[class*="cell"], [class*="contact"], [class*="user"], [class*="item"]')]
        .filter(el => el.offsetParent !== null && el.textContent?.trim().length > 2)
        .slice(0, 10)
        .map(el => ({ text: el.textContent?.trim().slice(0, 60), className: el.className?.slice(0, 60), dataId: el.dataset?.id }))
      log.push({ step: 'contact_list_items', count: listItems.length, items: listItems })

      // Find search input and type phone
      const searchInput = inputs.find(i => {
        const ph = (i.placeholder || '').toLowerCase()
        return ph.includes('поис') || ph.includes('search') || ph.includes('name') || ph.includes('contact')
      }) || inputs[0]

      if (searchInput) {
        searchInput.focus()
        searchInput.value = ''
        for (const char of ph) {
          searchInput.value += char
          searchInput.dispatchEvent(new Event('input', { bubbles: true }))
          searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }))
          await new Promise(r => setTimeout(r, 50))
        }
        log.push({ step: 'typed_phone', phone: ph, placeholder: searchInput.placeholder })
        await new Promise(r => setTimeout(r, 2500))

        // Capture results
        const results = [...document.querySelectorAll('[class*="result"], [class*="contact"], [class*="cell"], [class*="item"], [class*="row"]')]
          .filter(el => el.offsetParent !== null && el.textContent?.trim().length > 2 && el.children.length < 8)
          .slice(0, 10)
          .map(el => ({
            text: el.textContent?.trim().slice(0, 80),
            dataId: el.dataset?.id || el.dataset?.userId || el.dataset?.chatId,
            className: el.className?.slice(0, 80)
          }))
        log.push({ step: 'search_results', count: results.length, items: results })
      }

      // Return to chat list (Escape or click All)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      const allBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'All' || b.textContent?.trim() === 'Все')
      if (allBtn) allBtn.click()

      return log
    }, phone7)

    await new Promise(r => setTimeout(r, 1500))

    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)

    res.json({ phone: phone7, uiInteraction: uiResult, capturedWsFrames: capturedIn })
  } catch (e) {
    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)
    res.status(500).json({ error: e.message })
  }
})

// ─── Диагностика: запросить userId по телефону / пробовать WS-опкоды ──────────
// GET /lookup-user?phone=79126787532 — пробует разные подходы WS для поиска
app.get('/lookup-user', async (req, res) => {
  const phone = (req.query.phone || '').replace(/\D/g, '')
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'phone required' })
  if (!transport || !isReady) return res.status(503).json({ error: 'Not ready' })

  const phone7 = phone.startsWith('7') ? phone : '7' + phone.slice(-10)
  const results = []

  // Try known search opcodes with phone as query (safe ones only)
  const tryOpcodes = [
    { op: 68, payload: { query: phone7, count: 30 } },
    { op: 60, payload: { query: phone7, count: 30, type: 'ALL' } },
    // op:48 chatIds:[0] — special "get all chats" from startup sequence
    { op: 48, payload: { chatIds: [0] } },
  ]

  for (const { op, payload } of tryOpcodes) {
    try {
      const resp = await transport.sendFrame(op, payload, { waitResponse: true })
      const preview = JSON.stringify(resp).slice(0, 800)
      results.push({ op, payload, response: preview })
      if (resp?.result?.length > 0 || resp?.contacts?.length > 0 || resp?.chats?.length > 0) {
        console.log(`[lookup-user] op:${op} HIT:`, preview.slice(0, 200))
      }
    } catch (e) {
      results.push({ op, payload, error: e.message })
    }
  }

  res.json({ phone: phone7, results })
})

// ─── Диагностика: извлечь все контакты из DOM вкладки Contacts ───────────────
// GET /extract-contacts-dom — кликает Contacts tab, прокручивает список,
// возвращает все видимые контакты (имя + data-id если есть)
app.get('/extract-contacts-dom', async (req, res) => {
  if (!page || !isReady) return res.status(503).json({ error: 'Not ready' })

  try {
    const contacts = await page.evaluate(async () => {
      // Click Contacts tab
      const btns = [...document.querySelectorAll('button')]
      const contactsBtn = btns.find(b => b.textContent?.trim() === 'Contacts' || b.textContent?.trim() === 'Контакты')
      if (contactsBtn) { contactsBtn.click(); await new Promise(r => setTimeout(r, 1500)) }

      // Scroll the contact list to load more
      const scrollable = document.querySelector('[class*="list"], [class*="scroll"], [class*="chat-list"], main, [class*="sidebar"]')
      const allContacts = []
      const seen = new Set()

      for (let i = 0; i < 10; i++) {
        const cells = [...document.querySelectorAll('.cell--clickable, [class*="cell"][class*="clickable"], [class*="item"][class*="svelte"]')]
          .filter(el => el.offsetParent !== null)
        for (const el of cells) {
          const text = el.textContent?.trim()
          if (!text || text.length < 3 || seen.has(text)) continue
          // Skip nav items
          if (['All', 'All 2', 'New 2', 'Channels', 'Settings', 'Calls', 'Contacts'].includes(text.split('\n')[0]?.trim())) continue
          seen.add(text)
          const dataId = el.dataset?.id || el.dataset?.userId || el.dataset?.chatId
          const href = el.querySelector('a')?.href || ''
          allContacts.push({ name: text.split('\n')[0]?.trim().slice(0, 60), dataId, href: href.slice(0, 80) })
        }
        if (scrollable) scrollable.scrollTop += 400
        await new Promise(r => setTimeout(r, 500))
      }

      return allContacts
    })

    res.json({ count: contacts.length, contacts })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Старт ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[App] MAX Web Scraper запущен на порту ${PORT}`)
  console.log(`[App] History import mode: ${HISTORY_IMPORT_MODE}`)

  init().catch(e => {
    console.error('[App] Ошибка инициализации:', e.message)
    process.exit(1)
  })
})
