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
  assert.match(route, /checkMaxReachability\(phone, requestedProviderAccountId\)/)
  assert.match(route, /contactReachabilityV1\.recordExactProviderReachability\(\{/)
  assert.doesNotMatch(route, /findIdentityByPhoneAndChannel/)
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
  assert.match(checkEndpoint, /requireLiveMaxProviderAccount\(req, res\)/)
  assert.match(checkEndpoint, /providerAccountId/)
  assert.doesNotMatch(checkEndpoint, /sendTextMessage|messageSent|quotedMsgId/)
})

test('MAX scraper derives webhook account from the authenticated transport and signs ingress', () => {
  const scraper = read('max-web-scraper/index.js')
  const start = scraper.indexOf('async function forwardToWebhook(payload)')
  const end = scraper.indexOf('\nasync function', start + 1)
  const forwarder = scraper.slice(start, end)

  assert.ok(start >= 0, 'missing webhook forwarder')
  assert.match(forwarder, /throw new Error\('MAX_PROVIDER_ACCOUNT_UNPROVEN'\)/)
  assert.match(forwarder, /accountId: providerAccountId/)
  assert.match(forwarder, /liveAuthenticatedMaxProviderAccountId\(\)/)
  assert.match(forwarder, /MAX_PROVIDER_ACCOUNT_MISMATCH/)
  assert.match(forwarder, /maxScraperWebhookHeaders\(\)/)
  assert.doesNotMatch(forwarder, /MAX_ACCOUNT_ID|MAX_CONNECTION_ID/)
  assert.doesNotMatch(forwarder, /max-default/)
})

test('every MAX scraper outbound mutation requires and echoes its exact live account', () => {
  const scraper = read('max-web-scraper/index.js')
  const routeNames = ['send-message', 'send-reaction', 'delete-message', 'send-image', 'send-media']

  for (const [index, routeName] of routeNames.entries()) {
    const start = scraper.indexOf(`app.post('/${routeName}'`)
    const nextStart = index + 1 < routeNames.length
      ? scraper.indexOf(`app.post('/${routeNames[index + 1]}'`, start + 1)
      : scraper.indexOf("app.get('/contacts'", start + 1)
    assert.ok(start >= 0, `missing /${routeName}`)
    assert.ok(nextStart > start, `could not bound /${routeName}`)
    const endpoint = scraper.slice(start, nextStart)
    assert.match(endpoint, /requireLiveMaxProviderAccount\(req, res\)/, `/${routeName} lacks live account guard`)
    assert.match(endpoint, /providerAccountId/, `/${routeName} does not echo live account proof`)
  }
})

test('MAX delivery is server-only and no bot path simulates success', () => {
  const actions = read('gravity-mvp/src/app/max-actions.ts')
  const capability = read('gravity-mvp/src/modules/max-channel/public/v1/messaging-delivery-capability.ts')
  const transport = read('gravity-mvp/src/modules/max-channel/application/messaging-transport.ts')

  assert.doesNotMatch(actions, /export async function sendMaxMessage|export async function sendMaxPersonalMessage/)
  assert.doesNotMatch(actions, /MAX BOT SIMULATION/)
  assert.match(capability, /max-channel\/application\/messaging-transport/)
  assert.doesNotMatch(capability, /@\/app\/max-actions/)
  assert.match(transport, /import 'server-only'/)
  assert.match(transport, /MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE/)
  assert.match(transport, /MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH/)
})

