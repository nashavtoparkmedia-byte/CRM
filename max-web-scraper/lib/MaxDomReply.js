'use strict'

function splitMaxDomReplyText(text) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  if (lines.length < 3) return null

  const bodyText = lines[lines.length - 1]
  const quotedText = lines.slice(1, -1).join('\n').trim()
  if (!bodyText || !quotedText) return null

  return {
    headerText: lines[0],
    quotedText,
    bodyText,
    leafText: bodyText,
  }
}

function isProviderBackedDomReplyCandidate(parts, { hasReplyQuote = false, providerMessageId = null } = {}) {
  if (!parts?.bodyText || !parts?.quotedText) return false
  return Boolean(hasReplyQuote || /^d301[0-9a-f]{14}$/i.test(String(providerMessageId || '')))
}

module.exports = {
  isProviderBackedDomReplyCandidate,
  splitMaxDomReplyText,
}
