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

test('MAX webhook text dedup happens by provider identity before chat workflow side effects', () => {
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')

  assert.match(route, /const externalIdString = externalId \? String\(externalId\) : null/)
  assert.match(route, /const isTextProviderEvent = isTextType && usableAttachments\.length === 0/)
  assert.match(route, /skipped: 'text_without_provider_identity'/)
  assert.match(route, /externalIdString\.startsWith\('max-dom-'\)/)
  assert.match(route, /externalIdString\.startsWith\('max-recovered-'\)/)
  assert.match(route, /const allowLiveDomTextRecovery = Boolean/)
  assert.match(route, /source === 'dom_fallback'/)
  assert.match(route, /!isHistoryReplay/)
  assert.match(route, /!isOutgoing/)
  assert.match(route, /trimmedText\.length > 0/)
  assert.match(route, /&& !allowLiveDomTextRecovery/)
  assert.match(route, /where: \{ externalId: externalIdString \}/)

  assertBefore(
    route,
    'const existingText = await prisma.message.findUnique',
    'ConversationWorkflowService.onInboundMessage',
    'replayed provider text must return before inbound workflow/unread changes',
  )
})

test('MAX webhook history/catch-up does not promote existing chats as new activity', () => {
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')

  assert.match(route, /const isHistoryReplay = source === 'history' \|\| source === 'catchup'/)
  assert.match(route, /!isOutgoing && !isHistoryReplay/)
  assert.match(route, /\.\.\.\(isHistoryReplay \? \{\} : \{ lastMessageAt: sentAt \}\)/)
  assert.match(route, /metadata:\s+\{[^\n]*\.\.\.\(source \? \{ source \} : \{\}\)/)
})

test('MAX history and catch-up payloads carry explicit source markers', () => {
  const initialSync = read('max-web-scraper/sync/InitialHistorySync.js')

  assert.match(initialSync, /source: 'history'/)
  assert.match(initialSync, /source: 'catchup'/)
  assertBeforeAfter(
    initialSync,
    'source: \'history\'',
    'source: \'history\'',
    'this._sync.markSeen(msg)',
    'history source marker must be attached before marking seen',
  )
  assertBeforeAfter(
    initialSync,
    'source: \'catchup\'',
    'source: \'catchup\'',
    'this._sync.markSeen(msg)',
    'catch-up source marker must be attached before marking seen',
  )
})

test('MAX outbound text delivery consumes only MAX-owned validated semantic outcomes', () => {
  const scraper = read('max-web-scraper/index.js')
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')
  const maxCapability = read('gravity-mvp/src/modules/max-channel/public/v1/messaging-delivery-capability.ts')
  const deliveryRuntime = read('gravity-mvp/src/modules/messaging/public/v1/channel-delivery-runtime.ts')

  assert.match(scraper, /deliveryConfirmed: sendResult\.deliveryConfirmed/)
  assert.match(scraper, /deliveryStatus: sendResult\.deliveryStatus/)
  assert.match(scraper, /deliveryProof: sendResult\.deliveryProof/)
  assert.match(scraper, /kind: 'ui_send_action'/)
  assert.match(scraper, /ackId && isRealMaxMessageId\(ackId\)/)

  assert.match(deliveryRuntime, /outcome: 'delivered' \| 'pending'/)
  assert.match(maxCapability, /function validateMaxTextDeliveryResultV1/)
  assert.match(maxCapability, /hasExplicitFailure \|\| hasExplicitError/)
  assert.match(maxCapability, /proof\.clientMessageId === expectedClientMessageId/)
  assert.match(messageService, /const maxDeliveryConfirmed = maxRes\.outcome === 'delivered'/)
  assert.match(messageService, /const maxDeliveryConfirmed = retryMaxRes\.outcome === 'delivered'/)
  assert.doesNotMatch(messageService, /\(maxRes as any\)\?\.deliveryStatus/)
  assert.match(messageService, /deliveryStatus = maxDeliveryConfirmed \? 'delivered' : 'sent'/)
})

test('MAX phone UI send correlation excludes pre-send and generic activity', () => {
  const scraper = read('max-web-scraper/index.js')
  const transport = read('max-web-scraper/transport/TransportInterceptor.js')

  assertBeforeAfter(
    scraper,
    'const composeTextBeforeSubmit',
    'const sendFrameStartIndex = capturedFrames.length',
    "await page.keyboard.press('Enter')",
    'phone UI collector cursor must be captured immediately before the send action',
  )
  assert.match(scraper, /evaluatePhoneResolutionUiSend\(\{/)
  assert.match(scraper, /postActionFrames: postSendFrames/)
  assert.match(transport, /deliveryConfirmed: false/)
  assert.match(transport, /chatId: null/)
  assert.doesNotMatch(scraper, /findCorrelatedUiTextSendEcho/)
  assert.doesNotMatch(scraper, /exact_text_submit_route_changed/)
  assert.doesNotMatch(scraper, /confirmationSource = echo\.source/)
  assert.match(scraper, /source: uiDeliveryConfirmed \? 'ui_resolve_send' : 'ui_resolve_send_unconfirmed'/)
  assert.doesNotMatch(scraper, /messageSent: true/)
  assertBeforeAfter(
    scraper,
    'const liveResult = await resolvePhoneLive(digits, message)',
    'if (uiSendAttempted)',
    'const sendResult = normalizeTextSendResult',
    'an attempted phone UI send must return before the protocol send path can duplicate it',
  )
})

test('CRM outbound text keeps clientMessageId idempotency before creating a message', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assertBefore(
    messageService,
    'where: { clientMessageId }',
    'const created = await (prisma.message as any).create',
    'clientMessageId lookup must happen before outbound message create',
  )
  assert.match(messageService, /return \{ success: existing\.status !== 'failed', chatId: existing\.chatId, id: existing\.id, error: null, duplicate: true \}/)
})

test('CRM message ordering is based on provider sentAt before createdAt fallback', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')

  assert.match(messageService, /orderBy: \[\{ sentAt: 'desc' \}, \{ createdAt: 'desc' \}\]/)
  assert.match(route, /sentAt,\s+\/\/ validated above/)
  assertBefore(
    route,
    'sentAt = new Date(ts)',
    'sentAt, // validated above',
    'provider timestamp must be normalized before storing message sentAt',
  )
})

test('MAX empty op71 DOM recovery uses single fresh op128 chat when decoded chat id is wrong', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /function resolveEmptyOp71DomRecoveryChatId\(decodedChatId, maxAgeMs = 15_000\)/)
  assert.match(scraper, /recent\.length === 1/)
  assert.match(scraper, /single_recent_op128_after_mismatched_op71_chat/)
  assert.match(scraper, /const recoveryTarget = messages\.length === 0 \? resolveEmptyOp71DomRecoveryChatId\(decodedChatId\) : null/)
  assert.match(scraper, /decodedChatId=\$\{decodedChatId \|\| 'none'\} reason=\$\{recoveryTarget\.reason\}/)
  assertBefore(
    scraper,
    'const recoveryTarget = messages.length === 0 ? resolveEmptyOp71DomRecoveryChatId(decodedChatId) : null',
    "forwardRecentDomMessages(chatIdStr, 'empty_op71_after_op128')",
    'empty op71 must resolve the recovery chat before running guarded DOM batch recovery',
  )
})

