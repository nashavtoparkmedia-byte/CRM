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

  // The scraper reports delivered only with a provider id correlated to this send.
  assert.match(scraper, /case 'accepted':[\s\S]*?deliveryConfirmed: true,[\s\S]*?deliveryStatus: 'delivered',/)
  assert.doesNotMatch(scraper, /kind: 'ui_send_action'/)
  assert.doesNotMatch(scraper, /waitForUiSendAck/)

  assert.match(deliveryRuntime, /outcome: 'delivered' \| 'pending'/)
  assert.match(maxCapability, /function validateMaxTextDeliveryResultV1/)
  assert.match(maxCapability, /hasExplicitFailure \|\| hasExplicitError/)
  // S2 typed evidence: provider_ack only for an id MAX answered for this very send.
  assert.match(maxCapability, /proofKind === 'provider_ack' \|\| proofKind === 'provider_store_readback'/)
  assert.match(maxCapability, /outcome: correlatedProviderProof \? 'delivered' : 'pending'/)
  assert.match(maxCapability, /evidence: correlatedProviderProof \? 'provider_ack' : 'client_action'/)
  assert.doesNotMatch(maxCapability, /ui_send_action/)
  assert.match(messageService, /const maxDeliveryConfirmed = maxRes\.outcome === 'delivered'/)
  assert.match(messageService, /const maxDeliveryConfirmed = retryMaxRes\.outcome === 'delivered'/)
  assert.doesNotMatch(messageService, /\(maxRes as any\)\?\.deliveryStatus/)
  assert.match(messageService, /deliveryStatus = maxDeliveryConfirmed \? 'delivered' : 'sent'/)
})

