'use strict'

function digits(value) {
  const normalized = String(value || '').replace(/\D/g, '')
  return normalized || null
}

function uiRouteIdForProtocolChat(protocolChatId) {
  const chatId = digits(protocolChatId)
  if (!chatId) return null
  try {
    return BigInt.asUintN(32, BigInt(chatId)).toString()
  } catch {
    return null
  }
}

function createMaxProviderProfileEvidence(input = {}) {
  const providerIdentityId = digits(input.providerIdentityId)
  const protocolChatId = digits(input.protocolChatId)
  const uiRouteId = digits(input.uiRouteId)
  const expectedUiRouteId = uiRouteIdForProtocolChat(protocolChatId)
  if (!providerIdentityId || !protocolChatId || !uiRouteId || uiRouteId !== expectedUiRouteId) {
    return null
  }

  const observedAt = new Date(input.observedAt || Date.now())
  return {
    sourceKind: 'provider_profile',
    trustedForAutomaticResolution: true,
    observedAt: Number.isFinite(observedAt.getTime())
      ? observedAt.toISOString()
      : new Date().toISOString(),
    providerIdentityId,
    protocolChatId,
    uiRouteId,
  }
}

function isBoundMaxPhoneEvidence(value) {
  if (!value || value.sourceKind !== 'provider_profile') return false
  if (value.trustedForAutomaticResolution !== true) return false
  return Boolean(createMaxProviderProfileEvidence(value))
}

module.exports = {
  createMaxProviderProfileEvidence,
  isBoundMaxPhoneEvidence,
  uiRouteIdForProtocolChat,
}
