'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  assert.notEqual(firstIndex, -1, `${message}: missing ${first}`)
  assert.notEqual(secondIndex, -1, `${message}: missing ${second}`)
  assert.ok(firstIndex < secondIndex, message)
}

function assertBeforeAfter(source, anchor, first, second, message) {
  const anchorIndex = source.indexOf(anchor)
  assert.notEqual(anchorIndex, -1, `${message}: missing anchor ${anchor}`)
  const firstIndex = source.indexOf(first, anchorIndex)
  const secondIndex = source.indexOf(second, anchorIndex)
  assert.notEqual(firstIndex, -1, `${message}: missing ${first}`)
  assert.notEqual(secondIndex, -1, `${message}: missing ${second}`)
  assert.ok(firstIndex < secondIndex, message)
}

test('MAX UI media send fills and verifies caption before clicking send', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /async function fillMaxMediaCaption\(caption\)/)
  assert.match(scraper, /\[role="dialog"\] textarea/)
  assert.match(scraper, /\[role="dialog"\] div\[contenteditable="true"\]/)
  assert.match(scraper, /\[role="dialog"\] div\[contenteditable\]/)
  assert.ok(scraper.includes('div[contenteditable][role="textbox"]'))
  assert.ok(scraper.includes('const editableInput = \'input:not([type="file"]):not([type="search"])'))
  assert.ok(scraper.includes('`[role="dialog"] ${editableInput}`'))
  assert.ok(scraper.includes('`[aria-modal="true"] ${editableInput}`'))
  assert.match(scraper, /placeholder\*="Caption"/)
  assert.ok(scraper.includes('placeholder*="\\u041f\\u043e\\u0434\\u043f\\u0438\\u0441"'))
  assert.ok(scraper.includes('`${editableInput}[placeholder*="Caption" i]`'))
  assert.ok(scraper.includes('`${editableInput}[placeholder*="Message" i]`'))
  assert.ok(scraper.includes('editableInput,'))
  assert.ok(scraper.includes('`${editableInput}[placeholder*="\\u041f\\u043e\\u0434\\u043f\\u0438\\u0441" i]`'))
  assert.ok(scraper.includes('editableInput,'))
  assert.ok(scraper.includes('blocked_hint:'))
  assert.ok(scraper.includes('generic_input_without_media_context'))
  assert.ok(scraper.includes('caption candidate rejected'))
  assert.match(scraper, /async function fillEditableText\(locator, value\)/)
  assert.match(scraper, /locator\.fill\(text/)
  assert.match(scraper, /page\.keyboard\.insertText\(text\)/)
  assert.match(scraper, /String\(actual \|\| ''\)\.includes\(text\)/)
  assert.match(scraper, /const actual = await fillEditableText\(locator, text\)/)
  assert.match(scraper, /caption_input_not_found_or_not_updated/)
  assert.match(scraper, /captionResult = await fillMaxMediaCaption\(caption\)/)
  assert.match(scraper, /captionResult\.error \|\| 'caption_not_filled'/)
  assert.match(scraper, /max_send_media_caption_failed\.png/)

  assertBeforeAfter(
    scraper,
    'async function sendMediaViaUi',
    'const captionResult = await fillMaxMediaCaption(caption)',
    'let echoPromise = waitForUiMediaEcho',
    'caption must be filled before arming send/echo handling',
  )
  assertBeforeAfter(
    scraper,
    'async function sendMediaViaUi',
    'const captionResult = await fillMaxMediaCaption(caption)',
    'const sendSelectors = [',
    'caption must be filled before locating the send button',
  )
  assertBeforeAfter(
    scraper,
    'const captionResult = await fillMaxMediaCaption(caption)',
    "status: 'failed'",
    'return false',
    'caption failure must stop sendMediaViaUi instead of sending an image without text',
  )
})

test('MAX image captions are routed through UI media send instead of native image send', () => {
  const scraper = read('max-web-scraper/index.js')
  const routeStart = scraper.indexOf("app.post('/send-media'")
  assert.notEqual(routeStart, -1, 'missing /send-media route')
  const debugStart = scraper.indexOf('// Debug: list contacts', routeStart)
  assert.notEqual(debugStart, -1, 'missing route end anchor')
  const sendMediaRoute = scraper.slice(routeStart, debugStart)

  assert.match(sendMediaRoute, /const hasCaption = String\(caption \|\| ''\)\.trim\(\)\.length > 0/)
  assert.match(sendMediaRoute, /const shouldPreferUiMedia = \(mediaType === 'image' \|\| mimeType\.startsWith\('image\/'\)\) && \(hasCaption \|\| phone \|\| uiChatId \|\| UI_CHAT_ID_OVERRIDES\[String\(chatId\)\]\)/)
  assert.match(sendMediaRoute, /if \(!uiRouteId && hasCaption\) uiRouteId = cid/)
  assertBefore(
    sendMediaRoute,
    'const uiSent = await sendMediaViaUi(uiRouteId, fileBuffer, filename, mimeType, caption, transport)',
    'return await sendImage(transport, page, cid, fileBuffer, filename, mimeType, caption)',
    'image captions must try UI media send before native image send',
  )
})

test('CRM send-media proves the exact MAX identity and transport without heuristic routing', () => {
  const route = read('gravity-mvp/src/app/api/messages/send-media/route.ts')

  assert.match(route, /captionLength=\$\{String\(caption \|\| ''\)\.trim\(\)\.length\}/)
  assert.doesNotMatch(route, /caption=\$\{caption\}/)
  assert.match(route, /prepareOutboundConversationV1\(chat, profileId\)/)
  assert.match(route, /chatId: outbound\.target/)
  assert.match(route, /providerAccountId: outbound\.providerAccountId/)
  assert.match(route, /connectionId: outbound\.connectionId/)
  assert.match(route, /isPersonal: outbound\.isMaxPersonal/)
  assert.doesNotMatch(route, /driver\?\.(?:phone|telegramId)|maxPhone|uiChatId:/)
  assertBefore(
    route,
    'await prepareOutboundConversationV1(chat, profileId)',
    'getMaxChannelDeliveryV1().sendMedia',
    'identity/account/transport proof must precede MAX media delivery',
  )
  assertBefore(
    route,
    'await prepareOutboundConversationV1(chat, profileId)',
    'prisma.message.create',
    'identity/account/transport proof must precede local Message mutation',
  )
})


test('MAX image captions do not fall back to native media send when UI caption path fails', () => {
  const scraper = read('max-web-scraper/index.js')
  const routeStart = scraper.indexOf("app.post('/send-media'")
  assert.notEqual(routeStart, -1, 'missing /send-media route')
  const debugStart = scraper.indexOf('// Debug: list contacts', routeStart)
  assert.notEqual(debugStart, -1, 'missing route end anchor')
  const sendMediaRoute = scraper.slice(routeStart, debugStart)

  assert.match(sendMediaRoute, /if \(hasCaption\) throw new Error\('caption_ui_media_send_failed'\)/)
  assert.match(sendMediaRoute, /if \(hasCaption\) throw uiFirstErr/)
  assert.match(sendMediaRoute, /throw new Error\('caption_ui_media_send_unavailable'\)/)
  assertBefore(
    sendMediaRoute,
    "if (hasCaption && (mediaType === 'image' || mimeType.startsWith('image/'))) {",
    'return await sendImage(transport, page, cid, fileBuffer, filename, mimeType, caption)',
    'image captions must fail instead of falling back to native image send without text',
  )
})