test('MAX DOM recovery resolves browser route separately from protocol chat id', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /function dialogParticipantUiRouteId\(chatId\)/)
  assert.match(scraper, /function resolveUiRouteIdForChat\(chatId\)/)
  assert.match(scraper, /const staticRouteId = UI_CHAT_ID_OVERRIDES\[chatIdStr\]/)
  assert.match(scraper, /chatCache\.get\(chatIdStr\)/)
  assert.match(scraper, /String\(chat\.type\)\.toUpperCase\(\) !== 'DIALOG'/)
  assert.match(scraper, /const otherParticipants = participants/)
  assert.match(scraper, /return \{ uiRouteId: participantRouteId, source: 'dialog_participant' \}/)
  assert.match(scraper, /return \{ uiRouteId: chatIdStr, source: 'protocol_chat_id' \}/)
  assert.match(scraper, /'901943199056': '66896'/)
  assertBeforeAfter(
    scraper,
    'async function forwardRecentDomMessages(chatId, reason = \'manual\')',
    'const route = resolveUiRouteIdForChat(chatId)',
    'const candidates = await scrapeRecentDomMessages(uiRouteId)',
    'DOM recovery must resolve the browser route before scraping visible bubbles',
  )
})

test('MAX guarded DOM text recovery filters unanchored trailing text', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /function shouldKeepDomTextRecoveryCandidate\(chatId, candidate, candidates, index\)/)
  assert.match(scraper, /recentDirectInboundTextHits\(chatId, candidate\.text\)\.length > 0/)
  assert.match(scraper, /hasNearbyDirectNumericDomCandidate\(candidates, index\)/)
  assert.match(scraper, /preSkipped\.dom_unanchored_text_filtered = beforeAnchorFilter - recoverable\.length/)
  assertBefore(
    scraper,
    'recoverable = recoverable.filter((candidate, index, list) =>',
    'assignDomTextRecoveryBudgets(chatId, recoverable)',
    'unanchored DOM text must be filtered before assigning recovered duplicate ids',
  )
})

