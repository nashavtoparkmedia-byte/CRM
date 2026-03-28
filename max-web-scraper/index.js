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

// ─── Конфиг ──────────────────────────────────────────────────────────────────

const PORT            = process.env.PORT            || 3005
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/webhooks/max'
const MAX_URL         = 'https://web.max.ru/'
const USER_DATA_DIR   = path.join(__dirname, 'user_data')

// 'none' | 'from_connection_time' | 'available_history'
let HISTORY_IMPORT_MODE = process.env.HISTORY_IMPORT_MODE || 'from_connection_time'

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
    await forwardToWebhook(payload)
    console.log(`[App] → CRM: chatId=${payload.chatId} text="${(payload.text || '').slice(0, 50)}"`)
  } catch (e) {
    console.error('[App] Webhook forward failed:', e.message)
  }

  messageSync.markSeen(msg)
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

  const uploadUrl  = uploadResp.url
  const urlObj     = new URL(uploadUrl)
  const photoToken = urlObj.searchParams.get('photoIds')
  if (!photoToken) throw new Error('photoIds не найден в URL загрузки')

  // 2. Загрузить файл через page.evaluate (используем сессионные куки)
  const base64 = fileBuffer.toString('base64')
  const uploadResult = await page.evaluate(
    async ({ uploadUrl, base64, mimeType, filename }) => {
      try {
        const byteStr = atob(base64)
        const bytes   = new Uint8Array(byteStr.length)
        for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i)
        const blob = new Blob([bytes], { type: mimeType })
        const form = new FormData()
        form.append('photo', blob, filename)
        const resp = await fetch(uploadUrl, { method: 'POST', credentials: 'include', body: form })
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
    { uploadUrl, base64, mimeType, filename }
  )

  if (!uploadResult.ok) throw new Error(`Upload failed: ${uploadResult.error}`)

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

// ─── Инициализация ───────────────────────────────────────────────────────────

const session   = new SessionController()
const transport = new TransportInterceptor()
const sync      = new MessageSync()

let page          = null
let mediaPipeline = null
let initialSync   = null
let isReady       = false

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
  initialSync   = new InitialHistorySync(transport, sync, forwardToWebhook)

  transport.onMessage(msg => {
    handleIncoming(msg, mediaPipeline, sync).catch(e =>
      console.error('[App] handleIncoming error:', e.message)
    )
  })

  // 5. Авторизация
  session.attach(page, context)

  session.onAuth(async () => {
    console.log('[App] Авторизован — запускаем initial sync')
    isReady = true

    const syncResult = await initialSync.runIfNeeded(HISTORY_IMPORT_MODE)
    console.log('[App] Initial sync:', syncResult)
  })

  session.onLogout(() => {
    isReady = false
    console.log('[App] Сессия завершена')
  })

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
  res.json({ isReady, qrGenerated: qrExists, historyImportMode: HISTORY_IMPORT_MODE })
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

// ─── Старт ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[App] MAX Web Scraper запущен на порту ${PORT}`)
  console.log(`[App] History import mode: ${HISTORY_IMPORT_MODE}`)

  init().catch(e => {
    console.error('[App] Ошибка инициализации:', e.message)
    process.exit(1)
  })
})
