'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
}

test('reachability pre-check supports MAX and never turns operational failure into green success', () => {
  const route = read('gravity-mvp/src/app/api/channels/check-reachability/route.ts')

  assert.match(route, /type CheckChannel = 'telegram' \| 'whatsapp' \| 'max'/)
  assert.match(route, /return channel === 'telegram' \|\| channel === 'whatsapp' \|\| channel === 'max'/)
  assert.match(route, /checkMaxReachability\(phone\)/)
  assert.match(route, /status: 'checking'/)
  assert.match(route, /reachable: null/)
  assert.match(route, /retryable: extra\.retryable \?\? true/)
  assert.doesNotMatch(route, /return NextResponse\.json\(\{ reachable: true \}\)/)
})

test('MAX scraper exposes dry-run reachability endpoint without sending messages', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /app\.post\('\/check-reachability'/)
  assert.match(scraper, /resolvePhoneLive\(digits\)/)
  assert.match(scraper, /status: 'confirmed'/)
  assert.match(scraper, /status: 'unreachable'/)
  assert.match(scraper, /status: 'checking'/)

  const checkEndpointStart = scraper.indexOf("app.post('/check-reachability'")
  const sendEndpointStart = scraper.indexOf("app.post('/send-message'")
  assert.ok(checkEndpointStart >= 0, 'missing /check-reachability endpoint')
  assert.ok(sendEndpointStart > checkEndpointStart, 'reachability endpoint must be separate from send-message')
  const checkEndpoint = scraper.slice(checkEndpointStart, sendEndpointStart)
  assert.doesNotMatch(checkEndpoint, /sendTextMessage|messageSent|quotedMsgId/)
})

test('outbound sent status does not confirm provider account reachability', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assert.match(messageService, /if \(deliveryStatus === 'failed'\)/)
  assert.match(messageService, /else if \(deliveryStatus === 'delivered'\)/)
  assert.doesNotMatch(messageService, /deliveryStatus === 'delivered' \|\| deliveryStatus === 'sent'/)
})

test('new chat reachability UI checks MAX and reserves green for confirmed status', () => {
  const popover = read('gravity-mvp/src/app/messages/components/NewChatPopover.tsx')

  assert.match(popover, /dbChannel === 'telegram' \|\| dbChannel === 'whatsapp' \|\| dbChannel === 'max'/)
  assert.match(popover, /const normalized: ReachabilityState/)
  assert.match(popover, /normalized\.status === 'checking' \|\| normalized\.reachable === null/)
  assert.match(popover, /i\.reachabilityStatus === 'confirmed'/)
  assert.match(popover, /reachability\?\.status === 'confirmed'/)
  assert.match(popover, /reachability\?\.status === 'checking'/)
  assert.match(popover, /reachability\?\.status === 'unreachable'/)
  assert.doesNotMatch(popover, /const hasIdentity = !focusedContact \|\| focusedChannels\.has/)
})

test('channel tabs do not render CRM chat presence as green reachability', () => {
  const tabs = read('gravity-mvp/src/app/messages/components/ChatChannelTabs.tsx')

  assert.match(tabs, /showKnownChannelDot/)
  assert.match(tabs, /bg-gray-300" title="канал есть в CRM"/)
  assert.doesNotMatch(tabs, /showGreenDot/)
  assert.doesNotMatch(tabs, /showRedBlocked/)
  assert.doesNotMatch(tabs, /bg-emerald-500" title="канал активен"/)
  assert.doesNotMatch(tabs, /title="нет в этом канале"/)
})

test('contact profile shows explicit account reachability text and retries checking state', () => {
  const drawer = read('gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx')

  assert.match(drawer, /const checkChannels = \['telegram', 'whatsapp', 'max'\] as const/)
  assert.match(drawer, /nextStatus === 'checking' && data\.retryable !== false/)
  assert.match(drawer, /retryTimers\.push\(setTimeout\(\(\) => \{ if \(!cancelled\) runCheck\(channel\) \}, 5_000\)\)/)
  assert.match(drawer, /const reachabilityBadge = \(reachable: boolean \| null, live\?: LiveReachabilityEntry\) =>/)
  assert.match(drawer, /label: 'есть'/)
  assert.match(drawer, /label: 'нет'/)
  assert.match(drawer, /label: 'проверяем'/)
  assert.match(drawer, /label: 'нет связи'/)
})

test('WhatsApp reachability never converts operational fallback into account found', () => {
  const service = read('gravity-mvp/src/lib/whatsapp/WhatsAppService.ts')
  const route = read('gravity-mvp/src/app/api/channels/check-reachability/route.ts')

  assert.match(service, /reachable: boolean \| null/)
  assert.match(service, /waReachabilityChecking\('WhatsApp не подключён в CRM', 'no_ready_connection', false\)/)
  assert.match(service, /wa_reachability_client_not_ready/)
  assert.match(service, /initializeClient\(connId\)\.catch/)
  assert.match(service, /waReachabilityChecking\('WhatsApp не ответил за 8 секунд', 'timeout', true\)/)
  assert.doesNotMatch(service, /return \{ reachable: true \} \/\/ No ready connection/)
  assert.doesNotMatch(service, /return \{ reachable: true \} \/\/ Client not initialized/)
  assert.match(route, /retryable: result\.retryable !== false/)
  assert.match(route, /errorCode: result\.reason/)
})