test('MAX guarded DOM text recovery keeps bounded live context before first direct hit', () => {
  const scraper = read('max-web-scraper/index.js')
  const transport = read('max-web-scraper/transport/TransportInterceptor.js')

  assert.match(transport, /_recentOp128EventsByChat = new Map\(\)/)
  assert.match(transport, /_rememberRecentOp128Chat\(chatIdStr\)/)
  assert.match(transport, /recentOp128CountForChat\(chatId, maxAgeMs = 15_000\)/)
  assert.match(transport, /recentOp128SeriesKeyForChat\(chatId, maxAgeMs = 15_000\)/)
  assert.match(scraper, /function liveDomContextBeforeDirectBudget\(chatId, recoverable, firstDirectIndex\)/)
  assert.match(scraper, /transport\?\.recentOp128CountForChat\?\.\(chatId, 15_000\)/)
  assert.match(scraper, /const LIVE_DOM_WINDOW_CONTEXT_SLACK = 2/)
  assert.match(scraper, /recentOp128Count \+ LIVE_DOM_WINDOW_CONTEXT_SLACK/)
  assert.match(scraper, /const hasFreshLiveWindow = liveWindowDetails\.recentOp128Count > 0/)
  assert.match(scraper, /currentNumber != null && !hasFreshLiveWindow/)
  assert.match(scraper, /candidate\?\._liveDomContextBeforeDirect/)
  assert.match(scraper, /markLiveDomContextBeforeFirstDirect\(recoverable, keepFrom, firstDirectIndex\)/)
  assertBefore(
    scraper,
    'markLiveDomContextBeforeFirstDirect(recoverable, keepFrom, firstDirectIndex)',
    'recoverable = recoverable.slice(keepFrom)',
    'live DOM context must be marked before slicing candidates before first direct hit',
  )
})

test('MAX DOM text recovery ids are stable across overlapping scans in one live series', () => {
  const scraper = read('max-web-scraper/index.js')
  const transport = read('max-web-scraper/transport/TransportInterceptor.js')

  assert.match(transport, /recentOp128SeriesKeyForChat\(chatId, maxAgeMs = 15_000\)/)
  assert.match(transport, /return `op128-series:\$\{Math\.floor\(events\[0\] \/ 1000\)\}`/)
  assert.match(scraper, /function domRecoveryLiveSeriesKey\(chatId\)/)
  assert.match(scraper, /transport\?\.recentOp128SeriesKeyForChat\?\.\(chatId, 15_000\)/)
  assert.match(scraper, /function recentLiveDomWindowDetails\(chatId, candidateCount\)/)
  assert.match(scraper, /function limitRecoverableToRecentLiveDomWindow\(chatId, recoverable\)/)
  assert.match(scraper, /const liveWindowDetails = recentLiveDomWindowDetails\(chatId, recoverable\.length\)/)
  assert.match(scraper, /preSkipped\.dom_live_window_filtered = beforeLiveWindowFilter - recoverable\.length/)
  assert.match(scraper, /function shouldKeepNumericDomRecoveryCandidate\(candidate, candidates\)/)
  assert.match(scraper, /candidate\?\._liveDomSeriesCandidate/)
  assert.match(scraper, /candidate\._liveDomSeriesCandidate = true/)
  assert.match(scraper, /function applyDomTextRecoveryLimits\(chatId, candidates\)/)
  assert.match(scraper, /domFallbackSeen\.has\(candidate\._domRecoveryExternalId\)/)
  assert.match(scraper, /group\.items\.length - group\.directCount - alreadyRecovered/)
  assert.match(scraper, /candidate\._skipDomTextAlreadyRecovered = true/)
  assert.match(scraper, /preSkipped\.dom_numeric_future_filtered = beforeNumericFutureFilter - recoverable\.length/)
  assert.match(scraper, /const directAnchorKey = domRecoveryDirectAnchorKey\(candidates, i\)/)
  assert.match(scraper, /const anchorKey = directAnchorKey !== 'start:end' \? directAnchorKey : \(liveSeriesKey \|\| directAnchorKey\)/)
  assert.match(scraper, /const key = `\$\{dayKey\}:\$\{candidate\.displayMinute\}:\$\{text\}:\$\{anchorKey\}`/)
  assertBefore(
    scraper,
    'const liveSeriesKey = domRecoveryLiveSeriesKey(chatId)',
    'candidate._domRecoveryExternalId = stableDomMessageId(chatId, `dom-text-minute:${key}:${ordinal}`)',
    'DOM recovered ids must use one live series namespace across overlapping scans',
  )
  assertBefore(
    scraper,
    'const liveWindowDetails = recentLiveDomWindowDetails(chatId, recoverable.length)',
    'assignDirectHitsToDomCandidates(chatId, recoverable)',
    'live DOM recovery must discard visible history before assigning direct hits',
  )
  assertBefore(
    scraper,
    'preSkipped.dom_numeric_future_filtered = beforeNumericFutureFilter - recoverable.length',
    'assignDomTextRecoveryBudgets(chatId, recoverable)',
    'future numeric DOM candidates must be filtered before assigning recovered ids',
  )
  assertBefore(
    scraper,
    'assignDomRecoveryExternalIds(chatId, recoverable)',
    'applyDomTextRecoveryLimits(chatId, recoverable)',
    'DOM recovered ids must be assigned before per-text limits so overlapping scans do not spend quota on already-seen bubbles',
  )
  assertBefore(
    scraper,
    'candidate._liveDomSeriesCandidate = true',
    'recoverable = recoverable.filter((candidate, index, list) =>',
    'fresh live op128 series DOM candidates must be marked before guarded text filters',
  )
})
//M1_REBUILD_TRIGGER_AFTER_DOM_RECOVERY


