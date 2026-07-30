'use strict'

const MAX_MESSAGE_ID = /^d301([0-9a-f]{10})[0-9a-f]{4}$/i
const MAX_TIMESTAMP_MODULUS_MS = 2 ** 40

function providerMessageTimestampMs(providerMessageId, nowMs = Date.now()) {
  const match = MAX_MESSAGE_ID.exec(String(providerMessageId || ''))
  if (!match || !Number.isFinite(nowMs)) return null
  const lowBits = Number.parseInt(match[1], 16)
  if (!Number.isSafeInteger(lowBits)) return null

  const cycle = Math.floor(nowMs / MAX_TIMESTAMP_MODULUS_MS)
  const candidates = [cycle - 1, cycle, cycle + 1]
    .map(value => value * MAX_TIMESTAMP_MODULUS_MS + lowBits)
  return candidates.reduce((nearest, candidate) =>
    Math.abs(candidate - nowMs) < Math.abs(nearest - nowMs) ? candidate : nearest
  )
}

function normalizeProviderTimestamp(rawTimestamp, providerMessageId, nowMs = Date.now()) {
  let parsed = null
  if (typeof rawTimestamp === 'number') {
    parsed = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp
  } else if (typeof rawTimestamp === 'string' && rawTimestamp.trim()) {
    const numeric = Number(rawTimestamp)
    parsed = Number.isFinite(numeric)
      ? (numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(rawTimestamp).getTime()
  } else if (rawTimestamp instanceof Date) {
    parsed = rawTimestamp.getTime()
  }
  if (Number.isFinite(parsed)) return parsed
  return providerMessageTimestampMs(providerMessageId, nowMs) ?? nowMs
}

function timestampMsFromValue(value) {
  if (value == null || value === '') return null
  const ms = typeof value === 'number'
    ? value
    : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function directHitTimestampMs(hit) {
  return timestampMsFromValue(hit?.sentAtMs) ?? timestampMsFromValue(hit?.ts)
}

function hasDirectDomTimestampAnchor(candidates) {
  return candidates.some(candidate => directHitTimestampMs(candidate?._directHit) != null)
}

function estimateDomRecoveryTimestampMs(candidates, index, nowMs = Date.now()) {
  const anchors = candidates.map(candidate => directHitTimestampMs(candidate?._directHit))

  let prevIndex = -1
  let prevMs = null
  for (let i = index - 1; i >= 0; i--) {
    if (anchors[i] != null) {
      prevIndex = i
      prevMs = anchors[i]
      break
    }
  }

  let nextIndex = -1
  let nextMs = null
  for (let i = index + 1; i < candidates.length; i++) {
    if (anchors[i] != null) {
      nextIndex = i
      nextMs = anchors[i]
      break
    }
  }

  if (prevMs != null && nextMs != null && nextMs > prevMs) {
    const ratio = (index - prevIndex) / (nextIndex - prevIndex)
    return Math.round(prevMs + (nextMs - prevMs) * ratio)
  }
  if (prevMs != null) return prevMs + (index - prevIndex) * 1000
  if (nextMs != null) return nextMs - (nextIndex - index) * 1000
  return nowMs - (candidates.length - index) * 1000
}

module.exports = {
  estimateDomRecoveryTimestampMs,
  hasDirectDomTimestampAnchor,
  normalizeProviderTimestamp,
  providerMessageTimestampMs,
}
