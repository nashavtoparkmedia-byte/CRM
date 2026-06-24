'use strict'

require('dotenv').config()

const express  = require('express')
const fs       = require('fs')
const path     = require('path')
const cors     = require('cors')
const http     = require('http')
const https    = require('https')
const { chromium } = require('playwright')

const { SessionController }        = require('./session/SessionController')
const { TransportInterceptor, OP } = require('./transport/TransportInterceptor')
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
const USER_DATA_DIR   = path.join(__dirname, 'user_data')

// 'none' | 'from_connection_time' | 'available_history'
let HISTORY_IMPORT_MODE = process.env.HISTORY_IMPORT_MODE || 'from_connection_time'
let qrUpdatedAt         = null   // timestamp последней генерации QR

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

// ─── Очередь отправки ────────────────────────────────────────────────────────

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
  trackImportedMessage(payload.chatId, payload.timestamp)
  const url  = new URL(CRM_WEBHOOK_URL)
  const body = JSON.stringify(payload)
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
      res.on('end',  () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── Обработка входящего сообщения ───────────────────────────────────────────

async function handleIncoming(msg, mediaPipeline, messageSync, transport) {
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

  // Исходящее echo от сообщения, которое /send-message сейчас перехватывает
  // для получения реального conversation ID. Пропускаем здесь — CRM сам
  // обновит externalChatId когда /send-message вернёт ответ.
  if (msg.isOutgoing && msg.id && capturedEchoIds.has(String(msg.id))) {
    console.log(`[handleIncoming] Echo msgId=${msg.id} suppressed — captured by /send-message`)
    messageSync.markSeen(msg)
    return
  }

  let payload = MessageParser.toCrmPayload(msg)

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
    const downloaded = []
    for (const att of msg.attachments) {
      let attUrl = att.url
      // VIDEO/FILE не несут прямой ссылки — только videoId/fileId+token.
      // Резолвим через opcode 83/88 перед скачиванием (см. resolveAttachmentUrl).
      if (!attUrl && transport) {
        try {
          attUrl = await resolveAttachmentUrl(transport, att, msg.chatId, msg.id)
        } catch (e) {
          console.error('[App] resolveAttachmentUrl error:', e.message)
        }
      }
      if (!attUrl) { downloaded.push(att); continue }
      try {
        const file = await mediaPipeline.downloadAttachment(attUrl, att.mimeType)
        // Convert to data URL so CRM stores the file permanently.
        // Resolved CDN URLs (opcode 83/88) expire within minutes — if we
        // store the raw CDN URL, /api/attachments/{id} will get 403 later.
        const fileBuffer = fs.readFileSync(file.localPath)
        const dataUrl = `data:${file.mimeType};base64,${fileBuffer.toString('base64')}`
        downloaded.push({
          ...att,
          url:       dataUrl,
          mimeType:  file.mimeType,
          localPath: file.localPath,
          size:      file.size,
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
    payload = { ...payload, attachments: downloaded }
  }

  try {
    const result = await forwardToWebhook(payload)
    if (result.status >= 200 && result.status < 300) {
      console.log(`[App] → CRM: chatId=${payload.chatId} text="${(payload.text || '').slice(0, 50)}"`)
    } else {
      console.error(`[App] CRM webhook вернул ${result.status} для chatId=${payload.chatId} — сообщение потеряно! body:`, result.data?.slice(0, 200))
    }
  } catch (e) {
    console.error('[App] Webhook forward failed (network):', e.message, '— chatId:', payload.chatId)
  }

  messageSync.markSeen(msg)

  // Сохраняем timestamp последней активности для catch-up при рестарте
  try {
    fs.writeFileSync(
      path.join(__dirname, 'last_activity.json'),
      JSON.stringify({ ts: Date.now() })
    )
  } catch {}

  // Запоминаем chatId для catch-up при рестарте
  if (payload.chatId) {
    try {
      const knownPath = path.join(__dirname, 'known_chats.json')
      let known = []
      try { known = JSON.parse(fs.readFileSync(knownPath, 'utf8')) } catch {}
      if (!known.includes(payload.chatId)) {
        known.push(payload.chatId)
        fs.writeFileSync(knownPath, JSON.stringify(known))
      }
    } catch {}
  }
}

// ─── Отправка текста через WS opcode 64 ──────────────────────────────────────

async function sendText(transport, chatId, text, replyToMessageId) {
  const cid = -Date.now()
  const message = { text, cid, elements: [], attaches: [] }
  if (replyToMessageId) message.link = { type: 'REPLY', messageId: String(replyToMessageId) }
  try {
    const resp = await transport.sendFrame(OP.SEND_MESSAGE, { chatId, message, notify: true }, { waitResponse: true })
    // MAX responds with the created message; extract its server-assigned ID
    const maxMsgId = resp?.message?.id ? String(resp.message.id) : null
    if (maxMsgId) console.log(`[Send] MAX assigned msgId=${maxMsgId} for chatId=${chatId}`)
    return maxMsgId
  } catch (e) {
    // Re-throw MAX protocol errors (not.found, etc.) — these are real failures, not timeouts
    if (e.maxError) throw e
    // Pure timeout (no response) — message likely went through but no ID returned
    console.warn(`[sendText] No ack from MAX (timeout) — send may be delivered but externalId unknown`)
    return null
  }
}

// ─── Contact sync: refresh contact list from MAX ─────────────────────────────
let _lastContactSync = 0  // timestamp последнего успешного sync

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
async function resolveViaPhoneLookupDialog(digits) {
  if (!page || !transport || !isReady) return null
  const local10 = digits.slice(-10)
  console.log(`[ResolvePhone] "Найти по номеру" dialog: ${local10}`)

  const capturedFrames = []
  const rawHandler = (data) => {
    if (data.opcode !== 132 && data.opcode !== 1 && data.opcode !== 5) {
      capturedFrames.push({ opcode: data.opcode, cmd: data.cmd, payload: data.payload })
    }
  }
  transport._rawHandlers.push(rawHandler)

  const returnHome = async () => {
    try { await page.goto('https://web.max.ru', { timeout: 8000, waitUntil: 'domcontentloaded' }) } catch {}
  }
  const cleanup = () => {
    const idx = transport._rawHandlers.indexOf(rawHandler)
    if (idx > -1) transport._rawHandlers.splice(idx, 1)
  }

  try {
    // 1. Go to contacts section
    await page.goto('https://web.max.ru/contacts', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(1500)

    // 2. Click "+" button to open "Найти по номеру" dialog
    // The button is the blue circular + in the Contacts header
    let plusClicked = false
    const plusSelectors = [
      'button[title*="Найти"]', 'button[aria-label*="Найти"]',
      'button[title*="добавить"]', 'button[aria-label*="добавить"]',
      'button[title*="Добавить"]', 'button[aria-label*="Добавить"]',
      'button[title*="новый"]', 'button[aria-label*="новый"]',
    ]
    for (const sel of plusSelectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) {
        await page.locator(sel).first().click()
        plusClicked = true
        console.log(`[ResolvePhone] + button clicked (${sel})`)
        break
      }
    }

    if (!plusClicked) {
      // Fallback: dump visible buttons for debug, then click SVG-only (icon) button
      const btns = await page.evaluate(() =>
        [...document.querySelectorAll('button')]
          .filter(b => b.offsetParent !== null)
          .slice(0, 30)
          .map(b => ({
            text: b.innerText?.trim().slice(0, 30),
            title: b.getAttribute('title'),
            label: b.getAttribute('aria-label'),
            cls: b.className?.slice(0, 80),
          }))
      )
      console.log('[ResolvePhone] Contacts buttons:', JSON.stringify(btns))

      // Click the first SVG-only button (icon buttons have no text, usually the + btn)
      const clicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
        for (const b of btns) {
          if (!(b.innerText?.trim()) && b.querySelector('svg')) {
            b.click(); return b.className?.slice(0, 60) || 'clicked'
          }
        }
        return null
      })
      if (clicked) {
        plusClicked = true
        console.log('[ResolvePhone] SVG-only button clicked:', clicked)
      }
    }

    await page.waitForTimeout(800)
    await page.screenshot({ path: '/tmp/max_phone_dialog_open.png' }).catch(() => {})

    // 3. Find phone input in the dialog "Найти по номеру"
    // Placeholder is "123 456 78 90" — contains "123"
    const inputSelectors = [
      'input[placeholder*="123"]',
      'input[placeholder*="456"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[inputmode="tel"]',
      'input[placeholder*="номер"]',
      'input[placeholder*="Номер"]',
      'input[placeholder*="phone"]',
      'input[placeholder*="Phone"]',
    ]
    let dialogInput = null
    for (const sel of inputSelectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) {
        dialogInput = page.locator(sel).first()
        console.log(`[ResolvePhone] Dialog input found: ${sel}`)
        break
      }
    }

    if (!dialogInput) {
      // Log all visible inputs for debug
      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll('input')]
          .filter(i => i.type !== 'hidden' && i.offsetParent !== null)
          .map(i => ({ ph: i.placeholder, type: i.type, mode: i.inputMode, cls: i.className?.slice(0, 60) }))
      )
      console.log('[ResolvePhone] Visible inputs after + click:', JSON.stringify(inputs))
      cleanup(); await returnHome(); return null
    }

    // 4. Type local 10 digits into the dialog input
    await dialogInput.click()
    await dialogInput.fill('')
    await page.keyboard.type(local10, { delay: 50 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: '/tmp/max_phone_dialog_typed.png' }).catch(() => {})

    // 5. Click "Найти в МАХ" button
    const searchBtnSel = [
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
    await page.screenshot({ path: '/tmp/max_phone_dialog_result.png' }).catch(() => {})

    // 6a. URL changed → extract convId
    const urlAfter = page.url()
    if (urlAfter !== urlBefore) {
      const convId = urlAfter.match(/web\.max\.ru\/(\d{5,15})(?:[/?#]|$)/)?.[1]
      if (convId) {
        console.log(`[ResolvePhone] URL-resolved: ${digits} → convId ${convId}`)
        cleanup(); await returnHome(); return convId
      }
    }

    // 6b. "Написать" / "Начать чат" button appeared — click and capture URL
    const writeBtnSels = [
      'button:has-text("Написать")',
      'button:has-text("Начать чат")',
      'button:has-text("Start chat")',
      'button:has-text("Написать сообщение")',
    ]
    for (const sel of writeBtnSels) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log(`[ResolvePhone] Found write button "${sel}" — clicking`)
        await btn.click()
        await page.waitForTimeout(3000)
        const urlFinal = page.url()
        const convId = urlFinal.match(/web\.max\.ru\/(\d{5,15})(?:[/?#]|$)/)?.[1]
        if (convId) {
          console.log(`[ResolvePhone] URL after "Написать": ${digits} → convId ${convId}`)
          cleanup(); await returnHome(); return convId
        }
        // Also check WS op:48 for new chat
        for (const f of capturedFrames) {
          if (f.opcode !== 48) continue
          for (const c of (f.payload?.chats || [])) {
            const cid = String(c.chatId || c.id || '')
            if (cid && /^\d{6,15}$/.test(cid) && !chatCache.has(cid)) {
              console.log(`[ResolvePhone] New chat from op:48 after write: ${digits} → ${cid}`)
              cleanup(); await returnHome(); return cid
            }
          }
        }
        break
      }
    }

    // 6c. Check WS frames: op:60/68 search results
    console.log(`[ResolvePhone] WS frames: ${capturedFrames.map(f => `op:${f.opcode}`).join(',')}`)
    for (const f of capturedFrames) {
      if (f.opcode !== 60 && f.opcode !== 68) continue
      const results = Array.isArray(f.payload?.result) ? f.payload.result : []
      for (const r of results) {
        const id = r.id || r.userId || r.user_id
        if (id && /^\d{5,12}$/.test(String(id))) {
          console.log(`[ResolvePhone] op:${f.opcode} search result: ${digits} → ${id}`)
          cleanup(); await returnHome(); return String(id)
        }
      }
    }

    // 6d. DOM fallback — any numeric id in visible elements
    const domId = await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-id],[data-user-id],a[href*="/"]')) {
        const id = el.getAttribute('data-id') || el.getAttribute('data-user-id') ||
                   (el.getAttribute('href') || '').match(/\/(\d{6,15})(?:\/|$)/)?.[1]
        if (id && /^\d{6,15}$/.test(id)) return id
      }
      return null
    })
    if (domId) {
      console.log(`[ResolvePhone] DOM id: ${digits} → ${domId}`)
      cleanup(); await returnHome(); return domId
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
        if (data.opcode === 128 && data.payload?.message) {
          const sender = String(data.payload.message.sender || '')
          if (sender && sender !== String(transport._myUserId)) resolvedFromEcho = sender
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
async function resolvePhoneLive(digits) {
  // 1. Check chatCache — chats where name/title contains the phone number
  const tail10 = digits.slice(-10)
  for (const [chatIdStr, chatData] of chatCache.entries()) {
    const title = String(chatData.name || chatData.title || chatData.subject || '')
    const titleDigits = title.replace(/\D/g, '')
    if (titleDigits.length >= 10 && titleDigits.slice(-10) === tail10) {
      console.log(`[ResolvePhone] chatCache hit: ${digits} → chatId ${chatIdStr}`)
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
        return chatIdStr  // return convId — looksLikePhone=false so will be sent directly
      }
    }
  }

  // 4. "Найти по номеру" dialog — MAX Contacts → + → phone lookup
  //    Works even for private profiles since MAX server knows the phone→userId mapping.
  const dialogId = await resolveViaPhoneLookupDialog(digits)
  if (dialogId) return dialogId

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

  return new Promise((resolve, reject) => {
    const boundary = '----MaxBoundary' + Date.now()
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
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
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':        mimeType,
        'Content-Disposition': `attachment; filename=${encodeURIComponent(filename)}`,
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
  const uploadData = await uploadImageToMax(transport, fileBuffer, filename, mimeType)
  const photoToken = uploadData?.photoToken
    || uploadData?.token
    || (uploadData?.photos && Object.values(uploadData.photos)[0]?.token)
  if (!photoToken) throw new Error(`photoToken не найден в ответе: ${JSON.stringify(uploadData)}`)

  const cid = -Date.now()
  const resp = await transport.sendFrame(OP.SEND_MESSAGE, {
    chatId,
    message: { cid, text: caption || '', attaches: [{ _type: 'PHOTO', photoToken }] },
    notify: true,
  }, { waitResponse: true })
  return resp?.message?.id ? String(resp.message.id) : null
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
  const urlResp = await transport.sendFrame(OP.GET_UPLOAD_VIDEO_URL, { count: 1 }, { waitResponse: true })
  const info = urlResp?.info?.[0]
  if (!info?.url || info?.videoId == null) {
    throw new Error(`Не получен URL для загрузки видео. Ответ: ${JSON.stringify(urlResp)}`)
  }
  console.log(`[sendVideo] videoId=${info.videoId} url=${info.url.slice(0, 80)}`)
  await uploadRawBinary(info.url, fileBuffer, filename, mimeType)

  return sendMessageWithRetry(transport, chatId, {
    text:    caption || '',
    attaches: [{ _type: 'VIDEO', videoId: info.videoId, token: info.token || undefined, duration: null }],
  })
}

/**
 * Send file/audio/PDF/OGG: opcode 87 → raw binary upload → opcode 64 (with retry).
 * Response from opcode 87: {info: [{fileId, url}]}  (no token — fileId is enough)
 */
async function sendFile(transport, chatId, fileBuffer, filename, mimeType, caption) {
  const urlResp = await transport.sendFrame(OP.GET_UPLOAD_FILE_URL, { count: 1 }, { waitResponse: true })
  const info = urlResp?.info?.[0]
  if (!info?.url || info?.fileId == null) {
    throw new Error(`Не получен URL для загрузки файла. Ответ: ${JSON.stringify(urlResp)}`)
  }
  console.log(`[sendFile] fileId=${info.fileId} url=${info.url.slice(0, 80)}`)
  await uploadRawBinary(info.url, fileBuffer, filename, mimeType)

  return sendMessageWithRetry(transport, chatId, {
    text:    caption || '',
    attaches: [{ _type: 'FILE', fileId: info.fileId, name: filename, size: fileBuffer.length }],
  })
}

// ─── Реакции: opcode 178 (поставить) / 179 (снять) ───────────────────────────

async function sendReaction(transport, chatId, messageId, emoji) {
  await transport.sendFrame(OP.SEND_REACTION, {
    chatId,
    messageId: String(messageId),
    reaction: { reactionType: 'EMOJI', id: emoji },
  })
}

async function removeReaction(transport, chatId, messageId) {
  await transport.sendFrame(OP.REMOVE_REACTION, {
    chatId,
    messageId: String(messageId),
  })
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
  if (type === 'video' && att.videoId && att.token) {
    opcode = OP.RESOLVE_VIDEO
    payload = { videoId: att.videoId, token: att.token, chatId, messageId: String(messageId) }
  } else if ((type === 'file' || type === 'document') && att.fileId) {
    opcode = OP.RESOLVE_FILE
    payload = { fileId: att.fileId, chatId, messageId: String(messageId) }
  } else {
    return null
  }
  const resp = await transport.sendFrame(opcode, payload, { waitResponse: true })
  console.log(`[ResolveAttachment] opcode=${opcode} payload=${JSON.stringify(payload)} response=${JSON.stringify(resp).slice(0, 800)}`)
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

let page          = null
let context       = null   // Playwright persistent context — keep at module scope so shutdown/uncaught handlers can close it cleanly
let mediaPipeline = null
let initialSync   = null
let nameSync      = null  // PR-П: NameSync — раз в час подтягивает имена placeholder-чатов из MAX UI
let isReady       = false

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

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
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

  // 2. Навигируем
  console.log('[App] Открываем web.max.ru...')
  await page.goto(MAX_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  // 3. Подключаем CDP
  await transport.attachCdp(page, context)

  // 4. Создаём зависимые объекты
  mediaPipeline = new MediaPipeline(page)
  initialSync   = new InitialHistorySync(transport, sync, forwardToWebhook, mediaPipeline, chatCache, contactStore)

  // Перехватываем raw-фреймы (каждый блок изолирован — ошибка в одном не ломает другие)
  transport.onRawFrame(async data => {
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
          const id = chat.id ?? chat.chatId
          if (id && id !== 0) { chatCache.set(String(id), chat); added++ }
        }
        if (added > 0) console.log(`[ChatCache] +${added} чатов, всего: ${chatCache.size}`)
      } catch (e) { console.error('[App] onRawFrame GET_CHATS error:', e.message) }
    }
    // opcode 28 — animoji/реакции маппинг: id → emoji символ
    if (data.opcode === 28 && data.payload?.animojis) {
      try {
        for (const a of data.payload.animojis) {
          if (a.id && a.emoji) reactionEmojiById.set(Number(a.id), a.emoji)
        }
        console.log(`[App] reactionEmojiById: ${reactionEmojiById.size} записей`)
      } catch (e) { console.error('[App] opcode28 animoji error:', e.message) }
    }
    // opcode 288 — QR link от MAX сервера
    if (data.opcode === 288 && data.payload?.qrLink) {
      try {
        const qrLink  = data.payload.qrLink
        const qrPath  = path.join(__dirname, 'last_qr.png')
        await QRCode.toFile(qrPath, qrLink, {
          width:  400,
          margin: 2,
          color: { dark: '#000000', light: '#FFFFFF' },
        })
        qrUpdatedAt = Date.now()
        console.log('[QR] Сгенерирован из qrLink:', qrLink)
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
      fetch(reactionUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ externalMsgId, counters }),
      }).catch(e => console.error('[App] opcode155 reaction sync error:', e.message))
    }
    // Opcode 135 — chat update push; содержит lastReaction + lastReactedMessageId
    // В реальности opcode 155 не приходит при реакции другого пользователя — только 135.
    // Пропускаем если реакция пришла в ответ на нашу собственную отправку (seq >= 500).
    if (data.opcode === 135 && data.payload?.chat?.lastReactedMessageId && data.payload?.chat?.lastReaction) {
      const externalMsgId = String(data.payload.chat.lastReactedMessageId)
      const emoji          = normalizeReactionEmoji(data.payload.chat.lastReaction)
      if (!recentOwnReactionIds.has(externalMsgId)) {
        const reactionUrl = CRM_WEBHOOK_URL.replace(/\/api\/webhooks?\/max\/?.*$/, '/api/webhook/max/reaction')
        console.log(`[App] opcode135 reaction: msgId=${externalMsgId} raw=${JSON.stringify(data.payload.chat.lastReaction)} emoji=${emoji}`)
        fetch(reactionUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ externalMsgId, emoji, isRemove: false }),
        }).catch(e => console.error('[App] opcode135 reaction sync error:', e.message))
      } else {
        console.log(`[App] opcode135 skip own-reaction echo: msgId=${externalMsgId}`)
      }
    }
    // Логируем остальные неизвестные push-опкоды
    const KNOWN_OPCODES = new Set([6, 19, 32, 48, 49, 64, 65, 75, 80, 82, 83, 87, 88, 128, 130, 132, 135, 155, 178, 179, 180, 288])
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

      console.log('[App] WS reconnected, userId:', userId, '— catch-up...')
      const result = await initialSync.runIfNeeded('from_connection_time')
      console.log('[App] Reconnect catch-up:', result)
      return
    }

    console.log('[App] WS auth OK, userId:', userId)
    isReady = true
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
app.post('/send-message', async (req, res) => {
  let { chatId, message, phone, quotedMsgId } = req.body
  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }
  if (!chatId && !phone) {
    return res.status(400).json({ error: 'chatId or phone is required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }

  // Detect if chatId looks like a phone number (10+ digits)
  // MAX internal userIds are smaller numbers (typically 6-9 digits)
  const chatIdStr = String(chatId || '')
  const digits = chatIdStr.replace(/\D/g, '')
  const looksLikePhone = digits.length >= 10

  if (looksLikePhone) {
    // Must resolve phone → MAX internal userId before sending
    const fromStore = contactStore ? contactStore.findByPhone(digits) : null
    if (fromStore) {
      console.log(`[Send] contactStore: ${digits} → chatId ${fromStore}`)
      chatId = fromStore
    } else {
      const liveId = await resolvePhoneLive(digits)
      if (liveId) {
        console.log(`[Send] live-resolved: ${digits} → chatId ${liveId}`)
        chatId = liveId
        // Cache for subsequent sends in this session
        if (contactStore) contactStore._map.set(liveId, { name: null, firstName: null, lastName: null, phone: digits })
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
        if (data.opcode === 128 && data.payload?.message?.id && data.payload.chatId) {
          const sender = String(data.payload.message.sender || '')
          if (sender === transport._myUserId) {
            const idx = transport._rawHandlers.indexOf(echoRawHandler)
            if (idx > -1) transport._rawHandlers.splice(idx, 1)
            echoRawHandler = null
            resolve(String(data.payload.chatId))
          }
        }
      }
      transport._rawHandlers.push(echoRawHandler)
    })

    try {
      const maxMsgId = await enqueueSend(() => sendText(transport, Number(chatId), message, quotedMsgId))

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
      if (echoConvId && echoConvId !== String(chatId)) {
        console.log(`[Send] Conversation ID from echo: ${chatId} → ${echoConvId}`)
      }
      res.json({ success: true, chatId: returnChatId, externalId: maxMsgId || null })
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
    const maxMsgId = await enqueueSend(() => sendText(transport, Number(chatId), message, quotedMsgId))
    res.json({ success: true, chatId: String(chatId), externalId: maxMsgId || null })
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
  try {
    if (remove) {
      await removeReaction(transport, Number(chatId), messageId)
    } else {
      // Помечаем как нашу собственную реакцию чтобы opcode 135 echo не дублировал обновление
      recentOwnReactionIds.add(String(messageId))
      setTimeout(() => recentOwnReactionIds.delete(String(messageId)), 8000)
      await sendReaction(transport, Number(chatId), messageId, emoji)
    }
    res.json({ success: true })
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
  const { chatId, base64, filename, mimeType, caption } = req.body
  if (!chatId || !base64 || !filename || !mimeType) {
    return res.status(400).json({ error: 'chatId, base64, filename, mimeType are required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  try {
    const fileBuffer = Buffer.from(base64, 'base64')
    const externalId = await enqueueSend(() =>
      sendImage(transport, page, Number(chatId), fileBuffer, filename, mimeType, caption)
    )
    res.json({ success: true, externalId: externalId || null })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Универсальный endpoint для отправки любого медиа
// mediaType: 'image' | 'video' | 'document' | 'audio' | 'voice'
app.post('/send-media', async (req, res) => {
  const { chatId, base64, filename, mimeType, caption, mediaType } = req.body
  if (!chatId || !base64 || !filename || !mimeType || !mediaType) {
    return res.status(400).json({ error: 'chatId, base64, filename, mimeType, mediaType are required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  try {
    const fileBuffer = Buffer.from(base64, 'base64')
    const cid = Number(chatId)

    const externalId = await enqueueSend(async () => {
      if (mediaType === 'image' || mimeType.startsWith('image/')) {
        return sendImage(transport, page, cid, fileBuffer, filename, mimeType, caption)
      } else if (mediaType === 'video' || mimeType.startsWith('video/')) {
        return sendVideo(transport, cid, fileBuffer, filename, mimeType, caption)
      } else {
        // document, audio, voice, OGG, PDF — all go via opcode 87
        return sendFile(transport, cid, fileBuffer, filename, mimeType, caption)
      }
    })

    res.json({ success: true, externalId: externalId || null })
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
  })
})

app.get('/qr', (req, res) => {
  const qrPath = path.join(__dirname, 'last_qr.png')
  res.sendFile(qrPath, { dotfiles: 'allow' }, err => { if (err) res.status(404).json({ error: 'QR not found' }) })
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