test('MAX UI text fallback does not depend on browser clipboard permission', () => {
  const scraper = read('max-web-scraper/index.js')
  const start = scraper.indexOf('async function sendTextViaUi')
  assert.notEqual(start, -1, 'missing sendTextViaUi')
  const end = scraper.indexOf('function waitForUiSendAck', start)
  assert.notEqual(end, -1, 'missing waitForUiSendAck anchor')
  const block = scraper.slice(start, end)

  assert.doesNotMatch(block, /navigator\.clipboard\.writeText/)
  assert.match(scraper, /async function fillEditableText\(locator, value\)/)
  assert.match(block, /fillEditableText\(composeEl, text\)/)
  assert.match(scraper, /page\.keyboard\.insertText\(text\)/)
  assert.match(block, /page\.keyboard\.press\('Enter'\)/)
})


test('MAX reply text is sent through protocol chat id and is not downgraded to plain UI text', () => {
  const scraper = read('max-web-scraper/index.js')
  const start = scraper.indexOf('async function sendText')
  assert.notEqual(start, -1, 'missing sendText')
  const end = scraper.indexOf('async function fillEditableText', start)
  assert.notEqual(end, -1, 'missing fillEditableText anchor')
  const block = scraper.slice(start, end)

  assert.match(block, /const wsChatId = chatId/)
  assert.doesNotMatch(block, /replyToMessageId && directUiRouteId \? Number\(directUiRouteId\) : chatId/)
  assert.match(block, /reply via WS protocol chatId=\$\{chatId\} uiRoute=\$\{directUiRouteId\}/)
  assert.match(block, /reply send failed without MAX confirmation; not downgrading to plain UI text/)
  assertBefore(
    block,
    'if (replyToMessageId) {',
    'const uiRouteId = uiChatId || UI_CHAT_ID_OVERRIDES[String(chatId)] || chatId',
    'reply failures must stop before plain UI fallback can send an unquoted message',
  )
})

test('MAX inbound reply keeps provider reply id and DOM fallback skips quote-composed bubbles', () => {
  const scraper = read('max-web-scraper/index.js')
  const parser = read('max-web-scraper/parser/MessageParser.js')
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')

  assert.match(parser, /replyToExternalId: msg\.replyToMessageId \|\| null/)
  assert.match(route, /replyToExternalId\?: string \| number \| null/)
  assert.match(route, /const replyToExternalIdString = replyToExternalId \? String\(replyToExternalId\) : null/)
  assert.match(route, /replyToExternalId: replyToExternalIdString/)

  assert.match(scraper, /function looksLikeDomReplyQuoteText\(chatId, candidate\)/)
  assert.match(scraper, /candidate\.hasReplyQuote/)
  assert.match(scraper, /dom_reply_quote_text/)
  assert.match(scraper, /recentDirectInboundTextHits\(chatId, leafText\)\.length > 0/)
  assertBefore(
    scraper,
    "return { skipped: 'dom_reply_quote_text', text: latest.text }",
    "const pendingProviderId = reason === 'empty_op71_after_op128'",
    'DOM quote-composed reply bubbles must be filtered before assigning max-dom ids',
  )
})

