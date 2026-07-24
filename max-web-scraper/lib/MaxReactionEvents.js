'use strict'

function extractMaxId(value) {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).replace(/[^a-fA-F0-9]/g, '')
    return /^d301[0-9a-f]{14}$/i.test(text) ? text.toLowerCase() : null
  }
  if (typeof value !== 'object') return null
  if (value.__maxId && value.hex) return extractMaxId(value.hex)
  if (value.hex) return extractMaxId(value.hex)
  return null
}

function uniqueComplexEntryMessageId(value) {
  const ids = new Set()
  for (const entry of Array.isArray(value?.__complexEntries) ? value.__complexEntries : []) {
    const id = extractMaxId(entry?.key)
    if (id) ids.add(id)
  }
  return ids.size === 1 ? [...ids][0] : null
}

function reactionSnapshotMessageId(value) {
  return extractMaxId(value?.messageId || value?.id) || uniqueComplexEntryMessageId(value)
}

function normalizeSnapshotCounters(value, normalizeEmoji = item => item) {
  const raw = Array.isArray(value?.counters)
    ? value.counters
    : Array.isArray(value?.reactions)
      ? value.reactions
      : []

  const counters = []
  for (const item of raw) {
    const reaction = normalizeEmoji(item?.reaction || item?.id || item?.emoji || item)
    const count = Number(item?.count ?? item?.totalCount ?? item?.value ?? 1)
    if (reaction && Number.isFinite(count) && count > 0) counters.push({ reaction, count })
  }
  return counters
}

function reactionSnapshotEvent(value, normalizeEmoji) {
  const externalMsgId = reactionSnapshotMessageId(value)
  const counters = normalizeSnapshotCounters(value, normalizeEmoji)
  return externalMsgId ? { externalMsgId, counters } : null
}

function createReactionEventDeduper({ ttlMs = 5000, now = () => Date.now() } = {}) {
  const recent = new Map()
  return event => {
    const observedAt = now()
    for (const [key, seenAt] of recent) {
      if (observedAt - seenAt > ttlMs) recent.delete(key)
    }
    const key = `${event?.externalMsgId || ''}:${event?.emoji || ''}:${JSON.stringify(event?.counters || null)}:${!!event?.isRemove}`
    if (recent.has(key)) return false
    recent.set(key, observedAt)
    return true
  }
}

module.exports = {
  createReactionEventDeduper,
  extractMaxId,
  normalizeSnapshotCounters,
  reactionSnapshotEvent,
  reactionSnapshotMessageId,
}
