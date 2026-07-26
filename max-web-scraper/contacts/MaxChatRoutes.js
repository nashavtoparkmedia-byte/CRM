'use strict'

const { uiRouteIdForProtocolChat } = require('./MaxPhoneEvidence')

function normalizeRouteId(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits || null
}

function resolveMaxUiRouteId(chatId, options = {}) {
  const chatIdStr = normalizeRouteId(chatId)
  if (!chatIdStr) return { uiRouteId: String(chatId || ''), source: 'unresolved' }

  const staticRouteId = normalizeRouteId(options.overrides?.[chatIdStr])
  if (staticRouteId) return { uiRouteId: staticRouteId, source: 'static_override' }

  const protocolRouteId = uiRouteIdForProtocolChat(chatIdStr)
  if (protocolRouteId && protocolRouteId !== chatIdStr) {
    return { uiRouteId: protocolRouteId, source: 'protocol_low32' }
  }

  const participantRouteId = normalizeRouteId(options.participantRouteId)
  if (participantRouteId && participantRouteId !== chatIdStr) {
    return { uiRouteId: participantRouteId, source: 'dialog_participant' }
  }

  return { uiRouteId: chatIdStr, source: 'protocol_chat_id' }
}

module.exports = { resolveMaxUiRouteId }