test('MAX text send to a phone target fails closed before anything is typed', () => {
  const scraper = read('max-web-scraper/index.js')
  const handler = scraper.slice(scraper.indexOf("app.post('/send-message'"), scraper.indexOf('// Поставить/снять emoji-реакцию'))

  assert.doesNotMatch(handler, /resolvePhoneLive\(/)
  assertBefore(
    handler,
    "code: 'MAX_ROUTE_UNRESOLVED', reason: digits ? 'phone_target' : 'invalid_target'",
    'enqueueSend(() => sendText(',
    'a phone target must be refused before anything can be typed',
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
  // A repeated intent answers with the existing row and its canonical state.
  assert.match(messageService, /return \{ success: existing\.status !== 'failed', chatId: existing\.chatId, id: existing\.id, clientMessageId, duplicate: true, \.\.\.canonicalSendState\(existing\) \}/)
  assert.match(messageService, /return duplicateSendResult\(existing, clientMessageId\)/)
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


test('MAX compose send does not depend on browser clipboard permission and acts once', () => {
  const scraper = read('max-web-scraper/index.js')
  const start = scraper.indexOf('async function submitTextThroughCompose')
  assert.notEqual(start, -1, 'missing submitTextThroughCompose')
  const end = scraper.indexOf('async function submitReplyThroughPage', start)
  assert.notEqual(end, -1, 'missing submitReplyThroughPage anchor')
  const block = scraper.slice(start, end)

  assert.doesNotMatch(block, /navigator\.clipboard\.writeText/)
  assert.match(scraper, /async function fillEditableText\(locator, value\)/)
  assert.match(block, /fillEditableText\(composeEl, text\)/)
  assert.match(scraper, /page\.keyboard\.insertText\(text\)/)
  assert.equal((block.match(/page\.keyboard\.press\('Enter'\)/g) || []).length, 1)
  assert.doesNotMatch(block, /page\.goto\(/)
})

test('MAX reply text uses MAX Web store with a real provider target and is not downgraded to plain UI text', () => {
  const scraper = read('max-web-scraper/index.js')
  const bridge = read('max-web-scraper/lib/MaxWebReplyBridge.js')
  const start = scraper.indexOf('async function sendText')
  assert.notEqual(start, -1, 'missing sendText')
  const end = scraper.indexOf('function maskPhoneForLog', start)
  assert.notEqual(end, -1, 'missing maskPhoneForLog anchor')
  const block = scraper.slice(start, end)
  const reply = scraper.slice(scraper.indexOf('async function submitReplyThroughPage'), start)

  assert.match(block, /new MaxWebReplyBridge\(page\)\.resolveProviderId\([\s\S]*?quotedMessageContext \|\| \{\},[\s\S]*?\{ uiChatId: route\.uiRouteId \},[\s\S]*?\)/)
  assert.match(block, /return \{ outcome: 'refused', code: 'MAX_REPLY_TARGET_NOT_ADDRESSABLE'/)
  assert.match(block, /performAction: replyProviderId\s*\? \(\) => submitReplyThroughPage\(protocolChatId, text, replyProviderId, cid, route\.uiRouteId\)\s*: \(\) => submitTextThroughCompose\(route\.uiRouteId, text\)/)
  assert.match(reply, /const replyResult = await replyBridge\.sendReply\(protocolChatId, text, replyProviderId, cid, \{ uiChatId: uiRouteId \}\)/)
  assert.match(reply, /const storeConfirmedId = isRealMaxMessageId\(replyResult\?\.providerMessageId\)/)
  assert.doesNotMatch(reply, /submitTextThroughCompose|keyboard\.press/)
  assert.match(bridge, /await core\.module\.ro\(\{ chat, from: historyFrom \}\)/)
  assert.match(bridge, /await core\.module\.\$i\(\{ chat, message: pending \}\)/)
  assert.match(bridge, /pending\.id = BigInt\(args\.cid\)/)
  assert.match(bridge, /Reply requires real MAX provider message id/)
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
  assert.match(scraper, /recentDirectInboundTextHits\(chatId, parts\.leafText\)\.length > 0/)
  assertBefore(
    scraper,
    "return { skipped: 'dom_reply_quote_text', text: latest.text }",
    'const externalId = resolvedProviderId || stableDomCandidateMessageId(',
    'DOM quote-composed reply bubbles must be filtered before assigning max-dom ids',
  )
})

test('MAX text send endpoint answers from the decided outcome only', () => {
  const scraper = read('max-web-scraper/index.js')

  assert.match(scraper, /result = await enqueueSend\(\(\) => sendText\(/)
  assert.match(scraper, /\{ text: quotedText, sentAt: quotedSentAt, direction: quotedDirection \}/)
  assert.match(scraper, /const answer = textSendHttpAnswer\(result, \{ chatId: digits, providerAccountId \}\)/)
  assert.match(scraper, /externalId: result\.providerMessageId,/)
  assert.doesNotMatch(scraper, /normalizeTextSendResult/)
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
  const maxActions = read('gravity-mvp/src/app/max-actions.ts')
  const messageService = read('gravity-mvp/src/lib/MessageService.ts')

  assert.match(scraper, /function stableTextCid\(seed\)/)
  assert.match(scraper, /crypto\.createHash\('sha1'\)\.update\(String\(seed\)\)\.digest\(\)/)
  assert.match(scraper, /async function sendText\(transport, chatId, text, replyToMessageId, uiChatId, clientMessageId, quotedMessageContext\)/)
  assert.match(scraper, /const cid = stableTextCid\(clientMessageId\)/)
  assert.match(scraper, /let \{ chatId, message, phone, quotedMsgId, quotedText, quotedSentAt, quotedDirection, uiChatId, clientMessageId \} = req\.body/)
  assert.match(scraper, /clientMessageId,\s*\{ text: quotedText, sentAt: quotedSentAt, direction: quotedDirection \}/)

  assert.match(maxTransport, /clientMessageId\?: string/)
  assert.match(maxTransport, /clientMessageId: input\.clientMessageId/)
  assert.match(maxTransport, /providerAccountId,/)
  assert.match(maxCapability, /clientMessageId: input\.options\.clientMessageId/)
  assert.match(maxActions, /clientMessageId\?: string/)
  assert.match(maxActions, /quotedText: quotedContext\?\.text/)
  assert.match(maxActions, /quotedSentAt: quotedContext\?\.sentAt/)
  assert.match(maxActions, /quotedDirection: quotedContext\?\.direction/)
  assert.match(messageService, /clientMessageId: clientMessageId \|\| messageId/)
  assert.match(messageService, /clientMessageId: message\.clientMessageId \|\| message\.id/)
})

test('MAX text send makes at most one physical action per call and injects no op:64 of its own', () => {
  const scraper = read('max-web-scraper/index.js')
  const start = scraper.indexOf('async function sendText')
  assert.notEqual(start, -1, 'missing sendText')
  const end = scraper.indexOf('function maskPhoneForLog', start)
  const block = scraper.slice(start, end)
  const textSection = scraper.slice(scraper.indexOf('// ─── Отправка текста ──'), end)

  // No protocol send, no UI fallback after it, no reply quick retry: a timed-out
  // first action used to be followed by a second physical send inside one call.
  // (Native media sends keep their own op:64 frames; they are not text.)
  assert.notEqual(textSection.length, 0)
  assert.doesNotMatch(textSection, /sendFrame\(/)
  assert.doesNotMatch(scraper, /sendProtocolText/)
  assert.doesNotMatch(scraper, /retrying once with same cid/)
  assert.doesNotMatch(scraper, /UI fallback sent chatId/)
  assert.equal((block.match(/runSingleMaxTextSend\(/g) || []).length, 1)
  assert.equal((scraper.match(/runSingleMaxTextSend\(/g) || []).length, 1)
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

test('M1 inbound: a message is seen only after the CRM stored it, and the live path sends no op:32', () => {
  const scraper = read('max-web-scraper/index.js')
  const handle = scraper.slice(scraper.indexOf('async function handleIncoming('), scraper.indexOf('function inboundChatKey('))
  const forward = scraper.slice(scraper.indexOf('async function forwardIncomingMessage('), scraper.indexOf('// ─── Отправка текста ──'))

  // N0: the op:32 phone lookup closed the socket 39 ms after "1" arrived, and
  // "3","3","4" were never pushed. Inbound enrichment is cache-only.
  assert.doesNotMatch(handle + forward, /getContactPhone\(/)
  assert.doesNotMatch(handle, /messageSync\.markSeen\(msg\)/)
  assert.match(handle, /if \(ledgerId && !inboundLedger\.beginForward\(ledgerId\)\) return/)
  assert.match(handle, /finally \{\n\s*if \(ledgerId\) inboundLedger\.releaseForward\(ledgerId\)/)
  assertBefore(
    forward,
    'const result = await forwardWithBoundedRetry(forwardToWebhook, payload)',
    'messageSync.markSeen(msg)',
    'seen is marked only after the CRM answered',
  )
  assertBefore(
    forward,
    'if (result.status >= 200 && result.status < 300) {',
    'rememberRecentDirectInboundText(payload.chatId, payload.text, payload.externalId, payload.timestamp)',
    'DOM recovery may yield only to a row the CRM stored',
  )
  assert.equal((scraper.match(/rememberRecentDirectInboundText\(payload\.chatId/g) || []).length, 1)
})

test('M1 inbound: pushes are stored per chat in arrival order and acknowledged pushes reach the ledger', () => {
  const scraper = read('max-web-scraper/index.js')
  assert.match(scraper, /transport\.onMessage\(msg => \{\n\s*inboundLedger\.enqueue\(inboundChatKey\(msg\?\.chatId\), \(\) => handleIncoming\(msg, mediaPipeline, sync, transport\)\)/)
  assert.match(scraper, /transport\.onBrowserMessageAck\(\(\{ chatId, messageId \}\) => \{\n\s*inboundLedger\.noteBrowserAck\(chatId, messageId\)/)
  assert.match(scraper, /const inboundLedger = new InboundDeliveryLedger\(\{\n\s*graceMs: 4000,\n\s*onUnpersisted: event => \{\n\s*recoverUnpersistedLiveMessage\(event\)/)
})

test('M1 socket: no automatic history request is injected into MAX\'s binary socket', () => {
  const scraper = read('max-web-scraper/index.js')
  assert.match(scraper, /const SCRAPER_INJECTED_HISTORY_REQUESTS_ENABLED = false\n/)
  const auth = scraper.slice(scraper.indexOf('transport.onWsAuth(async (userId) => {'), scraper.indexOf('session.onLogout('))
  assertBefore(
    auth,
    'if (!SCRAPER_INJECTED_HISTORY_REQUESTS_ENABLED) {',
    "const result = await initialSync.runIfNeeded('from_connection_time')",
    'reconnect catch-up is gated before it can send op:49',
  )
  assert.match(auth, /if \(SCRAPER_INJECTED_HISTORY_REQUESTS_ENABLED\) await runBidirectionalHistoryRecoverySafely\(\)/)
  assert.match(auth, /if \(SCRAPER_INJECTED_HISTORY_REQUESTS_ENABLED \|\| !\['from_connection_time', 'none'\]\.includes\(HISTORY_IMPORT_MODE\)\) \{/)
})

test('M1 socket: frames are read with the MAX Web layout in both directions', () => {
  const transport = read('max-web-scraper/transport/TransportInterceptor.js')
  const binary = transport.slice(transport.indexOf('\n  _handleBinaryFrame(buf) {'), transport.indexOf('\n  _normalizeMaxMsg(payload) {'))
  assert.match(binary, /const frame = decodeMaxBinaryFrame\(buf\)/)
  assert.doesNotMatch(binary, /buf\.slice\(9\)|mappedCmd|skip <= 5/)
  assert.match(transport, /const outgoing = decodeMaxBinaryFrame\(buf\)/)
  assert.doesNotMatch(transport, /maxMsgpackDecodeAll\(buf\.slice\(12\)\)/)
})

test('M1/M2 outbound: a static route as attested, any other chat only on its canonical route once MAX accepts it, on an authenticated socket', () => {
  const scraper = read('max-web-scraper/index.js')
  const route = scraper.slice(scraper.indexOf('function resolveAttestedTextSendRoute('), scraper.indexOf('function isPageOnWebRoute('))
  assert.match(route, /const attested = UI_CHAT_ID_OVERRIDES\[protocolChatId\]/)
  assert.match(route, /if \(requested && requested !== String\(attested\)\) return \{ route: null, reason: 'route_conflict' \}/)
  assert.match(route, /const canonical = canonicalWebRouteForChat\(protocolChatId\)/)
  assert.match(route, /if \(!canonical\) return \{ route: null, reason: 'route_unresolved' \}/)
  assert.match(route, /source: 'canonical_real_id', requiresAttestation: true/)
  const surface = scraper.slice(scraper.indexOf('async function openTextSendRoute('), scraper.indexOf('async function findComposeInput('))
  assert.match(surface, /if \(needsComposeRoute && !isPageOnWebRoute\(uiRouteId\)\) \{/)
  assert.match(surface, /transport\.waitForSendReadySocket\(\{ stableMs: 1200, timeoutMs: 20_000 \}\)/)
  // Nothing is typed into a canonical route before MAX answered the page opening it.
  assert.match(surface, /await transport\.waitForRouteAttestation\(protocolChatId, \{ sinceMs: openedAt, timeoutMs: 4_000 \}\)/)
  assert.match(surface, /if \(!attestation\) return \{ ready: false, reason: 'route_unattested' \}/)
  assert.match(surface, /refusedCode: 'MAX_ROUTE_UNRESOLVED'/)
})
