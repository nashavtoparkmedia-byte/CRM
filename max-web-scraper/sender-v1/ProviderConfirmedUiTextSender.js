'use strict'

function unknown(safeCode) {
  return Object.freeze({
    outcome: 'UNKNOWN_AFTER_ATTEMPT',
    safeCode,
    physicalProviderCalled: true,
  })
}

/**
 * Execute one fenced MAX Web text action and promote it only when MAX exposes
 * an exact provider message id.  This helper never retries the physical action.
 */
async function sendProviderConfirmedUiText(options) {
  const {
    request,
    sendViaUi,
    startProviderAck,
    resolveProviderMessageId,
    isRealProviderMessageId,
    clock = () => Date.now(),
  } = options || {}

  const protocolChatId = String(request?.route?.protocolChatId || '')
  const webRouteId = String(request?.route?.webRouteId || '')
  const text = request?.payload?.text
  if (!/^\d{5,15}$/.test(protocolChatId) || !/^\d{5,15}$/.test(webRouteId)
    || typeof text !== 'string' || text.length === 0
    || typeof sendViaUi !== 'function' || typeof startProviderAck !== 'function'
    || typeof resolveProviderMessageId !== 'function' || typeof isRealProviderMessageId !== 'function') {
    return unknown('EXACT_WEB_ROUTE_MISSING')
  }

  const sentAt = Number(clock())
  let ackPromise
  try {
    // Register the exact own-echo listener before the single physical action.
    ackPromise = Promise.resolve(startProviderAck({ protocolChatId, text }))
      .catch(() => null)
  } catch {
    ackPromise = Promise.resolve(null)
  }

  let actionAccepted = false
  try {
    actionAccepted = await sendViaUi({ protocolChatId, webRouteId, text })
  } catch {
    return unknown('UI_PROVIDER_ACTION_OUTCOME_UNKNOWN')
  }
  if (actionAccepted !== true) return unknown('UI_PROVIDER_ACTION_OUTCOME_UNKNOWN')

  let storeId = null
  try {
    storeId = await resolveProviderMessageId({ protocolChatId, webRouteId, text, sentAt })
  } catch {}
  const providerMessageId = isRealProviderMessageId(storeId) ? String(storeId) : await ackPromise
  if (!isRealProviderMessageId(providerMessageId)) return unknown('EXACT_PROVIDER_ID_MISSING')
  return Object.freeze({
    outcome: 'PROVIDER_CONFIRMED',
    safeCode: 'EXACT_PROVIDER_CONFIRMATION',
    physicalProviderCalled: true,
    providerMessageId: String(providerMessageId),
  })
}

module.exports = { sendProviderConfirmedUiText }
