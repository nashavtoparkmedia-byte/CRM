/**
 * MAX Web Scraper — Фаза 0: Discovery
 *
 * Запуск: node discovery/discover.js
 *
 * Что делает:
 *   - Перехватывает все HTTP request/response к max.ru / vk.com
 *   - Перехватывает WebSocket фреймы (через page.on + CDP)
 *   - Перехватывает SSE события
 *   - Пишет всё в discovery/traces/trace.jsonl
 *
 * Управление из консоли (нажать цифру + Enter перед действием в браузере):
 *   1 → outgoing_text
 *   2 → incoming_text
 *   3 → outgoing_image
 *   4 → incoming_image
 *   5 → open_chat        (открыть конкретный чат)
 *   6 → scroll_history   (скроллить историю вверх)
 *   7 → reload_page
 *   q → quit
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { chromium } = require('playwright')
const fs           = require('fs')
const path         = require('path')
const readline     = require('readline')

const USER_DATA_DIR = path.join(__dirname, '..', 'user_data')
const TRACE_DIR     = path.join(__dirname, 'traces')
const TRACE_FILE    = path.join(TRACE_DIR, 'trace.jsonl')

fs.mkdirSync(TRACE_DIR, { recursive: true })

// Текущий сценарий — меняется через консоль
let currentScenario = 'idle'
let wsUrls = new Set()

// ─── Логирование ───────────────────────────────────────────────────────────

function log(entry) {
  const line = JSON.stringify({
    ts:       Date.now(),
    scenario: currentScenario,
    ...entry
  })
  fs.appendFileSync(TRACE_FILE, line + '\n')
}

function print(msg) {
  process.stdout.write(msg + '\n')
}

// ─── Фильтр — только MAX/VK трафик, без статики ──────────────────────────

function isRelevant(url) {
  if (!url.includes('max.ru') && !url.includes('vk.com') && !url.includes('myteam')) return false
  if (url.match(/\.(js|css|png|ico|woff|woff2|svg|jpg|jpeg|gif|webp|ttf|otf|map)(\?|$)/)) return false
  return true
}

// ─── Главная функция ──────────────────────────────────────────────────────

;(async () => {
  print('\n[Discovery] Запуск браузера...')

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  })

  const page = context.pages()[0] || await context.newPage()

  // Скрываем webdriver
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  // ── HTTP requests ──────────────────────────────────────────────────────

  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = req.url()

    if (isRelevant(url)) {
      log({
        kind:    'http_req',
        method:  req.method(),
        url,
        headers: req.headers(),
        body:    req.postData() || null
      })
      print(`→ ${req.method()} ${url.slice(0, 120)}`)
    }

    route.continue()
  })

  // ── HTTP responses ─────────────────────────────────────────────────────

  page.on('response', async (resp) => {
    const url = resp.url()
    if (!isRelevant(url)) return

    let body = null
    try {
      const text = await resp.text()
      if (text.startsWith('{') || text.startsWith('[')) {
        body = JSON.parse(text)
      } else if (text.length < 1000) {
        body = text
      } else {
        body = text.slice(0, 500) + '...[truncated]'
      }
    } catch {}

    log({
      kind:        'http_resp',
      url,
      status:      resp.status(),
      contentType: resp.headers()['content-type'] || null,
      body
    })

    if (resp.status() >= 400) {
      print(`← ${resp.status()} ${url.slice(0, 120)}`)
    }
  })

  // ── WebSocket (page.on — для новых соединений) ─────────────────────────

  page.on('websocket', (ws) => {
    const wsUrl = ws.url()
    if (!wsUrls.has(wsUrl)) {
      wsUrls.add(wsUrl)
      print(`\n🔌 WS CONNECT: ${wsUrl}`)
      log({ kind: 'ws_open', url: wsUrl })
    }

    ws.on('framereceived', ({ payload }) => {
      const isBin = Buffer.isBuffer(payload)
      const preview = isBin
        ? `[binary ${payload.length} bytes]`
        : String(payload).slice(0, 300)

      log({
        kind:      'ws_in',
        is_binary: isBin,
        payload:   isBin ? `[binary ${payload.length}b]` : String(payload).slice(0, 3000)
      })

      if (!isBin) {
        print(`← WS: ${preview}`)
      }
    })

    ws.on('framesent', ({ payload }) => {
      const isBin = Buffer.isBuffer(payload)
      log({
        kind:      'ws_out',
        is_binary: isBin,
        payload:   isBin ? `[binary ${payload.length}b]` : String(payload).slice(0, 3000)
      })

      if (!isBin) {
        print(`→ WS: ${String(payload).slice(0, 200)}`)
      }
    })

    ws.on('close', () => {
      print(`🔌 WS CLOSE: ${wsUrl}`)
      log({ kind: 'ws_close', url: wsUrl })
    })
  })

  // ── CDP — ловит WS для уже открытых соединений + SSE ──────────────────

  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')

  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    if (!wsUrls.has(url)) {
      print(`\n🔌 CDP WS OPEN: ${url}`)
      log({ kind: 'ws_open_cdp', url, requestId })
    }
  })

  cdp.on('Network.webSocketFrameReceived', ({ requestId, timestamp, response }) => {
    if (!response.payloadData) return
    const payload = response.payloadData
    const isBin = response.opcode === 2

    log({
      kind:        'ws_in_cdp',
      requestId,
      is_binary:   isBin,
      payload:     isBin ? `[binary]` : payload.slice(0, 3000)
    })
  })

  cdp.on('Network.webSocketFrameSent', ({ requestId, timestamp, response }) => {
    if (!response.payloadData) return
    log({
      kind:      'ws_out_cdp',
      requestId,
      payload:   response.payloadData.slice(0, 3000)
    })
  })

  cdp.on('Network.eventSourceMessageReceived', (e) => {
    print(`← SSE: ${e.eventName} | ${e.data.slice(0, 200)}`)
    log({
      kind:      'sse',
      eventId:   e.eventId,
      eventName: e.eventName,
      data:      e.data
    })
  })

  // ── Навигация ──────────────────────────────────────────────────────────

  print('[Discovery] Открываем web.max.ru...')
  log({ kind: 'session_start' })

  try {
    await page.goto('https://web.max.ru/', {
      waitUntil: 'networkidle',
      timeout:   60000
    })
  } catch (e) {
    print(`[Discovery] Timeout при загрузке: ${e.message}`)
  }

  print('\n[Discovery] Браузер готов.')
  print('─────────────────────────────────────────────')
  print('Управление сценариями (нажми цифру + Enter):')
  print('  1 → outgoing_text    — перед отправкой текста')
  print('  2 → incoming_text    — перед получением текста')
  print('  3 → outgoing_image   — перед отправкой фото')
  print('  4 → incoming_image   — перед получением фото')
  print('  5 → open_chat        — перед открытием чата')
  print('  6 → scroll_history   — перед скроллом истории вверх')
  print('  7 → reload_page      — перед перезагрузкой')
  print('  q → quit')
  print('─────────────────────────────────────────────')
  print(`Трейс пишется в: ${TRACE_FILE}\n`)

  // ── CLI управление ─────────────────────────────────────────────────────

  const SCENARIO_MAP = {
    '1': 'outgoing_text',
    '2': 'incoming_text',
    '3': 'outgoing_image',
    '4': 'incoming_image',
    '5': 'open_chat',
    '6': 'scroll_history',
    '7': 'reload_page'
  }

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout
  })

  rl.on('line', async (input) => {
    const key = input.trim()

    if (SCENARIO_MAP[key]) {
      currentScenario = SCENARIO_MAP[key]
      log({ kind: 'scenario_change', scenario: currentScenario })
      print(`\n✓ Сценарий: ${currentScenario} — теперь выполни действие в браузере\n`)
      return
    }

    if (key === 'q') {
      print('[Discovery] Завершение...')
      log({ kind: 'session_end' })
      await context.close()
      process.exit(0)
    }

    if (key === 's') {
      // Статус — показать что поймано
      const lines = fs.existsSync(TRACE_FILE)
        ? fs.readFileSync(TRACE_FILE, 'utf8').trim().split('\n').length
        : 0
      print(`[Discovery] Записано событий: ${lines}`)
      print(`[Discovery] WS соединений: ${wsUrls.size}`)
      print(`[Discovery] Текущий сценарий: ${currentScenario}`)
    }
  })

  // Держим процесс живым
  await new Promise(() => {})
})()
