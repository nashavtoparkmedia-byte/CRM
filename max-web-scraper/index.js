'use strict'

require('dotenv').config()

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const cors    = require('cors')

const { SessionController }   = require('./session/SessionController')
const { TransportInterceptor } = require('./transport/TransportInterceptor')
const { MessageParser }        = require('./parser/MessageParser')
const { MediaPipeline }        = require('./media/MediaPipeline')
const { MessageSync }          = require('./sync/MessageSync')
const { InitialHistorySync, HISTORY_MODE } = require('./sync/InitialHistorySync')
const { ENDPOINTS }            = require('./transport/TransportInterceptor')

// ─── Конфиг ──────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT            || 3005
const CRM_WEBHOOK_URL  = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/webhooks/max'
const MAX_URL          = process.env.MAX_URL         || 'https://max.ru'

// Режим импорта истории — перезаписывается через POST /set-history-mode
// 'none' | 'from_connection_time' | 'available_history'
let HISTORY_IMPORT_MODE = process.env.HISTORY_IMPORT_MODE || 'from_connection_time'

// ─── Очередь отправки ────────────────────────────────────────────────────────

const sendQueue   = []
let   isSending   = false

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

const http  = require('http')
const https = require('https')

async function forwardToWebhook(payload) {
  const url    = new URL(CRM_WEBHOOK_URL)
  const body   = JSON.stringify(payload)
  const mod    = url.protocol === 'https:' ? https : http
  const options = {
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
    path:     url.pathname + url.search,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end',  () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── Обработка входящего сообщения ───────────────────────────────────────────

async function handleIncoming(msg, mediaPipeline, messageSync) {
  // Пропускаем исходящие
  if (msg.isOutgoing) return

  // Дедупликация
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
  } catch (e) {
    console.error('[App] Webhook forward failed:', e.message)
  }

  messageSync.markSeen(msg)
}

// ─── Catch-up при рестарте ────────────────────────────────────────────────────

async function runCatchUp(page, messageSync) {
  const since = Date.now() - 10 * 60 * 1000  // последние 10 минут
  console.log('[App] Запуск catch-up с', new Date(since).toISOString())

  const missed = await messageSync.fetchMissedMessages(page, since)
  console.log(`[App] Missed messages: ${missed.length}`)

  for (const msg of missed) {
    if (msg.isOutgoing) continue
    if (messageSync.isDuplicate(msg)) continue

    try {
      await forwardToWebhook(MessageParser.toCrmPayload(msg))
    } catch (e) {
      console.error('[App] Catch-up webhook error:', e.message)
    }
    messageSync.markSeen(msg)
  }
}

// ─── Отправка текста ─────────────────────────────────────────────────────────

async function sendText(page, phone, text) {
  if (!ENDPOINTS.sendText) throw new Error('sendText endpoint не заполнен — см. FINDINGS.md')

  const result = await page.evaluate(
    async ({ endpoint, phone, text }) => {
      try {
        const resp = await fetch(endpoint, {
          method:      'POST',
          credentials: 'include',
          headers:     { 'Content-Type': 'application/json' },
          body:        JSON.stringify({ phone, message: text })
        })
        if (!resp.ok) {
          const err = await resp.text().catch(() => '')
          return { ok: false, error: `HTTP ${resp.status}: ${err.slice(0, 200)}` }
        }
        return { ok: true, data: await resp.json() }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
    { endpoint: ENDPOINTS.sendText, phone, text }
  )

  if (!result.ok) throw new Error(`sendText failed: ${result.error}`)
  return result.data
}

// ─── Отправка изображения ────────────────────────────────────────────────────

async function sendImage(page, mediaPipeline, phone, fileBuffer, filename, mimeType, caption) {
  const uploadResult = await mediaPipeline.uploadFile(fileBuffer, filename, mimeType)

  if (!ENDPOINTS.sendMedia) throw new Error('sendMedia endpoint не заполнен — см. FINDINGS.md')

  const result = await page.evaluate(
    async ({ endpoint, phone, uploadResult, caption }) => {
      try {
        const body = { phone, caption: caption || '', ...uploadResult }
        const resp = await fetch(endpoint, {
          method:      'POST',
          credentials: 'include',
          headers:     { 'Content-Type': 'application/json' },
          body:        JSON.stringify(body)
        })
        if (!resp.ok) {
          const err = await resp.text().catch(() => '')
          return { ok: false, error: `HTTP ${resp.status}: ${err.slice(0, 200)}` }
        }
        return { ok: true, data: await resp.json() }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
    { endpoint: ENDPOINTS.sendMedia, phone, uploadResult, caption }
  )

  if (!result.ok) throw new Error(`sendImage failed: ${result.error}`)
  return result.data
}

// ─── Основная инициализация ──────────────────────────────────────────────────

const session   = new SessionController()
const transport = new TransportInterceptor()
const sync      = new MessageSync()

let page           = null
let mediaPipeline  = null
let initialSync    = null
let isReady        = false

async function init() {
  const { chromium } = require('playwright')

  const browser  = await chromium.launchPersistentContext(
    path.join(__dirname, 'user_data'),
    {
      headless:          false,
      args:              ['--no-sandbox', '--disable-setuid-sandbox'],
      viewport:          { width: 1280, height: 900 },
    }
  )

  page = await browser.newPage()

  mediaPipeline = new MediaPipeline(page)
  initialSync   = new InitialHistorySync(page, sync, forwardToWebhook)

  await transport.attach(page, browser)

  transport.onMessage(msg => {
    handleIncoming(msg, mediaPipeline, sync).catch(e =>
      console.error('[App] handleIncoming error:', e.message)
    )
  })

  await session.attach(page, MAX_URL)

  session.onAuth(async () => {
    console.log('[App] Авторизован — запускаем initial sync и catch-up')
    isReady = true

    await runCatchUp(page, sync)

    const syncResult = await initialSync.runIfNeeded(HISTORY_IMPORT_MODE)
    console.log('[App] Initial sync result:', syncResult)
  })

  session.onLogout(() => {
    isReady = false
    console.log('[App] Сессия завершена')
  })

  await session.start()
}

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Отправить текст
app.post('/send-message', async (req, res) => {
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' })
  }
  if (!isReady || !page) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }

  try {
    const data = await enqueueSend(() => sendText(page, phone, message))
    res.json({ success: true, data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Отправить изображение
app.post('/send-image', async (req, res) => {
  const { phone, base64, filename, mimeType, caption } = req.body
  if (!phone || !base64 || !filename || !mimeType) {
    return res.status(400).json({ error: 'phone, base64, filename, mimeType are required' })
  }
  if (!isReady || !page) {
    return res.status(503).json({ error: 'Not ready — ожидайте авторизации' })
  }

  try {
    const fileBuffer = Buffer.from(base64, 'base64')
    const data = await enqueueSend(() =>
      sendImage(page, mediaPipeline, phone, fileBuffer, filename, mimeType, caption)
    )
    res.json({ success: true, data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({
    status:  isReady ? 'ready' : 'initializing',
    isReady,
    queueLength: sendQueue.length,
  })
})

// Статус
app.get('/status', (req, res) => {
  const qrExists = fs.existsSync(path.join(__dirname, 'last_qr.png'))
  res.json({
    isReady,
    qrGenerated:       qrExists,
    historyImportMode: HISTORY_IMPORT_MODE,
  })
})

// QR код
app.get('/qr', (req, res) => {
  const qrPath = path.join(__dirname, 'last_qr.png')
  res.sendFile(qrPath, err => {
    if (err) res.status(404).json({ error: 'QR not found' })
  })
})

// Установить режим импорта истории
app.post('/set-history-mode', (req, res) => {
  const { mode } = req.body
  const valid = ['none', 'from_connection_time', 'available_history']
  if (!valid.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode. Use: ${valid.join(', ')}` })
  }
  HISTORY_IMPORT_MODE = mode
  console.log('[App] History import mode set to:', mode)
  res.json({ success: true, mode })
})

// Перезапуск сессии
app.post('/restart', async (req, res) => {
  try {
    InitialHistorySync.resetDoneFlag()
    await session.restart()
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Сброс флага синхронизации (без перезапуска)
app.post('/reset-sync', (req, res) => {
  InitialHistorySync.resetDoneFlag()
  res.json({ success: true, message: 'Sync flag reset — следующий запуск повторит initial sync' })
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
