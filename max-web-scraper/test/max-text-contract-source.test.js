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

test('MAX outbound text delivery is confirmed only by a real d301 provider message id', () => {
  const scraper = read('max-web-scraper/index.js')
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assert.match(scraper, /deliveryConfirmed: isRealMaxMessageId\(maxMsgId\)/)
  assert.match(scraper, /deliveryStatus: isRealMaxMessageId\(maxMsgId\) \? 'delivered' : 'send_requested'/)
  assert.match(scraper, /externalId: null, deliveryConfirmed: false, deliveryStatus: 'send_requested'/)
  assert.match(scraper, /ackId && isRealMaxMessageId\(ackId\)/)

  assert.match(messageService, /const maxDeliveryConfirmed = Boolean\(\(maxRes as any\)\?\.deliveryConfirmed && isRealMaxMessageId\(maxExternalId\)\)/)
  assert.match(messageService, /deliveryStatus = maxDeliveryConfirmed \? 'delivered' : 'sent'/)
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
    'sentAt,   // validated above',
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
