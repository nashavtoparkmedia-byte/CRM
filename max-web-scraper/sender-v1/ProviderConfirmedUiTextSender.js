'use strict'

function unknown(safeCode) {
  return Object.freeze({
    outcome: 'UNKNOWN_AFTER_ATTEMPT',
    safeCode,
    physicalProviderCalled: true,
  })
}

function refused(safeCode) {
  return Object.freeze({
    outcome: 'REFUSED_BEFORE_SEND',
    safeCode,
    physicalProviderCalled: false,
  })
}

function safeSenderCode(error, fallback) {
  const code = error?.safeCode || error?.code
  return /^[A-Z0-9_]{1,128}$/.test(String(code || '')) ? String(code) : fallback
}

/**
 * Execute one fenced MAX Web text action and promote it only when MAX exposes
 * an exact provider message id.  This helper never retries the physical action.
 */
async function sendProviderConfirmedUiText(options) {
  const {
    request,
    sendViaUi,
    sendReplyViaUi,
    startProviderAck,
    snapshotProviderMessageIds,
    resolveProviderMessageId,
    isRealProviderMessageId,
    clock = () => Date.now(),
  } = options || {}

  const protocolChatId = String(request?.route?.protocolChatId || '')
  const webRouteId = String(request?.route?.webRouteId || '')
  const text = request?.payload?.text
  const replyToProviderMessageId = request?.payload?.replyToProviderMessageId || null
  if (!/^\d{5,15}$/.test(protocolChatId) || !/^\d{5,15}$/.test(webRouteId)
    || typeof text !== 'string' || text.length === 0
    || typeof sendViaUi !== 'function' || typeof startProviderAck !== 'function'
    || typeof snapshotProviderMessageIds !== 'function'
    || typeof resolveProviderMessageId !== 'function' || typeof isRealProviderMessageId !== 'function') {
    return refused('EXACT_WEB_ROUTE_MISSING')
  }
  if (replyToProviderMessageId !== null
    && (!isRealProviderMessageId(replyToProviderMessageId) || typeof sendReplyViaUi !== 'function')) {
    return refused('REPLY_TARGET_UNSENDABLE')
  }

  let excludedProviderMessageIds
  try {
    excludedProviderMessageIds = Object.freeze(Array.from(new Set(
      (await snapshotProviderMessageIds({ protocolChatId, webRouteId }))
        .filter(isRealProviderMessageId)
        .map(value => String(value).toLowerCase())
    )))
  } catch {
    return refused('PROVIDER_STORE_SNAPSHOT_FAILED')
  }

  let ackPromise
  try {
    // Register the exact own-echo listener before the single physical action.
    ackPromise = Promise.resolve(startProviderAck({ protocolChatId, text, replyToProviderMessageId }))
      .catch(() => null)
  } catch {
    ackPromise = Promise.resolve(null)
  }

  const sentAt = Number(clock())
  let actionAccepted = false
  let directProviderMessageId = null
  try {
    if (replyToProviderMessageId) {
      const replyResult = await sendReplyViaUi({
        protocolChatId,
        webRouteId,
        text,
        replyToProviderMessageId,
        clientMessageId: request.clientMessageId,
        attemptId: request.attemptId,
      })
      directProviderMessageId = isRealProviderMessageId(replyResult?.providerMessageId)
        ? String(replyResult.providerMessageId)
        : null
      actionAccepted = replyResult === true || replyResult?.ok === true || directProviderMessageId !== null
    } else {
      actionAccepted = await sendViaUi({ protocolChatId, webRouteId, text })
    }
  } catch (error) {
    const safeCode = safeSenderCode(error, 'UI_PROVIDER_ACTION_OUTCOME_UNKNOWN')
    return error?.beforeProviderAction === true ? refused(safeCode) : unknown(safeCode)
  }
  if (actionAccepted !== true) return unknown('UI_PROVIDER_ACTION_OUTCOME_UNKNOWN')
  if (directProviderMessageId) {
    return Object.freeze({
      outcome: 'PROVIDER_CONFIRMED',
      safeCode: 'EXACT_PROVIDER_CONFIRMATION',
      physicalProviderCalled: true,
      providerMessageId: directProviderMessageId,
    })
  }

  let storeId = null
  try {
    storeId = await resolveProviderMessageId({ protocolChatId, webRouteId, text, sentAt, excludedProviderMessageIds, replyToProviderMessageId })
  } catch {}
  if (isRealProviderMessageId(storeId)) {
    return Object.freeze({
      outcome: 'PROVIDER_CONFIRMED',
      safeCode: 'EXACT_PROVIDER_CONFIRMATION',
      physicalProviderCalled: true,
      providerMessageId: String(storeId),
    })
  }

  const echoId = await ackPromise
  if (isRealProviderMessageId(echoId)
    && !excludedProviderMessageIds.includes(String(echoId).toLowerCase())) {
    return Object.freeze({
      outcome: 'PROVIDER_CONFIRMED',
      safeCode: 'EXACT_PROVIDER_CONFIRMATION',
      physicalProviderCalled: true,
      providerMessageId: String(echoId),
    })
  }

  // MAX Web can materialize the durable provider row after the own-echo wait
  // starts. Re-read the store once after that bounded wait; never repeat the UI
  // action and never promote a DOM-only identifier.
  try {
    storeId = await resolveProviderMessageId({ protocolChatId, webRouteId, text, sentAt, excludedProviderMessageIds, replyToProviderMessageId })
  } catch {}
  const providerMessageId = isRealProviderMessageId(storeId) ? String(storeId) : null
  if (!isRealProviderMessageId(providerMessageId)) return unknown('EXACT_PROVIDER_ID_MISSING')
  return Object.freeze({
    outcome: 'PROVIDER_CONFIRMED',
    safeCode: 'EXACT_PROVIDER_CONFIRMATION',
    physicalProviderCalled: true,
    providerMessageId: String(providerMessageId),
  })
}

module.exports = { sendProviderConfirmedUiText }
