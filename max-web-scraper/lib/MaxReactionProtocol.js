'use strict'

function canonicalMaxMessageId(value) {
  const clean = String(value || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
  return /^d301[0-9a-f]{14}$/.test(clean) ? clean : null
}

function extractMaxMessageIdsFromBinaryFrame(frame) {
  if (!Buffer.isBuffer(frame)) return []
  const ids = new Set()

  for (let index = 0; index + 12 <= frame.length; index += 1) {
    if (
      frame[index] !== 0xc7 ||
      frame[index + 1] !== 0x09 ||
      frame[index + 2] !== 0x01 ||
      ![0xcf, 0xd3].includes(frame[index + 3])
    ) {
      continue
    }

    const id = canonicalMaxMessageId(
      Buffer.concat([Buffer.from([0xd3]), frame.subarray(index + 4, index + 12)]).toString('hex'),
    )
    if (id) ids.add(id)
  }

  return [...ids]
}

function isEmoji(value) {
  return typeof value === 'string' && /\p{Extended_Pictographic}/u.test(value)
}

function normalizeEmojiAlias(value) {
  return String(value || '').replace(/\uFE0F/g, '')
}

function recoverReactionCatalog(value) {
  const found = new Map()
  const visited = new Set()

  const register = (id, emoji) => {
    const providerId = Number(id)
    if (!Number.isInteger(providerId) || providerId <= 0 || !isEmoji(emoji)) return
    found.set(`${providerId}:${emoji}`, { id: providerId, emoji: String(emoji) })
  }

  const walk = (item, depth = 0) => {
    if (item == null || depth > 12) return
    if (typeof item !== 'object') return
    if (visited.has(item)) return
    visited.add(item)

    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        const current = item[index]
        const next = item[index + 1]
        if (Number.isInteger(Number(current)) && isEmoji(next)) register(current, next)
        walk(current, depth + 1)
      }
      return
    }

    register(item.id, item.emoji)
    for (const child of Object.values(item)) walk(child, depth + 1)
  }

  walk(value)
  return [...found.values()]
}

function bufferFromSerialized(value) {
  if (Buffer.isBuffer(value)) return value
  if (
    value &&
    typeof value === 'object' &&
    value.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data)
  }
  return null
}

function collectBuffers(value, out = [], visited = new Set(), depth = 0) {
  if (value == null || depth > 8) return out
  const direct = bufferFromSerialized(value)
  if (direct) {
    out.push(direct)
    return out
  }
  if (typeof value !== 'object' || visited.has(value)) return out
  visited.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectBuffers(item, out, visited, depth + 1)
    return out
  }
  for (const item of Object.values(value)) collectBuffers(item, out, visited, depth + 1)
  return out
}

function readMsgpackCount(buffer, offset) {
  if (!Buffer.isBuffer(buffer) || offset >= buffer.length) return null
  const marker = buffer[offset]
  if (marker <= 0x7f) return marker
  if (marker === 0xcc && offset + 1 < buffer.length) return buffer[offset + 1]
  if (marker === 0xcd && offset + 2 < buffer.length) return buffer.readUInt16BE(offset + 1)
  if (marker === 0xce && offset + 4 < buffer.length) return buffer.readUInt32BE(offset + 1)
  return null
}

function compactMessageFingerprint(messageId) {
  const id = canonicalMaxMessageId(messageId)
  if (!id) return null
  return Buffer.from(id, 'hex').subarray(3, 8)
}

function correlateCompactMessageId(buffer, requestedMessageIds) {
  const exactIds = [...new Set(
    (requestedMessageIds || []).map(canonicalMaxMessageId).filter(Boolean),
  )]
  if (exactIds.length === 1) return exactIds[0]

  const matches = exactIds.filter(id => {
    const fingerprint = compactMessageFingerprint(id)
    return fingerprint && buffer.includes(fingerprint)
  })
  return matches.length === 1 ? matches[0] : null
}

function parseCompactReactionCounters(buffer, supportedEmojis) {
  const marker = Buffer.from('counters')
  const markerIndex = buffer.indexOf(marker)
  if (markerIndex < 0) return null

  const afterMarker = markerIndex + marker.length
  const arrayMarker = buffer[afterMarker]
  if (arrayMarker === 0x90) return []

  const windowEnd = Math.min(buffer.length, afterMarker + 512)
  const window = buffer.subarray(afterMarker, windowEnd)
  const counters = []
  const seen = new Set()
  const emojis = [...new Set((supportedEmojis || []).filter(isEmoji))]
    .sort((left, right) => Buffer.byteLength(right) - Buffer.byteLength(left))

  for (const emoji of emojis) {
    const bytes = Buffer.from(emoji)
    const emojiOffset = window.indexOf(bytes)
    if (emojiOffset < 0) continue

    const countMarker = Buffer.from('totalCount')
    const countKeyOffset = window.indexOf(countMarker, emojiOffset + bytes.length)
    if (countKeyOffset < 0 || countKeyOffset - emojiOffset > 96) continue
    const count = readMsgpackCount(window, countKeyOffset + countMarker.length)
    const alias = normalizeEmojiAlias(emoji)
    if (!Number.isFinite(count) || count <= 0 || seen.has(alias)) continue
    seen.add(alias)
    counters.push({ reaction: emoji, count })
  }

  return counters
}

function extractCompactReactionSnapshots(
  messagesReactions,
  { requestedMessageIds = [], supportedEmojis = [] } = {},
) {
  const snapshots = new Map()
  for (const buffer of collectBuffers(messagesReactions)) {
    const counters = parseCompactReactionCounters(buffer, supportedEmojis)
    if (!Array.isArray(counters)) continue
    const messageId = correlateCompactMessageId(buffer, requestedMessageIds)
    if (messageId) snapshots.set(messageId, counters)
  }
  return snapshots
}

function reactionCapabilityEmojis(catalog, fallback = ['👍', '⚡️']) {
  const emojis = []
  const aliases = new Set()
  for (const item of catalog || []) {
    if (!isEmoji(item?.emoji)) continue
    const alias = normalizeEmojiAlias(item.emoji)
    if (aliases.has(alias)) continue
    aliases.add(alias)
    emojis.push(String(item.emoji))
  }
  return emojis.length > 0 ? emojis : fallback
}

module.exports = {
  canonicalMaxMessageId,
  correlateCompactMessageId,
  extractCompactReactionSnapshots,
  extractMaxMessageIdsFromBinaryFrame,
  normalizeEmojiAlias,
  parseCompactReactionCounters,
  reactionCapabilityEmojis,
  recoverReactionCatalog,
}
