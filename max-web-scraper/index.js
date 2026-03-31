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
const { ContactStore }             = require('./contacts/ContactStore')
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

let importSession = null  // { jobId, crmApiUrl, startedAt, messagesImported, chatsSet }

function startImportSession(jobId, crmApiUrl) {
  importSession = { jobId, crmApiUrl, startedAt: Date.now(), messagesImported: 0, chatsSet: new Set() }
}

function trackImportedMessage(chatId) {
  if (!importSession) return
  importSession.messagesImported++
  if (chatId) importSession.chatsSet.add(String(chatId))
}

async function finishImportSession(status = 'completed', resultType = 'partial') {
  if (!importSession) return
  const { jobId, crmApiUrl, startedAt, messagesImported, chatsSet } = importSession
  importSession = null

  if (!jobId || !crmApiUrl) return

  const body = JSON.stringify({
    status,
    resultType,
    messagesImported,
    chatsScanned:    chatsSet.size,
    contactsFound:   contactStore ? contactStore._map.size : 0,
    startedAt:       new Date(startedAt).toISOString(),
    finishedAt:      new Date().toISOString(),
    coveredPeriodFrom: new Date(startedAt).toISOString(),
    coveredPeriodTo:   new Date().toISOString(),
  })

  try {
    const url = new URL(`${crmApiUrl}/api/import-jobs/${jobId}`)
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
  trackImportedMessage(payload.chatId)
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

async function handleIncoming(msg, mediaPipeline, messageSync) {
  if (msg.isOutgoing) return
  if (messageSync.isDuplicate(msg)) return

  let payload = MessageParser.toCrmPayload(msg)

  // Добавляем имя и телефон контакта из ContactStore
  const senderName  = contactStore.getName(payload.senderId)
  const senderPhone = contactStore.getPhone(payload.senderId)
  if (senderName)  payload = { ...payload, senderName }
  if (senderPhone) payload = { ...payload, senderPhone }

  // Скачиваем вложения
  if (msg.attachments && msg.attachments.length > 0) {
    const downloaded = []
    for (const att of msg.attachments) {
      if (!att.url) { downloaded.push(att); continue }
      try {
        const file = await mediaPipeline.downloadAttachment(att.url, att.mimeType)
        downloaded.push({ ...att, localPath: file.localPath, size: file.size })
      } catch (e) {
        console.error('[App] Ошибка скачивания вложения:', e.message)
        downloaded.push(att)
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

async function sendText(transport, chatId, text) {
  const cid = -Date.now()
  await transport.sendFrame(OP.SEND_MESSAGE, {
    chatId,
    message: { text, cid, elements: [], attaches: [] },
    notify:  true,
  })
}

// ─── Отправка изображения: opcode 80 → HTTP upload → opcode 64 ───────────────

async function sendImage(transport, page, chatId, fileBuffer, filename, mimeType, caption) {
  // 1. Запросить URL для загрузки
  const uploadResp = await transport.sendFrame(
    OP.GET_UPLOAD_URL,
    { count: 1 },
    { waitResponse: true }
  )

  if (!uploadResp || !uploadResp.url) {
    throw new Error('Не получен URL для загрузки фото')
  }

  const uploadUrl = uploadResp.url

  // 2. Загрузить файл напрямую из Node.js (apiToken уже в URL — куки не нужны)
  const uploadData = await new Promise((resolve, reject) => {
    const boundary = '----MaxBoundary' + Date.now()
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    )
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([header, fileBuffer, footer])

    const urlObj = new URL(uploadUrl)
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }

    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        console.log('[sendImage] Upload status:', res.statusCode, 'response:', data.slice(0, 300))
        if (res.statusCode >= 400) { reject(new Error(`Upload HTTP ${res.statusCode}: ${data}`)); return }
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  // photoToken приходит из ответа: {"photos": {"<key>": {"token": "..."}}}
  const photoToken = uploadData?.photoToken
    || uploadData?.token
    || (uploadData?.photos && Object.values(uploadData.photos)[0]?.token)
  if (!photoToken) throw new Error(`photoToken не найден в ответе: ${JSON.stringify(uploadData)}`)

  // 3. Отправить сообщение с фото
  const cid = -Date.now()
  await transport.sendFrame(OP.SEND_MESSAGE, {
    chatId,
    message: {
      cid,
      text:    caption || '',
      attaches: [{ _type: 'PHOTO', photoToken }],
    },
    notify: true,
  })
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

  console.log('[App] Завершение процесса')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ─── Инициализация ───────────────────────────────────────────────────────────

const session      = new SessionController()
const transport    = new TransportInterceptor()
const sync         = new MessageSync()
const contactStore = new ContactStore()

const chatCache = new Map()  // chatId → chat object (собирается из opcode 48 при старте)

let page          = null
let mediaPipeline = null
let initialSync   = null
let isReady       = false

// Exponential backoff для WS reconnect
let _reconnectCount    = 0
let _lastReconnectAt   = 0
let _reconnectDelay    = 0

async function init() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
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
  initialSync   = new InitialHistorySync(transport, sync, forwardToWebhook, mediaPipeline, chatCache)

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
  })

  transport.onMessage(msg => {
    handleIncoming(msg, mediaPipeline, sync).catch(e =>
      console.error('[App] handleIncoming error:', e.message)
    )
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
    console.log('[App] Сессия завершена')
  })

  // Ждём авторизацию: если WS auth не пришёл — покажем QR
  await session.checkAndWaitForLogin()
}

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Отправить текст
// Body: { chatId: number, message: string }
app.post('/send-message', async (req, res) => {
  const { chatId, message } = req.body
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' })
  }
  if (!isReady) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }
  try {
    await enqueueSend(() => sendText(transport, Number(chatId), message))
    res.json({ success: true })
  } catch (e) {
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
    await enqueueSend(() =>
      sendImage(transport, page, Number(chatId), fileBuffer, filename, mimeType, caption)
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
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
  res.sendFile(qrPath, err => { if (err) res.status(404).json({ error: 'QR not found' }) })
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
      const importMode = mode === 'last_n_days' ? 'from_connection_time' : mode
      await initialSync.runIfNeeded(importMode)
      await finishImportSession('completed', mode === 'available_history' ? 'full' : 'partial')
    } catch (e) {
      console.error('[Import] Ошибка:', e.message)
      await finishImportSession('failed', 'failed')
    }
  })()
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