test('canonical MAX webhook requires the non-default scraper secret and legacy ingress is retired', () => {
  const canonical = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
  const legacy = read('gravity-mvp/src/app/api/webhook/max/route.ts')
  const auth = read('gravity-mvp/src/modules/max-channel/internal/scraper-webhook-auth.ts')

  assert.match(auth, /process\.env\.MAX_SCRAPER_WEBHOOK_SECRET/)
  assert.match(auth, /timingSafeEqual/)
  assert.doesNotMatch(auth, /\|\|\s*['"][^'"]+['"]/)
  const authIndex = canonical.indexOf('isAuthorizedMaxScraperWebhookV1')
  const bodyIndex = canonical.indexOf('await request.json') >= 0
    ? canonical.indexOf('await request.json')
    : canonical.indexOf('await req.json')
  assert.ok(authIndex >= 0)
  assert.ok(bodyIndex > authIndex, 'webhook must authorize before parsing or mutating')
  assert.match(canonical, /MAX_SCRAPER_WEBHOOK_UNAUTHORIZED/)
  assert.match(legacy, /MAX_LEGACY_WEBHOOK_RETIRED/)
  assert.match(legacy, /\/api\/webhooks\/max/)
  assert.doesNotMatch(legacy, /await\s+(?:request|req)\.json|externalChatId\s*=|phoneDigits/)
})

test('production provisions the MAX webhook secret to both services through the shared env file', () => {
  const envExample = read('.env.production.example')
  const compose = read('deploy/docker-compose.production.yml')

  assert.match(envExample, /^MAX_SCRAPER_WEBHOOK_SECRET=__GENERATE_WITH_openssl_rand_base64_32__$/m)
  const gravityService = compose.split('\n  gravity-mvp:')[1].split('\n  tg-bot:')[0]
  const scraperService = compose.split('\n  max-web-scraper:')[1].split('\nvolumes:')[0]
  assert.match(gravityService, /env_file:\s*\n\s*- \.\.\/\.env\.production/)
  assert.match(scraperService, /env_file:\s*\n\s*- \.\.\/\.env\.production/)
})

test('MAX reaction ingress is signed, account-bound, and exact-id only', () => {
  const scraper = read('max-web-scraper/index.js')
  const route = read('gravity-mvp/src/app/api/webhook/max/reaction/route.ts')

  assert.match(scraper, /forwardMaxReactionWebhook/)
  assert.match(scraper, /JSON\.stringify\(\{ \.\.\.payload, providerAccountId \}\)/)
  assert.match(route, /isAuthorizedMaxScraperWebhookV1/)
  assert.match(route, /MAX_PROVIDER_ACCOUNT_COLLISION/)
  assert.match(route, /findUnique/)
  assert.doesNotMatch(route, /findFirst|contains: suffix|compactId/)
})

test('outbound sent status does not confirm provider account reachability', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assert.match(messageService, /if \(deliveryStatus === 'delivered'\)/)
  assert.match(messageService, /contactReachabilityV1\.recordExactProviderReachability\(\{/)
  assert.match(messageService, /providerTargetId: outboundBinding\.identityTarget/)
  assert.doesNotMatch(messageService, /updateReachabilityByChatId/)
  assert.doesNotMatch(messageService, /status: 'unreachable'/)
  assert.doesNotMatch(messageService, /deliveryStatus === 'delivered' \|\| deliveryStatus === 'sent'/)
})

test('new chat reachability UI checks MAX and reserves green for confirmed status', () => {
  const popover = read('gravity-mvp/src/app/messages/components/NewChatPopover.tsx')

  assert.match(popover, /dbChannel === 'telegram' \|\| dbChannel === 'whatsapp' \|\| dbChannel === 'max'/)
  assert.match(popover, /const normalized: ReachabilityState/)
  assert.match(popover, /normalized\.status === 'checking' \|\| normalized\.reachable === null/)
  assert.match(popover, /body: JSON\.stringify\(\{ phone: phoneValue, channel: dbChannel \}\)/)
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
  assert.match(drawer, /identityId: identity\.id/)
  assert.match(drawer, /contactId: contact\.id/)
  assert.match(drawer, /body: JSON\.stringify\(\{ phone, channel, \.\.\.exactIdentityBinding \}\)/)
  assert.match(drawer, /item => item\.phoneId === phone\.id && item\.channel === channel/)
  assert.match(drawer, /reachabilityKey\(identity\.phoneId, identity\.channel, identity\.id\)/)
  assert.match(drawer, /nextStatus === 'checking' && data\.retryable !== false && attempt < 5/)
  assert.match(drawer, /runCheck\(phoneId, phone, channel, identity, attempt \+ 1\)/)
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
