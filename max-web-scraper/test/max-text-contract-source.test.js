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
  assert.match(route, /\.\.\.\(source \? \{ source \} : \{\}\)/)
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

  assert.match(scraper, /deliveryConfirmed: sendResult\.deliveryConfirmed/)
  assert.match(scraper, /deliveryStatus: sendResult\.deliveryStatus/)
  assert.match(scraper, /externalId: null, deliveryConfirmed: false, deliveryStatus: 'send_requested'/)
  assert.match(scraper, /ackId && isRealMaxMessageId\(ackId\)/)
  assert.match(scraper, /result\.deliveryConfirmed && isRealMaxMessageId\(maxMessageId \|\| externalId\)/)
  assert.doesNotMatch(scraper, /result\.deliveryConfirmed \|\| deliveryStatus === 'delivered'/)

  assert.match(messageService, /Boolean\(\(maxRes as any\)\?\.deliveryConfirmed && isRealMaxMessageId\(maxExternalId\)\)/)
  assert.doesNotMatch(messageService, /\|\| maxDeliveryStatus === 'delivered'/)
  assert.match(messageService, /deliveryStatus = crmStatusForMaxDelivery\(durableStatus, maxDeliveryConfirmed\)/)
})

test('CRM retry preserves reply identity and does not promote every HTTP 200 to delivered', () => {
  const workspace = read('gravity-mvp/src/app/messages/components/ChatWorkspace.tsx')
  const messagesHook = read('gravity-mvp/src/app/messages/hooks/useMessages.ts')

  assert.match(workspace, /retryMessage\(msg\.id\)/)
  assert.doesNotMatch(workspace.slice(workspace.indexOf('const handleRetry ='), workspace.indexOf('const handleReply')), /sendMessage\(/)
  assert.match(messagesHook, /fetch\('\/api\/messages\/retry'/)
  assert.match(messagesHook, /metadata: quotedMsgId \? \{ quotedMsgId \} : undefined/)
  assert.match(messagesHook, /const allowedStatuses = new Set\(\['queued', 'sent', 'delivered', 'read', 'failed'\]\)/)
  assert.match(messagesHook, /allowedStatuses\.has\(result\.status\)/)
  assert.doesNotMatch(messagesHook, /result\.success === false \? 'failed' as const : 'delivered' as const/)
  assert.match(messagesHook, /maxDelivery: \{ status: 'needs_review'/)
})

test('CRM outbound text keeps clientMessageId idempotency before creating a message', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assertBefore(
    messageService,
    'where: { clientMessageId }',
    'const created = await (prisma.message as any).create',
    'clientMessageId lookup must happen before outbound message create',
  )
  assert.match(messageService, /status: existing\.status, externalId: existing\.externalId, metadata: existing\.metadata/)
  assert.match(messageService, /error: null, duplicate: true/)
})

test('MAX text DOM fallback refuses an unanchored body without provider identity', () => {
  const scraper = read('max-web-scraper/index.js')
  const exactLookup = scraper.indexOf("{ text: latest.text, sentAt: receivedAt, direction: 'inbound' }")
  const identityGate = scraper.indexOf("skipped: 'provider_identity_required'", exactLookup)
  assert.ok(exactLookup > -1 && identityGate > exactLookup)
  assert.match(scraper.slice(exactLookup, identityGate), /readProviderMessage/)
  assert.match(scraper.slice(exactLookup, identityGate), /!providerMessage\.isOutgoing/)
  assert.match(scraper, /!isOutgoingCandidate && !resolvedProviderId && attachments\.length === 0/)
  assert.match(scraper, /skipped: 'provider_identity_required'/)
})

test('scraper health exposes bounded capture diagnostics without payload or credentials', () => {
  const scraper = read('max-web-scraper/index.js')
  const healthStart = scraper.indexOf("app.get('/health'")
  const statusStart = scraper.indexOf("app.get('/status'", healthStart)
  const health = scraper.slice(healthStart, statusStart)
  assert.match(health, /transport\?\.getCaptureHealth\?\.\(\)/)
  for (const field of ['adapterState', 'spoolPendingCount', 'spoolPendingBytes',
    'lostBeforeSpoolCount', 'lastDrainErrorCode', 'hookFailureCount']) {
    assert.ok(health.includes(field), `missing safe capture health field: ${field}`)
  }
  assert.doesNotMatch(health, /sanitizedPayload|secret|credential|authorization/i)
})

test('CRM message ordering is based on provider sentAt before createdAt fallback', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')

  assert.match(messageService, /\{ sentAt: 'desc' \},\s+\{ externalId: 'desc' \},\s+\{ createdAt: 'desc' \},\s+\{ id: 'desc' \}/s)
  assert.match(route, /sentAt,\s+\/\/ validated above/)
  assertBefore(
    route,
    'sentAt = new Date(ts)',
    'sentAt,   // validated above',
    'provider timestamp must be normalized before storing message sentAt',
  )
})

test('direct transport and live DOM recovery share one per-chat projection lane', () => {
  const scraper = read('max-web-scraper/index.js')
  const transportStart = scraper.indexOf('transport.onMessage(msg =>')
  const transportHandler = scraper.slice(transportStart, scraper.indexOf('// Синхронизация реакций', transportStart))
  const latestStart = scraper.indexOf('async function forwardLatestDomMessage(')
  const latestRecovery = scraper.slice(latestStart, scraper.indexOf('async function forwardRecentDomMessages(', latestStart))
  const batchStart = scraper.indexOf('async function forwardRecentDomMessages(')
  const batchRecovery = scraper.slice(batchStart, scraper.indexOf('// ─── Contact sync', batchStart))

  assert.match(scraper, /function enqueueInboundProjection\(chatId, task\)/)
  assert.match(transportHandler, /enqueueInboundProjection\(msg\?\.chatId/)
  assert.match(latestRecovery, /enqueueInboundProjection\(chatId/)
  assert.match(batchRecovery, /enqueueInboundProjection\(chatId/)
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
  assert.match(scraper, /return resolveMaxUiRouteId\(chatIdStr, \{/)
  assert.match(scraper, /chatCache\.get\(chatIdStr\)/)
  assert.match(scraper, /String\(chat\.type\)\.toUpperCase\(\) !== 'DIALOG'/)
  assert.match(scraper, /const otherParticipants = participants/)
  assert.match(scraper, /overrides: UI_CHAT_ID_OVERRIDES/)
  assert.match(scraper, /participantRouteId,/)
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


test('MAX reply text uses a MAX provider frame with a real target and is not downgraded to plain UI text', () => {
  const scraper = read('max-web-scraper/index.js')
  const bridge = read('max-web-scraper/reply/MaxWebReplyBridge.js')
  const start = scraper.indexOf('async function sendText')
  assert.notEqual(start, -1, 'missing sendText')
  const end = scraper.indexOf('async function fillEditableText', start)
  assert.notEqual(end, -1, 'missing fillEditableText anchor')
  const block = scraper.slice(start, end)

  assert.match(block, /const wsChatId = chatId/)
  assert.doesNotMatch(block, /replyToMessageId && directUiRouteId \? Number\(directUiRouteId\) : chatId/)
  assert.match(block, /reply via MAX provider frame chatId=\$\{chatId\}/)
  assert.match(block, /const ackPromise = waitForUiSendAck\(transport, timeoutMs, \{[\s\S]*?chatId: resolvedReplyChatId \|\| wsChatId,[\s\S]*?text,[\s\S]*?replyToMessageId: resolvedReplyToMessageId,[\s\S]*?\}\)/)
  const ackStart = scraper.indexOf('function waitForUiSendAck')
  const ackEnd = scraper.indexOf('async function sendTextViaUi', ackStart)
  const ackBlock = scraper.slice(ackStart, ackEnd)
  assert.doesNotMatch(ackBlock, /OP\.MEDIA_STATUS/)
  assert.match(ackBlock, /String\(echoedReplyId \|\| ''\) !== expectedReplyId/)
  assert.match(block, /replyResult = await replyBridge\.sendReply\([\s\S]*?resolvedReplyChatId \|\| wsChatId,[\s\S]*?resolvedReplyToMessageId,[\s\S]*?cid,[\s\S]*?\)/)
  assert.doesNotMatch(block, /sendBinaryReply/)
  assert.match(block, /const storeConfirmedId = isRealMaxMessageId\(replyResult\?\.providerMessageId\)/)
  assert.match(block, /const maxMsgId = storeConfirmedId \|\| await ackPromise/)
  assert.match(block, /replyBridge\.resolveProviderId\([\s\S]*?quotedMessageContext \|\| \{\},[\s\S]*?\{ uiChatId: directUiRouteId \},[\s\S]*?\)/)
  assert.match(block, /resolvedReplyChatId = resolved\.providerChatId \|\| null/)
  assert.match(bridge, /await core\.module\.ro\(\{ chat, from: historyFrom \}\)/)
  assert.match(bridge, /await core\.module\.\$i\(\{ chat, message: pending \}\)/)
  assert.match(bridge, /pending\.id = BigInt\(args\.cid\)/)
  assert.doesNotMatch(bridge, /!core\.legacySendPrimitives \|\| typeof core\.module\.\$i/)
  assert.match(bridge, /Reply requires real MAX provider message id/)
  assert.match(block, /reply send failed without MAX confirmation; not downgrading to plain UI text/)
  assertBefore(
    block,
    'if (replyToMessageId) {',
    'const uiRouteId = uiChatId || resolveUiRouteIdForChat(chatId).uiRouteId',
    'reply failures must stop before plain UI fallback can send an unquoted message',
  )
})

test('MAX inbound reply keeps provider reply id and DOM fallback separates quote metadata from body', () => {
  const scraper = read('max-web-scraper/index.js')
  const parser = read('max-web-scraper/parser/MessageParser.js')
  const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')

  assert.match(parser, /replyToExternalId: msg\.replyToMessageId \|\| null/)
  assert.match(route, /replyToExternalId\?: string \| number \| null/)
  assert.match(route, /const replyToExternalIdString = replyToExternalId \? String\(replyToExternalId\) : null/)
  assert.match(route, /replyToExternalId: replyToExternalIdString/)

  assert.match(scraper, /function looksLikeDomReplyQuoteText\(chatId, candidate\)/)
  assert.match(scraper, /candidate\.hasReplyQuote/)
  assert.match(scraper, /recentDirectInboundTextHits\(chatId, parts\.leafText\)\.length > 0/)
  assert.match(scraper, /text: replyParts\.leafText/)
  assert.match(scraper, /_replyQuoteText: replyParts\.quotedText/)
  assert.match(scraper, /replyQuoteText: latest\._replyQuoteText/)
  assert.match(route, /unresolvedReplyQuoteText: replyQuoteTextString/)
  assert.match(route, /replyResolutionStatus: 'ambiguous_or_missing'/)
})

test('MAX known-chat text send endpoint normalizes object send results before HTTP response', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /const sendResult = normalizeTextSendResult\(await enqueueSend\(\(\) => sendText\(/)
  assert.match(scraper, /\{ text: quotedText, sentAt: quotedSentAt, direction: quotedDirection \}/)
  assert.match(scraper, /externalId: sendResult\.externalId \|\| null/)
  assert.match(scraper, /maxMessageId: sendResult\.maxMessageId \|\| null/)
  assert.doesNotMatch(scraper, /externalId: maxMsgId \|\| null, deliveryConfirmed: isRealMaxMessageId\(maxMsgId\)/)
})

test('CRM MAX delivery path never writes non-string send-result object as message externalId', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')
  const maxActions = read('gravity-mvp/src/app/max-actions.ts')

  assert.match(maxActions, /const externalId = typeof data\.externalId === 'string'/)
  assert.match(messageService, /const rawMaxExternalId = \(maxRes as any\)\?\.externalId/)
  assert.match(messageService, /const rawMaxMessageId = \(maxRes as any\)\?\.maxMessageId/)
  assert.match(messageService, /const rawMaxExternalId = \(retryMaxRes as any\)\?\.externalId/)
  assert.doesNotMatch(messageService, /const maxExternalId = \(maxRes as any\)\?\.externalId \|\| null/)
  assert.doesNotMatch(messageService, /const maxExternalId = \(retryMaxRes as any\)\?\.externalId \|\| null/)
})


test('MAX outbound text passes stable clientMessageId through CRM and scraper retry path', () => {
  const scraper = read('max-web-scraper/index.js')
  const maxActions = read('gravity-mvp/src/app/max-actions.ts')
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assert.match(scraper, /function stableTextCid\(seed\)/)
  assert.match(scraper, /crypto\.createHash\('sha1'\)\.update\(String\(seed\)\)\.digest\(\)/)
  assert.match(scraper, /async function sendText\(transport, chatId, text, replyToMessageId, uiChatId, clientMessageId, quotedMessageContext\)/)
  assert.match(scraper, /const cid = stableTextCid\(clientMessageId\)/)
  assert.match(scraper, /let \{ chatId, message, phone, quotedMsgId, quotedText, quotedSentAt, quotedDirection, uiChatId, clientMessageId \} = req\.body/)
  assert.match(scraper, /clientMessageId,\s*\{ text: quotedText, sentAt: quotedSentAt, direction: quotedDirection \}/)

  assert.match(maxActions, /clientMessageId\?: string/)
  assert.match(maxActions, /quotedText: quotedContext\?\.text/)
  assert.match(maxActions, /quotedSentAt: quotedContext\?\.sentAt/)
  assert.match(maxActions, /quotedDirection: quotedContext\?\.direction/)
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
  assert.match(block, /const isOpcode64Timeout = \/Timeout: \(\?:opcode 64\|MAX Web reply\)\/i\.test\(String\(e\.message \|\| ''\)\)/)
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

test('MAX failed reply retains quoted message identity for background retry', () => {
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')
  const metadataStart = messageService.indexOf('const metadata: any = {}')
  const metadataEnd = messageService.indexOf('await (prisma.message as any).update({', metadataStart)
  assert.notEqual(metadataStart, -1, 'missing delivery metadata block')
  assert.notEqual(metadataEnd, -1, 'missing delivery metadata update')
  const metadataBlock = messageService.slice(metadataStart, metadataEnd)

  assert.match(metadataBlock, /if \(quotedMsgId\) metadata\.quotedMsgId = quotedMsgId/)
  assertBefore(
    metadataBlock,
    'if (quotedMsgId) metadata.quotedMsgId = quotedMsgId',
    'if (maxDeliveryMetadata)',
    'reply identity must survive provider failure even when maxDeliveryMetadata was not created',
  )
  assert.match(messageService, /let retryQuotedMsgId = meta\.quotedMsgId/)
  assert.match(messageService, /quotedMsgId: retryQuotedMsgId/)
  assert.match(messageService, /quotedText: retryQuotedText/)
  assert.match(messageService, /quotedSentAt: retryQuotedSentAt/)
  assert.match(messageService, /quotedDirection: retryQuotedDirection/)
})
