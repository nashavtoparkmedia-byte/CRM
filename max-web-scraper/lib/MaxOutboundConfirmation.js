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
    attempts = 4,
    delayMs = 250,
    waitFn = wait,
  } = options

  if (!bridge || typeof bridge.resolveProviderId !== 'function') return null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await bridge.resolveProviderId(
      protocolChatId,
      { text, sentAt, direction: 'outbound' },
      { uiChatId: uiRouteId },
    ).catch(() => null)
    if (isRealMaxMessageId(result?.providerMessageId)) {
      return String(result.providerMessageId)
    }
    if (attempt + 1 < attempts) await waitFn(delayMs)
  }

  return null
}

module.exports = {
  isRealMaxMessageId,
  resolveOutboundProviderMessageId,
}