test('MAX known-chat text send endpoint normalizes object send results before HTTP response', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /const sendResult = normalizeTextSendResult\(await enqueueSend\(\(\) => sendText\(transport, Number\(chatId\), message, quotedMsgId, uiChatId, clientMessageId\)\)\)/)
  assert.match(scraper, /const hasExplicitFailure = result\.success === false \|\| result\.failed === true \|\| result\.failure === true/)
  assert.match(scraper, /if \(hasExplicitFailure \|\| hasExplicitError\)/)
  assert.match(scraper, /externalId: sendResult\.externalId \|\| null/)
  assert.match(scraper, /maxMessageId: sendResult\.maxMessageId \|\| null/)
  assert.doesNotMatch(scraper, /externalId: maxMsgId \|\| null, deliveryConfirmed: isRealMaxMessageId\(maxMsgId\)/)
})

test('CRM MAX delivery path never writes non-string send-result object as message externalId', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')
  const maxCapability = read('gravity-mvp/src/modules/max-channel/public/v1/messaging-delivery-capability.ts')
  const deliveryRuntime = read('gravity-mvp/src/modules/messaging/public/v1/channel-delivery-runtime.ts')

  assert.match(maxCapability, /const rawExternalId = optionalString\(raw\.externalId\) \|\| optionalString\(raw\.maxMessageId\)/)
  assert.match(maxCapability, /const externalId = isRealMaxMessageId\(rawExternalId\) \? rawExternalId : null/)
  assert.match(deliveryRuntime, /externalId: string \| null/)
  assert.match(messageService, /const maxExternalId = maxRes\.externalId/)
  assert.match(messageService, /const maxExternalId = retryMaxRes\.externalId/)
  assert.doesNotMatch(messageService, /rawMaxExternalId/)
})


test('MAX outbound text passes stable clientMessageId through CRM and scraper retry path', () => {
  const scraper = read('max-web-scraper/index.js')
  const maxTransport = read('gravity-mvp/src/modules/max-channel/application/messaging-transport.ts')
  const maxCapability = read('gravity-mvp/src/modules/max-channel/public/v1/messaging-delivery-capability.ts')
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assert.match(scraper, /function stableTextCid\(seed\)/)
  assert.match(scraper, /crypto\.createHash\('sha1'\)\.update\(String\(seed\)\)\.digest\(\)/)
  assert.match(scraper, /async function sendText\(transport, chatId, text, replyToMessageId, uiChatId, clientMessageId\)/)
  assert.match(scraper, /const cid = stableTextCid\(clientMessageId\)/)
  assert.match(scraper, /let \{ chatId, message, phone, quotedMsgId, uiChatId, clientMessageId \} = req\.body/)
  assert.match(scraper, /sendText\(transport, Number\(chatId\), message, quotedMsgId, uiChatId, clientMessageId\)/)

  assert.match(maxTransport, /clientMessageId\?: string/)
  assert.match(maxTransport, /clientMessageId: input\.clientMessageId/)
  assert.match(maxTransport, /providerAccountId,/)
  assert.match(maxCapability, /clientMessageId: input\.options\.clientMessageId/)
  assert.match(messageService, /clientMessageId: clientMessageId \|\| messageId/)
  assert.match(messageService, /clientMessageId: message\.clientMessageId \|\| message\.id/)
})

test('MAX reply timeout does one quick retry on stable WS before falling back to background retry', () => {
  const scraper = read('max-web-scraper/index.js')
  const start = scraper.indexOf('async function sendText')
  assert.notEqual(start, -1, 'missing sendText')
  const end = scraper.indexOf('async function fillEditableText', start)
  assert.notEqual(end, -1, 'missing fillEditableText anchor')
  const block = scraper.slice(start, end)

  assert.match(block, /const sendProtocolText = async \(timeoutMs\) =>/)
  assert.match(block, /return await sendProtocolText\(30_000\)/)
  assert.match(block, /const isOpcode64Timeout = \/Timeout: opcode 64\/i\.test\(String\(e\.message \|\| ''\)\)/)
  assert.match(block, /reply send timed out; waiting for stable WS and retrying once with same cid/)
  assert.match(block, /await transport\.waitForStableWs\(800, 8_000\)/)
  assert.match(block, /return await sendProtocolText\(15_000\)/)
  assertBefore(
    block,
    'return await sendProtocolText(15_000)',
    'reply send failed without MAX confirmation; not downgrading to plain UI text',
    'reply quick retry must happen before handing the failed message to the background retry worker',
  )
})
