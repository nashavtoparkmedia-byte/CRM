'use strict'

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

module.exports = { estimateDomRecoveryTimestampMs, hasDirectDomTimestampAnchor }
