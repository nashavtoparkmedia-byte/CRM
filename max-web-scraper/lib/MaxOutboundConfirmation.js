'use strict'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function isRealMaxMessageId(value) {
  return /^d301/i.test(String(value || ''))
}

async function resolveOutboundProviderMessageId(options = {}) {
  const {
    bridge,
    protocolChatId,
    uiRouteId,
    text,
    sentAt,
    replyToProviderMessageId = null,
    attempts = 18,
    delayMs = 500,
    waitFn = wait,
    excludedProviderMessageIds = [],
    historyLookbackMs = 180_000,
    historyMaxPages = 6,
  } = options

  if (!bridge || typeof bridge.resolveProviderId !== 'function') return null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await bridge.resolveProviderId(
      protocolChatId,
      { text, sentAt, direction: 'outbound', ...(replyToProviderMessageId ? { replyToProviderMessageId } : {}) },
      {
        uiChatId: uiRouteId,
        excludedProviderMessageIds,
        historyWindowStart: Number.isFinite(sentAt) ? Number(sentAt) - historyLookbackMs : undefined,
        historyMaxPages,
      },
    ).catch(() => null)
    if (isRealMaxMessageId(result?.providerMessageId)) {
      return String(result.providerMessageId)
    }
    if (attempt + 1 < attempts) await waitFn(delayMs)
  }

  return null
}

async function snapshotOutboundProviderMessageIds(options = {}) {
  const { bridge, protocolChatId, uiRouteId } = options
  if (!bridge || typeof bridge.snapshotProviderMessageIds !== 'function') {
    throw new Error('MAX provider-store snapshot is unavailable')
  }
  const providerMessageIds = await bridge.snapshotProviderMessageIds(
    protocolChatId,
    { uiChatId: uiRouteId },
  )
  return Object.freeze(Array.from(new Set(
    (Array.isArray(providerMessageIds) ? providerMessageIds : [])
      .filter(isRealMaxMessageId)
      .map(value => String(value).toLowerCase())
  )).sort())
}

module.exports = {
  isRealMaxMessageId,
  resolveOutboundProviderMessageId,
  snapshotOutboundProviderMessageIds,
}
